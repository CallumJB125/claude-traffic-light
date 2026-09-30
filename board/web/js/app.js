// The board app: state, the /ws/board stream, HTTP actions, and one render
// loop. Rendering is a pure function of `state` (render-*.js); this file owns
// clocks, network and DOM events.
import { h, render } from './h.js';
import { api, errorText } from './api.js';
import { connectBoard } from './socket.js';
import { displayFace, alertsForViewer, isHumanOwned } from './view.js';
import { boardScreen, loadingScreen } from './render-board.js';
import { drawer } from './render-drawer.js';
import { dialog } from './render-dialogs.js';
import { signinScreen } from './render-signin.js';
import { PLAN_APPROVAL_LABEL } from '../../shared/states.js';

const root = document.getElementById('root');
const perf = () => performance.now();

const state = {
  auth: 'loading', // loading | signed_out | forbidden | ok
  authMode: null, // /api/health auth: 'dev' | 'access'
  authError: null,
  authBusy: false,
  email: null,
  me: null,
  boardId: null,
  board: null,
  members: new Map(),
  cards: new Map(), // id → {view, rx}
  conn: { status: 'connecting', lostAt: null, lostPerf: null, retryAt: null },
  detail: null, // {cardId, data, rx, tab, section, error}
  dialog: null,
  busy: new Set(),
  toasts: [],
  theme: 'system',
  showAllDone: false,
  repos: null,
};

let socket = null;

// ── theme ────────────────────────────────────────────────────────────────────

function loadTheme() {
  try { state.theme = localStorage.getItem('board-theme') ?? 'system'; } catch { state.theme = 'system'; }
  applyTheme();
}
function applyTheme() {
  if (state.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
}
function setTheme(t) {
  state.theme = ['dark', 'light'].includes(t) ? t : 'system';
  try { localStorage.setItem('board-theme', state.theme); } catch { /* private mode */ }
  applyTheme();
  update();
}

// ── toasts ───────────────────────────────────────────────────────────────────

let toastSeq = 0;
function toast(text, tone = 'info') {
  const id = ++toastSeq;
  state.toasts = [...state.toasts, { id, text, tone }].slice(-3);
  update();
  setTimeout(() => { state.toasts = state.toasts.filter((t) => t.id !== id); update(); }, tone === 'error' ? 7000 : 4500);
}

// ── model ────────────────────────────────────────────────────────────────────

function buildModel() {
  const now = perf();
  const lost = state.conn.status === 'lost';
  // While disconnected the board shows states as of the drop; ages freeze.
  const clockNow = lost && state.conn.lostPerf != null ? state.conn.lostPerf : now;
  const entries = [...state.cards.values()].map(({ view, rx }) => {
    const elapsed_ms = Math.max(0, clockNow - rx);
    return { view, elapsed_ms, face: displayFace(view, { elapsed_ms, connection_lost: lost }) };
  });
  let detail = null;
  if (state.detail) {
    const d = state.detail;
    const elapsed_ms = d.rx != null ? Math.max(0, clockNow - d.rx) : 0;
    const data = d.data ? { ...d.data, feed: (d.data.feed ?? []).map((ev) => ({ ...ev, at_age_ms: ev.at_age_ms == null ? null : ev.at_age_ms + Math.max(0, clockNow - (ev._rx ?? d.rx)) })) } : null;
    detail = { ...d, data, elapsed_ms };
  }
  return {
    me: state.me,
    board: state.board,
    members: state.members,
    entries,
    alerts: alertsForViewer(state.me?.member?.id, entries),
    conn: { ...state.conn, retryInMs: state.conn.retryAt != null ? state.conn.retryAt - Date.now() : null },
    detail,
    dialog: state.dialog,
    busy: state.busy,
    theme: state.theme,
    showAllDone: state.showAllDone,
    openCardId: state.detail?.cardId ?? null,
    readOnly: state.me?.member?.role === 'viewer',
  };
}

function toasts() {
  return h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' },
    state.toasts.map((t) => h('p', { key: String(t.id), class: 'toast', 'data-tone': t.tone }, t.text)));
}

function screen() {
  if (state.auth === 'loading') return loadingScreen();
  if (state.auth !== 'ok') {
    return signinScreen({ status: state.auth, error: state.authError, devLogin: state.authMode === 'dev', busy: state.authBusy, email: state.email });
  }
  if (state.conn.status === 'upgrade') return loadingScreen('This page is older than the board. Reload to get the new version.');
  if (!state.board) return h('div', { class: 'app-shell' }, loadingScreen(state.conn.status === 'connecting' && state.conn.retryAt ? 'Can’t reach the board yet. Retrying…' : 'Loading the board…'), toasts());
  const model = buildModel();
  return h('div', { class: 'app-shell' }, boardScreen(model), drawer(model), dialog(model), toasts());
}

let queued = false;
function update() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    render(root, screen());
    syncDialogs();
  });
}

function syncDialogs() {
  for (const el of root.querySelectorAll('dialog[data-dialog]')) {
    if (!el.open) {
      el.showModal();
      const auto = el.querySelector('[autofocus]');
      if (auto) auto.focus();
      else if (el.dataset.dialog === 'drawer') el.querySelector('.drawer-title')?.setAttribute('tabindex', '-1');
    }
  }
  const sec = state.detail?.scrollTo;
  if (sec && state.detail?.data) {
    const target = root.querySelector(`#sec-${sec}`);
    if (target) { target.scrollIntoView({ block: 'start' }); state.detail.scrollTo = null; }
  }
}

// ── auth + boot ──────────────────────────────────────────────────────────────

async function boot() {
  state.auth = 'loading';
  update();
  // /api/health says whether this hub offers dev login (BOARD_AUTH=dev) or Access.
  if (state.authMode == null) {
    try { state.authMode = (await api.health()).auth ?? 'access'; } catch { state.authMode = 'access'; }
  }
  try {
    state.me = await api.me();
  } catch (err) {
    state.auth = err.status === 403 ? 'forbidden' : 'signed_out';
    state.email = err.extra?.email ?? null;
    state.authError = err.status === 401 || err.status === 403 ? null : errorText(err);
    update();
    return;
  }
  state.auth = 'ok';
  const wanted = new URLSearchParams(location.search).get('board');
  const boards = state.me.boards ?? [];
  state.boardId = boards.find((b) => b.id === wanted)?.id ?? boards[0]?.id ?? null;
  if (!state.boardId) { state.auth = 'forbidden'; update(); return; }
  document.title = `${boards.find((b) => b.id === state.boardId)?.name ?? 'Board'} · Claude Buddy`;
  socket?.close();
  socket = connectBoard({ boardId: state.boardId, onMessage, onStatus });
  update();
  openFromHash();
}

function onStatus({ status, retryAt }) {
  const prev = state.conn.status;
  if (status === 'signed_out') { socket?.close(); boot(); return; }
  if (status === 'lost' && prev !== 'lost') {
    state.conn.lostAt = new Date();
    state.conn.lostPerf = perf();
  }
  if (status === 'open') { state.conn.lostAt = null; state.conn.lostPerf = null; }
  state.conn.status = status;
  state.conn.retryAt = retryAt ?? null;
  update();
}

function onMessage(msg) {
  const now = perf();
  switch (msg.type) {
    case 'welcome': break;
    case 'snapshot': {
      if (msg.board_id !== state.boardId) return;
      state.board = msg.board;
      state.members = new Map(msg.members.map((m) => [m.member_id, m]));
      state.cards = new Map(msg.cards.map((c) => [c.id, { view: c, rx: now }]));
      if (state.detail) refreshDetail(state.detail.cardId);
      break;
    }
    case 'card.upsert': {
      if (msg.board_id !== state.boardId) return;
      state.cards.set(msg.card.id, { view: msg.card, rx: now });
      if (state.detail?.cardId === msg.card.id) refreshDetailSoon(msg.card.id);
      break;
    }
    case 'card.remove': {
      state.cards.delete(msg.card_id);
      if (state.detail?.cardId === msg.card_id) closeDrawer();
      break;
    }
    case 'lease.tick': {
      const c = state.cards.get(msg.card_id);
      if (!c) return;
      state.cards.set(msg.card_id, { view: { ...c.view, live: msg.live, state_age_ms: msg.state_age_ms }, rx: now });
      break;
    }
    case 'event.append': {
      const d = state.detail;
      if (d?.cardId === msg.card_id && d.data) {
        const feed = d.data.feed ?? [];
        if (!feed.some((e) => e.id === msg.event.id)) d.data = { ...d.data, feed: [...feed, { ...msg.event, _rx: now }].slice(-200) };
      }
      break;
    }
    case 'error': if (msg.code !== 'VALIDATION') toast(msg.message, 'error'); break;
    default: break;
  }
  update();
}

// ── detail drawer ────────────────────────────────────────────────────────────

async function openDetail(cardId, section = null) {
  if (!state.cards.has(cardId)) return;
  const tab = section === 'handover' || section === 'comments' ? section : (state.detail?.cardId === cardId ? state.detail.tab : 'activity');
  state.detail = { cardId, data: state.detail?.cardId === cardId ? state.detail.data : null, rx: state.detail?.rx ?? null, tab, scrollTo: ['asks', 'overlaps'].includes(section) ? section : null, error: null };
  try { history.replaceState(null, '', `#card=${encodeURIComponent(cardId)}`); } catch { /* sandboxed */ }
  update();
  await refreshDetail(cardId);
}

async function refreshDetail(cardId) {
  try {
    const data = await api.card(cardId);
    if (state.detail?.cardId !== cardId) return;
    state.detail = { ...state.detail, data, rx: perf(), error: null };
  } catch (err) {
    if (state.detail?.cardId !== cardId) return;
    state.detail = { ...state.detail, error: errorText(err) };
  }
  update();
}

let detailTimer = null;
function refreshDetailSoon(cardId) {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(() => refreshDetail(cardId), 250);
}

function closeDrawer() {
  const id = state.detail?.cardId;
  state.detail = null;
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* sandboxed */ }
  update();
  if (id) queueMicrotask(() => root.querySelector(`[data-card-id="${CSS.escape(id)}"] .card-open`)?.focus());
}

function openFromHash() {
  const m = location.hash.match(/^#card=(.+)$/);
  if (!m) return;
  const id = decodeURIComponent(m[1]);
  const tryOpen = () => { if (state.cards.has(id)) openDetail(id); else if (state.conn.status !== 'open') setTimeout(tryOpen, 200); };
  tryOpen();
}

// ── actions ──────────────────────────────────────────────────────────────────

async function withBusy(key, fn) {
  if (state.busy.has(key)) return undefined;
  state.busy.add(key);
  update();
  try {
    return await fn();
  } catch (err) {
    toast(errorText(err), 'error');
    if (err.code === 'VERSION_CONFLICT' || err.code === 'ILLEGAL_TRANSITION') refreshBoardCard(err);
    if (err.code === 'ALREADY_ANSWERED' && state.detail) refreshDetail(state.detail.cardId);
    if (err.code === 'UNAUTHENTICATED') boot();
    return undefined;
  } finally {
    state.busy.delete(key);
    update();
  }
}

function refreshBoardCard() {
  if (state.detail) refreshDetail(state.detail.cardId);
}

function applyCard(res) {
  if (res?.card) state.cards.set(res.card.id, { view: res.card, rx: perf() });
}

const viewOf = (id) => state.cards.get(id)?.view;
const keyOf = (id) => viewOf(id)?.key ?? 'Card';

async function doAction(cardId, action, body = {}, done) {
  const res = await withBusy(`${cardId}:${action}`, () => api.action(cardId, action, body));
  if (res) {
    applyCard(res);
    if (done) toast(done);
    if (state.detail?.cardId === cardId) refreshDetailSoon(cardId);
  }
  return res;
}

const DONE_COPY = {
  cancel: (k) => `${k} is back in To do.`,
  retry: (k) => `${k} is queued again.`,
  take_over: (k) => `You took over ${k}.`,
  take_over_myself: (k) => `${k} is yours now.`,
  approve_done: (k) => `${k} is done.`,
  stop: (k) => `Stopped ${k}.`,
};

async function loadRepos() {
  if (state.repos) return state.repos;
  try {
    const res = await api.repos();
    state.repos = res.repos ?? res ?? [];
  } catch { state.repos = []; }
  return state.repos;
}

async function openGive(cardId, mode) {
  const v = viewOf(cardId);
  if (!v) return;
  state.dialog = {
    kind: 'give', cardId, mode,
    target: state.me.member.id,
    repo_id: v.repo?.id ?? '',
    base_ref: v.base_ref ?? '',
    budget_usd: v.budget?.cap_usd ?? 5,
    plan_approval: (v.labels ?? []).includes(PLAN_LABEL),
    repos: state.repos,
    preview: { loading: true },
  };
  update();
  const repos = await loadRepos();
  if (state.dialog?.cardId === cardId) {
    const d = state.dialog;
    if (!d.base_ref && d.repo_id) d.base_ref = repos.find((r) => r.id === d.repo_id)?.default_branch ?? '';
    state.dialog = { ...d, repos };
  }
  update();
  loadPreview();
}

// The hub reads plan approval from this card label (CONTRACT §10.2).
const PLAN_LABEL = PLAN_APPROVAL_LABEL;

async function loadPreview() {
  const d = state.dialog;
  if (d?.kind !== 'give') return;
  const target = d.target === state.me.member.id ? null : d.target;
  const token = {};
  d.previewToken = token;
  state.dialog = { ...d, preview: { loading: true }, previewToken: token };
  update();
  try {
    const res = await api.overlapPreview(d.cardId, target);
    if (state.dialog?.previewToken !== token) return;
    state.dialog = { ...state.dialog, preview: { overlaps: res.overlaps ?? [], sponsor: res.sponsor ?? null } };
  } catch (err) {
    if (state.dialog?.previewToken !== token) return;
    state.dialog = { ...state.dialog, preview: { error: errorText(err) } };
  }
  update();
}

async function submitGive(form) {
  const d = state.dialog;
  const v = viewOf(d.cardId);
  const fd = new FormData(form);
  const target = fd.get('target') || state.me.member.id;
  const repo_id = fd.get('repo_id') || null;
  const base_ref = String(fd.get('base_ref') ?? '').trim() || null;
  const budget = Number(fd.get('budget_usd'));
  const wantPlan = fd.get('plan_approval') === 'on';
  if (!repo_id) { state.dialog = { ...d, error: 'Pick a repo first. Claude only works inside a repo.' }; update(); return; }
  state.dialog = { ...d, busy: true, error: null };
  update();
  try {
    const labels = new Set(v.labels ?? []);
    if (wantPlan) labels.add(PLAN_LABEL); else labels.delete(PLAN_LABEL);
    const patch = {};
    if (repo_id !== (v.repo?.id ?? null)) patch.repo_id = repo_id;
    if (base_ref !== (v.base_ref ?? null)) patch.base_ref = base_ref;
    if (labels.size !== (v.labels ?? []).length || [...labels].some((l) => !(v.labels ?? []).includes(l))) patch.labels = [...labels];
    if (Object.keys(patch).length) applyCard(await api.patchCard(d.cardId, { version: v.version, ...patch }));
    const isMe = target === state.me.member.id;
    const action = d.mode === 'redispatch' ? 'take_over_with_claude' : 'dispatch';
    const body = { target_member_id: isMe ? null : target };
    if (d.mode !== 'redispatch') body.backend = 'claude_cli';
    // Additive field (CONTRACT §9): the hub ignores it until it accepts a per-dispatch budget.
    if (Number.isFinite(budget) && budget > 0) body.budget_usd = budget;
    const res = await api.action(d.cardId, action, body);
    applyCard(res);
    state.dialog = null;
    const name = state.members.get(target)?.name;
    toast(isMe ? `${v.key} is queued for your Claude.` : `Asked ${name}'s Claude. ${name} confirms before it starts.`);
  } catch (err) {
    state.dialog = { ...state.dialog, busy: false, error: errorText(err) };
  }
  update();
}

async function submitDialogForm(form, submitter) {
  const kind = form.dataset.form;
  const d = state.dialog;
  const cardId = form.dataset.card;
  const fd = new FormData(form);
  const run = async (fn, doneText) => {
    state.dialog = { ...d, busy: true, error: null };
    update();
    try {
      applyCard(await fn());
      state.dialog = null;
      if (doneText) toast(doneText);
      if (state.detail?.cardId === cardId) refreshDetailSoon(cardId);
    } catch (err) {
      state.dialog = state.dialog ? { ...state.dialog, busy: false, error: errorText(err) } : null;
    }
    update();
  };
  if (kind === 'confirm') {
    const action = form.dataset.confirm;
    const hubAction = action === 'take_over_confirm' ? 'take_over' : action;
    const body = action === 'take_over_confirm' ? { confirm: true } : {};
    return run(() => api.action(cardId, hubAction, body), DONE_COPY[hubAction]?.(keyOf(cardId)));
  }
  if (kind === 'handover') {
    const k = fd.get('kind') ?? 'queue';
    const target = k === 'member' ? { kind: 'member', member_id: fd.get('member_id') } : { kind: k };
    return run(() => api.action(cardId, 'hand_over', { target }), `${keyOf(cardId)} is handing over. Claude is writing its final handover.`);
  }
  if (kind === 'changes') {
    return run(() => api.action(cardId, 'request_changes', { comment: String(fd.get('comment') ?? '').trim() }), `Sent ${keyOf(cardId)} back to Claude with your notes.`);
  }
  if (kind === 'new') {
    const labels = String(fd.get('labels') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const budget = Number(fd.get('budget_usd'));
    const body = {
      title: String(fd.get('title') ?? '').trim(),
      body: String(fd.get('body') ?? '').trim() || undefined,
      acceptance: String(fd.get('acceptance') ?? '').trim() || undefined,
      repo_id: fd.get('repo_id') || undefined,
      base_ref: String(fd.get('base_ref') ?? '').trim() || undefined,
      labels: labels.length ? labels : undefined,
      budget_usd: Number.isFinite(budget) && budget > 0 ? budget : undefined,
    };
    return run(() => api.createCard(state.boardId, body), `Created “${body.title}”.`);
  }
  if (kind === 'give') return submitGive(form);
  if (kind === 'answer') {
    const askId = form.dataset.ask;
    const answer = submitter?.name === 'option' ? submitter.value : String(fd.get('answer') ?? '').trim();
    if (!answer) return undefined;
    const res = await withBusy(`ask:${askId}`, () => api.action(cardId, 'answer', { ask_id: askId, answer }));
    if (res) { applyCard(res); toast('Answer sent. Claude picks it up at its next step.'); refreshDetail(cardId); }
    return undefined;
  }
  if (kind === 'comment') {
    const body = String(fd.get('body') ?? '').trim();
    if (!body) return undefined;
    const res = await withBusy(`comment:${cardId}`, () => api.comment(cardId, body, fd.get('for_agent') === 'on'));
    if (res) { form.reset(); refreshDetail(cardId); }
    return undefined;
  }
  if (kind === 'devlogin') {
    const login = submitter?.name === 'login' ? submitter.value : String(fd.get('github_login') ?? '').trim();
    if (!login) return undefined;
    state.authBusy = true;
    update();
    try { await api.devLogin(login); state.authError = null; await boot(); } catch (err) {
      state.authError = err.status === 404 ? 'Dev login is off on this hub.' : errorText(err);
    }
    state.authBusy = false;
    update();
  }
  return undefined;
}

async function openNewCard() {
  state.dialog = { kind: 'new', repos: state.repos };
  update();
  const repos = await loadRepos();
  if (state.dialog?.kind === 'new') { state.dialog = { ...state.dialog, repos }; update(); }
}

async function moveCard(cardId, column) {
  const v = viewOf(cardId);
  if (!v || !isHumanOwned(v) || v.column === column) return;
  // Optimistic: human-owned cards move immediately, the hub confirms.
  state.cards.set(cardId, { view: { ...v, column }, rx: state.cards.get(cardId).rx });
  update();
  const res = await withBusy(`${cardId}:move`, () => api.patchCard(cardId, { version: v.version, column }));
  if (res) applyCard(res);
  else state.cards.set(cardId, { view: v, rx: state.cards.get(cardId)?.rx ?? perf() });
  update();
}

// ── DOM events ───────────────────────────────────────────────────────────────

function onClick(e) {
  const dlg = e.target.closest?.('dialog[data-dialog]');
  if (dlg && e.target === dlg) {
    // Backdrop click closes (the dialog element itself only receives clicks outside its content box).
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    return;
  }
  const el = e.target.closest?.('[data-action]');
  if (!el || el.disabled) return;
  const action = el.dataset.action;
  const cardId = el.dataset.card;
  switch (action) {
    case 'open': e.preventDefault(); openDetail(cardId, el.dataset.section ?? null); return;
    case 'watch': openDetail(cardId, 'activity'); return;
    case 'allow': case 'deny': case 'answer': case 'approve_plan': case 'resolve_conflict': case 'continue':
      openDetail(cardId, 'asks'); return;
    case 'give_to_claude': openGive(cardId, 'dispatch'); return;
    case 'take_over_with_claude': openGive(cardId, 'redispatch'); return;
    case 'stop': case 'cancel': case 'take_over_confirm':
      state.dialog = { kind: 'confirm', action, cardId }; update(); return;
    case 'take_over': case 'take_over_myself': case 'retry': case 'approve_done':
      doAction(cardId, action, {}, DONE_COPY[action]?.(keyOf(cardId))); return;
    case 'request_changes': state.dialog = { kind: 'changes', cardId }; update(); return;
    case 'hand_over': state.dialog = { kind: 'handover', cardId, kind_: 'queue' }; update(); return;
    case 'permission': {
      const prId = el.dataset.pr;
      withBusy(`pr:${prId}`, () => api.answerPermission(prId, el.dataset.decision, el.dataset.scope)).then((res) => {
        if (!res) return;
        applyCard(res);
        toast(el.dataset.decision === 'deny' ? 'Denied. Claude is told why it can’t run that.' : 'Allowed. Claude continues.');
        if (state.detail) refreshDetail(state.detail.cardId);
      });
      return;
    }
    case 'tab': if (state.detail) { state.detail = { ...state.detail, tab: el.dataset.tab }; update(); } return;
    case 'close-drawer': root.querySelector('dialog[data-dialog="drawer"]')?.close(); return;
    case 'close-dialog': el.closest('dialog')?.close(); return;
    case 'new-card': openNewCard(); return;
    case 'theme': setTheme(el.dataset.next); return;
    case 'reconnect': socket?.reconnectNow(); return;
    case 'toggle-done': state.showAllDone = !state.showAllDone; update(); return;
    case 'access-login': e.preventDefault(); location.reload(); return;
    default:
  }
}

function onSubmit(e) {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  submitDialogForm(form, e.submitter);
}

function onChange(e) {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const what = el.dataset.change;
  if (what === 'give-target' && state.dialog?.kind === 'give') { state.dialog = { ...state.dialog, target: el.value }; loadPreview(); }
  if (what === 'give-repo' && state.dialog?.kind === 'give') {
    const repo = state.repos?.find((r) => r.id === el.value);
    const form = el.form;
    state.dialog = { ...state.dialog, repo_id: el.value, base_ref: form?.base_ref?.value || repo?.default_branch || '' };
    update();
  }
  if (what === 'handover-kind' && state.dialog?.kind === 'handover') { state.dialog = { ...state.dialog, kind_: el.value }; update(); }
  if (what === 'move') moveCard(el.dataset.card, el.value);
}

// Dialog close (Escape, backdrop, close buttons) is the one path back to state.
function onDialogClose(e) {
  const el = e.target;
  if (!(el instanceof HTMLDialogElement) || !el.dataset.dialog) return;
  if (el.dataset.dialog === 'drawer') { if (state.detail) closeDrawer(); } else if (state.dialog) { state.dialog = null; update(); }
}

function onKeydown(e) {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'n' && state.auth === 'ok' && state.board && !root.querySelector('dialog[open]')) {
    e.preventDefault();
    openNewCard();
    return;
  }
  const tab = e.target.closest?.('[role="tab"]');
  if (tab && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End')) {
    const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
    let i = tabs.indexOf(tab);
    i = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault();
    state.detail = { ...state.detail, tab: tabs[i].dataset.tab };
    update();
    queueMicrotask(() => root.querySelector(`#tab-${tabs[i].dataset.tab}`)?.focus());
  }
}

// Drag and drop: human-owned cards only. Agent-driven cards move by run state.
let dragId = null;
function onDragStart(e) {
  const cardEl = e.target.closest?.('[data-card-id][draggable="true"]');
  if (!cardEl) return;
  dragId = cardEl.dataset.cardId;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
  cardEl.classList.add('is-dragging');
}
function onDragOver(e) {
  if (!dragId) return;
  const zone = e.target.closest?.('[data-drop]');
  if (!zone) return;
  e.preventDefault();
  for (const z of root.querySelectorAll('.column.is-drop')) if (z !== zone.parentElement) z.classList.remove('is-drop');
  zone.parentElement.classList.add('is-drop');
}
function onDrop(e) {
  const zone = e.target.closest?.('[data-drop]');
  if (!zone || !dragId) return;
  e.preventDefault();
  moveCard(dragId, zone.dataset.drop);
}
function onDragEnd() {
  dragId = null;
  for (const z of root.querySelectorAll('.is-drop, .is-dragging')) z.classList.remove('is-drop', 'is-dragging');
}

function onImgError(e) {
  if (e.target instanceof HTMLImageElement && e.target.hasAttribute('data-avatar')) e.target.remove();
}

document.addEventListener('click', onClick);
document.addEventListener('submit', onSubmit);
document.addEventListener('change', onChange);
document.addEventListener('keydown', onKeydown);
document.addEventListener('close', onDialogClose, true);
document.addEventListener('dragstart', onDragStart);
document.addEventListener('dragover', onDragOver);
document.addEventListener('drop', onDrop);
document.addEventListener('dragend', onDragEnd);
document.addEventListener('error', onImgError, true);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => update());

// Ages advance between pushes (§5.1): re-derive every face once a second.
setInterval(() => { if (state.auth === 'ok' && state.board) update(); }, 1000);

loadTheme();
boot();
