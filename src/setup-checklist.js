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
    id: 'tackle', title: 'Tackle your first card with AI', state,
    detail: state === DONE ? 'You have run a card.' : 'Open a card on your board and choose Tackle with AI.',
    fix: state === DONE ? null : { label: 'Open Overview', destination: 'overview' },
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

module.exports = { build, createForHelp };
