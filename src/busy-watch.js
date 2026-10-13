// Watches the busy sources (macOS Calendar through the bundled EventKit
// helper, an optional ICS feed, macOS Focus) and keeps the "While you were
// away" log. src/busy.js does the judging; this does the I/O, on a timer.
//
// Dev runs (tests, demos, shots) never touch a real source: no helper, no
// Focus files, no fetch, so no permission prompt can ever come from them.
// They read CLAUDE_BUDDY_FAKE_BUSY (a JSON file: {busy, reason}) instead.
const path = require('path');
const crypto = require('crypto');
const Busy = require('./busy.js');

const TICK_MS = 15 * 1000;
const CALENDAR_EVERY_MS = 60 * 1000;
const ICS_EVERY_MS = 10 * 60 * 1000;
// Recurring series are expanded once per fetch and then hourly, over a day
// either side; each tick only looks at the stored occurrences.
const ICS_EXPAND_EVERY_MS = 60 * 60 * 1000;
const ICS_TIMEOUT_MS = 20 * 1000;
const ICS_CACHE_VERSION = 2;
const FOCUS_SHORTCUT_EVERY_MS = 60 * 1000;
// A Focus reading survives this many failed polls in a row: one hiccup must
// not flip busy → unknown and back.
const FOCUS_GRACE_FAILS = 2;
const BACK_MS = 2 * 60 * 1000; // how long 'back-from-busy' holds after a busy spell
const RECAP_MS = 60 * 60 * 1000; // an undismissed recap goes stale after this
const ICS_MAX_BYTES = 5 * 1024 * 1024;
const ICS_MAX_REDIRECTS = 3;

// The feed URL is a secret (it grants read access to a calendar), so a
// redirect may never take it — or the response — off HTTPS.
async function fetchHttpsOnly(url, signal, fetchImpl = fetch) {
  let current = url;
  for (let hop = 0; hop <= ICS_MAX_REDIRECTS; hop += 1) {
    const res = await fetchImpl(current, { signal, redirect: 'manual' }); // privacy-flow: ics-feed
    if (!(res.status >= 300 && res.status < 400)) return res;
    const next = res.headers.get('location');
    if (!next) throw new Error(`HTTP ${res.status} without a location`);
    current = new URL(next, current).toString();
    if (!/^https:\/\//i.test(current)) throw new Error('redirected off HTTPS — refused');
  }
  throw new Error('too many redirects');
}

module.exports = function busyWatch(deps) {
  const {
    rootDir, helperPath, loadConfig, isDevRun, onChange = () => {}, log = () => {},
    exec, readFile, writeFile, removeFile = () => {}, exists, fetch, home,
    now = () => Date.now(), fakeFile = null, tickMs = TICK_MS,
  } = deps;
  const ICS_CACHE = path.join(rootDir, 'busy-ics-cache.json');
  const AWAY_FILE = path.join(rootDir, 'away.json');
  // Set once calendar access has been seen granted. A later notDetermined
  // then means macOS forgot the grant (an ad-hoc signed update does that),
  // not that you never gave it.
  const GRANTED_MARKER = path.join(rootDir, '.calendar-granted');
  const DND_DIR = path.join(home, 'Library', 'DoNotDisturb', 'DB');

  const cal = { status: null, occurrences: [], fetchedAt: 0, error: null, reset: false };
  const ics = { url: null, key: null, titles: false, events: [], occurrences: [], expandedAt: 0, fetchedAt: 0, error: null, fetching: false };
  const focus = { via: null, reading: { focused: false, mode: null }, error: null, shortcutAt: 0, running: false, fails: 0 };
  let combined = { busy: null, reasons: [], until: null };
  let away = null;
  let recap = null;
  let backUntil = 0;
  let timer = null;
  let asking = null;

  // ── Calendar (EventKit helper) ────────────────────────────────────────────
  async function helper(args, timeout = 10000) {
    const out = await exec(helperPath, args, timeout);
    return JSON.parse(String(out || '').trim().split('\n').pop());
  }

  async function refreshCalendar(config, t) {
    if (!config.busyCalendar) { cal.status = null; cal.occurrences = []; return; }
    if (!exists(helperPath)) { cal.status = 'missing'; return; }
    if (cal.fetchedAt && t - cal.fetchedAt < CALENDAR_EVERY_MS) return;
    cal.fetchedAt = t;
    if (asking) { cal.status = 'notDetermined'; return; }
    try {
      // One spawn per poll: `events` never prompts and reports the permission
      // it found alongside the events (or instead of them).
      const args = ['events', String(t - 6 * 3600000), String(t + 24 * 3600000)];
      if (config.busyCalendarTitles) args.push('--titles');
      const r = await helper(args);
      cal.status = r.status || null;
      cal.error = r.error && r.error !== 'not-authorized' ? r.error : null;
      if (cal.status === 'fullAccess') {
        cal.reset = false;
        if (!exists(GRANTED_MARKER)) writeFile(GRANTED_MARKER, new Date(t).toISOString());
      } else if (cal.status === 'notDetermined' && exists(GRANTED_MARKER) && !cal.reset) {
        cal.reset = true;
        log('[busy] calendar access was granted before and is gone now; Settings offers Reconnect');
      }
      cal.occurrences = cal.status === 'fullAccess' && Array.isArray(r.events) ? r.events : [];
    } catch (e) {
      cal.error = e.message;
      log('[busy] calendar helper failed:', e.message);
    }
  }

  // The EventKit prompt, only ever from a click on Settings' calendar
  // tick-box: turning the source on is the consent, so first launch after an
  // update never shows a system dialog. macOS itself shows it at most once.
  async function enableCalendar() {
    if (isDevRun || !exists(helperPath)) return;
    if (!asking) {
      asking = (async () => {
        try {
          if ((await helper(['status'])).status === 'notDetermined') {
            log('[busy] asking for calendar access');
            await helper(['request'], 130000);
          }
        } catch (e) {
          cal.error = e.message;
          log('[busy] calendar request failed:', e.message);
        } finally {
          asking = null;
        }
      })();
    }
    await asking;
    cal.fetchedAt = 0;
    await tick();
  }

  // ── ICS feed ──────────────────────────────────────────────────────────────
  // https only (webcal:// is https in disguise): the secret address travels
  // in the URL, and a plain-http feed would hand it to the network.
  function icsUrl(config) {
    const u = String(config.busyIcsUrl || '').trim().replace(/^webcals?:\/\//i, 'https://');
    return /^https:\/\/\S+$/i.test(u) ? u : null;
  }
  const urlKey = (url) => crypto.createHash('sha256').update(url).digest('hex');

  // The body, refused past ICS_MAX_BYTES before it is all in memory.
  async function readCapped(res) {
    const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
    if (declared > ICS_MAX_BYTES) throw new Error('feed is over 5 MB');
    if (!res.body || typeof res.body.getReader !== 'function') {
      const text = await res.text();
      if (text.length > ICS_MAX_BYTES) throw new Error('feed is over 5 MB');
      return text;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ICS_MAX_BYTES) { try { await reader.cancel(); } catch { /* already closed */ } throw new Error('feed is over 5 MB'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  function expandIcs(t) {
    ics.occurrences = Busy.expandICS(ics.events, t - 86400000, t + 86400000, { titles: ics.titles });
    ics.expandedAt = t;
  }

  async function refreshIcs(config, t) {
    const url = icsUrl(config);
    const titles = !!config.busyCalendarTitles;
    if (url !== ics.url || titles !== ics.titles) {
      Object.assign(ics, { url, key: url ? urlKey(url) : null, titles, fetchedAt: 0, events: [], occurrences: [], expandedAt: 0, error: null });
      if (url) loadIcsCache(t);
    }
    if (!url) return;
    if (ics.fetching || (ics.fetchedAt && t - ics.fetchedAt < ICS_EVERY_MS)) {
      if (ics.expandedAt && t - ics.expandedAt >= ICS_EXPAND_EVERY_MS) expandIcs(t);
      return;
    }
    ics.fetching = true;
    ics.fetchedAt = t;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), ICS_TIMEOUT_MS);
    try {
      const res = await fetchHttpsOnly(url, abort.signal, fetch); // privacy-flow: ics-feed
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await readCapped(res);
      if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('not a calendar feed');
      ics.events = Busy.parseICS(text, { titles });
      ics.error = null;
      expandIcs(t);
      // Only what decides busy/free (plus titles when opted in): no
      // descriptions, attendees, locations or the secret URL on disk.
      writeFile(ICS_CACHE, JSON.stringify({ v: ICS_CACHE_VERSION, key: ics.key, titles, events: ics.events }));
    } catch (e) {
      // Keep the last good copy: a flaky network shouldn't make you "free".
      ics.error = abort.signal.aborted ? 'timed out' : e.message;
      if (ics.expandedAt && t - ics.expandedAt >= ICS_EXPAND_EVERY_MS) expandIcs(t);
      log('[busy] ICS fetch failed:', ics.error);
    } finally {
      clearTimeout(timer);
      ics.fetching = false;
    }
  }
  // Only the cache of this very feed: a changed URL must not inherit the old one's events.
  function loadIcsCache(t) {
    try {
      const c = JSON.parse(readFile(ICS_CACHE));
      // The first cache format kept the raw feed and its URL: don't leave that lying around.
      if (c.v !== ICS_CACHE_VERSION) { removeFile(ICS_CACHE); return; }
      if (c.key !== ics.key || !Array.isArray(c.events)) return;
      ics.events = c.titles && !ics.titles ? c.events.map(({ title, ...ev }) => ev) : c.events;
      expandIcs(t);
    } catch { /* no cache yet */ }
  }

  // ── Focus ─────────────────────────────────────────────────────────────────
  // Assertions.json first (free when readable; macOS guards it behind Full
  // Disk Access on most setups, and Buddy never asks for that). Otherwise a
  // Shortcut the user made that prints the current Focus.
  function focusOk(via, reading) {
    focus.via = via;
    focus.reading = reading;
    focus.error = null;
    focus.fails = 0;
  }
  // A failed poll keeps the last good reading for FOCUS_GRACE_FAILS polls.
  function focusFailed(error) {
    focus.error = error;
    focus.fails += 1;
    if (focus.fails > FOCUS_GRACE_FAILS || !focus.via) { focus.via = null; focus.reading = { focused: false, mode: null }; }
  }

  async function refreshFocus(config, t) {
    if (!config.busyFocus) { focus.via = null; focus.reading = { focused: false, mode: null }; focus.fails = 0; return; }
    let fileError;
    try {
      const text = readFile(path.join(DND_DIR, 'Assertions.json'));
      let modes = null;
      try { modes = readFile(path.join(DND_DIR, 'ModeConfigurations.json')); } catch { /* names are optional */ }
      const reading = Busy.parseFocusAssertions(text, modes);
      if (!reading.error) { focusOk('assertions', reading); return; }
      fileError = 'unreadable';
    } catch (e) {
      fileError = e.code === 'EPERM' || e.code === 'EACCES' ? 'no-access' : e.code === 'ENOENT' ? 'no-file' : e.message;
    }
    const name = String(config.busyFocusShortcut || '').trim();
    if (!name) { focusFailed(fileError); return; }
    // Between Shortcut runs the last reading stands.
    if (focus.running || (focus.shortcutAt && t - focus.shortcutAt < FOCUS_SHORTCUT_EVERY_MS)) return;
    focus.running = true;
    focus.shortcutAt = t;
    try {
      // `--` so a name starting with a dash is a name, not an option.
      focusOk('shortcut', Busy.parseFocusShortcut(await exec('/usr/bin/shortcuts', ['run', '--', name], 15000)));
    } catch (e) {
      focusFailed(`shortcut: ${e.message}`);
    } finally {
      focus.running = false;
    }
  }

  function readFake() {
    try { return JSON.parse(readFile(fakeFile)); } catch { return null; }
  }

  function readings(config, t) {
    if (isDevRun) {
      const f = fakeFile ? readFake() : null;
      return f ? { fake: { on: true, busy: !!f.busy, until: f.until || null, mode: f.reason || null } } : {};
    }
    const out = {};
    if (config.busyCalendar && cal.status === 'fullAccess') out.calendar = { on: true, ...Busy.busyAt(cal.occurrences, t) };
    if (ics.url && (ics.events.length || !ics.error)) out.ics = { on: true, ...Busy.busyAt(ics.occurrences, t) };
    if (config.busyFocus && focus.via) out.focus = { on: true, busy: !!focus.reading.focused, mode: focus.reading.mode };
    return out;
  }

  async function tick() {
    const config = loadConfig();
    const t = now();
    if (!isDevRun) {
      await Promise.all([refreshCalendar(config, t), refreshIcs(config, t), refreshFocus(config, t)]);
    }
    const next = Busy.combine(readings(config, t));
    const changed = next.busy !== combined.busy || next.reasons.join() !== combined.reasons.join();
    combined = next;
    if (changed) {
      // Source names only: a meeting's title never goes to the log.
      log(`[busy] ${next.busy === null ? 'no sources' : next.busy ? `busy (${next.reasons.map((r) => r.split(':')[0]).join(', ')})` : 'free'}`);
      onChange();
    }
  }

  // ── While you were away ───────────────────────────────────────────────────
  // Called on every status broadcast with the live sessions. Returns the
  // recap when a busy spell has just ended with something in it.
  function observe(sessions) {
    const t = now();
    const holding = combined.busy === true && loadConfig().busyHold !== false;
    if (holding) {
      if (!away) away = Busy.startAway(t, combined.reasons, sessions);
      else Busy.noteAway(away, sessions, t);
      return null;
    }
    if (!away) return null;
    const done = Busy.finishAway(away, t, sessions);
    away = null;
    backUntil = t + BACK_MS;
    if (!done.items.length && !done.held) return null;
    recap = done;
    try { writeFile(AWAY_FILE, JSON.stringify(recap, null, 2)); } catch (e) { log('[busy] could not write away.json:', e.message); }
    return recap;
  }

  function clearRecap() {
    recap = null;
    try { removeFile(AWAY_FILE); } catch { /* already gone */ }
  }
  function currentRecap() {
    if (recap && now() - recap.to > RECAP_MS) clearRecap();
    return recap;
  }

  return {
    start() {
      if (timer) return;
      tick().catch((e) => log('[busy] tick failed:', e.message));
      timer = setInterval(() => tick().catch((e) => log('[busy] tick failed:', e.message)), tickMs);
    },
    stop() { clearInterval(timer); timer = null; },
    tick,
    enableCalendar,
    helperAvailable: () => !isDevRun && !!exists(helperPath),
    observe,
    // Only while pings are actually being held does the rest of the app act busy.
    holding: () => combined.busy === true && loadConfig().busyHold !== false,
    env: () => ({ busy: combined.busy, backFromBusy: now() < backUntil }),
    // rule: the name of the rule whose ping waited; signal: what it was for.
    noteHeld(rule, signal) { if (away) Busy.noteHeld(away, { rule, signal }, now()); },
    recap: currentRecap,
    dismiss: clearRecap,
    status() {
      const config = loadConfig();
      return {
        busy: combined.busy, reasons: combined.reasons, until: combined.until,
        calendar: { on: !!config.busyCalendar, status: cal.status, reset: cal.reset, error: cal.error, next: cal.status === 'fullAccess' ? Busy.nextBusy(cal.occurrences, now()) : null },
        ics: { on: !!ics.url, events: ics.events.length, error: ics.error, fetchedAt: ics.fetchedAt || null },
        focus: { on: !!config.busyFocus, via: focus.via, focused: !!focus.reading.focused, mode: focus.reading.mode, error: focus.error },
      };
    },
  };
};

module.exports.BACK_MS = BACK_MS;
module.exports.fetchHttpsOnly = fetchHttpsOnly;
