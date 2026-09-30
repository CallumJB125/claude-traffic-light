// Watches the busy sources (macOS Calendar through the bundled EventKit
// helper, an optional ICS feed, macOS Focus) and keeps the "While you were
// away" log. src/busy.js does the judging; this does the I/O, on a timer.
//
// Dev runs (tests, demos, shots) never touch a real source: no helper, no
// Focus files, no fetch, so no permission prompt can ever come from them.
// They read CLAUDE_BUDDY_FAKE_BUSY (a JSON file: {busy, reason}) instead.
const path = require('path');
const Busy = require('./busy.js');

const TICK_MS = 15 * 1000;
const CALENDAR_EVERY_MS = 60 * 1000;
const ICS_EVERY_MS = 10 * 60 * 1000;
const FOCUS_SHORTCUT_EVERY_MS = 30 * 1000;
const BACK_MS = 2 * 60 * 1000; // how long 'back-from-busy' holds after a busy spell
const RECAP_MS = 60 * 60 * 1000; // an undismissed recap goes stale after this
const ICS_MAX_BYTES = 5 * 1024 * 1024;

module.exports = function busyWatch(deps) {
  const {
    rootDir, helperPath, loadConfig, isDevRun, onChange = () => {}, log = () => {},
    exec, readFile, writeFile, exists, fetch, home,
    now = () => Date.now(), fakeFile = null, tickMs = TICK_MS,
  } = deps;
  const ASKED_MARKER = path.join(rootDir, '.calendar-asked');
  const ICS_CACHE = path.join(rootDir, 'busy-ics-cache.json');
  const AWAY_FILE = path.join(rootDir, 'away.json');
  const DND_DIR = path.join(home, 'Library', 'DoNotDisturb', 'DB');

  const cal = { status: null, occurrences: [], fetchedAt: 0, error: null };
  const ics = { url: null, events: [], fetchedAt: 0, error: null, fetching: false };
  const focus = { via: null, reading: { focused: false, mode: null }, error: null, shortcutAt: 0, running: false };
  let combined = { busy: null, reasons: [], until: null };
  let away = null;
  let recap = null;
  let backUntil = 0;
  let timer = null;

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
    try {
      let st = (await helper(['status'])).status;
      // The one-time ask: only ever once per install, so turning it down sticks.
      if (st === 'notDetermined' && !exists(ASKED_MARKER)) {
        writeFile(ASKED_MARKER, new Date(t).toISOString());
        log('[busy] asking for calendar access');
        st = (await helper(['request'], 130000)).status;
      }
      cal.status = st;
      if (st !== 'fullAccess') { cal.occurrences = []; return; }
      const args = ['events', String(t - 6 * 3600000), String(t + 24 * 3600000)];
      if (config.busyCalendarTitles) args.push('--titles');
      const r = await helper(args);
      cal.occurrences = Array.isArray(r.events) ? r.events : [];
      cal.error = r.error || null;
    } catch (e) {
      cal.error = e.message;
      log('[busy] calendar helper failed:', e.message);
    }
  }

  // ── ICS feed ──────────────────────────────────────────────────────────────
  function icsUrl(config) {
    const u = String(config.busyIcsUrl || '').trim().replace(/^webcals?:\/\//i, 'https://');
    return /^https?:\/\/\S+$/i.test(u) ? u : null;
  }

  async function refreshIcs(config, t) {
    const url = icsUrl(config);
    if (url !== ics.url) { ics.url = url; ics.fetchedAt = 0; ics.events = []; ics.error = null; if (url) loadIcsCache(); }
    if (!url || ics.fetching || (ics.fetchedAt && t - ics.fetchedAt < ICS_EVERY_MS)) return;
    ics.fetching = true;
    ics.fetchedAt = t;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > ICS_MAX_BYTES) throw new Error('feed is over 5 MB');
      if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('not a calendar feed');
      ics.events = Busy.parseICS(text);
      ics.error = null;
      writeFile(ICS_CACHE, JSON.stringify({ url, text }));
    } catch (e) {
      // Keep the last good copy: a flaky network shouldn't make you "free".
      ics.error = e.message;
      log('[busy] ICS fetch failed:', e.message);
    } finally {
      ics.fetching = false;
    }
  }
  // Only the cache of this very feed: a changed URL must not inherit the old one's events.
  function loadIcsCache() {
    try { const c = JSON.parse(readFile(ICS_CACHE)); if (c.url === ics.url) ics.events = Busy.parseICS(c.text); } catch { /* no cache yet */ }
  }

  // ── Focus ─────────────────────────────────────────────────────────────────
  // Assertions.json first (free when readable; macOS guards it behind Full
  // Disk Access on most setups, and Buddy never asks for that). Otherwise a
  // Shortcut the user made that prints the current Focus.
  async function refreshFocus(config, t) {
    if (!config.busyFocus) { focus.via = null; focus.reading = { focused: false, mode: null }; return; }
    try {
      const text = readFile(path.join(DND_DIR, 'Assertions.json'));
      let modes = null;
      try { modes = readFile(path.join(DND_DIR, 'ModeConfigurations.json')); } catch { /* names are optional */ }
      focus.reading = Busy.parseFocusAssertions(text, modes);
      focus.via = 'assertions';
      focus.error = null;
      return;
    } catch (e) {
      focus.error = e.code === 'EPERM' || e.code === 'EACCES' ? 'no-access' : e.code === 'ENOENT' ? 'no-file' : e.message;
    }
    const name = String(config.busyFocusShortcut || '').trim();
    if (!name) { focus.via = null; return; }
    if (focus.running || (focus.shortcutAt && t - focus.shortcutAt < FOCUS_SHORTCUT_EVERY_MS)) return;
    focus.running = true;
    focus.shortcutAt = t;
    try {
      focus.reading = Busy.parseFocusShortcut(await exec('/usr/bin/shortcuts', ['run', name], 15000));
      focus.via = 'shortcut';
      focus.error = null;
    } catch (e) {
      focus.via = null;
      focus.error = `shortcut: ${e.message}`;
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
    if (ics.url && (ics.events.length || !ics.error)) out.ics = { on: true, ...Busy.busyAt(Busy.expandICS(ics.events, t - 86400000, t + 86400000, { titles: !!config.busyCalendarTitles }), t) };
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
      log(`[busy] ${next.busy === null ? 'no sources' : next.busy ? `busy (${next.reasons.join(', ')})` : 'free'}`);
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
    if (!done.items.length) return null;
    recap = done;
    try { writeFile(AWAY_FILE, JSON.stringify(recap, null, 2)); } catch (e) { log('[busy] could not write away.json:', e.message); }
    return recap;
  }

  function currentRecap() {
    if (recap && now() - recap.to > RECAP_MS) recap = null;
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
    observe,
    // Only while pings are actually being held does the rest of the app act busy.
    holding: () => combined.busy === true && loadConfig().busyHold !== false,
    env: () => ({ busy: combined.busy, backFromBusy: now() < backUntil }),
    noteHeld() { if (away) away.held = (away.held || 0) + 1; },
    recap: currentRecap,
    dismiss() { recap = null; },
    status() {
      const config = loadConfig();
      return {
        busy: combined.busy, reasons: combined.reasons, until: combined.until,
        calendar: { on: !!config.busyCalendar, status: cal.status, error: cal.error, next: cal.status === 'fullAccess' ? Busy.nextBusy(cal.occurrences, now()) : null },
        ics: { on: !!ics.url, events: ics.events.length, error: ics.error, fetchedAt: ics.fetchedAt || null },
        focus: { on: !!config.busyFocus, via: focus.via, focused: !!focus.reading.focused, mode: focus.reading.mode, error: focus.error },
      };
    },
  };
};

module.exports.BACK_MS = BACK_MS;
