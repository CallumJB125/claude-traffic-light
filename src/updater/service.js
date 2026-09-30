// The updater's state machine, one per app. No Electron here: the network
// (fetch), the platform back-end, the busy check and the clock are injected,
// so the tests drive it against a local fake feed.
//
//   idle → checking → available → downloading → ready → installing
//                  ↘ idle (up to date)       ↘ error (keeps `available`)
//
// Every manifest passes verify.js before anything is offered. It never
// restarts on its own: install({when:'now'}) while a session is working is
// deferred with busyReason set; install({when:'idle'}) waits for 30 s with
// nothing busy. Channel, autoDownload, and the last accepted issuedAt per
// channel persist in <userData>/updater.json.
const fs = require('fs');
const path = require('path');
const V = require('./verify.js');

const FOUR_HOURS = 4 * 3600000;
const MAX_SIG_BYTES = 1024;
const STATUSES = ['idle', 'checking', 'available', 'downloading', 'ready', 'installing', 'error'];

function toError(err) {
  if (err instanceof V.UpdateError) return { code: err.code, detail: err.detail };
  return { code: 'unknown', detail: String(err?.message || err).slice(0, 300) };
}

/**
 * opts: {
 *   fetch, keys (verify.loadKeys), feedBase ('https://download.plexiform.dev'),
 *   currentVersion, userData, backend (null: check only), isBusy () → reason|null,
 *   platform, arch, argv, now, setTimer, clearTimer, setRepeat, clearRepeat, log, retryDelayMs, idleMs, idlePollMs
 * }
 */
function createService(opts) {
  const {
    fetch, keys, feedBase, currentVersion, userData, backend = null, isBusy = () => null,
    platform = process.platform, arch = process.arch, argv = [], now = () => Date.now(),
    setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, clearRepeat = clearInterval, log = console,
    retryDelayMs = 2000, idleMs = 30000, idlePollMs = 5000,
  } = opts;
  const storePath = path.join(userData, 'updater.json');
  const store = { channel: /-beta\b/.test(currentVersion) ? 'beta' : 'stable', autoDownload: true, lastIssuedAt: {}, lastCheckedAt: null, lastRunVersion: null, previousVersion: null };
  try { Object.assign(store, JSON.parse(fs.readFileSync(storePath, 'utf8'))); } catch { /* first run */ }
  if (!V.CHANNELS.includes(store.channel)) store.channel = 'stable';
  if (store.lastRunVersion && store.lastRunVersion !== currentVersion) store.previousVersion = store.lastRunVersion;
  const from = argv.find((a) => a.startsWith('--updated-from='));
  if (from && V.parseVersion(from.slice(15))) store.previousVersion = from.slice(15);
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
  let timers = [];
  const listeners = new Set();

  if (argv.includes('--update-failed')) {
    status = 'error';
    error = { code: 'unknown', detail: 'The new version did not start, so Plexiform went back to this one.' };
  }

  const channelBase = (ch = store.channel) => `${feedBase.replace(/\/+$/, '')}${ch === 'beta' ? '/beta' : ''}/`;

  function getState() {
    const revert = backend?.revertInfo ? backend.revertInfo() : { canRevert: !!(backend?.canFetchRevert && store.previousVersion), previousVersion: store.previousVersion };
    return {
      status,
      currentVersion,
      channel: store.channel,
      autoDownload: store.autoDownload,
      lastCheckedAt: store.lastCheckedAt,
      available: available && { ...available },
      progress: progress && { ...progress },
      error: error && { ...error },
      canRevert: !!revert.canRevert,
      previousVersion: revert.previousVersion || null,
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
    emit();
  }
  const failWith = (err) => {
    const e = toError(err);
    log.warn?.(`[updater] ${e.code}: ${e.detail}`);
    set({ status: 'error', error: e, progress: null });
    return { ok: false, error: e.code };
  };

  async function get(url, limit) {
    let res;
    try {
      res = await fetch(url, { cache: 'no-store', redirect: 'follow' }); // privacy-flow: auto-update
    } catch (err) {
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
      throw new V.UpdateError('offline', `The update server stopped answering (${err?.message || err}).`);
    }
    return Buffer.concat(chunks);
  }

  // A promote copies release.json and its .sig one after the other, so a
  // check in between sees a mismatch; one retry rides that out.
  async function fetchManifest(url) {
    for (let tryNo = 0; ; tryNo++) {
      const [bytes, sig] = await Promise.all([get(url, 256 * 1024), get(`${url}.sig`, MAX_SIG_BYTES)]);
      try {
        return V.openManifest(bytes, sig.toString('utf8'), keys);
      } catch (err) {
        if (err.code !== 'signature' || tryNo > 0) throw err;
        await new Promise((r) => setTimer(r, retryDelayMs));
      }
    }
  }

  // Verifies url's manifest and makes it the offer. → true if there is one.
  async function takeOffer(manifestUrl, { revertTo = null } = {}) {
    const m = await fetchManifest(manifestUrl);
    const d = V.decide(m, { channel: store.channel, currentVersion, lastIssuedAt: store.lastIssuedAt[store.channel] || null, revertTo });
    if (!revertTo) {
      const last = store.lastIssuedAt[store.channel];
      if (!last || Date.parse(m.issuedAt) > Date.parse(last)) store.lastIssuedAt[store.channel] = m.issuedAt;
    }
    store.lastCheckedAt = new Date(now()).toISOString();
    save();
    if (!d.update) { offer = null; return false; }
    if (!backend) throw new V.UpdateError('unknown', 'This build cannot install updates (a development run).');
    const entry = V.pickFile(m, { platform, arch, kind: backend.fileKind });
    if (!entry) throw new V.UpdateError('server', `Release ${m.version} has no ${backend.fileKind} for ${platform} ${arch}.`);
    const url = new URL(entry.name, manifestUrl).href;
    await backend.prepare?.({ manifest: m, entry, manifestUrl, url, rollback: d.rollback });
    offer = { manifest: m, entry, manifestUrl, url, rollback: d.rollback };
    available = { version: m.version, notes: m.notes || '', size: entry.size, publishedAt: m.issuedAt };
    return true;
  }

  function preflightError() {
    const e = backend?.preflight?.();
    return e ? toError(e) : null;
  }

  async function runCheck() {
    set({ status: 'checking', error: null, progress: null });
    try {
      offer = null;
      available = null;
      if (!(await takeOffer(`${channelBase()}release.json`))) {
        set({ status: 'idle', available: null });
        return { ok: true };
      }
      const pre = preflightError();
      if (pre) { set({ status: 'error', error: pre }); return { ok: false, error: pre.code }; }
      set({ status: 'available' });
      if (store.autoDownload) return download();
      return { ok: true };
    } catch (err) {
      offer = null;
      available = null;
      return failWith(err);
    }
  }

  function check() {
    if (status === 'downloading' || status === 'installing' || status === 'ready') return Promise.resolve({ ok: true, skipped: status });
    if (!checking) checking = runCheck().finally(() => { checking = null; });
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

  async function doInstall() {
    stopIdleWait();
    set({ status: 'installing', busyReason: null });
    try {
      const r = await backend.install({ ...offer, currentVersion });
      // A .deb opens in the software installer; the app keeps running.
      if (r?.stay) set({ status: 'ready' });
      return { ok: true };
    } catch (err) {
      return failWith(err);
    }
  }

  function waitForIdle() {
    stopIdleWait();
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

  // when: 'now' | 'idle'. 'now' while busy is deferred (busyReason says why)
  // unless force, which is the person saying "restart anyway".
  function install({ when = 'now', force = false } = {}) {
    if (status !== 'ready' || !offer) return Promise.resolve({ ok: false, error: 'not-ready' });
    if (when === 'idle') { waitForIdle(); return Promise.resolve({ ok: true, deferred: true }); }
    if (when !== 'now') return Promise.resolve({ ok: false, error: 'bad-when' });
    const reason = force ? null : isBusy();
    if (reason) { set({ busyReason: reason }); return Promise.resolve({ ok: false, error: 'busy', deferred: true }); }
    return doInstall();
  }

  function setChannel(ch) {
    if (!V.CHANNELS.includes(ch)) return Promise.resolve({ ok: false, error: 'bad-channel' });
    if (status === 'downloading' || status === 'installing') return Promise.resolve({ ok: false, error: 'busy' });
    if (ch === store.channel) return Promise.resolve({ ok: true });
    store.channel = ch;
    save();
    stopIdleWait();
    offer = null;
    set({ status: 'idle', available: null, error: null, progress: null, busyReason: null });
    return check();
  }

  function setAutoDownload(on) {
    store.autoDownload = !!on;
    save();
    emit();
    if (store.autoDownload && status === 'available') return download();
    return Promise.resolve({ ok: true });
  }

  // Back to the previous version, verified like any update, then "ready":
  // the person restarts for it the same way.
  async function revert() {
    const s = getState();
    if (!s.canRevert) return { ok: false, error: 'no-previous' };
    if (status === 'downloading' || status === 'installing' || status === 'checking') return { ok: false, error: 'busy' };
    stopIdleWait();
    try {
      if (backend.revertLocal) {
        const { version } = await backend.revertLocal();
        offer = { manifest: null, entry: null, revert: true };
        set({ status: 'ready', error: null, progress: null, available: { version, notes: '', size: null, publishedAt: null } });
        return { ok: true };
      }
      set({ status: 'checking', error: null, progress: null });
      await takeOffer(`${channelBase()}${s.previousVersion}/release.json`, { revertTo: s.previousVersion });
      set({ status: 'available' });
      return download();
    } catch (err) {
      return failWith(err);
    }
  }

  function setRequired(minVersion, hubName) {
    let need = null;
    try { if (minVersion && V.compareVersions(currentVersion, minVersion) < 0) need = { minVersion, hubName: hubName || null }; } catch { /* not a version: ignore */ }
    requiredByHub = need;
    emit();
    if (need && status === 'idle') check();
  }

  function start({ firstDelayMs = 30000, everyMs = FOUR_HOURS } = {}) {
    timers.push(setTimer(() => { check(); }, firstDelayMs), setRepeat(() => { check(); }, everyMs));
    for (const t of timers) t?.unref?.();
  }

  function stop() {
    stopIdleWait();
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
