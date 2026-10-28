'use strict';
// QoL4b: what Plexiform knows about its access to your terminals, read without ever bringing up a macOS prompt.
//
// macOS answers two things without asking: whether an app is installed (its bundle is on disk) and whether Plexiform
// is trusted for Accessibility (systemPreferences.isTrustedAccessibilityClient(false)). Automation of one app can't be
// read without a prompt from here (only the native AEDeterminePermissionToAutomateTarget can), so for the four apps
// that need it this shows what Plexiform last saw when it scripted them: allowed when a jump worked, turned off when
// macOS refused (-1743). That is history, and it says so, with the date (review B4-S1). The one path that can bring up
// the prompt is the Test button, run only on the person's click, only while the app is already running (checked by
// main before any script, review B4-M1), and never offered once macOS has refused, because macOS won't ask again
// (B4-S3).

const MIN_TEST_GAP_MS = 2000;
const TEST_TIMEOUT_MS = 30000; // src/focus/index.js PROMPT_TIMEOUT_MS: long enough to answer the prompt

// The apps whose tab-switching needs Automation (src/focus/*.js `needs`), by the name their adapters use.
const AUTOMATION = Object.freeze({
  Terminal: { bundle: 'com.apple.Terminal', paths: ['/System/Applications/Utilities/Terminal.app', '/Applications/Utilities/Terminal.app'] },
  iTerm2: { bundle: 'com.googlecode.iterm2', paths: ['/Applications/iTerm.app', '~/Applications/iTerm.app'] },
  Ghostty: { bundle: 'com.mitchellh.ghostty', paths: ['/Applications/Ghostty.app', '~/Applications/Ghostty.app'] },
  'Ghostty Dock': { bundle: 'consulting.cloudscale.ghosttydock', paths: [] }, // found by src/ghostty-dock.js, passed in
});
// Terminals Plexiform switches to with no permission at all.
const NO_PERMISSION = Object.freeze({
  kitty: ['/Applications/kitty.app', '~/Applications/kitty.app'],
  WezTerm: ['/Applications/WezTerm.app', '~/Applications/WezTerm.app'],
});
const AUTOMATION_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation';
const ACCESSIBILITY_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

const known = (app) => typeof app === 'string' && Object.hasOwn(AUTOMATION, app);
const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

/** The seen map, cleaned: only the four names, only allowed/denied with a finite time. */
function cleanSeen(file) {
  const apps = plain(file) && plain(file.apps) ? file.apps : {};
  const out = {};
  for (const app of Object.keys(AUTOMATION)) {
    const s = Object.hasOwn(apps, app) ? apps[app] : null;
    if (plain(s) && (s.state === 'allowed' || s.state === 'denied') && Number.isFinite(s.at)) out[app] = { state: s.state, at: s.at };
  }
  return out;
}

const day = (at) => { try { return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); } catch { return ''; } };

/**
 * One row per installed terminal, then Accessibility. installed(app) → bool (prompt-free: files on disk);
 * trusted → bool from isTrustedAccessibilityClient(false); seen: cleanSeen output.
 * → [{app, needs, state, text, fix, actions: ['test'?, 'open-settings'?]}]
 */
function view({ installed, trusted, seen }) {
  const rows = [];
  for (const app of Object.keys(AUTOMATION)) {
    if (!installed(app)) continue;
    const s = seen[app];
    const fix = `Open Privacy & Security › Automation and turn on ${app} under Plexiform.`;
    if (s && s.state === 'denied') rows.push({ app, needs: 'automation', state: 'denied', text: `Turned off when last tried (${day(s.at)}).`, fix, actions: ['open-settings'] });
    else if (s && s.state === 'allowed') rows.push({ app, needs: 'automation', state: 'allowed', text: `Allowed when last used (${day(s.at)}).`, fix: '', actions: ['test', 'open-settings'] });
    else rows.push({ app, needs: 'automation', state: 'unknown', text: 'Not asked yet. macOS asks the first time you click one of its sessions, or when you press Test.', fix: '', actions: ['test', 'open-settings'] });
  }
  for (const app of Object.keys(NO_PERMISSION)) {
    if (installed(app)) rows.push({ app, needs: 'none', state: 'not-needed', text: 'Needs no permission.', fix: '', actions: [] });
  }
  rows.push(trusted
    ? { app: 'Accessibility', needs: 'accessibility', state: 'allowed', text: 'Allowed. Used only to bring a terminal window forward when a click has no session to go to.', fix: '', actions: [] }
    : { app: 'Accessibility', needs: 'accessibility', state: 'off', text: 'Off. Only needed to bring a terminal window forward when a click has no session to go to.', fix: 'Open Privacy & Security › Accessibility and turn on Plexiform.', actions: ['open-settings'] });
  return rows;
}

/** Health: a warning only when an Automation app is turned off (review Q2: not for Accessibility). */
function healthRow(rows) {
  const off = rows.filter((r) => r.needs === 'automation' && r.state === 'denied').map((r) => r.app);
  if (!off.length) return null;
  return { status: 'warn', detail: `Plexiform can't switch to the exact tab in ${off.join(' or ')}: macOS has turned that off.`, fix: 'terminal-access-open', fixLabel: 'Open Terminal settings' };
}

/**
 * The store and the one prompting path. deps:
 *   read() / write(obj): terminal-access.json; now();
 *   running(bundleId) → Promise<bool>: is it running, asked without a prompt (lsappinfo, no shell);
 *   script(bundleId, timeoutMs) → Promise<{ok, stderr, timedOut}>: the read-only test script.
 */
function createStore({ read, write, now = Date.now, running, script }) {
  let seen = null;
  let lastTest = -Infinity;
  const current = () => {
    if (seen === null) { let f = null; try { f = read(); } catch { f = null; } seen = cleanSeen(f); }
    return seen;
  };
  function record(app, state) {
    if (!known(app) || (state !== 'allowed' && state !== 'denied')) return false;
    seen = { ...current(), [app]: { state, at: now() } };
    try { write({ v: 1, apps: seen }); } catch { /* kept for this run */ }
    return true;
  }
  async function test(app) {
    if (!known(app)) return { ok: false, note: '' };
    const t = now();
    if (t - lastTest < MIN_TEST_GAP_MS) return { ok: false, note: '' };
    lastTest = t;
    if (current()[app]?.state === 'denied') return { ok: false, note: `macOS won't ask again. Open Privacy & Security › Automation and turn on ${app} under Plexiform.` };
    const bundle = AUTOMATION[app].bundle;
    let up = false;
    try { up = (await running(bundle)) === true; } catch { up = false; }
    if (!up) return { ok: false, note: `Open ${app} first, then press Test.` };
    let r;
    try { r = await script(bundle, TEST_TIMEOUT_MS); } catch (e) { r = { ok: false, stderr: e.message }; }
    if (r && r.ok) { record(app, 'allowed'); return { ok: true, note: `Plexiform can switch to ${app} tabs.` }; }
    if (r && /-1743/.test(r.stderr || '')) { record(app, 'denied'); return { ok: false, note: `macOS turned it off. Open Privacy & Security › Automation and turn on ${app} under Plexiform.` }; }
    if (r && r.timedOut) return { ok: false, note: 'No answer in 30 seconds. If macOS asked, choose OK, then press Test again.' };
    return { ok: false, note: `Couldn't test ${app}. Try again in a moment.` };
  }
  return { record, test, seen: () => ({ ...current() }) };
}

/** The test script: a read-only count, addressed by bundle id so no app is looked up by name. */
const testScript = (bundle) => `tell application id "${bundle}" to count windows`;

/** lsappinfo's answer for one bundle: running when it names a pid. */
const runningFrom = (stdout) => /"pid"\s*=\s*\d+/.test(String(stdout || ''));

module.exports = { AUTOMATION, NO_PERMISSION, AUTOMATION_URL, ACCESSIBILITY_URL, MIN_TEST_GAP_MS, TEST_TIMEOUT_MS, known, cleanSeen, view, healthRow, createStore, testScript, runningFrom };
