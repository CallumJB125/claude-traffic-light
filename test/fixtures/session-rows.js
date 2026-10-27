'use strict';
// Fixture sessions for the shared row view model (PR 0s): one Sessions & agents
// build (overview-service) that both the row VM test and the frozen sidebar
// golden (sidebar-rows-golden.json) read. The clock is fixed, so ids and ages
// are stable.
const { createOverviewService } = require('../../src/overview-service');

const NOW = Date.parse('2026-10-27T10:00:00Z');
const at = (ms) => new Date(NOW - ms).toISOString();

const SESSIONS = [
  { sessionId: 's-iterm', source: 'claude', signal: 'waiting', updatedAt: at(1000), hostApp: 'iTerm2', cwd: '/Users/someone/private/alpha', taskTitle: 'Fix the login page' },
  { sessionId: 's-term', source: 'codex', signal: 'tool-use', updatedAt: at(2000), terminal: { env: { TERM_PROGRAM: 'Apple_Terminal' } }, cwd: '/Users/someone/private/beta' },
  { sessionId: 's-warp', source: 'claude', signal: 'tool-use', updatedAt: at(3000), hostApp: 'Warp', cwd: '/Users/someone/private/gamma' },
  // A paired device's session: listed, never "in a terminal on this computer".
  { sessionId: 's-remote', source: 'claude', signal: 'tool-use', updatedAt: at(4000), hostApp: 'iTerm2', remote: true, device: 'dev-1', deviceName: 'Studio Mac', taskTitle: 'Remote work' },
  // A title that looks like a path is dropped for the "<AI> session in <project>" fallback.
  { sessionId: 's-pathy', source: 'claude', signal: 'idle', updatedAt: at(5000), hostApp: 'Terminal', cwd: '/Users/someone/private/delta', taskTitle: '/Users/someone/private/delta/notes.md' },
  // No folder: overview's "Other work" placeholder, which is not a project name.
  { sessionId: 's-nocwd', source: 'codex', signal: 'idle', updatedAt: at(6000) },
  // Bound to a team board card (the team row).
  { sessionId: 's-team', source: 'codex', signal: 'tool-use', codexLifecycle: 1, codexClosedTurn: false, codexTurnId: 'turn', codexHookAt: at(700), updatedAt: at(700), cwd: '/Users/someone/private/epsilon', taskId: 'task' },
];

const teamRow = { board_id: 'board', board_name: 'Team board', team_id: 'team', member_id: 'member', card: { id: 'card', title: 'Team card title', key: 'T-1', fence: 3, repo: { id: 'repo', short_name: 'epsilon' }, run: { id: 'run', ai: 'codex', device_name: 'Laptop' }, run_state: 'running', live: { hb_age_ms: 10 } } };
const teamData = { ok: true, status: 'complete', principal: { user_id: 'owner' }, cards: [teamRow], agents: [{ card_id: 'card', board_id: 'board', member_id: 'member', connection: 'accepted', live: { green: true, hb_age_ms: 10 } }] };
const teamSource = { key: 'hub', kind: 'team', userId: 'owner', current: () => true, matches: () => true, read: async () => teamData, open: async () => true, send: async () => ({ ok: true }) };
const capture = [{ provider: 'codex', session_id: 's-team', task_id: 'task', card_id: 'card', destination: { kind: 'team', board_id: 'board', team_id: 'team' } }];

const task = (over) => ({ id: over.id, title: over.title, state: 'running', ai: { id: 'claude', model: null }, repo: { name: 'zeta' }, branch: `plexiform/${over.id}`,
  workInPlace: false, hub: false, cost: { usd: 0.42, budgetUsd: null }, actions: [], label: 'Working', green: true, ...over });
const TASKS = [
  task({ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Add a cache', state: 'running' }),
  task({ id: 'aaaaaaaa-0000-4000-8000-000000000002', title: 'Review me', state: 'in_review', label: 'Ready to review', green: false }),
  task({ id: 'aaaaaaaa-0000-4000-8000-000000000003', title: 'Needs an answer', state: 'blocked', actions: ['approve', 'deny'], label: 'Needs you', green: false }),
  task({ id: 'aaaaaaaa-0000-4000-8000-000000000004', title: 'In my terminal', state: 'handed_over', label: 'In your terminal', green: false, ai: { id: 'codex', model: null } }),
  task({ id: 'aaaaaaaa-0000-4000-8000-000000000005', title: 'Budgeted', state: 'parked', parkReason: 'limit', cost: { usd: 1, budgetUsd: 2 }, label: 'Paused', green: false }),
];

function service(over = {}) {
  return createOverviewService({ sessions: () => SESSIONS, work: async () => ({ sources: [teamSource], capture }),
    managed: () => ({ conn: { status: 'connected' }, tasks: TASKS }), now: () => NOW, ...over });
}

module.exports = { NOW, SESSIONS, TASKS, service };
