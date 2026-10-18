'use strict';
// IPC for the Home page (home.html). Main reads what other pages already show
// (waiting inputs, local sessions, today's spend, AI tools, your own cards)
// and answers only the Home page itself. The renderer sends a page id or an
// opaque card handle, never a path, URL or command.
const InputView = require('./input-view.js');
const SessionOverview = require('./session-overview.js');
const { finding } = require('../usage-waste-view.js');
const { summary } = require('./ai-tools.js');

const LOCAL_BOARD = 'My board (this Mac)';
const PAGES = new Set(['waiting', 'sessions', 'board', 'usage', 'settings', 'team', 'myday', 'overview', 'tasks']);
const AITOOLS = /^aitools(?::[a-z]{2,12})?$/;
const LIST_MAX = 20;
const OPTIONS_MAX = 4;
const OPTION_LABEL_MAX = 40;
const TEAM_TTL_MS = 15000;
const TOOLS_TTL_MS = 15000;
const COSTS_TTL_MS = 60000;
const text = (v, n = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '');

// Any tool found but not connected gets the banner; nothing found gets the install pointer.
function banner(tools) {
  if (!Array.isArray(tools)) return null;
  const installed = tools.filter((t) => t && t.installed);
  if (!installed.length) return { kind: 'none', text: 'No AI tools found yet. Plexiform works with Claude Code, Codex, Gemini CLI, Cursor, Hermes, Copilot CLI, OpenCode, Goose, Cline and Aider.', action: { label: 'See AI tools', destination: 'aitools' } };
  const sum = summary(tools);
  if (!sum.waiting.length) return null;
  const names = sum.waitingLabels.map((l) => text(l, 60));
  return {
    kind: 'connect',
    text: `${text(sum.text, 400)} Connect ${names.length > 1 ? 'them' : 'it'} to see what ${names.length > 1 ? 'they are' : 'it is'} doing here.`,
    action: names.length > 1 ? { label: `Connect ${names.length} tools`, destination: 'aitools:all' } : { label: `Connect ${names[0]}`, destination: `aitools:${sum.waiting[0]}` },
  };
}

// `paused` (the cost guard's pause view) sits above the waits: the person's own
// limit stopped the work, so it needs them before any question does.
// Quick decision options: only a request file the Waiting page could answer
// with one click (answerable, not expired, a plain choice: no question form,
// no elicitation schema, no free text). Ids only: main rebuilds the answer.
function quickOptions(input, now) {
  if (!InputView.canAnswer(input, now) || input.source !== 'hook' || typeof input.id !== 'string' || input.id.length > 100) return [];
  if (input.questions || input.schema || input.freeText) return [];
  return (Array.isArray(input.options) ? input.options : [])
    .filter((o) => o && typeof o.id === 'string' && o.id && o.id !== 'answers' && o.id.length <= 100 && typeof o.label === 'string' && o.label.trim())
    .slice(0, OPTIONS_MAX)
    .map((o) => ({ id: o.id, label: text(o.label.trim(), OPTION_LABEL_MAX) }));
}

function needs(inputs, now, paused = null) {
  const queue = InputView.queue(inputs);
  return {
    paused: paused && typeof paused.text === 'string' ? { text: text(paused.text, 160), note: text(paused.note, 300), resumable: paused.resumable !== false } : null,
    total: queue.length,
    items: queue.slice(0, LIST_MAX).map((i) => ({ id: typeof i.id === 'string' ? i.id.slice(0, 100) : '', kind: InputView.KIND_LABEL[i.kind] || 'Waiting', headline: InputView.headline(i), project: text(InputView.project(i), 100), age: InputView.ageText(i, now), late: InputView.escalated(i, now), options: quickOptions(i, now) })),
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

// The cost guard report (src/spend-enforce.js) cut to one card: the receipt's headline, whether the limit is enforced, and the top waste finding.
function costs(report) {
  if (!report || typeof report !== 'object') return null;
  const r = report.receipt, e = report.enforce, w = report.waste;
  const out = {
    receipt: r && typeof r.headline === 'string' ? { month: text(r.month, 40), headline: text(r.headline) } : null,
    enforce: e && e.available ? {
      on: !!e.settings?.enforceCaps,
      paused: e.paused && typeof e.paused.text === 'string' ? { text: text(e.paused.text, 160), note: text(e.paused.note, 300), resumable: e.paused.resumable !== false } : null,
      status: text(e.capActive ? (e.paused?.text ? `${e.paused.text}: tool calls are being refused.` : 'Your limit is spent: tool calls are being refused.')
        : e.sessionsStopped ? `${e.sessionsStopped} runaway session${e.sessionsStopped === 1 ? ' is' : 's are'} being held.`
          : e.settings?.enforceCaps ? 'Your limit is enforced. Nothing is being refused right now.' : 'Your limit is not enforced.'),
    } : null,
    waste: w && Array.isArray(w.findings) ? { days: w.days, count: w.findings.length, top: w.findings.length ? text(finding(w.findings[0]), 300) : null, files: w.files || 0 } : null,
  };
  return out.receipt || out.enforce || out.waste ? out : null;
}

// Tasks finished while you were away (Plus). Null when there is nothing, or the plan lacks it.
const morningReport = () => require('./morning-report.js').current();

function register({ ipcMain, allowed, state, localSessions, tools, myDay, openPage, openAiTools, morning = morningReport, now = Date.now, collisions = null, costGuard = () => null, resumeCap = null, demo = null }) {
  let toolsMemo = { at: -Infinity, value: null };
  let costsMemo = { at: -Infinity, value: null };
  let teamMemo = { at: -Infinity, value: null, none: false };
  const part = (fn) => { try { return fn(); } catch { return null; } };
  async function snapshot() {
    const time = now();
    const st = part(state);
    const inputs = st && st.reason !== 'travel' ? (st.inputs || []) : [];
    if (time - toolsMemo.at > TOOLS_TTL_MS) { const rows = part(tools); toolsMemo = { at: time, value: part(() => banner(rows)), demo: Array.isArray(rows) && !rows.some((t) => t && t.connected) }; }
    if (time - teamMemo.at > TEAM_TTL_MS) {
      let team = null, none = false;
      try { team = cards(await myDay.snapshot()); none = team === null; } catch { team = null; }
      teamMemo = { at: time, value: team, none };
    }
    // The first waste scan can take seconds, so Home shows the card from the next refresh rather than waiting.
    if (time - costsMemo.at > COSTS_TTL_MS) {
      costsMemo.at = time;
      Promise.resolve().then(costGuard).then((report) => { costsMemo.value = costs(report); }, () => { costsMemo.value = null; });
    }
    return {
      observed_at: time,
      banner: toolsMemo.value,
      canDemo: !!demo && toolsMemo.demo === true,
      needs: st ? part(() => needs(inputs, time, costsMemo.value?.enforce?.paused ?? null)) : null,
      running: st ? part(() => running(localSessions(st.sessions || []), time, collisions)) : null,
      today: st ? part(() => today(st.spend, inputs, time)) : null,
      team: teamMemo.value,
      teamless: teamMemo.none,
      morning: part(() => morning()?.state() ?? null),
      costs: costsMemo.value,
    };
  }
  // The demo answers from its fixtures alone: no store is read while it is on.
  ipcMain.handle('home:state', (e) => (!allowed(e) ? null : demo?.active() ? demo.home(now()) : snapshot()));
  ipcMain.handle('home:navigate', (e, destination) => {
    if (!allowed(e) || typeof destination !== 'string') return false;
    if (AITOOLS.test(destination)) { toolsMemo.at = -Infinity; return !!openAiTools(destination); }
    if (!PAGES.has(destination)) return false;
    openPage(destination);
    return true;
  });
  // Resume after a cap: the cost guard owns the decision (src/spend-enforce.js); Home only forwards it.
  ipcMain.handle('home:resume-cap', async (e) => {
    if (!allowed(e) || demo?.active() || typeof resumeCap !== 'function') return { ok: false };
    try {
      const r = await resumeCap();
      if (!r || r.error) return { ok: false, error: r?.error };
      try { costsMemo = { at: now(), value: costs(await costGuard()) }; } catch { costsMemo.at = -Infinity; }
      return { ok: true };
    } catch { return { ok: false }; }
  });
  ipcMain.handle('home:morning-seen', (e) => (allowed(e) && !demo?.active() ? !!morning()?.markSeen() : false));
  ipcMain.handle('home:open-card', async (e, handle) => (allowed(e) && !demo?.active() && typeof handle === 'string' && handle.length <= 100 ? !!await myDay.open(handle) : false));
}

module.exports = { register, banner, needs, running, today, cards, costs, LOCAL_BOARD };
