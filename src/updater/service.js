// The updater's state machine, one per app. No Electron here: the network
// (fetch), the platform back-end, the busy check and the clock are injected,
// so the tests drive it against a local fake feed.
//
//   idle → checking → available → downloading → ready → installing
//                  ↘ idle (up to date)       ↘ error (keeps `available`)
//
// Every manifest passes verify.js before anything is offered. Nothing
// downloads or installs unless asked: autoDownload is off until the person
// turns it on, and only install() installs. It never restarts on its own:
// install({when:'now'}) while a session is working is deferred with
// busyReason set; install({when:'idle'}) waits for 30 s with nothing busy. A
// back-end that doesn't restart the app (the .deb opens the system
// installer) skips both. Channel, autoDownload, and the last accepted
// issuedAt per channel persist in <userData>/updater.json.
const fs = require('fs');
const path = require('path');
const V = require('./verify.js');

const FOUR_HOURS = 4 * 3600000;
const MAX_SIG_BYTES = 1024;
const STATUSES = ['idle', 'checking', 'available', 'downloading', 'ready', 'installing', 'error'];
// A check on the schedule that can't reach the server keeps what it had.
const TRANSIENT = new Set(['offline', 'server']);

function toError(err) {
  if (err instanceof V.UpdateError) return { code: err.code, detail: err.detail };
  return { code: 'unknown', detail: String(err?.message || err).slice(0, 300) };
}

const channelOf = (version) => (/-beta\b/.test(version) ? 'beta' : 'stable');

/**
 * opts: {
 *   fetch, keyring (verify.loadKeyring), feedBase ('https://download.plexiform.dev'),
 *   currentVersion, userData, backend (null: check only), isBusy () → reason|null,
 *   builtAt (this build's release floor, ISO; null in dev),
 *   updatedFrom (the version the mac helper swapped from, already checked; null),
 *   updateFailed (the mac helper rolled a failed update back),
 *   platform, arch, now, setTimer, clearTimer, setRepeat, clearRepeat, log,
 *   retryDelayMs, idleMs, idlePollMs, fetchTimeoutMs, installStallMs
 * }
 */
function createService(opts) {
  const {
    fetch, keyring, feedBase, currentVersion, userData, backend = null, isBusy = () => null,
    builtAt = null, updatedFrom = null, updateFailed = false,
    platform = process.platform, arch = process.arch, now = () => Date.now(),
    setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, clearRepeat = clearInterval, log = console,
    retryDelayMs = 2000, idleMs = 30000, idlePollMs = 5000, fetchTimeoutMs = 30000, installStallMs = 150000,
  } = opts;
  const storePath = path.join(userData, 'updater.json');
  const store = { channel: channelOf(currentVersion), channelChosen: false, autoDownload: false, lastIssuedAt: {}, lastCheckedAt: null, lastRunVersion: null, previousVersion: null };
  try { Object.assign(store, JSON.parse(fs.readFileSync(storePath, 'utf8'))); } catch { /* first run */ }
  // Until the person picks a channel it follows the running version, so a
  // beta build that was replaced by a stable one goes back to stable.
  if (!store.channelChosen || !V.CHANNELS.includes(store.channel)) store.channel = channelOf(currentVersion);
  if (!store.lastIssuedAt || typeof store.lastIssuedAt !== 'object') store.lastIssuedAt = {};
  if (store.lastRunVersion && store.lastRunVersion !== currentVersion) store.previousVersion = store.lastRunVersion;
  if (updatedFrom && V.parseVersion(updatedFrom)) store.previousVersion = updatedFrom;
  if (store.previousVersion && !V.parseVersion(store.previousVersion)) store.previousVersion = null;
  store.lastRunVersion = currentVersion;
  const save = () => {
    try {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(`${storePath}.tmp`, JSON.stringify(store, null, 2));
      fs.renameSync(`${storePath}.tmp`, storePath);
    } catch (err) { log.warn?.('[updater] could not save settings:', err.message); }
  };
  save();

  let status = 'idle';
  let error = null;
  let available = null;
  let progress = null;
  let busyReason = null;
  let requiredByHub = null;
  // what `available` refers to: the verified manifest, this machine's file, where it came from
  let offer = null;
  let checking = null;
  let idleWait = null;
  let busyWatch = null;
  let stallWatch = null;
  let timers = [];
  const listeners = new Set();

  if (updateFailed) {
    status = 'error';
    error = { code: 'unknown', detail: 'The new version did not start, so Plexiform went back to this one.' };
  }

  const channelBase = (ch = store.channel) => `${feedBase.replace(/\/+$/, '')}${ch === 'beta' ? '/beta' : ''}/`;

  function getState() {
    const canRevert = !!(backend?.canFetchRevert && store.previousVersion);
    return {
      status,
      currentVersion,
      channel: store.channel,
      autoDownload: store.autoDownload,
      lastCheckedAt: store.lastCheckedAt,
      available: available && { ...available },
      progress: progress && { ...progress },
      error: error && { ...error },
      canRevert,
      previousVersion: store.previousVersion || null,
      requiredByHub: requiredByHub && { ...requiredByHub },
      busyReason,
      installKind: backend?.kind || 'restart',
    };
  }
  function emit() {
    const s = getState();
    for (const fn of listeners) { try { fn(s); } catch (err) { log.warn?.('[updater] listener failed:', err.message); } }
  }
  function set(next) {
    ({ status = status, error = error, available = available, progress = progress } = next);
    if ('busyReason' in next) busyReason = next.busyReason;
    // A reason to wait only means something while an update waits to install.
    if (status !== 'ready') busyReason = null;
    emit();
  }
  const failWith = (err, over = {}) => {
    const e = toError(err);
    log.warn?.(`[updater] ${e.code}: ${e.detail}`);
    set({ status: 'error', error: e, progress: null, ...over });
    return { ok: false, error: e.code };
  };

  async function get(url, limit) {
    const signal = AbortSignal.timeout(fetchTimeoutMs);
    const timedOut = () => new V.UpdateError('offline', `The update server did not answer within ${Math.round(fetchTimeoutMs / 1000)} s.`);
    let res;
    try {
      res = await fetch(url, { cache: 'no-store', redirect: 'follow', signal }); // privacy-flow: auto-update
    } catch (err) {
      if (signal.aborted) throw timedOut();
      throw new V.UpdateError('offline', `Could not reach the update server (${err?.cause?.code || err?.message || err}).`);
    }
    if (res.status !== 200) throw new V.UpdateError('server', `The update server answered ${res.status} for ${url.split('/').slice(-2).join('/')}.`);
    const chunks = [];
    let n = 0;
    try {
      for await (const c of res.body) {
        n += c.length;
        if (n > limit) throw new V.UpdateError('verify', `${url.split('/').pop()} is too large.`);
        chunks.push(Buffer.from(c));
      }
    } catch (err) {
      if (err instanceof V.UpdateError) throw err;
      if (signal.aborted) throw timedOut();
      throw new V.UpdateError('offline', `The update server stopped answering (${err?.message || err}).`);
    }
    return Buffer.concat(chunks);
  }

  // A promote copies release.json and its .sig one after the other, so a
  // check in between sees a mismatch; one retry rides that out.
  async function fetchManifest(url, channel) {
    for (let tryNo = 0; ; tryNo++) {
      const [bytes, sig] = await Promise.all([get(url, 256 * 1024), get(`${url}.sig`, MAX_SIG_BYTES)]);
      try {
        return V.openManifest(bytes, sig.toString('utf8'), keyring, { channel });
      } catch (err) {
        if (err.code !== 'signature' || tryNo > 0) throw err;
        await new Promise((r) => setTimer(r, retryDelayMs));
      }
    }
  }

  // Verifies url's manifest. → { update: false, expired, manifest } or
  // { update: true, expired, offer, available }. Changes nothing but the
  // replay floor and lastCheckedAt; the caller decides whether to use it.
  async function takeOffer(manifestUrl, { channel, revertTo = null }) {
    const m = await fetchManifest(manifestUrl, channel);
    const last = store.lastIssuedAt[channel] || null;
    const d = V.decide(m, { channel, currentVersion, lastIssuedAt: last, builtAt, revertTo, now: now() });
    if (!revertTo && (!last || Date.parse(m.issuedAt) > Date.parse(last))) store.lastIssuedAt[channel] = m.issuedAt;
    store.lastCheckedAt = new Date(now()).toISOString();
    save();
    if (!d.update) return { update: false, expired: d.expired, manifest: m };
    if (!backend) throw new V.UpdateError('unknown', 'This build cannot install updates (a development run).');
    const entry = V.pickFile(m, { platform, arch, kind: backend.fileKind });
    if (!entry) throw new V.UpdateError('server', `Release ${m.version} has no ${backend.fileKind} for ${platform} ${arch}.`);
    const url = new URL(entry.name, manifestUrl).href;
    await backend.prepare?.({ manifest: m, entry, manifestUrl, url, rollback: d.rollback });
    return {
      update: true,
      expired: d.expired,
      offer: { manifest: m, entry, manifestUrl, url, rollback: d.rollback },
      available: { version: m.version, notes: m.notes || '', size: entry.size, publishedAt: m.issuedAt },
    };
  }

  function preflightError() {
    const e = backend?.preflight?.();
    return e ? toError(e) : null;
  }

  const expiredError = (m) => ({
    code: 'expired',
    detail: `Couldn't confirm Plexiform is up to date since ${m.issuedAt.slice(0, 10)}: the update server keeps offering a release that has expired.`,
  });

  // user: the person asked (a scheduled check that can't reach the server
  // keeps the previous state and says nothing).
  async function runCheck({ user }) {
    const before = { status, error, available, progress, offer };
    for (;;) {
      const channel = store.channel;
      set({ status: 'checking', error: null, progress: null });
      let found;
      try {
        found = await takeOffer(`${channelBase(channel)}release.json`, { channel });
      } catch (err) {
        if (store.channel !== channel) continue;
        const e = toError(err);
        if (!user && TRANSIENT.has(e.code)) {
          log.warn?.(`[updater] scheduled check: ${e.code}: ${e.detail}`);
          offer = before.offer;
          set({ status: before.status, error: before.error, available: before.available, progress: before.progress });
          return { ok: false, error: e.code, kept: true };
        }
        offer = null;
        return failWith(err, { available: null });
      }
      // The channel changed while this one was being checked: check the new one.
      if (store.channel !== channel) continue;
      if (!found.update) {
        offer = null;
        if (found.expired) set({ status: 'error', error: expiredError(found.manifest), available: null });
        else set({ status: 'idle', available: null });
        return { ok: true };
      }
      offer = found.offer;
      available = found.available;
      const pre = preflightError();
      if (pre) { set({ status: 'error', error: pre }); return { ok: false, error: pre.code }; }
      set({ status: 'available' });
      if (store.autoDownload) return download();
      return { ok: true };
    }
  }

  function check({ user = false } = {}) {
    if (status === 'downloading' || status === 'installing' || status === 'ready') return Promise.resolve({ ok: true, skipped: status });
    if (!checking) checking = runCheck({ user }).finally(() => { checking = null; });
    return checking;
  }

  async function download() {
    if (!offer || !(status === 'available' || status === 'error')) return { ok: false, error: 'nothing-to-download' };
    const pre = preflightError();
    if (pre) { set({ status: 'error', error: pre }); return { ok: false, error: pre.code }; }
    const { entry } = offer;
    set({ status: 'downloading', error: null, progress: { percent: 0, transferred: 0, total: entry.size } });
    try {
      let last = -1;
      await backend.download({
        ...offer,
        onProgress: ({ transferred, total = entry.size }) => {
          const percent = total ? Math.min(100, Math.floor((transferred / total) * 100)) : 0;
          if (percent === last) return;
          last = percent;
          set({ progress: { percent, transferred, total } });
        },
      });
      set({ status: 'ready', progress: null });
      return { ok: true };
    } catch (err) {
      return failWith(err);
    }
  }

  function stopIdleWait() {
    if (idleWait) { clearTimer(idleWait.timer); idleWait = null; }
  }
  function stopBusyWatch() {
    if (busyWatch) { clearTimer(busyWatch); busyWatch = null; }
  }
  function stopStallWatch() {
    if (stallWatch) { clearTimer(stallWatch); stallWatch = null; }
  }

  async function doInstall() {
    stopIdleWait();
    stopBusyWatch();
    set({ status: 'installing', error: null, busyReason: null });
    try {
      const r = await backend.install({ ...offer, currentVersion });
      // A .deb opens in the software installer; the app keeps running.
      if (r?.stay) { set({ status: 'ready' }); return { ok: true }; }
      // The back-end quits the app to install. If it is still here after
      // this long the installer never started: say so, and offer it again.
      stopStallWatch();
      stallWatch = setTimer(() => {
        stallWatch = null;
        if (status !== 'installing') return;
        log.warn?.('[updater] install-stalled: still running after install');
        set({ status: 'ready', error: { code: 'install-stalled', detail: 'The update did not start. Try again, or quit Plexiform and open it again.' } });
      }, installStallMs);
      stallWatch?.unref?.();
      return { ok: true };
    } catch (err) {
      // The download is still verified and in place: back to ready, to try again.
      return failWith(err, { status: 'ready' });
    }
  }

  function waitForIdle() {
    stopIdleWait();
    stopBusyWatch();
    idleWait = { since: null, timer: null };
    const tick = () => {
      if (!idleWait || status !== 'ready') { stopIdleWait(); return; }
      const reason = isBusy();
      if (reason) {
        idleWait.since = null;
        if (reason !== busyReason) set({ busyReason: reason });
      } else {
        if (busyReason) set({ busyReason: null });
        if (idleWait.since == null) idleWait.since = now();
        if (now() - idleWait.since >= idleMs) { doInstall(); return; }
      }
      idleWait.timer = setTimer(tick, idlePollMs);
    };
    tick();
  }

  // After a deferred 'now', keeps busyReason true until the sessions settle.
  function watchBusy() {
    stopBusyWatch();
    const tick = () => {
      busyWatch = null;
      if (idleWait || status !== 'ready' || !busyReason) return;
      const reason = isBusy();
      if (reason !== busyReason) set({ busyReason: reason });
      if (reason) busyWatch = setTimer(tick, idlePollMs);
    };
    busyWatch = setTimer(tick, idlePollMs);
  }

  // when: 'now' | 'idle'. 'now' while busy is deferred (busyReason says why)
  // unless force, which is the person saying "restart anyway".
  function install({ when = 'now', force = false } = {}) {
    if (when !== 'now' && when !== 'idle') return Promise.resolve({ ok: false, error: 'bad-when' });
    if (status !== 'ready' || !offer) return Promise.resolve({ ok: false, error: 'not-ready' });
    // Opening the system installer interrupts nobody.
    if (backend?.kind === 'deb-manual') return doInstall();
    if (when === 'idle') { waitForIdle(); return Promise.resolve({ ok: true, deferred: true }); }
    const reason = force ? null : isBusy();
    if (reason) { set({ busyReason: reason }); watchBusy(); return Promise.resolve({ ok: false, error: 'busy', deferred: true }); }
    return doInstall();
  }

  function setChannel(ch) {
    if (!V.CHANNELS.includes(ch)) return Promise.resolve({ ok: false, error: 'bad-channel' });
    if (status === 'downloading' || status === 'installing') return Promise.resolve({ ok: false, error: 'busy' });
    store.channelChosen = true;
    if (ch === store.channel) { save(); return Promise.resolve({ ok: true }); }
    store.channel = ch;
    save();
    stopIdleWait();
    stopBusyWatch();
    offer = null;
    set({ status: 'idle', available: null, error: null, progress: null, busyReason: null });
    // An in-flight check sees the new channel when it finishes and checks again.
    return check({ user: true });
  }

  function setAutoDownload(on) {
    store.autoDownload = !!on;
    save();
    emit();
    if (store.autoDownload && status === 'available') return download();
    return Promise.resolve({ ok: true });
  }

  // Back to the previous version: its own signed release, fetched, verified
  // and downloaded like any update, then "ready"; the person restarts for it
  // the same way. It holds the same in-flight slot as a check.
  function revert() {
    const s = getState();
    if (!s.canRevert) return Promise.resolve({ ok: false, error: 'no-previous' });
    if (checking || status === 'downloading' || status === 'installing') return Promise.resolve({ ok: false, error: 'busy' });
    stopIdleWait();
    stopBusyWatch();
    const channel = store.channel;
    checking = (async () => {
      set({ status: 'checking', error: null, progress: null });
      try {
        const found = await takeOffer(`${channelBase(channel)}${s.previousVersion}/release.json`, { channel, revertTo: s.previousVersion });
        offer = found.offer;
        available = found.available;
      } catch (err) {
        offer = null;
        return failWith(err, { available: null });
      }
      set({ status: 'available' });
      return download();
    })().finally(() => { checking = null; });
    return checking;
  }

  function setRequired(minVersion, hubName) {
    let need = null;
    try { if (minVersion && V.compareVersions(currentVersion, minVersion) < 0) need = { minVersion, hubName: hubName || null }; } catch { /* not a version: ignore */ }
    requiredByHub = need;
    emit();
    if (need && status === 'idle') return check();
    return Promise.resolve({ ok: true });
  }

  function start({ firstDelayMs = 30000, everyMs = FOUR_HOURS } = {}) {
    timers.push(setTimer(() => { check(); }, firstDelayMs), setRepeat(() => { check(); }, everyMs));
    for (const t of timers) t?.unref?.();
  }

  function stop() {
    stopIdleWait();
    stopBusyWatch();
    stopStallWatch();
    clearTimer(timers[0]);
    clearRepeat(timers[1]);
    timers = [];
  }

  // For Health's version check: { state: 'current' | 'available' | 'error' | 'unknown', version?, detail? }
  function healthStatus() {
    if (available && ['available', 'downloading', 'ready', 'installing'].includes(status)) return { state: 'available', version: available.version, detail: status === 'ready' ? 'Restart Plexiform to finish updating.' : undefined };
    if (status === 'error') return { state: 'error', detail: error?.detail || error?.code };
    if (store.lastCheckedAt) return { state: 'current', version: currentVersion };
    return { state: 'unknown', detail: 'not checked yet' };
  }

  return {
    getState, check, download, install, setChannel, setAutoDownload, revert, setRequired, start, stop, healthStatus,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

module.exports = { createService, STATUSES, FOUR_HOURS };
