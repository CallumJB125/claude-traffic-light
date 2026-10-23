'use strict';
// O3: the person's own wrapped tasks (local and cli) that did real work, as the session-shaped records
// work-capture already understands, so they get automatic cards through the very same path as a native
// session (routing, team title, retry, toggle, personal override). Only the task's title, its state and its
// folder cross: never the task text, the AI's words, an outcome or a failure reason.
const path = require('node:path');

const TASK_ID = /^tsk_[A-Za-z0-9]{1,64}$/;
// Task state → the hook signal work-capture's phase() reads: working, waiting (needs the person), review, ended, idle.
const SIGNAL = {
  claimed: 'tool-use', running: 'tool-use', quiet: 'tool-use', handing_over: 'tool-use',
  blocked: 'permission-ask', suspended: 'permission-ask', unresponsive: 'permission-ask', orphaned: 'permission-ask',
  // A failed wrapped task keeps its worktree: it needs the person.
  failed: 'permission-ask',
  in_review: 'stop',
  done: 'session-end',
  parked: 'idle-nudge', queued: 'idle-nudge',
};

function recordsFor(rows, { host }) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows.slice(0, 20) : []) {
    if (!r || !TASK_ID.test(r.taskId) || (r.ai !== 'claude' && r.ai !== 'codex') || typeof r.root !== 'string' || !path.isAbsolute(r.root)) continue;
    const signal = Object.prototype.hasOwnProperty.call(SIGNAL, r.state) ? SIGNAL[r.state] : null;
    if (!signal || !Number.isFinite(r.changedAt)) continue;
    out.push({ source: r.ai, sessionId: r.taskId, taskId: r.taskId, host, cwd: r.root,
      taskTitle: typeof r.title === 'string' && r.title.trim() ? r.title.slice(0, 200) : 'Task', signal, updatedAt: new Date(r.changedAt).toISOString() });
  }
  return out;
}

module.exports = { recordsFor, SIGNAL };
