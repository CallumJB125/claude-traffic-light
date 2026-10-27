'use strict';
// The session surface contract (plan-agent-terminal §R2.13 PR 0s): who drives a
// session, chat or terminal, and the two per-task facts every surface shows the
// same way (chatState, openInTerminal). Pure: no I/O, nothing imported from the
// app. The chat (C-PRs) and the terminal (T-PRs) both build on this file.

const ORIGINS = Object.freeze(['chat', 'plexiform-tab', 'external']);
const DRIVERS = Object.freeze(['chat', 'terminal', 'external']);
// focus/ids.js ORIGINS labels, plus Ghostty Dock, which joins originOf when the
// focus layer learns it.
const HOST_APPS = Object.freeze(['Terminal', 'iTerm', 'Plexiform Terminal', 'Ghostty Dock']);
// Each origin's legal drivers. A chat is driven by the chat or, after a
// take-over, a terminal; a native Plexiform tab is always a terminal; an
// external session is never taken over.
const LEGAL = Object.freeze({ chat: ['chat', 'terminal'], 'plexiform-tab': ['terminal'], external: ['external'] });
const EVENTS = Object.freeze(['takeover', 'handback']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const fail = (message) => Object.assign(new Error(message), { code: 'VALIDATION' });
const optionalId = (v, name) => { if (v === null) return null; if (typeof v !== 'string' || !ID.test(v)) throw fail(`${name} is invalid`); return v; };

/** @returns {Readonly<{provider, sessionId, taskId, origin, driver, hostApp, tabId}>} */
function sessionRef({ provider, sessionId, taskId = null, origin, driver, hostApp = null, tabId = null } = {}) {
  if (typeof provider !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(provider)) throw fail('provider is invalid');
  if (typeof sessionId !== 'string' || !ID.test(sessionId)) throw fail('sessionId is invalid');
  if (!ORIGINS.includes(origin)) throw fail('origin is invalid');
  if (!DRIVERS.includes(driver) || !LEGAL[origin].includes(driver)) throw fail('driver is invalid for this origin');
  if (hostApp !== null && !HOST_APPS.includes(hostApp)) throw fail('hostApp is invalid');
  const ref = { provider, sessionId, taskId: optionalId(taskId, 'taskId'), origin, driver, hostApp, tabId: optionalId(tabId, 'tabId') };
  if (origin === 'chat' && ref.taskId === null) throw fail('a chat session has a task');
  return Object.freeze(ref);
}

// takeover: chat → terminal. handback: terminal → chat, only for a chat that was
// taken over. Everything else is refused. A launch that never started
// (TERMINAL_DIDNT_START) leaves the engine handed_over, so the driver stays
// terminal and hand-back stays legal (§R3.14 condition 1).
function nextDriver(ref, event) {
  if (!EVENTS.includes(event) || !ref || ref.origin !== 'chat') return { ok: false, code: 'ILLEGAL_TRANSITION' };
  if (event === 'takeover' && ref.driver === 'chat') return { ok: true, driver: 'terminal' };
  if (event === 'handback' && ref.driver === 'terminal') return { ok: true, driver: 'chat' };
  return { ok: false, code: 'ILLEGAL_TRANSITION' };
}

const driverOfTaskState = (state) => (state === 'handing_over' || state === 'handed_over' ? 'terminal' : 'chat');

// One state per managed task, for every surface that shows chats. diffFiles is
// the engine's evidence.diffStat.files when the caller read it, else null.
// 'your-turn' (in_review, nothing changed) is shown inside the Sessions page's
// own bucket in PR 0s; moving it to Working on it waits for the PR that moves
// that page onto the row model (plan-pr0s §6, ruling 1).
const WORKING = new Set(['todo', 'queued', 'claimed', 'running', 'quiet', 'reconnecting']);
const PERSON_FAIL = new Set(['limit', 'budget']);
function chatStateOf(task, { diffFiles = null } = {}) {
  if (!task || typeof task.state !== 'string') return null;
  const actions = Array.isArray(task.actions) ? task.actions : [];
  const { state } = task;
  if (actions.includes('answer') || actions.includes('approve') || (state === 'queued' && task.awaitingConfirm === true)
    || (state === 'parked' && ['limit', 'auth'].includes(task.parkReason)) || (state === 'failed' && PERSON_FAIL.has(task.failKind))) return 'needs-you';
  if (state === 'handing_over' || state === 'handed_over') return 'in-terminal';
  if (state === 'in_review') return Number.isInteger(diffFiles) && diffFiles === 0 ? 'your-turn' : 'review';
  if (WORKING.has(state) || state === 'blocked') return 'working';
  if (state === 'parked' || state === 'suspended') return 'paused';
  if (state === 'failed' || state === 'orphaned' || state === 'stalled' || state === 'unresponsive') return 'failed';
  if (state === 'done') return 'ended';
  return null;
}

// The task half of tasks-service.js's canOpen (:404): repo, not in place, not a
// hub task, Claude or Codex, no budget. D5 quick chats can't open either.
// The session half (a live take-over for this page) stays in tasks-service.
function openInTerminalOf(task, { quickChat = false } = {}) {
  const no = (reason) => ({ available: false, code: 'CANT_OPEN', reason });
  if (!task || typeof task !== 'object') return no('no-task');
  if (quickChat) return no('quick-chat');
  if (!task.repo) return no('no-repo');
  if (task.workInPlace) return no('in-place');
  if (task.hub) return no('hub');
  if (!['claude', 'codex'].includes(task.ai?.id)) return no('provider');
  if (task.cost?.budgetUsd !== null) return no('budgeted');
  return { available: true, code: null, reason: null };
}

module.exports = { ORIGINS, DRIVERS, HOST_APPS, EVENTS, sessionRef, nextDriver, driverOfTaskState, chatStateOf, openInTerminalOf };
