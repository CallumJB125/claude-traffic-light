'use strict';

// The first-run checklist on the Help page. Pure: main passes in what it
// already knows (the health report, the account summary, the Tackle with AI
// task list) and gets rows back. Each row says done / todo / unknown; a fix is
// only ever a destination Help may already open (the AI tools page included),
// never a command.
//
// `unknown` (no account summary, no task service) counts as not done, so the
// panel never claims a step that nothing confirmed.

const DONE = 'done';
const TODO = 'todo';
const UNKNOWN = 'unknown';

function hooksRow(report) {
  const c = report?.checks?.find((x) => x.id === 'hooks');
  const state = !c ? UNKNOWN : c.status === 'ok' ? DONE : TODO;
  return {
    id: 'hooks', title: 'Connect Claude Code', state,
    detail: c ? (c.status === 'ok' ? c.detail : [c.detail, c.next].filter(Boolean).join(' ')) : 'Not checked yet.',
    fix: state === DONE ? null : { label: 'Open Health', destination: 'settings' },
  };
}

// One row per AI tool found on this Mac, each opening its own row on the AI
// tools page. `tools` is src/ai-tools.js quick(): only what main already read.
function toolRow(t) {
  const done = t.connected;
  const seen = t.lastEvent && t.lastEvent.at ? `Last event ${t.lastEvent.text}.` : 'No events yet. Start a session in it.';
  return {
    id: `tool:${t.id}`, title: `Connect ${t.label}`, state: done ? DONE : TODO,
    detail: done ? `Connected. ${seen}` : t.detail || 'Found on this Mac, not connected yet.',
    fix: done ? null : { label: t.state === 'ready' ? 'Connect' : 'Fix', destination: `aitools:${t.id}` },
  };
}

// The single first-run question: everything found but not yet connected.
function promptFor(tools) {
  const pending = tools.filter((t) => t.installed && !t.connected && t.state !== 'fix');
  if (!pending.length) return null;
  const names = pending.map((t) => t.label);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  return { text: `We found ${list} on this Mac. Connect ${names.length > 1 ? 'them' : 'it'}?`, ids: pending.map((t) => t.id), fix: { label: 'Connect all', destination: 'aitools:all' } };
}

function signInRow(account) {
  const state = account == null ? UNKNOWN : account.signedIn ? DONE : TODO;
  return {
    id: 'signin', title: 'Sign in with Google or GitHub', state,
    detail: state === DONE ? `Signed in${account.name ? ` as ${account.name}` : ''}.` : 'Optional until you want a team board.',
    fix: state === DONE ? null : { label: 'Sign in', destination: 'join' },
  };
}

function teamRow(account) {
  const state = account == null ? UNKNOWN : account.teamName ? DONE : TODO;
  return {
    id: 'team', title: 'Create or join a team', state,
    detail: state === DONE ? `On ${account.teamName}.` : 'Your board stays on this Mac until you do.',
    fix: state === DONE ? null : { label: 'Join your team', destination: 'join' },
  };
}

function tackleRow(tasks) {
  const n = Array.isArray(tasks) ? tasks.length : null;
  const state = n === null ? UNKNOWN : n > 0 ? DONE : TODO;
  return {
    id: 'tackle', title: 'Give your first card to AI', state,
    detail: state === DONE ? 'You have run a card.' : 'Open a card on your board and send it to AI.',
    fix: state === DONE ? null : { label: 'Open the board', destination: 'board' },
  };
}

function build({ report = null, account = null, tasks = null, tools = null } = {}) {
  const found = Array.isArray(tools) ? tools.filter((t) => t.installed) : [];
  const toolRows = found.length ? found.map(toolRow) : [hooksRow(report)];
  const rows = [...toolRows, signInRow(account), teamRow(account), tackleRow(tasks)];
  const done = rows.filter((r) => r.state === DONE).length;
  return { rows, done, total: rows.length, complete: done === rows.length, prompt: found.length ? promptFor(found) : null };
}

// Help re-asks on every status change; the health checks read the disk, so
// the report is reused for a few seconds.
const REPORT_TTL_MS = 5000;
function createForHelp({ report, account, tasks, tools = () => null, now = Date.now }) {
  let at = -Infinity, last = null;
  return () => {
    if (now() - at > REPORT_TTL_MS) { try { last = report(); } catch { last = null; } at = now(); }
    let acct = null, list = null;
    try { acct = account(); } catch { /* unknown */ }
    try { list = tasks(); } catch { /* unknown */ }
    let found = null;
    try { found = tools(); } catch { /* unknown */ }
    return build({ report: last, account: acct, tasks: list, tools: found });
  };
}

// ── First-run setup (onboarding.html) ───────────────────────────────────────
// What the setup window shows, from what main already knows: `tools` is
// src/ai-tools.js quick(), `sessions` the live local sessions. `claudeAuto`:
// Claude Code's hooks are written by Plexiform at start, so its row says so
// and offers Undo instead of a checkbox.
const SOURCE_TOOL = { 'claude-code': 'claude', 'cursor-agent': 'cursor' };
const toolOf = (s) => { const src = String(s?.source || 'claude'); return SOURCE_TOOL[src] || src; };
const folderOf = (cwd) => String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';

// The session most recently heard from, in words: "Codex is working in api."
function firstSession(sessions, tools) {
  const live = (Array.isArray(sessions) ? sessions : []).filter((s) => s && !s.remote);
  if (!live.length) return null;
  const at = (s) => Date.parse(s.updatedAt) || 0;
  const s = live.reduce((a, b) => (at(b) > at(a) ? b : a));
  const id = toolOf(s);
  const label = tools.find((t) => t.id === id)?.label || id.charAt(0).toUpperCase() + id.slice(1);
  const folder = folderOf(s.cwd);
  return { tool: id, label, folder, text: folder ? `${label} is working in ${folder}.` : `${label} is working.` };
}

function onboardingView({ tools = [], sessions = [], loginItem = null, claudeAuto = false } = {}) {
  const list = Array.isArray(tools) ? tools : [];
  const rows = list.filter((t) => t.installed).map((t) => {
    const auto = t.id === 'claude' && t.connected && claudeAuto;
    const selectable = !t.connected && t.state !== 'fix';
    return {
      id: t.id, label: t.label, connected: !!t.connected, auto, selectable,
      canUndo: auto || (!!t.connected && !!t.canUndo),
      status: auto ? 'Connected automatically' : t.connected ? 'Connected' : t.state === 'fix' ? 'Needs a fix' : 'Found',
      detail: auto ? 'Plexiform connects Claude Code each time it starts. Undo turns that off.' : t.state === 'fix' || t.state === 'reconnect' ? t.detail : '',
    };
  });
  const missing = list.filter((t) => !t.installed).map((t) => ({ id: t.id, label: t.label }));
  return { rows, missing, pending: rows.filter((r) => r.selectable).map((r) => r.id), loginItem, session: firstSession(sessions, list) };
}

module.exports = { build, createForHelp, onboardingView, firstSession };
