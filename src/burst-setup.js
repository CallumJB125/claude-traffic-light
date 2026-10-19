'use strict';

// Guided Burst setup as a pure state machine: install → trust → enable → check.
// Nothing here talks to Burst or the Mac. `next(state, probe)` reads what the
// client already found (detect, consoleDetect, upgrade-status, mod-status) and
// gives each step its status, the one thing it changes on the Mac (from Burst's
// README, "What it changes on your Mac") and at most one primary action. Main
// marks a step as started after a consent dialog; a started step that the
// probe never confirms within TIMEOUT_MS fails with a Retry.

const { MIN_VERSION } = require('./burst-view.js');

const TIMEOUT_MS = 120000;
const STEPS = Object.freeze(['install', 'trust', 'enable', 'check']);
const MODES = Object.freeze(['base-url', 'transparent']);

const TITLES = Object.freeze({ install: 'Install Burst', trust: 'Trust Burst on this Mac', enable: 'Turn Burst on', check: 'First check' });

// Each line is one row of the README table, in the step that makes that change.
const CHANGES = Object.freeze({
  install: Object.freeze([
    'A LaunchAgent that runs the gateway, one for the support console, plus the binary in ~/.local/bin.',
    'The Claude Burst app in ~/Applications, which opens the dashboard.',
    'Entries in ~/.claude/settings.json: hooks for the features you switch on.',
  ]),
  trust: Object.freeze([
    'An /etc/hosts entry, a pf redirect and a trusted root CA (name-constrained to api.anthropic.com, in the System keychain).',
    'Root LaunchDaemons. macOS asks for your Mac password in Terminal; Plexiform never sees it.',
  ]),
  enable: Object.freeze([
    'ANTHROPIC_BASE_URL in ~/.claude/settings.json (base-url mode), so Claude Code sends its requests through the gateway on this Mac.',
  ]),
  check: Object.freeze(['Nothing. Plexiform reads Burst\'s status from 127.0.0.1 only.']),
});

function atLeast(version, min) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!m) return false;
  for (let i = 0; i < 3; i++) { const n = Number(m[i + 1]); if (n !== min[i]) return n > min[i]; }
  return true;
}

const A = (kind, label) => ({ kind, label });
const RETRY = A('retry', 'Try again');

function initial(mode = 'base-url') {
  const marks = {};
  for (const id of STEPS) marks[id] = { startedAt: null, failed: false };
  return { mode: MODES.includes(mode) ? mode : 'base-url', marks, steps: [] };
}

const withMark = (state, id, mark) => ({ ...state, marks: { ...state.marks, [id]: { ...state.marks[id], ...mark } } });
const start = (state, id, now = Date.now()) => (STEPS.includes(id) ? withMark(state, id, { startedAt: now, failed: false }) : state);
const reset = (state, id) => (STEPS.includes(id) ? withMark(state, id, { startedAt: null, failed: false }) : state);

// What the probe says about each step, before timers: { done, skipped, failed, primary, detail }.
function facts(state, probe) {
  const d = probe.detect || { kind: 'checking' };
  const s = d.kind === 'present' || d.kind === 'broken' ? d.state || {} : {};
  const present = d.kind === 'present';
  const tooOld = present && !atLeast(s.version, MIN_VERSION);
  const mode = present && MODES.includes(s.mode) ? s.mode : state.mode;
  const out = {};

  if (d.kind === 'checking') out.install = { detail: 'Checking whether Burst is installed…', primary: null };
  else if (d.kind === 'not_installed') out.install = { detail: 'Burst is not installed. Install clones it from GitHub into ~/claude-burst and runs its installer in Terminal.', primary: A('install', 'Install Burst') };
  else if (d.kind === 'broken') out.install = { failed: true, detail: `Burst is installed but its configuration could not be read${s.configError ? ` (${s.configError})` : ''}. Repair reinstalls it in the mode it was in.`, primary: A('repair', 'Repair') };
  else if (d.kind === 'unreachable') out.install = { failed: true, detail: 'Burst is installed but its gateway is not answering. Repair restarts it.', primary: A('repair', 'Repair') };
  else if (d.kind === 'untrusted') out.install = { failed: true, detail: `${d.reason || 'The program on Burst\'s port is not Burst.'} Plexiform stops here; fix that before going on.`, primary: null };
  else if (tooOld) out.install = { detail: `Burst ${s.version} is installed but older than ${MIN_VERSION.join('.')}. Update it and the rest of setup can continue.`, primary: A('update', 'Update Burst') };
  else out.install = { done: true, detail: `Burst ${s.version} is installed.`, primary: null };

  if (mode !== 'transparent') out.trust = { skipped: true, detail: 'Base-url mode needs no certificate or hosts entry, so there is nothing to trust.', primary: null };
  else if (!out.install.done) out.trust = { detail: 'Transparent mode needs a trusted certificate and an /etc/hosts entry. This comes after install.', primary: null };
  else if (s.caTrusted === false) out.trust = { detail: 'This Mac does not trust Burst\'s certificate for api.anthropic.com, so Claude Code\'s requests fail the TLS check. Fix re-trusts it (macOS asks for your Mac password in Terminal).', primary: A('repair', 'Fix trust') };
  else if (s.hostsEntry === false) out.trust = { detail: 'The /etc/hosts entry that sends api.anthropic.com to Burst is missing, so Burst sees nothing. Fix puts it back (macOS asks for your Mac password in Terminal).', primary: A('repair', 'Fix hosts entry') };
  else out.trust = { done: true, detail: 'The certificate and hosts entry are in place.', primary: null };

  if (!out.install.done) out.enable = { detail: 'Puts Burst in Claude Code\'s path. This comes after install.', primary: null };
  else if (s.active === true) out.enable = { done: true, detail: `Burst is on, ${mode} mode.`, primary: null };
  else out.enable = { detail: s.inactiveReason || 'Burst is installed but not in Claude Code\'s path.', primary: A('enable', 'Turn on') };

  const c = probe.console;
  if (!out.enable.done) out.check = { detail: 'Confirms that the gateway and its support console both answer. This comes after Burst is on.', primary: null };
  else if (!c || c.kind === 'checking') out.check = { detail: 'Checks that the gateway and its support console both answer.', primary: A('retry', 'Run check') };
  else if (c.kind === 'unreachable') out.check = { failed: true, detail: 'The gateway answers, but Burst\'s support console (the part that repairs and restarts it) does not. Repair starts it again.', primary: A('repair', 'Start console') };
  else if (c.kind === 'untrusted') out.check = { failed: true, detail: `${c.reason || 'The program on the console port is not Burst\'s console.'} Plexiform stops here.`, primary: null };
  else if (c.kind === 'off') out.check = { done: true, detail: 'Burst answers. Its support console is switched off in its config, so repairs run from Terminal.', primary: null };
  else out.check = { done: true, detail: upgradeNote(probe.upgrade, probe.modStatus) || 'Burst and its support console both answer.', primary: null };
  return out;
}

function upgradeNote(upgrade, mods) {
  const u = upgrade && typeof upgrade === 'object' ? upgrade : null;
  if (u && u.canUpgrade === true && u.upToDate === false) return `Burst and its support console both answer. A newer Burst${u.latestVersion ? ` (${u.latestVersion})` : ''} is available.`;
  // /api/mod-status is flat: the burst-session mod's installed/current flags.
  if (mods && typeof mods === 'object' && mods.installed === true && mods.current === false) return 'Burst and its support console both answer. Its Claude Code mod is out of date; Update Burst refreshes it.';
  return '';
}

const secs = (ms) => Math.max(0, Math.round(ms / 1000));

// Pure: the next state from the current one and a probe {detect, console, upgrade, modStatus}.
function next(state, probe = {}, { now = Date.now() } = {}) {
  const st = state && state.marks ? state : initial(state && state.mode);
  const f = facts(st, probe);
  const marks = { ...st.marks };
  const steps = STEPS.map((id) => {
    const x = f[id];
    const m = marks[id];
    let status;
    let primary = x.primary;
    let detail = x.detail;
    let startedAt = null;
    if (x.done) { status = 'done'; marks[id] = { startedAt: null, failed: false }; }
    else if (x.skipped) { status = 'skipped'; marks[id] = { startedAt: null, failed: false }; }
    else if (m.startedAt !== null && now - m.startedAt < TIMEOUT_MS) {
      status = 'running'; startedAt = m.startedAt; primary = null;
      detail = `${id === 'check' ? 'Checking' : 'Waiting for Burst to confirm'}… ${secs(now - m.startedAt)} s. ${id === 'check' ? '' : 'Follow the Terminal window; this page updates on its own.'}`.trim();
    } else if (m.startedAt !== null) {
      status = 'failed'; marks[id] = { startedAt: null, failed: true }; primary = RETRY;
      detail = `Nothing changed after ${secs(TIMEOUT_MS)} s. ${x.detail} If the Terminal window shows an error, fix that first.`;
    } else if (m.failed) { status = 'failed'; primary = RETRY; detail = `${x.detail} Try again when ready.`; }
    else if (x.failed) status = 'failed';
    else status = 'todo';
    return { id, title: TITLES[id], whatItChanges: CHANGES[id], status, primary, detail, startedAt };
  });
  return { mode: st.mode, marks, steps };
}

const current = (state) => { const s = (state && state.steps || []).find((x) => x.status !== 'done' && x.status !== 'skipped'); return s ? s.id : null; };
const running = (state) => (state && state.steps || []).some((x) => x.status === 'running');

module.exports = { STEPS, MODES, TITLES, CHANGES, TIMEOUT_MS, initial, start, reset, next, current, running };
