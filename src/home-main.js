'use strict';
// IPC for the Home page (home.html). Main reads what other pages already show
// (waiting inputs, local sessions, today's spend, AI tools, your own cards)
// and answers only the Home page itself. The renderer sends a page id or an
// opaque card handle, never a path, URL or command.
const InputView = require('./input-view.js');
const SessionOverview = require('./session-overview.js');

const LOCAL_BOARD = 'My board (this Mac)';
const PAGES = new Set(['waiting', 'sessions', 'board', 'usage', 'settings', 'team', 'myday', 'overview', 'tasks']);
const AITOOLS = /^aitools(?::[a-z]{2,12})?$/;
const LIST_MAX = 20;
const TEAM_TTL_MS = 15000;
const TOOLS_TTL_MS = 15000;
const text = (v, n = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '');
const join = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]);

// Any tool found but not connected gets the banner; nothing found gets the install pointer.
function banner(tools) {
  if (!Array.isArray(tools)) return null;
  const installed = tools.filter((t) => t && t.installed);
  if (!installed.length) return { kind: 'none', text: 'No AI tools found yet. Plexiform works with Claude Code, Codex, Gemini CLI, Cursor and Hermes.', action: { label: 'See AI tools', destination: 'aitools' } };
  const pending = installed.filter((t) => !t.connected);
  if (!pending.length) return null;
  const names = pending.map((t) => text(t.label, 60) || t.id);
  return {
    kind: 'connect',
    text: `We found ${join(names)} on this Mac. Connect ${names.length > 1 ? 'them' : 'it'} to see what ${names.length > 1 ? 'they are' : 'it is'} doing here.`,
    action: pending.length > 1 ? { label: `Connect ${pending.length} tools`, destination: 'aitools:all' } : { label: `Connect ${names[0]}`, destination: `aitools:${pending[0].id}` },
  };
}

function needs(inputs, now) {
  const queue = InputView.queue(inputs);
  return {
    total: queue.length,
    items: queue.slice(0, LIST_MAX).map((i) => ({ kind: InputView.KIND_LABEL[i.kind] || 'Waiting', headline: InputView.headline(i), project: text(InputView.project(i), 100), age: InputView.ageText(i, now), late: InputView.escalated(i, now) })),
  };
}

// Live = reported in the last 90 s and not ended; the rest are only counted.
function running(sessions, now, collisions = null) {
  const snap = SessionOverview.snapshot({ sessions, now, collisions });
  const open = snap.sessions.filter((s) => s.status !== 'Ended');
  const live = open.filter((s) => s.freshness === 'recent');
  return { quiet: open.length - live.length, items: live.slice(0, LIST_MAX).map((s) => ({ provider: s.provider, project: s.project, status: s.status, age_ms: s.age_ms, ...(s.collisions ? { collision: s.collisions[0].text } : {}) })) };
}

function today(spend, inputs, now) {
  const day = spend?.budget?.day;
  const waits = (Array.isArray(inputs) ? inputs : []).map((i) => InputView.ageMs(i, now)).filter((v) => v !== null);
  return {
    spend: day ? { spent: day.spent, budget: day.budget, level: day.level, unpriced: day.unpriced || 0, equivalent: spend.mode === 'subscription' } : null,
    longestWaitMs: waits.length ? Math.max(...waits) : null,
  };
}

// Only on a team: the local board alone is not "your cards".
function cards(snapshot) {
  const sources = Array.isArray(snapshot?.sources) ? snapshot.sources : [];
  if (!sources.some((s) => s && s.name !== LOCAL_BOARD)) return null;
  const all = sources.flatMap((s) => s.cards ?? []), decisions = sources.flatMap((s) => s.decisions ?? []);
  return {
    unavailable: sources.some((s) => s.status === 'unavailable'),
    cards: all.slice(0, LIST_MAX).map((c) => ({ handle: c.handle, key: c.key, title: c.title, board: c.board, team: c.team, state: c.state, due_date: c.due_date })),
    decisions: decisions.slice(0, LIST_MAX).map((d) => ({ handle: d.handle, key: d.key, title: d.title, board: d.board, kind: d.kind, summary: d.summary })),
  };
}

// Tasks finished while you were away (Plus). Null when there is nothing, or the plan lacks it.
const morningReport = () => require('./morning-report.js').current();

function register({ ipcMain, allowed, state, localSessions, tools, myDay, openPage, openAiTools, morning = morningReport, now = Date.now, collisions = null }) {
  let toolsMemo = { at: -Infinity, value: null };
  let teamMemo = { at: -Infinity, value: null };
  const part = (fn) => { try { return fn(); } catch { return null; } };
  async function snapshot() {
    const time = now();
    const st = part(state);
    const inputs = st && st.reason !== 'travel' ? (st.inputs || []) : [];
    if (time - toolsMemo.at > TOOLS_TTL_MS) toolsMemo = { at: time, value: part(() => banner(tools())) };
    if (time - teamMemo.at > TEAM_TTL_MS) {
      let team = null;
      try { team = cards(await myDay.snapshot()); } catch { team = null; }
      teamMemo = { at: time, value: team };
    }
    return {
      observed_at: time,
      banner: toolsMemo.value,
      needs: st ? part(() => needs(inputs, time)) : null,
      running: st ? part(() => running(localSessions(st.sessions || []), time, collisions)) : null,
      today: st ? part(() => today(st.spend, inputs, time)) : null,
      team: teamMemo.value,
      morning: part(() => morning()?.state() ?? null),
    };
  }
  ipcMain.handle('home:state', (e) => (allowed(e) ? snapshot() : null));
  ipcMain.handle('home:navigate', (e, destination) => {
    if (!allowed(e) || typeof destination !== 'string') return false;
    if (AITOOLS.test(destination)) { toolsMemo.at = -Infinity; return !!openAiTools(destination); }
    if (!PAGES.has(destination)) return false;
    openPage(destination);
    return true;
  });
  ipcMain.handle('home:morning-seen', (e) => (allowed(e) ? !!morning()?.markSeen() : false));
  ipcMain.handle('home:open-card', async (e, handle) => (allowed(e) && typeof handle === 'string' && handle.length <= 100 ? !!await myDay.open(handle) : false));
}

module.exports = { register, banner, needs, running, today, cards, LOCAL_BOARD };
