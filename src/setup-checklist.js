'use strict';

// The first-run checklist on the Help page. Pure: main passes in what it
// already knows (the health report, the account summary, the Tackle with AI
// task list) and gets rows back. Each row says done / todo / unknown; a fix is
// only ever a destination Help may already open, never a command.
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

function build({ report = null, account = null, tasks = null } = {}) {
  const rows = [hooksRow(report), signInRow(account), teamRow(account), tackleRow(tasks)];
  const done = rows.filter((r) => r.state === DONE).length;
  return { rows, done, total: rows.length, complete: done === rows.length };
}

// Help re-asks on every status change; the health checks read the disk, so
// the report is reused for a few seconds.
const REPORT_TTL_MS = 5000;
function createForHelp({ report, account, tasks, now = Date.now }) {
  let at = -Infinity, last = null;
  return () => {
    if (now() - at > REPORT_TTL_MS) { try { last = report(); } catch { last = null; } at = now(); }
    let acct = null, list = null;
    try { acct = account(); } catch { /* unknown */ }
    try { list = tasks(); } catch { /* unknown */ }
    return build({ report: last, account: acct, tasks: list });
  };
}

module.exports = { build, createForHelp };
