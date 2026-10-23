'use strict';
// "Try the demo": for someone with no connected AI tool, Home shows made-up
// sessions, a question waiting for them, a day's spend and a sample board,
// under a DEMO banner on every page that carries it. Everything comes from
// the fixtures below. The demo is a flag in memory: it reads no store, writes
// no file, starts nothing and sends nothing, and Exit demo (or quitting) puts
// the real view back.

const MIN = 60_000;

function fixtures(now) {
  return {
    observed_at: now,
    demo: true,
    banner: null,
    morning: {
      count: 2, costUsd: 0.84, more: 0, asks: [],
      items: [
        { title: 'Find and fix flaky tests', branch: 'buddy/find-and-fix-flaky-a41c9e', commits: 2, files: 3, added: 41, removed: 17, costUsd: 0.61, tests: 'passed', pr: false, ask: null, state: 'in_review', summary: '' },
        { title: 'Weekly report from my git history', branch: null, commits: 0, files: 0, added: 0, removed: 0, costUsd: 0.23, tests: 'none', pr: false, ask: null, state: 'done', summary: 'Report ready: 4 themes, 23 commits.' },
      ],
    },
    needs: {
      total: 1,
      items: [{ kind: 'Permission', headline: 'Claude Code wants to run: npm test -- --watch=false', project: 'acme-web', age: '2 min', late: false }],
    },
    running: {
      quiet: 1,
      items: [
        { provider: 'Claude Code', project: 'acme-web', status: 'Needs you', bucket: 'needs', age_ms: 2 * MIN },
        { provider: 'Codex', project: 'billing-service', status: 'Working on it', bucket: 'working', age_ms: 20_000 },
        { provider: 'Gemini CLI', project: 'docs-site', status: 'Working on it', bucket: 'working', age_ms: 45_000 },
      ],
    },
    today: { spend: { spent: 6.42, budget: 10, level: null, unpriced: 0, equivalent: false }, longestWaitMs: 2 * MIN },
    costs: {
      receipt: { month: 'This month', headline: 'Compaction and model choice saved about $18.40 this month (sample).' },
      enforce: { on: true, status: 'Your limit is enforced. Nothing is being refused right now.' },
      waste: { days: 7, count: 2, top: 'One session re-read the same 4 large files 11 times (sample).', files: 12 },
    },
    teamless: false,
    team: {
      unavailable: false,
      cards: [
        { handle: 'demo-1', key: 'DEMO-12', title: 'Checkout form loses the address on back', board: 'Sample board', team: 'Demo team', state: 'In progress', due_date: null },
        { handle: 'demo-2', key: 'DEMO-9', title: 'Retry webhooks with backoff', board: 'Sample board', team: 'Demo team', state: 'Review', due_date: null },
        { handle: 'demo-3', key: 'DEMO-15', title: 'Write the v2.3 release notes', board: 'Sample board', team: 'Demo team', state: 'To do', due_date: null },
      ],
      decisions: [{ handle: 'demo-4', key: 'DEMO-9', title: 'Retry webhooks with backoff', board: 'Sample board', kind: 'Plan to approve', summary: 'Codex proposes 5 retries over 30 minutes' }],
    },
  };
}

function create() {
  let on = false;
  return {
    active: () => on,
    start: () => { on = true; return true; },
    exit: () => { on = false; return true; },
    home: (now = Date.now()) => fixtures(now),
  };
}

// allowed(e): the pages that carry the banner (Home, Tasks, Help).
function register({ ipcMain, allowed, demo, onChange = () => {} }) {
  const on = (channel, fn) => ipcMain.handle(channel, (e) => (allowed(e) ? fn() : null));
  on('demo:state', () => ({ active: demo.active() }));
  on('demo:start', () => { demo.start(); onChange(true); return { active: true }; });
  on('demo:exit', () => { demo.exit(); onChange(false); return { active: false }; });
}

module.exports = { create, register, fixtures };
