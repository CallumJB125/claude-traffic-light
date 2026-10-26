'use strict';

// Main-process owner of the login-shell values the Claude carry needs (PR 2b, C2/N1). Reads the allowlisted names
// from the user's login shell once, in the background (never blocking startup; a spawn before it resolves uses the
// app's own env), keeps them in memory, and tells subscribers (the Tasks helper, the team runners, over their
// parentPort) when they change. A timeout or failure leaves no values, so every site falls back to the app env.
// Values are never logged: only fixed reason codes.
const { CLAUDE_READ_NAMES } = require('../board/shared/user-provider.cjs');
const { LOGIN_ENV_MESSAGE } = require('../board/shared/login-env-store.cjs');
const { codexLoginNames } = require('../board/shared/codex-carry.cjs');

// What the Claude carry asks for (board/shared/claude-carry.cjs resolveWith).
const CARRY_NAMES = Object.freeze([...CLAUDE_READ_NAMES, 'CLAUDE_CODE_OAUTH_TOKEN']);

// What the Claude and Codex carries ask for (PR 3). A Codex env_key is any name the user picked, so the set is
// read from the Codex config in the CODEX_HOME that applies: the app's, or (second pass) the login shell's.
// loginValues: what the login shell gave so far (null before the first read). Names only, never values.
function carryNames(loginValues, { env = process.env, home, readFile } = {}) {
  let codex = [];
  try { codex = codexLoginNames({ env, loginEnv: loginValues ?? {}, ...(home ? { home } : {}), ...(readFile ? { readFile } : {}) }); } catch { codex = []; }
  return [...new Set([...CARRY_NAMES, ...codex])];
}

// Only whether the OAuth token is set is ever needed (the carry words an auth failure differently), so the value
// itself never leaves the reader: it becomes '1'.
const PRESENCE_ONLY = 'CLAUDE_CODE_OAUTH_TOKEN';
const FIRST_READ_WAIT_MS = 5000;   // the reader's own timeout is 4 s
const FOCUS_MIN_MS = 60_000;

function createLoginEnvHub({ read, invalidate = () => {}, names = CARRY_NAMES, log = () => {}, debounceMs = 1500, setTimer = setTimeout, clearTimer = clearTimeout, firstReadWaitMs = FIRST_READ_WAIT_MS, focusMinMs = FOCUS_MIN_MS, now = Date.now } = {}) {
  // null = not read yet; {} = read, nothing there (or it failed): the two must stay apart.
  let values = null;
  let settled = false;
  let settle;
  const firstRead = new Promise((r) => { settle = r; });
  let lastFocus = -Infinity;
  let seq = 0;
  let timer = null;
  const subscribers = new Set();
  const publish = () => { for (const fn of [...subscribers]) { try { fn(values); } catch { /* a subscriber's error is its own */ } } };

  // names: a fixed list, or (loginValues) => list for names that depend on what the login shell says (carryNames).
  const namesFor = (lv) => { try { const n = typeof names === 'function' ? names(lv) : names; return Array.isArray(n) ? n : CARRY_NAMES; } catch { return CARRY_NAMES; } };
  const good = (r) => !!r && r.ok === true && r.env && typeof r.env === 'object';

  async function refresh() {
    const mine = ++seq;
    let res;
    const asked = namesFor(null);
    try { res = await read({ names: asked }); } catch { res = null; }
    // A login-shell CODEX_HOME can point at a config naming other variables: one more read, only then.
    if (good(res) && typeof names === 'function') {
      const more = namesFor(res.env).filter((n) => !asked.includes(n));
      if (more.length) {
        let again;
        try { again = await read({ names: [...asked, ...more] }); } catch { again = null; }
        if (good(again)) res = again;
      }
    }
    if (mine !== seq) return values;   // a newer refresh is in flight
    const ok = good(res);
    const env = ok ? { ...res.env } : {};
    if (typeof env[PRESENCE_ONLY] === 'string') { if (env[PRESENCE_ONLY] !== '') env[PRESENCE_ONLY] = '1'; else delete env[PRESENCE_ONLY]; }
    const next = Object.freeze(env);
    if (!ok) log(`login shell env unavailable (${typeof res?.reason === 'string' ? res.reason.slice(0, 32) : 'failed'})`);
    const changed = JSON.stringify(next) !== JSON.stringify(values);
    values = next;
    settled = true; settle();
    if (changed) publish();
    return values;
  }

  return {
    refresh,
    /** The current snapshot: null until the first read settles, then {} if nothing was found or it failed. */
    values: () => values,
    /** A refresh from an app focus: at most one a minute (a failed read is not cached by the reader). */
    focus() {
      if (now() - lastFocus < focusMinMs) return Promise.resolve(values);
      lastFocus = now();
      return refresh();
    },
    /** The setLoginShellEnv seam of src/claude-carry.js: waits (bounded) for the first read, so a spawn in the first
     *  seconds gets the login-shell gateway; after that, a snapshot filtered to the names asked for. */
    read: async ({ names: asked } = {}) => {
      if (!settled) {
        let t;
        await Promise.race([firstRead, new Promise((r) => { t = setTimer(r, firstReadWaitMs); })]);
        clearTimer(t);
        if (!settled) { values = Object.freeze({}); settled = true; settle(); }   // gave up: the app env decides from now on
      }
      const want = new Set(Array.isArray(asked) ? asked : []);
      return Object.fromEntries(Object.entries(values ?? {}).filter(([k]) => want.has(k)));
    },
    /** A provider or settings change: forget the reader's cache and read again (debounced; one shell start). */
    invalidate() {
      invalidate();
      if (timer) clearTimer(timer);
      timer = setTimer(() => { timer = null; refresh().catch(() => {}); }, debounceMs);
      timer.unref?.();
    },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    stop() { if (timer) clearTimer(timer); timer = null; subscribers.clear(); },
  };
}

/** The message a helper process gets: the values only, as an own plain object. */
const loginEnvMessage = (values) => ({ type: LOGIN_ENV_MESSAGE, values: { ...values } });

module.exports = { createLoginEnvHub, loginEnvMessage, carryNames, CARRY_NAMES };
