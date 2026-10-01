// The board app: state, the /ws/board stream, HTTP actions, and one render
// loop. Rendering is a pure function of `state` (render-*.js); this file owns
// clocks, network and DOM events.
import { h, render } from './h.js';
import { tacklePreference, rememberTackle } from './tackle.js';
import { api, errorText, setOrg, currentOrg, setCsrf } from './api.js';
import { connectBoard } from './socket.js';
import { displayFace, alertsForViewer, agedView } from './view.js';
import { planMoves, moveSummary, dragModel, toggleSelection, pruneSelection, idsToDrag, kbdStart, kbdKey, announcement } from './dnd.js';
import { emptyFilters, isFiltering, parseFilters, writeFilters, toggleIn, applyFilters, filterOptions } from './filters.js';
import { parseTitles, needsConfirm, pendingCard } from './quickadd.js';
import { installDnd, snapshotRects, playFlip } from './dnd-dom.js';
import { boardScreen, loadingScreen, THEME_NEXT } from './render-board.js';
import { paletteResults } from './palette.js';
import { starterWorkflow } from './render-workflows.js';
import { normalizeBg, normalizeTheme } from './themes.js';
import { tableScreen } from './render-table.js';
import { DEFAULT_SORT, nextSort } from './table.js';
import { dashboardScreen } from './render-dashboard.js';
import { integrationsScreen, connectWindowTarget, takeInput } from './render-integrations.js';
import { teamScreen } from './render-team.js';
import { emptyFold, pullJournal, windowMetrics, cardMetrics } from './metrics.js';
import { VIEWS } from './views.js';
import { drawer } from './render-drawer.js';
import { colorMap } from './labels.js';
import { dialog } from './render-dialogs.js';
import { decodeFeedback, sendFeedback, canSend, ARM_MS, FRAGMENT_PREFIX } from './feedback-send.js';
import { signinScreen, noTeamScreen } from './render-signin.js';
import { accountErrorText, parseJoin } from './account-text.js';
import { PLAN_APPROVAL_LABEL } from '../../shared/states.js';
import { BRAND } from '../../shared/brand.js';

const root = document.getElementById('root');
const perf = () => performance.now();

const state = {
  auth: 'loading', // loading | signed_out | forbidden | no_team (accounts: signed in, no team yet) | ok
  authMode: null, // /api/health auth: 'dev' | 'access' | 'accounts' | 'local'
  authError: null,
  authBusy: false,
  methods: null, // accounts: GET /api/auth/methods, for the signed-out screen
  onboard: { busy: false, error: null, where: null }, // the no-team screen's forms
  invite: { busy: false, error: null, made: null }, // Team view: the invite just made (its link and code, shown once)
  localCardDismissed: false,
  email: null,
  me: null,
  boardId: null,
  board: null,
  boards: [],
  members: new Map(),
  cards: new Map(), // id → {view, rx}
  conn: { status: 'connecting', lostAt: null, lostPerf: null, retryAt: null },
  detail: null, // {cardId, data, rx, tab, section, error}
  dialog: null,
  busy: new Set(),
  toasts: [],
  theme: 'system',
  bg: 'none', // board background (themes.js), per browser
  themeMenu: false,
  showAllDone: false,
  repos: null,
  view: 'board',
  table: { sort: DEFAULT_SORT },
  filters: emptyFilters(), // shared by Board and Table; lives in ?q= &f= and sessionStorage
  dash: null, // set below: freshDash(), status idle | loading | ok | error
  integ: { status: 'idle', data: null, error: null, open: null, audit: {}, tokenFor: null, manifest: null, confirmDisconnect: null },
  cardsRev: 0,
  selection: new Set(), // card ids picked with Shift/⌘-click
  drag: null, // pointer drag in flight: {ids, over, mode}
  kbd: null, // keyboard pick-up: {ids, from, over}
  announce: '',
  quickAdd: null, // inline add-a-card: {open, seed, confirm: titles|null, keep}
  // Archived cards (D94) are not in the snapshot: "Show archived" fetches them into their own map.
  showArchived: false,
  archived: null, // id → {view, rx} while showArchived
  // team.presence (D37b). `stale` from a socket drop until the next frame.
  presence: { members: [], loaded: false, stale: false },
  overview: { status: 'idle', data: null, error: null, updatedAt: null },
};

let socket = null;
let boardGeneration = 0;
const boardReadOnly = () => state.me?.member?.role === 'viewer' || !!state.board?.archived_at;

// ── theme ────────────────────────────────────────────────────────────────────

function loadLocalCard() {
  try { state.localCardDismissed = localStorage.getItem('board-local-card') === 'dismissed'; } catch { state.localCardDismissed = false; }
}
function loadTheme() {
  try { state.theme = normalizeTheme(localStorage.getItem('board-theme')); } catch { state.theme = 'system'; }
  try { state.bg = normalizeBg(localStorage.getItem('board-bg')); } catch { state.bg = 'none'; }
  applyTheme();
}
function applyTheme() {
  const d = document.documentElement.dataset;
  if (state.theme === 'system') delete d.theme; else d.theme = state.theme;
  if (state.bg === 'none') delete d.boardBg; else d.boardBg = state.bg;
}
function setTheme(t) {
  state.theme = normalizeTheme(t);
  try { localStorage.setItem('board-theme', state.theme); } catch { /* private mode */ }
  applyTheme();
  update();
}
function setBg(b) {
  state.bg = normalizeBg(b);
  try { localStorage.setItem('board-bg', state.bg); } catch { /* private mode */ }
  applyTheme();
  update();
}
function closeThemeMenu({ refocus = false } = {}) {
  if (!state.themeMenu) return;
  state.themeMenu = false;
  renderNow();
  if (refocus) root.querySelector('[data-action="theme-menu"]')?.focus();
}

// ── views ───────────────────────────────────────────────────────────────────
// ?view= wins (the app window's sidebar links straight to a view), then the
// last one this browser used.

function loadView() {
  const want = new URLSearchParams(location.search).get('view');
  let saved = null;
  try { saved = localStorage.getItem('board-view'); } catch { /* private mode */ }
  state.view = VIEWS.some((v) => v.id === want) ? want : VIEWS.some((v) => v.id === saved) ? saved : 'board';
}
function setView(v) {
  if (!VIEWS.some((x) => x.id === v) || state.view === v) return;
  state.view = v;
  if (v === 'dashboard') loadJournal();
  if (v === 'integrations') loadIntegrations();
  if (v === 'team' && state.board) { presenceFallbackSoon(); loadTeamOverview(); }
  // Team pages are opened from the app sidebar; only board views are remembered.
  if (VIEWS.find((x) => x.id === v)?.switcher !== false) { try { localStorage.setItem('board-view', v); } catch { /* private mode */ } }
  try {
    const q = new URLSearchParams(location.search);
    q.set('view', v);
    history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
  } catch { /* sandboxed */ }
  update();
}

// ── filters ──────────────────────────────────────────────────────────────────
// The URL wins (a shared link shows the same cards); otherwise this tab's last
// filters come back after a reload.

function loadFilters() {
  const q = new URLSearchParams(location.search);
  if (q.has('q') || q.has('f')) { state.filters = parseFilters(location.search); return; }
  try { state.filters = parseFilters(sessionStorage.getItem('board-filters') ?? ''); } catch { /* storage off */ }
}
function setFilters(next) {
  state.filters = next;
  try {
    const q = writeFilters(next, new URLSearchParams(location.search));
    history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}${location.hash}`);
  } catch { /* sandboxed */ }
  try { sessionStorage.setItem('board-filters', writeFilters(next, new URLSearchParams()).toString()); } catch { /* storage off */ }
  update();
}

// ── integrations ─────────────────────────────────────────────────────────────

async function loadIntegrations() {
  state.integ = { ...state.integ, status: 'loading' };
  update();
  try {
    state.integ = { ...state.integ, status: 'ok', data: await api.integrations(), error: null };
  } catch (err) {
    state.integ = { ...state.integ, status: 'error', error: errorText(err) };
  }
  update();
}

// `input`: a start form's values (takeInput already emptied the fields); sent, never kept.
async function connectIntegration(provider, kind, input) {
  if (kind === 'token') { state.integ = { ...state.integ, tokenFor: provider }; update(); return; }
  const res = await withBusy(`integ-connect:${provider}`, () => api.startConnect(provider, input));
  if (res?.form && res.bind) {
    // Submitted by the admin from the page; same window target as a link.
    state.integ = { ...state.integ, manifest: { provider, ...res.form, target: connectWindowTarget(provider, res.bind, navigator.userAgent) } };
    update();
    return;
  }
  if (!res?.url || !res.bind) return;
  window.open(res.url, connectWindowTarget(provider, res.bind, navigator.userAgent), 'noopener');
  update();
}

async function submitIntegrationToken(form) {
  const provider = form.dataset.provider;
  const token = String(new FormData(form).get('token') ?? '').trim();
  if (!token) return;
  const res = await withBusy(`integ-connect:${provider}`, () => api.connectToken(provider, token));
  if (res) { state.integ = { ...state.integ, tokenFor: null }; toast('Connected.'); loadIntegrations(); }
}

// Pending connections (D97). The pasted values leave the form at once and
// never enter state: takeInput clears the inputs before the request goes.
function preparedAnswer(provider, res) {
  if (!res?.pending) return;
  if (res.needs) state.integ = { ...state.integ, needs: { ...state.integ.needs, [res.pending.id]: res.needs } };
  if (res.url && res.bind) window.open(res.url, connectWindowTarget(provider, res.bind, navigator.userAgent), 'noopener');
  loadIntegrations();
}

async function submitPrepare(form) {
  const pendingId = form.dataset.pending;
  const provider = pendingId ? state.integ.data?.pending?.find((p) => p.id === pendingId)?.provider : form.dataset.provider;
  const input = takeInput(form);
  if (!provider || !Object.keys(input).length) return;
  const key = pendingId ? `integ-pending:${pendingId}` : `integ-connect:${provider}`;
  preparedAnswer(provider, await withBusy(key, () => api.prepareIntegration(pendingId ?? provider, input)));
}

async function pasteInstead(provider) {
  preparedAnswer(provider, await withBusy(`integ-connect:${provider}`, () => api.prepareIntegration(provider, {})));
}

async function authorizePending(id, provider) {
  const res = await withBusy(`integ-pending:${id}`, () => api.authorizeIntegration(id));
  if (res?.url && res.bind) window.open(res.url, connectWindowTarget(provider, res.bind, navigator.userAgent), 'noopener');
}

// Identity links (D98): the provider's sign-in opens in the same connect window as D42.
async function linkIdentity(id, provider) {
  const res = await withBusy(`integ-link:${id}`, () => api.startIdentityLink(id));
  if (res?.url && res.bind) window.open(res.url, connectWindowTarget(provider, res.bind, navigator.userAgent), 'noopener');
}

async function unlinkIdentity(id) {
  const res = await withBusy(`integ-link:${id}`, () => api.unlinkIdentity(id));
  if (res) { toast('Unlinked.'); loadIntegrations(); }
}

async function toggleLinked(id) {
  if (state.integ.linked?.[id]) {
    const { [id]: _, ...rest } = state.integ.linked;
    state.integ = { ...state.integ, linked: rest };
    update();
    return;
  }
  const res = await withBusy(`integ-link:${id}`, () => api.linkedMembers(id));
  if (res?.identities) { state.integ = { ...state.integ, linked: { ...state.integ.linked, [id]: res.identities } }; update(); }
}

async function revokeIdentity(id, memberId) {
  const res = await withBusy(`integ-link:${id}`, () => api.revokeIdentity(id, memberId));
  if (!res) return;
  state.integ = { ...state.integ, linked: { ...state.integ.linked, [id]: (state.integ.linked?.[id] ?? []).filter((x) => x.member_id !== memberId) } };
  toast('Link revoked.');
  update();
}

async function cancelPending(id) {
  const res = await withBusy(`integ-pending:${id}`, () => api.disconnectIntegration(id));
  state.integ = { ...state.integ, confirmCancel: null };
  if (res) { toast('Setup cancelled.'); loadIntegrations(); } else update();
}

async function toggleActivity(id) {
  const open = state.integ.open === id ? null : id;
  state.integ = { ...state.integ, open };
  update();
  if (!open) return;
  try {
    const res = await api.integrationAudit(id);
    state.integ = { ...state.integ, audit: { ...state.integ.audit, [id]: res.entries ?? [] } };
  } catch (err) {
    state.integ = { ...state.integ, audit: { ...state.integ.audit, [id]: [] }, error: errorText(err) };
  }
  update();
}

async function setAutonomy(id, action, mode) {
  const conn = state.integ.data?.connections?.find((c) => c.id === id);
  if (!conn) return;
  const autonomy = { ...(conn.settings?.autonomy ?? {}), [action]: mode };
  const res = await withBusy(`integ:${id}`, () => api.patchIntegration(id, { autonomy }));
  if (res?.connection) {
    state.integ = { ...state.integ, data: { ...state.integ.data, connections: state.integ.data.connections.map((c) => (c.id === id ? res.connection : c)) } };
    update();
  }
}

async function disconnectIntegration(id) {
  const res = await withBusy(`integ:${id}`, () => api.disconnectIntegration(id));
  state.integ = { ...state.integ, confirmDisconnect: null };
  if (res) { toast('Disconnected.'); loadIntegrations(); } else update();
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
  const entries = [...state.cards.values(), ...(state.showArchived && state.archived ? state.archived.values() : [])].map(({ view, rx }) => {
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
  const labelColors = Array.isArray(state.board?.labels) ? colorMap(state.board.labels) : null;
  const fctx = { viewerId: state.me?.member?.id, members: state.members, labelColors };
  const filtered = applyFilters(entries, state.filters, fctx);
  const live = entries.filter((e) => !e.view.archived);
  return {
    me: state.me,
    board: state.board,
    boards: state.boards,
    members: state.members,
    entries,
    visible: filtered.entries,
    filters: state.filters,
    filterInfo: { total: filtered.total, shown: filtered.shown, options: filterOptions(entries, fctx), archived: state.archived?.size ?? null },
    labelColors,
    showArchived: state.showArchived,
    alerts: alertsForViewer(state.me?.member?.id, live),
    conn: { ...state.conn, retryInMs: state.conn.retryAt != null ? state.conn.retryAt - Date.now() : null },
    detail,
    dialog: state.dialog,
    busy: state.busy,
    theme: state.theme,
    bg: state.bg,
    themeMenu: state.themeMenu,
    showAllDone: state.showAllDone,
    selection: state.selection,
    kbd: state.kbd,
    announce: state.announce,
    quickAdd: state.quickAdd,
    drag: state.drag || state.kbd ? dragModel(state.drag ?? { ids: state.kbd.ids, over: state.kbd.over, mode: 'keyboard' }, entries) : null,
    openCardId: state.detail?.cardId ?? null,
    readOnly: boardReadOnly(),
    view: state.view,
    table: state.table,
    dashboard: state.view === 'dashboard' ? dashboardModel(live) : null,
    localCard: state.authMode === 'local' && !state.localCardDismissed,
    accounts: state.authMode === 'accounts',
    invite: state.invite,
    integrations: state.view === 'integrations' ? { ...state.integ, nowMs: Date.now(), local: state.authMode === 'local' } : null,
    presence: { ...state.presence, stale: state.presence.stale || lost },
    teamOverview: { ...state.overview, stale: lost || !!state.overview.error || (state.overview.updatedAt != null && Date.now() - state.overview.updatedAt > 45_000), ageMs: state.overview.updatedAt == null ? null : Date.now() - state.overview.updatedAt },
    // Presence ages freeze at the drop, like card ages.
    nowMs: lost && state.conn.lostAt ? state.conn.lostAt.getTime() : Date.now(),
  };
}

// ── dashboard ────────────────────────────────────────────────────────────────
// Journal pages are folded into per-card histories as they arrive (metrics.js)
// and dropped, and the journal is append-only, so after the first full read a
// refresh only asks for rows past the last seq. Refreshes: on opening the
// view, every 60 s while it is open and visible, and after card changes at
// most once per 10 s (the first change after a refresh schedules it, later
// ones ride along: a throttle, not a debounce).

const JOURNAL_PAGE = 1000;
const DASH_REFRESH_MS = 60_000;
const DASH_UPSERT_THROTTLE_MS = 10_000;
let dashToken = 0;

const freshDash = () => ({ status: 'idle', fold: emptyFold(), offset: 0, error: null, updatedAt: null, epoch: null });
state.dash = freshDash();

async function loadJournal() {
  if (!state.boardId || state.dash.status === 'loading') return;
  const token = ++dashToken;
  const boardId = state.boardId;
  state.dash = { ...state.dash, status: 'loading' };
  update();
  try {
    const res = await pullJournal(state.dash.fold, (after, limit) => api.journal(boardId, after, limit), { pageSize: JOURNAL_PAGE });
    if (token !== dashToken) return;
    state.dash = { ...state.dash, status: 'ok', fold: res.fold, offset: res.offset ?? state.dash.offset, error: null, updatedAt: Date.now() };
  } catch (err) {
    if (token !== dashToken) return;
    state.dash = { ...state.dash, status: 'error', error: errorText(err) };
  }
  update();
}

function resetDashboard() {
  dashToken++;
  state.dash = freshDash();
  winMemo = null;
  cardMemo = null;
}

// A new hub epoch (a restart, or a restore that may have rewritten history
// the fold holds) drops the fold: one full re-read per restart.
function onHubEpoch(epoch) {
  const prev = state.dash.epoch;
  if (prev && epoch && prev !== epoch) {
    resetDashboard();
    if (state.view === 'dashboard') loadJournal();
  }
  state.dash.epoch = epoch ?? null;
}

let dashUpsertTimer = null;
function dashboardSoon() {
  if (state.view !== 'dashboard' || dashUpsertTimer) return;
  dashUpsertTimer = setTimeout(() => { dashUpsertTimer = null; if (state.view === 'dashboard') loadJournal(); }, DASH_UPSERT_THROTTLE_MS);
}

// The window sums walk every card's history: only when rows arrive or the
// minute turns. The join with live cards is cheap and runs on card changes.
let winMemo = null;
let cardMemo = null;
function dashboardModel(entries) {
  const d = state.dash;
  const base = { status: d.status, error: d.error, updated_at: d.updatedAt, metrics: null };
  if (d.updatedAt == null) return base;
  // Journal times are the hub's; so is "now".
  const now = Date.now() + d.offset;
  const minute = Math.floor(now / 60_000);
  if (winMemo?.fold !== d.fold || winMemo.version !== d.fold.version || winMemo.minute !== minute) {
    winMemo = { fold: d.fold, version: d.fold.version, minute, win: windowMetrics(d.fold, now) };
    cardMemo = null;
  }
  if (cardMemo?.rev !== state.cardsRev) {
    cardMemo = { rev: state.cardsRev, metrics: cardMetrics(winMemo.win, d.fold, entries.map((e) => agedView(e.view, e.elapsed_ms))) };
  }
  return { ...base, metrics: cardMemo.metrics };
}

function toasts() {
  return h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' },
    state.toasts.map((t) => h('p', { key: String(t.id), class: 'toast', 'data-tone': t.tone }, t.text)));
}

function screen() {
  if (state.auth === 'loading') return loadingScreen();
  if (state.auth === 'no_team') return h('div', { class: 'app-shell' }, noTeamScreen({ invites: state.me?.pending_invites ?? [], onboard: state.onboard }), toasts());
  if (state.auth !== 'ok') {
    return signinScreen({ status: state.auth, error: state.authError, devLogin: state.authMode === 'dev', accounts: state.authMode === 'accounts', emailOff: state.methods?.email === false, devSecretKnown: !!devSecret(), busy: state.authBusy, email: state.email });
  }
  if (state.conn.status === 'upgrade') return loadingScreen('This page is older than the board. Reload to get the new version.');
  if (!state.board) return h('div', { class: 'app-shell' }, loadingScreen(state.conn.status === 'connecting' && state.conn.retryAt ? 'Can’t reach the board yet. Retrying…' : 'Loading the board…'), toasts());
  const model = buildModel();
  const body = model.view === 'table' ? tableScreen(model) : model.view === 'dashboard' ? dashboardScreen(model) : model.view === 'integrations' ? integrationsScreen(model) : model.view === 'team' ? teamScreen(model) : null;
  return h('div', { class: 'app-shell' }, boardScreen(model, body), drawer(model), dialog(model), toasts());
}

let queued = false;
function update() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { if (queued) renderNow(); });
}
// Synchronous render, for callers that measure the DOM right after (FLIP).
function renderNow() {
  queued = false;
  render(root, screen());
  syncDialogs();
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
  const generation = ++boardGeneration;
  const current = () => generation === boardGeneration;
  state.auth = 'loading';
  update();
  // /api/health says whether this hub offers dev login (BOARD_AUTH=dev) or Access.
  if (state.authMode == null) {
    try { state.authMode = (await api.health()).auth ?? 'access'; } catch { state.authMode = 'access'; }
  }
  try {
    const me = await api.me();
    if (!current()) return;
    state.me = me;
  } catch (err) {
    if (!current()) return;
    // A sign-in in several orgs: the hub lists them; take ?org= or the first.
    if (err.code === 'CONFLICT' && Array.isArray(err.extra?.orgs) && err.extra.orgs.length && !currentOrg()) {
      const want = new URLSearchParams(location.search).get('org');
      setOrg((err.extra.orgs.find((o) => o.id === want) ?? err.extra.orgs[0]).id);
      return boot();
    }
    state.auth = err.status === 403 ? 'forbidden' : 'signed_out';
    state.email = err.extra?.email ?? null;
    if (state.authMode === 'accounts' && state.auth === 'signed_out' && !state.methods) state.methods = await api.methods().catch(() => null);
    state.authError = err.status === 401 || err.status === 403 ? null : errorText(err);
    update();
    return;
  }
  state.auth = 'ok';
  setCsrf(state.me.csrf_token);
  if (state.authMode === 'accounts' && !state.me.member && !state.me.pending_invites?.length && (state.me.client_workspaces?.length || state.me.pending_client_invites?.length)) {
    location.replace('/clients'); return;
  }
  if (state.authMode === 'accounts' && !state.me.member && !(state.me.pending_invites?.length)) {
    try {
      const setup = await api.setupAccount();
      if (!current()) return;
      if (setup.teams?.length) { setOrg(setup.teams[0].id); return boot(); }
      state.me.pending_invites = setup.pending_invites ?? [];
      if (!state.me.pending_invites.length && (setup.client_workspaces?.length || setup.pending_client_invites?.length)) { location.replace('/clients'); return; }
    } catch (err) {
      if (!current()) return;
      // Preserve the existing create-or-join forms when a rate limit,
      // quota or admission rule prevents automatic setup.
      state.onboard = { busy: false, error: accountErrorText(err, 'team'), where: 'create' };
    }
  }
  try { const result = await api.boards(true); if (!current()) return; state.boards = result.boards; }
  catch { if (!current()) return; state.boards = state.me.boards ?? []; }
  if (!current()) return;
  const wanted = new URLSearchParams(location.search).get('board');
  const boards = state.boards;
  let remembered = null;
  try { remembered = localStorage.getItem(lastBoardKey()); } catch { /* storage off */ }
  state.boardId = boards.find((b) => b.id === wanted)?.id ?? boards.find((b) => b.id === remembered && !b.archived_at)?.id ?? boards.find((b) => !b.archived_at)?.id ?? null;
  // A new account has no team: offer to create or join one, not "not a member".
  if (!state.boardId) { state.auth = state.authMode === 'accounts' && !state.me.member ? 'no_team' : 'forbidden'; update(); return; }
  state.board = { ...boards.find((b) => b.id === state.boardId), settings: {}, labels: [] };
  document.title = `${boards.find((b) => b.id === state.boardId)?.name ?? 'Board'} · ${BRAND.name}`;
  rememberBoard();
  resetDashboard();
  state.presence = { members: [], loaded: false, stale: false };
  state.overview = { status: 'idle', data: null, error: null, updatedAt: null };
  socket?.close();
  socket = connectBoard({ boardId: state.boardId, org: currentOrg(), onMessage: (m) => { if (current()) onMessage(m); }, onStatus: (...args) => { if (current()) onStatus(...args); } });
  update();
  openFromHash();
}

function lastBoardKey() {
  return `board-last:${state.me?.org?.id ?? currentOrg()}:${state.me?.user?.id ?? state.me?.member?.id}`;
}

function rememberBoard() {
  if (!state.boards.find((b) => b.id === state.boardId)?.archived_at) {
    try { localStorage.setItem(lastBoardKey(), state.boardId); } catch { /* storage off */ }
  }
}

async function switchBoard(id, { openCard = null, section = null } = {}) {
  if (!state.boards.some((b) => b.id === id)) return;
  socket?.close(); socket = null;
  state.board = null;
  state.cards = new Map(); state.archived = null; state.members = new Map();
  state.cardsRev += 1;
  state.detail = null; state.dialog = null; state.selection = new Set();
  state.drag = null; state.kbd = null; state.quickAdd = null;
  state.showArchived = false; state.repos = null; state.themeMenu = false;
  state.filters = emptyFilters();
  try { sessionStorage.removeItem('board-filters'); } catch { /* storage off */ }
  const query = new URLSearchParams(location.search);
  query.set('board', id); query.delete('q'); query.delete('f');
  const fragment = openCard ? `#${new URLSearchParams({ card: openCard, ...(section ? { section } : {}) })}` : '';
  history.replaceState(null, '', `${location.pathname}?${query}${fragment}`);
  state.conn = { status: 'connecting', lostAt: null, lostPerf: null, retryAt: null };
  await boot();
}

async function manageBoards() {
  state.dialog = { kind: 'boards' }; update();
  const generation = boardGeneration;
  try {
    const result = await api.boards(true);
    if (generation === boardGeneration) { state.boards = result.boards; update(); }
  } catch (err) {
    if (generation === boardGeneration && state.dialog?.kind === 'boards') { state.dialog = { ...state.dialog, error: errorText(err) }; update(); }
  }
}

async function submitBoardDialog(form) {
  const d = state.dialog;
  if (!d || d.busy || d.kind !== form.dataset.form) return;
  state.dialog = { ...d, busy: true }; update();
  const generation = boardGeneration;
  try {
    const fd = new FormData(form);
    let result;
    if (d.kind === 'new-board') {
      const key_prefix = String(fd.get('key_prefix') ?? '').trim();
      result = await api.createBoard({ name: String(fd.get('name') ?? '').trim(), ...(key_prefix ? { key_prefix } : {}) });
    } else if (d.kind === 'rename-board') result = await api.renameBoard(d.id, String(fd.get('name') ?? '').trim());
    else result = await api.archiveBoard(d.id);
    if (generation !== boardGeneration) return;
    state.boards = (await api.boards(true)).boards;
    if (generation !== boardGeneration) return;
    state.dialog = null;
    if (d.kind === 'new-board') await switchBoard(result.board.id);
    else if (d.kind === 'archive-board' && state.boardId === d.id) await switchBoard(state.boards.find((b) => !b.archived_at).id);
    else { if (state.board?.id === result.board.id) state.board = { ...state.board, ...result.board }; update(); }
  } catch (err) {
    if (generation === boardGeneration && state.dialog?.kind === d.kind) { state.dialog = { ...d, busy: false, error: errorText(err) }; update(); }
  }
}

async function restoreBoard(id) {
  const generation = boardGeneration;
  const result = await withBusy(`board:${id}`, () => api.restoreBoard(id));
  if (!result) return;
  const boards = (await api.boards(true)).boards;
  if (generation !== boardGeneration) return;
  state.boards = boards;
  if (state.board?.id === id) state.board = { ...state.board, ...result.board };
  update();
}

async function setIntegrationBoard(id, target_board_id) {
  const result = await withBusy(`integ:${id}`, () => api.patchIntegration(id, { target_board_id }));
  if (result?.connection) {
    state.integ = { ...state.integ, data: { ...state.integ.data, connections: state.integ.data.connections.map((c) => c.id === id ? result.connection : c) } };
    update();
  }
}

// ── accounts: a first team ─────────────────────────────────────────────────

async function enterTeam(teamId, done) {
  state.onboard = { busy: false, error: null, where: null };
  setOrg(teamId);
  await boot();
  if (done) toast(done);
}

// One no-team action at a time; its error shows under its own form.
async function onboardCall(where, step, fn) {
  if (state.onboard.busy) return null;
  state.onboard = { busy: true, error: null, where };
  update();
  try {
    return await fn();
  } catch (err) {
    if (err.code === 'ALREADY_MEMBER' && err.extra?.team?.id) { enterTeam(String(err.extra.team.id), accountErrorText(err, 'invite')); return null; }
    state.onboard = { busy: false, error: accountErrorText(err, step), where };
    update();
    return null;
  }
}

async function createFirstTeam(name) {
  const r = await onboardCall('create', 'team', () => api.createTeam(name));
  if (r) await enterTeam(r.team.id, `${r.team.name} is ready. Invite people with the Invite button.`);
}

async function joinTeam(where, body) {
  const r = await onboardCall(where, 'invite', () => api.acceptInvite(body));
  if (r) await enterTeam(r.team.id, `You joined ${r.team.name}.`);
}

async function createInvite(email, role) {
  const teamId = state.me?.org?.id;
  if (!teamId || state.invite.busy) return;
  state.invite = { busy: true, error: null, made: null };
  update();
  try {
    const r = await api.createInvite(teamId, email, role);
    state.invite = { busy: false, error: null, made: { email, link: String(r.link ?? ''), code: String(r.code ?? ''), mailed: r.mailed === true } };
  } catch (err) {
    const replayed = err.code === 'CONFLICT' && err.extra?.reason === 'REPLAYED';
    state.invite = { busy: false, error: accountErrorText(err, 'invite'), made: null, resend: replayed ? { email } : null };
  }
  update();
}

// After a REPLAYED answer: the invite exists but its link and code were shown once, so make new ones.
async function resendInvite() {
  const teamId = state.me?.org?.id;
  const offer = state.invite.resend;
  if (!teamId || !offer || state.invite.busy) return;
  state.invite = { ...state.invite, busy: true };
  update();
  try {
    const list = await api.listInvites(teamId);
    const inv = (list?.invites ?? []).find((i) => String(i.email).toLowerCase() === offer.email.trim().toLowerCase());
    if (!inv) {
      state.invite = { busy: false, error: 'There’s no invite waiting for that address now. Create it again.', made: null };
    } else {
      const r = await api.resendInvite(teamId, inv.id);
      state.invite = { busy: false, error: null, made: { email: String(inv.email), link: String(r.link ?? ''), code: String(r.code ?? ''), mailed: r.mailed === true } };
    }
  } catch (err) {
    state.invite = { busy: false, error: accountErrorText(err, 'invite'), made: null };
  }
  update();
}

async function copyInvite(what) {
  const v = state.invite.made?.[what === 'code' ? 'code' : 'link'];
  if (!v) return;
  try { await navigator.clipboard.writeText(v); toast(what === 'code' ? 'Code copied.' : 'Link copied.'); } catch { toast('Couldn’t copy. Select it and copy it yourself.', 'error'); }
}

async function signOut() {
  try { await api.signout(); } catch (err) { if (err.code !== 'UNAUTHENTICATED') { toast(accountErrorText(err), 'error'); return; } }
  location.assign('/signin');
}

function onStatus({ status, retryAt }) {
  const prev = state.conn.status;
  if (status === 'signed_out') { socket?.close(); boot(); return; }
  if (status === 'lost' && prev !== 'lost') {
    state.conn.lostAt = new Date();
    state.conn.lostPerf = perf();
  }
  if (status === 'lost') state.presence.stale = true;
  if (status === 'open') { state.conn.lostAt = null; state.conn.lostPerf = null; }
  state.conn.status = status;
  state.conn.retryAt = retryAt ?? null;
  update();
}

function onMessage(msg) {
  const now = perf();
  switch (msg.type) {
    case 'team.boards': {
      if (msg.org_id !== state.me?.org?.id) return;
      state.boards = msg.boards;
      state.me = { ...state.me, boards: msg.boards.filter((b) => !b.archived_at) };
      const board = msg.boards.find((b) => b.id === state.boardId);
      if (board && state.board) { state.board = { ...state.board, ...board }; document.title = `${board.name} · ${BRAND.name}`; }
      break;
    }
    case 'welcome': onHubEpoch(msg.hub_epoch); break;
    case 'snapshot': {
      if (msg.board_id !== state.boardId) return;
      state.board = msg.board;
      state.members = new Map(msg.members.map((m) => [m.member_id, m]));
      state.cards = new Map(msg.cards.map((c) => [c.id, { view: c, rx: now }]));
      state.cardsRev += 1;
      openPendingFeedback();
      state.selection = pruneSelection(state.selection, state.cards.keys());
      if (state.showArchived) loadArchived();
      if (state.detail) refreshDetail(state.detail.cardId);
      if (state.view === 'dashboard' && state.dash.status === 'idle') loadJournal();
      if (state.view === 'integrations' && state.integ.status === 'idle') loadIntegrations();
      presenceFallbackSoon();
      if (state.view === 'team' && state.overview.status === 'idle') loadTeamOverview();
      break;
    }
    case 'team.presence':
      state.presence = { members: msg.members, loaded: true, stale: false };
      break;
    case 'card.upsert': {
      if (msg.board_id !== state.boardId) return;
      state.cards.set(msg.card.id, { view: msg.card, rx: now });
      state.archived?.delete(msg.card.id);
      state.cardsRev += 1;
      if (state.detail?.cardId === msg.card.id) refreshDetailSoon(msg.card.id);
      dashboardSoon();
      break;
    }
    case 'card.remove': {
      state.cards.delete(msg.card_id);
      state.cardsRev += 1;
      if (state.showArchived) loadArchived();
      else {
        state.selection = pruneSelection(state.selection, state.cards.keys());
        if (state.detail?.cardId === msg.card_id) closeDrawer();
      }
      break;
    }
    case 'board.labels':
      if (msg.board_id !== state.boardId || !state.board) return;
      state.board = { ...state.board, labels: msg.labels };
      break;
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

// The socket sends presence right after every snapshot; this is only the
// fallback for a frame that never comes (the endpoint is rate limited), tried
// once per board, never on a timer.
let overviewIntent = null;
async function loadTeamOverview() {
  if (state.auth !== 'ok' || !state.me?.member || state.overview.status === 'loading') return;
  const intent = overviewIntent = {}, generation = boardGeneration, memberId = state.me.member.id, org = currentOrg();
  const current = () => intent === overviewIntent && generation === boardGeneration && memberId === state.me?.member?.id && org === currentOrg();
  state.overview = { ...state.overview, status: 'loading', error: null }; update();
  try {
    const data = await api.teamOverview();
    if (current()) { state.overview = { status: 'ok', data, error: null, updatedAt: Date.now() }; update(); }
  } catch (error) {
    if (current()) { state.overview = { ...state.overview, status: 'error', error: errorText(error) }; update(); }
  }
}

let presenceFallbackFor = null;
function presenceFallbackSoon() {
  if (state.view !== 'team' || presenceFallbackFor === state.boardId) return;
  const boardId = state.boardId;
  presenceFallbackFor = boardId;
  setTimeout(async () => {
    if (state.presence.loaded || state.boardId !== boardId) return;
    try {
      const res = await api.presence(boardId);
      if (!state.presence.loaded && state.boardId === boardId) { state.presence = { members: res.members ?? [], loaded: true, stale: false }; update(); }
    } catch { /* the socket frame or the next snapshot will fill it */ }
  }, 2000);
}

// ── detail drawer ────────────────────────────────────────────────────────────

// ── archive (D94) and labels (D91) ──────────────────────────────────────────

async function loadArchived() {
  const boardId = state.boardId;
  try {
    const snap = await api.board(boardId, { includeArchived: true });
    if (!state.showArchived || state.boardId !== boardId) return;
    const rx = perf();
    state.archived = new Map(snap.cards.filter((c) => c.archived && !state.cards.has(c.id)).map((c) => [c.id, { view: c, rx }]));
  } catch (err) {
    if (state.boardId !== boardId) return;
    toast(errorText(err), 'error');
  }
  update();
}

function setShowArchived(on) {
  state.showArchived = on;
  if (on) loadArchived();
  else {
    state.archived = null;
    state.selection = pruneSelection(state.selection, state.cards.keys());
    if (state.detail && !state.cards.has(state.detail.cardId)) closeDrawer();
  }
  update();
}

async function archiveCards(ids) {
  for (const id of ids) {
    const res = await withBusy(`${id}:archive`, () => api.archiveCard(id));
    if (!res?.card) continue;
    state.cards.delete(id);
    if (state.showArchived) state.archived?.set(id, { view: res.card, rx: perf() });
    state.cardsRev += 1;
    if (!state.showArchived && state.detail?.cardId === id) closeDrawer();
    toast(`${res.card.key} archived. Show archived to restore it.`);
  }
  if (!state.showArchived) state.selection = pruneSelection(state.selection, state.cards.keys());
  update();
}

async function restoreCards(ids) {
  for (const id of ids) {
    const res = await withBusy(`${id}:restore`, () => api.restoreCard(id));
    if (!res?.card) continue;
    state.archived?.delete(id);
    applyCard(res);
    toast(`${res.card.key} restored.`);
    if (state.detail?.cardId === id) refreshDetailSoon(id);
  }
  update();
}

async function setCover(cardId, token) {
  const v = viewOf(cardId);
  if (!v) return;
  const res = await withBusy(`${cardId}:cover`, () => api.patchCard(cardId, { version: v.version, cover: token || null }));
  if (res) applyCard(res);
}

// Registry changes also arrive as board.labels; the answer is applied at once
// so the manager never waits on the socket.
async function labelCall(fn) {
  const d = state.dialog;
  const generation = boardGeneration, boardId = state.boardId;
  if (d?.kind === 'labels') { state.dialog = { ...d, busy: true, error: null }; update(); }
  try {
    await fn();
    if (generation !== boardGeneration) return false;
    const res = await api.labels(boardId);
    if (generation !== boardGeneration) return false;
    if (state.board) state.board = { ...state.board, labels: res.labels };
    if (state.dialog?.kind === 'labels') state.dialog = { kind: 'labels', busy: false, error: null };
    return true;
  } catch (err) {
    if (generation !== boardGeneration) return false;
    if (state.dialog?.kind === 'labels') state.dialog = { ...state.dialog, busy: false, error: errorText(err) };
    else toast(errorText(err), 'error');
    return false;
  } finally {
    update();
  }
}

async function openDetail(cardId, section = null) {
  if (!state.cards.has(cardId) && !state.archived?.has(cardId)) return;
  const tab = section === 'handover' || section === 'comments' ? section : (state.detail?.cardId === cardId ? state.detail.tab : 'activity');
  state.detail = { cardId, data: state.detail?.cardId === cardId ? state.detail.data : null, rx: state.detail?.rx ?? null, tab, scrollTo: ['asks', 'overlaps'].includes(section) ? section : null, error: null };
  try { history.replaceState(null, '', `#card=${encodeURIComponent(cardId)}`); } catch { /* sandboxed */ }
  update();
  await refreshDetail(cardId);
}

async function refreshDetail(cardId) {
  if (!cardId || state.detail?.cardId !== cardId) return;
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
  // Back to what opened it: the card or row, else a dashboard list entry.
  if (id) queueMicrotask(() => (root.querySelector(`[data-card-id="${CSS.escape(id)}"] .card-open`) ?? root.querySelector(`[data-action="open"][data-card="${CSS.escape(id)}"]`))?.focus());
}

// The hub prints http://…/#dev_secret=<secret> at startup: keep it for this tab
// only and take it out of the address bar.
function devSecret() {
  try { return sessionStorage.getItem('board_dev_secret'); } catch { return null; }
}

function rememberDevSecret(v) {
  try { sessionStorage.setItem('board_dev_secret', v); } catch { /* storage off: typed each time */ }
}

function takeDevSecretFromHash() {
  const m = location.hash.match(/^#dev_secret=([^&]+)$/);
  if (!m) return;
  rememberDevSecret(decodeURIComponent(m[1]));
  history.replaceState(null, '', location.pathname + location.search);
}

// The fragment is dropped before anything is shown; a report that arrives
// before sign-in/board load waits here and opens once the board is ready.
let pendingFeedback = null;
function takeFeedbackFromHash() {
  if (!location.hash.startsWith(FRAGMENT_PREFIX)) return;
  const payload = decodeFeedback(location.hash);
  history.replaceState(null, '', location.pathname + location.search);
  if (!payload) return;
  pendingFeedback = payload;
  openPendingFeedback();
}

function openPendingFeedback() {
  if (!pendingFeedback || state.auth !== 'ok' || !state.board) return;
  const armedAt = performance.now() + ARM_MS;
  state.dialog = { kind: 'feedback', payload: pendingFeedback, busy: false, result: null, armed: false, armedAt };
  pendingFeedback = null;
  update();
  setTimeout(() => {
    if (state.dialog?.kind === 'feedback' && state.dialog.armedAt === armedAt) { state.dialog = { ...state.dialog, armed: true }; update(); }
  }, ARM_MS);
}

async function submitFeedback() {
  const d = state.dialog;
  if (d?.kind !== 'feedback' || d.busy || d.result?.ok || state.me?.member?.role === 'viewer') return;
  if (!canSend({ armedAt: d.armedAt, now: performance.now(), focused: document.hasFocus(), visible: document.visibilityState })) return;
  state.dialog = { ...d, busy: true, result: null };
  update();
  const result = await sendFeedback({ api, boards: state.me?.boards, payload: d.payload });
  if (state.dialog?.kind === 'feedback') { state.dialog = { ...state.dialog, busy: false, result }; update(); }
}

function openFromHash() {
  const query = new URLSearchParams(location.hash.slice(1)), id = query.get('card');
  if (!id) return;
  const section = query.get('section'), generation = boardGeneration;
  const tryOpen = () => {
    if (generation !== boardGeneration) return;
    if (state.cards.has(id)) openDetail(id, section);
    else if (state.conn.status !== 'open') setTimeout(tryOpen, 200);
  };
  tryOpen();
}

// ── actions ──────────────────────────────────────────────────────────────────

async function withBusy(key, fn) {
  if (state.busy.has(key)) return undefined;
  state.busy.add(key);
  const generation = boardGeneration;
  update();
  try {
    const result = await fn();
    return generation === boardGeneration ? result : undefined;
  } catch (err) {
    if (generation !== boardGeneration) return undefined;
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
  if (!res?.card) return;
  if (res.card.board_id && res.card.board_id !== state.boardId) return;
  if (res.card.archived) state.archived?.set(res.card.id, { view: res.card, rx: perf() });
  else state.cards.set(res.card.id, { view: res.card, rx: perf() });
  state.cardsRev += 1;
}

const viewOf = (id) => (state.cards.get(id) ?? state.archived?.get(id))?.view;
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
  const preference = tacklePreference(state.me.member.id, undefined, state.board?.settings?.default_budget_usd ?? 5), retry = mode === 'retry';
  state.dialog = {
    kind: 'give', cardId, mode, instance: {},
    target: retry ? v.run?.owner?.member_id ?? state.me.member.id : state.me.member.id,
    repo_id: v.repo?.id ?? '',
    base_ref: v.base_ref ?? '',
    ai: retry ? v.run?.ai ?? 'claude' : preference.ai,
    budget_mode: retry || v.budget?.cap_usd != null ? 'cap' : preference.budget_mode,
    budget_usd: retry ? Math.max(v.budget?.cap_usd ?? 0, v.budget?.spent_usd ?? 0) + 0.5 : v.budget?.cap_usd ?? preference.budget_usd,
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
    const res = await api.overlapPreview(d.cardId, target, d.repo_id || null);
    if (state.dialog?.previewToken !== token) return;
    state.dialog = { ...state.dialog, preview: { overlaps: res.overlaps ?? [], sponsor: res.sponsor ?? null, runners: res.runners ?? [], can_use_no_budget: res.can_use_no_budget === true } };
  } catch (err) {
    if (state.dialog?.previewToken !== token) return;
    state.dialog = { ...state.dialog, preview: { error: errorText(err) } };
  }
  update();
}

async function submitGive(form) {
  const d = state.dialog;
  const generation = boardGeneration, memberId = state.me?.member?.id;
  const current = () => generation === boardGeneration && state.me?.member?.id === memberId && state.dialog?.instance === d.instance;
  const v = viewOf(d.cardId);
  const fd = new FormData(form);
  const target = fd.get('target') || state.me.member.id;
  const repo_id = fd.get('repo_id') || null;
  const base_ref = String(fd.get('base_ref') ?? '').trim() || null;
  const budget = Number(fd.get('budget_usd'));
  const ai = fd.get('ai') || d.ai;
  const uncapped = ai === 'codex' || fd.get('budget_mode') === 'none';
  const wantPlan = fd.get('plan_approval') === 'on';
  if (!repo_id) { state.dialog = { ...d, error: 'Pick a repo first. The agent works inside that repo.' }; update(); return; }
  if (!uncapped && (!Number.isFinite(budget) || budget < 0.5 || budget > 1000)) { state.dialog = { ...d, error: 'Choose a card budget between $0.50 and $1,000.' }; update(); return; }
  state.dialog = { ...d, busy: true, error: null };
  update();
  try {
    const labels = new Set(v.labels ?? []);
    if (wantPlan) labels.add(PLAN_LABEL); else labels.delete(PLAN_LABEL);
    const patch = {};
    if (repo_id !== (v.repo?.id ?? null)) patch.repo_id = repo_id;
    if (base_ref !== (v.base_ref ?? null)) patch.base_ref = base_ref;
    if (labels.size !== (v.labels ?? []).length || [...labels].some((l) => !(v.labels ?? []).includes(l))) patch.labels = [...labels];
    if (Object.keys(patch).length) {
      const changed = await api.patchCard(d.cardId, { version: v.version, ...patch });
      if (!current()) return;
      applyCard(changed);
    }
    if (!current()) return;
    const isMe = target === state.me.member.id;
    const action = d.mode === 'retry' ? 'retry' : d.mode === 'redispatch' ? 'take_over_with_claude' : 'dispatch';
    const body = { target_member_id: isMe ? null : target, ai, budget_usd: uncapped ? null : budget };
    const res = await api.action(d.cardId, action, body);
    if (!current()) return;
    rememberTackle(memberId, { ai, budget_mode: uncapped ? 'none' : 'cap', budget_usd: Number.isFinite(budget) && budget >= 0.5 ? budget : d.budget_usd });
    applyCard(res);
    state.dialog = null;
    const name = state.members.get(target)?.name;
    toast(isMe ? `${v.key} is queued for ${ai === 'codex' ? 'Codex' : 'Claude Code'}.` : `Asked ${name}. They confirm before work starts.`);
  } catch (err) {
    if (!current()) return;
    state.dialog = { ...state.dialog, busy: false, error: errorText(err) };
  }
  update();
}

async function submitDialogForm(form, submitter) {
  const kind = form.dataset.form;
  if (kind === 'workflow-publish' || kind === 'workflow-apply') return submitWorkflow(form, kind);
  if (['new-board', 'rename-board', 'archive-board'].includes(kind)) return submitBoardDialog(form);
  if (kind === 'integ-token') return submitIntegrationToken(form);
  if (kind === 'integ-prepare') return submitPrepare(form);
  if (kind === 'integ-start') return connectIntegration(form.dataset.provider, 'app_install', takeInput(form));
  if (kind === 'create-team') {
    const name = String(new FormData(form).get('name') ?? '').trim();
    if (!name) return undefined;
    return createFirstTeam(name);
  }
  if (kind === 'team-invite') {
    const fd = new FormData(form);
    const email = String(fd.get('email') ?? '').trim();
    if (!email) return undefined;
    await createInvite(email, String(fd.get('role') ?? 'member'));
    if (state.invite.made) form.reset();
    return undefined;
  }
  if (kind === 'join-team') {
    const p = parseJoin(new FormData(form).get('invite'), location.origin);
    if (p.error) { state.onboard = { busy: false, error: p.error, where: 'join' }; update(); return undefined; }
    return joinTeam('join', p);
  }
  if (kind === 'label-create') {
    const fd0 = new FormData(form);
    const name = String(fd0.get('name') ?? '').trim();
    if (name && await labelCall(() => api.createLabel(state.boardId, name, String(fd0.get('color') ?? 'grey')))) form.reset();
    return undefined;
  }
  if (kind === 'label-rename') {
    const to = String(new FormData(form).get('name') ?? '').trim();
    const from = form.dataset.label;
    if (!to || to === from) { state.dialog = { ...state.dialog, rename: null }; update(); return undefined; }
    if (await labelCall(() => api.patchLabel(state.boardId, from, { name: to }))) toast(`Renamed ${from} to ${to} on every card.`);
    return undefined;
  }
  const d = state.dialog;
  const cardId = form.dataset.card;
  const fd = new FormData(form);
  const run = async (fn, doneText) => {
    const generation = boardGeneration;
    const submitted = { ...d, busy: true, error: null };
    state.dialog = submitted;
    update();
    try {
      const res = await fn();
      if (generation !== boardGeneration) return;
      applyCard(res);
      if (state.dialog === submitted) state.dialog = null;
      if (doneText) toast(doneText);
      if (cardId && state.detail?.cardId === cardId) refreshDetailSoon(cardId);
    } catch (err) {
      if (generation !== boardGeneration) return;
      if (state.dialog === submitted) state.dialog = { ...submitted, busy: false, error: errorText(err) };
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
    const typed = String(fd.get('dev_secret') ?? '').trim();
    if (typed) rememberDevSecret(typed);
    try { await api.devLogin(login, devSecret()); state.authError = null; await boot(); } catch (err) {
      state.authError = err.status === 404 ? 'Dev login is off on this hub.'
        : err.status === 403 ? 'Dev login needs the secret the hub printed when it started (open the URL it printed).' : errorText(err);
    }
    state.authBusy = false;
    update();
  }
  return undefined;
}

// ── command palette ──────────────────────────────────────────────────────────
// Opening is instant and unanimated: it is a keyboard shortcut people press
// hundreds of times a day.

function togglePalette() {
  if (state.auth !== 'ok' || !state.board) return;
  if (state.dialog?.kind === 'palette') { closePalette(); return; }
  if (root.querySelector('dialog[open]:not([data-dialog="drawer"])')) return;
  state.dialog = { kind: 'palette', query: '', index: 0, scope: null, instance: {} };
  renderNow();
}

function closePalette() {
  clearTimeout(searchTimer);
  state.dialog = null;
  renderNow();
}

function paletteNow() {
  const m = buildModel();
  return paletteResults(state.dialog, { entries: m.entries, view: state.view, readOnly: m.readOnly, filters: state.filters });
}

function runPalette(item, { give = false } = {}) {
  const run = give ? { type: 'give', ...item.give } : item.run;
  if (!run) return;
  if (run.type === 'scope-give') { state.dialog = { ...state.dialog, scope: 'give', query: '', index: 0 }; renderNow(); return; }
  if (run.type === 'scope-search') { state.dialog = { ...state.dialog, scope: 'search', query: '', index: 0, instance: {}, search: null }; renderNow(); return; }
  closePalette();
  switch (run.type) {
    case 'open-card': openDetail(run.id); break;
    case 'open-search': openSearchResult(run); break;
    case 'workflows': openWorkflows(); break;
    case 'view': setView(run.view); break;
    case 'theme-next': setTheme(THEME_NEXT[state.theme]); break;
    case 'new-card': openNewCard(); break;
    case 'give': openGive(run.id, run.mode); break;
    case 'filter':
      if (state.view === 'dashboard') setView('board');
      setFilters({ ...emptyFilters(), chips: [run.chip] });
      break;
    case 'filter-clear': setFilters(emptyFilters()); break;
    default:
  }
}

let searchTimer = null;
function searchSoon() {
  clearTimeout(searchTimer);
  const d = state.dialog, generation = boardGeneration, memberId = state.me?.member?.id, org = currentOrg();
  const current = () => generation === boardGeneration && state.me?.member?.id === memberId && currentOrg() === org
    && state.dialog?.kind === 'palette' && state.dialog.scope === 'search' && state.dialog.instance === d.instance && state.dialog.query === d.query;
  state.dialog = { ...d, search: null, searchError: null, searchLoading: d.query.trim().length >= 2 };
  if (!state.dialog.searchLoading) return;
  searchTimer = setTimeout(async () => {
    if (!current()) return;
    try {
      const result = await api.search(d.query);
      if (current()) { state.dialog = { ...state.dialog, search: result, searchLoading: false, index: 0 }; update(); }
    } catch (error) {
      if (current()) { state.dialog = { ...state.dialog, searchError: errorText(error), searchLoading: false }; update(); }
    }
  }, 150);
}

async function openSearchResult(run) {
  const generation = boardGeneration, memberId = state.me?.member?.id, org = currentOrg();
  const current = () => generation === boardGeneration && state.me?.member?.id === memberId && currentOrg() === org;
  try {
    // Search is a snapshot; opening still checks the current resource access.
    const data = await api.card(run.id);
    if (!current()) return;
    if (data.card.archived || data.card.board_id !== run.boardId) { toast('This work has changed. Search again.'); return; }
    if (run.boardId === state.boardId) { openDetail(run.id, run.section); return; }
    const result = await api.boards();
    if (!current()) return;
    if (!result.boards.some((board) => board.id === run.boardId && !board.archived_at)) { toast('This board is no longer available.'); return; }
    state.boards = result.boards;
    await switchBoard(run.boardId, { openCard: run.id, section: run.section });
  } catch (error) { if (current()) toast(errorText(error)); }
}

function workflowIntent(mode, extra = {}) { return { kind: 'workflows', mode, instance: {}, request_id: crypto.randomUUID(), ...extra }; }
function workflowGuard(d) {
  const generation = boardGeneration, memberId = state.me?.member?.id, org = currentOrg();
  return () => generation === boardGeneration && memberId === state.me?.member?.id && org === currentOrg() && state.dialog?.kind === 'workflows' && state.dialog.instance === d.instance;
}
async function openWorkflows(id = null, { includeArchived = false } = {}) {
  const d = workflowIntent(id ? 'detail' : 'library', { loading: true, includeArchived }); state.dialog = d; update();
  const current = workflowGuard(d);
  try {
    const result = await (id ? api.workflow(id) : api.workflows(includeArchived));
    if (current()) { state.dialog = { ...state.dialog, loading: false, ...(id ? { selected: result } : result) }; update(); }
  } catch (error) { if (current()) { state.dialog = { ...d, loading: false, error: errorText(error) }; update(); } }
}
function workflowDraft(form) {
  const fd = new FormData(form);
  return { name: String(fd.get('name') ?? ''), description: String(fd.get('description') ?? ''), steps: state.dialog.draft.steps.map((s, i) => ({ title: String(fd.get(`title-${i}`) ?? ''), body: String(fd.get(`body-${i}`) ?? ''), acceptance: String(fd.get(`acceptance-${i}`) ?? ''), plan_approval: fd.get(`plan-${i}`) === 'on' })) };
}
async function submitWorkflow(form, kind) {
  const d = state.dialog;
  if (d?.kind !== 'workflows' || d.busy || boardReadOnly()) return;
  const current = workflowGuard(d), fd = new FormData(form), selected = d.selected?.workflow;
  const draft = kind === 'workflow-publish' ? workflowDraft(form) : null;
  const version = kind === 'workflow-apply' ? d.selected.versions.find((v) => v.version === d.previewVersion) ?? selected : null;
  state.dialog = { ...d, busy: true, error: null, ...(draft ? { draft } : {}), context: String(fd.get('context') ?? ''), title_prefix: String(fd.get('title_prefix') ?? '') }; update();
  try {
    const result = kind === 'workflow-publish'
      ? await api.publishWorkflow(selected?.id ?? null, { request_id: d.request_id, ...(selected ? { expected_version: selected.version } : {}), definition: draft })
      : await api.applyWorkflow(state.boardId, selected.id, { request_id: d.request_id, version: version.version, content_hash: version.content_hash, context: String(fd.get('context') ?? ''), title_prefix: String(fd.get('title_prefix') ?? '') });
    if (!current()) return;
    if (kind === 'workflow-publish') { toast(`Published workflow version ${result.workflow.version}.`); await openWorkflows(result.workflow.id); }
    else { state.dialog = null; toast(`Created ${result.instance.steps.length} workflow tasks.`); update(); }
  } catch (error) { if (current()) { state.dialog = { ...state.dialog, busy: false, error: errorText(error) }; update(); } }
}
async function archiveWorkflow() {
  const d = state.dialog, w = d?.selected?.workflow;
  if (!w || d.busy || boardReadOnly()) return;
  const current = workflowGuard(d); state.dialog = { ...d, busy: true }; update();
  try { const result = await api.archiveWorkflow(w.id, !w.archived_at); if (current()) { state.dialog = { ...state.dialog, busy: false, selected: result }; update(); } }
  catch (error) { if (current()) { state.dialog = { ...state.dialog, busy: false, error: errorText(error) }; update(); } }
}

function paletteKeydown(e) {
  const d = state.dialog;
  const n = paletteResults(d, { entries: buildModel().entries, view: state.view, readOnly: boardReadOnly(), filters: state.filters }).length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!n) return;
    state.dialog = { ...d, index: (Math.min(d.index, n - 1) + (e.key === 'ArrowDown' ? 1 : -1) + n) % n };
    renderNow();
    root.querySelector('.pal-opt[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const hit = paletteNow()[Math.min(d.index, n - 1)];
    if (hit) runPalette(hit.item, { give: (e.metaKey || e.ctrlKey) && !!hit.item.give });
  } else if (e.key === 'Tab') {
    e.preventDefault(); // the field is the only stop: Tab must not leave the dialog
  }
}

// ── quick add ────────────────────────────────────────────────────────────────

let pendingSeq = 0;

function openQuickAdd() {
  if (boardReadOnly() || state.view !== 'board') return false;
  state.quickAdd = { open: true, seed: '', confirm: null, keep: false };
  renderNow();
  const ta = root.querySelector('.quickadd-input');
  ta?.focus();
  ta?.scrollIntoView({ block: 'nearest' });
  return true;
}

function closeQuickAdd() {
  state.quickAdd = null;
  update();
}

// Optimistic: the cards are on the board before the request leaves; the hub's
// card then replaces each placeholder. A failure removes it and hands the text
// back in the field.
async function createQuick(titles, keep) {
  if (boardReadOnly()) return;
  const generation = boardGeneration, boardId = state.boardId;
  const prefix = state.board?.key_prefix ?? null;
  const memberId = state.me?.member?.id ?? null;
  const temps = titles.map((t) => pendingCard(t, ++pendingSeq, { prefix, memberId }));
  for (const v of temps) state.cards.set(v.id, { view: v, rx: perf() });
  state.cardsRev += 1;
  state.quickAdd = keep ? { open: true, seed: '', confirm: null, keep } : null;
  update();
  const failed = [];
  for (const v of temps) {
    if (generation !== boardGeneration) return;
    try {
      const res = await api.createCard(boardId, { title: v.title });
      if (generation !== boardGeneration) return;
      state.cards.delete(v.id);
      applyCard(res);
    } catch (err) {
      if (generation !== boardGeneration) return;
      state.cards.delete(v.id);
      failed.push(v.title);
      toast(`Couldn't add “${v.title}”: ${errorText(err)}`, 'error');
      if (err.code === 'UNAUTHENTICATED') boot();
    }
    state.cardsRev += 1;
    update();
  }
  if (failed.length) {
    state.quickAdd = { open: true, seed: failed.join('\n'), confirm: null, keep };
    renderNow();
    root.querySelector('.quickadd-input')?.focus();
  }
}

function commitTitles(titles, keep) {
  if (!titles.length) { if (!keep) closeQuickAdd(); return; }
  const ta = root.querySelector('.quickadd-input');
  if (needsConfirm(titles)) {
    state.quickAdd = { ...state.quickAdd, confirm: titles, keep };
    update();
    return;
  }
  if (ta) ta.value = '';
  createQuick(titles, keep);
}

function onPaste(e) {
  const ta = e.target.closest?.('[data-input="quickadd"]');
  const text = e.clipboardData?.getData('text') ?? '';
  if (!ta || !/\r?\n/.test(text.trim())) return;
  e.preventDefault();
  commitTitles(parseTitles(ta.value.slice(0, ta.selectionStart) + text + ta.value.slice(ta.selectionEnd)), true);
}

async function openNewCard() {
  if (boardReadOnly()) return;
  state.dialog = { kind: 'new', repos: state.repos };
  update();
  const repos = await loadRepos();
  if (state.dialog?.kind === 'new') { state.dialog = { ...state.dialog, repos }; update(); }
}

// Optimistic: the column changes now (and the cards settle into place), the hub
// confirms per card. Each card's PATCHes run one after another so a second
// quick move sends the version the first one returned; a failure rolls that
// card back and says why.
const moveChains = new Map();

function say(text) {
  state.announce = state.announce === text ? `${text}\u200b` : text;
}

function moveCards(ids, column, { flipFrom = null } = {}) {
  if (boardReadOnly()) return { moves: [], skipped: [] };
  const plan = planMoves(ids, viewOf, column);
  const summary = moveSummary(plan, column);
  say(summary);
  if (!plan.moves.length) {
    if (plan.skipped.length) toast(summary);
    update();
    return plan;
  }
  const before = snapshotRects(root);
  for (const m of plan.moves) {
    const c = state.cards.get(m.id);
    state.cards.set(m.id, { view: { ...c.view, column }, rx: c.rx });
  }
  state.cardsRev += 1;
  state.drag = null;
  renderNow();
  playFlip(root, before, flipFrom && new Map(plan.moves.map((m) => [m.id, flipFrom])));
  if (plan.skipped.length) toast(summary);
  for (const m of plan.moves) queueMove(m, column);
  return plan;
}

function queueMove(m, column) {
  const next = (moveChains.get(m.id) ?? Promise.resolve()).then(async () => {
    const v = viewOf(m.id);
    if (!v) return;
    try {
      applyCard(await api.patchCard(m.id, { version: v.version, column }));
    } catch (err) {
      toast(`Couldn't move ${m.key}: ${errorText(err)}`, 'error');
      if (err.code === 'VERSION_CONFLICT' || err.code === 'ILLEGAL_TRANSITION') refreshBoardCard();
      if (err.code === 'UNAUTHENTICATED') boot();
      const cur = state.cards.get(m.id);
      if (cur && cur.view.column === column) {
        const before = snapshotRects(root);
        state.cards.set(m.id, { view: { ...cur.view, column: m.from }, rx: cur.rx });
        state.cardsRev += 1;
        renderNow();
        playFlip(root, before);
      }
    }
    update();
  });
  moveChains.set(m.id, next);
  next.finally(() => { if (moveChains.get(m.id) === next) moveChains.delete(m.id); });
}

function setSelection(next) {
  state.selection = next;
  update();
}

// ── DOM events ───────────────────────────────────────────────────────────────

function onClick(e) {
  if (state.themeMenu && !e.target.closest?.('.menu-wrap')) closeThemeMenu();
  const dlg = e.target.closest?.('dialog[data-dialog]');
  if (dlg && e.target === dlg) {
    // Backdrop click closes (the dialog element itself only receives clicks outside its content box).
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    return;
  }
  const picked = (e.shiftKey || e.metaKey || e.ctrlKey) && !e.target.closest?.('a, .card-actions') ? e.target.closest?.('.card[data-card-id]') : null;
  if (picked) {
    e.preventDefault();
    setSelection(toggleSelection(state.selection, picked.dataset.cardId));
    return;
  }
  const el = e.target.closest?.('[data-action]');
  if (!el || el.disabled) return;
  const action = el.dataset.action;
  const cardId = el.dataset.card;
  switch (action) {
    case 'manage-boards': manageBoards(); return;
    case 'new-board': state.dialog = { kind: 'new-board' }; update(); return;
    case 'rename-board': case 'archive-board': {
      const b = state.boards.find((b) => b.id === el.dataset.board);
      if (b) { state.dialog = { kind: action, id: b.id, name: b.name }; update(); }
      return;
    }
    case 'restore-board': restoreBoard(el.dataset.board); return;
    case 'switch-board': switchBoard(el.dataset.board); return;
    case 'open': e.preventDefault(); openDetail(cardId, el.dataset.section ?? null); return;
    case 'team-overview-refresh': loadTeamOverview(); return;
    case 'team-open-card': openSearchResult({ id: cardId, boardId: el.dataset.board }); return;
    case 'watch': openDetail(cardId, 'activity'); return;
    case 'allow': case 'deny': case 'answer': case 'approve_plan': case 'resolve_conflict': case 'continue':
      openDetail(cardId, 'asks'); return;
    case 'give_to_claude': openGive(cardId, 'dispatch'); return;
    case 'take_over_with_claude': openGive(cardId, 'redispatch'); return;
    case 'stop': case 'cancel': case 'take_over_confirm':
      state.dialog = { kind: 'confirm', action, cardId }; update(); return;
    case 'retry':
      if (viewOf(cardId)?.fail_kind === 'budget') openGive(cardId, 'retry');
      else doAction(cardId, action, {}, DONE_COPY[action]?.(keyOf(cardId)));
      return;
    case 'take_over': case 'take_over_myself': case 'approve_done':
      doAction(cardId, action, {}, DONE_COPY[action]?.(keyOf(cardId))); return;
    case 'request_changes': state.dialog = { kind: 'changes', cardId }; update(); return;
    case 'hand_over': state.dialog = { kind: 'handover', cardId, kind_: 'queue' }; update(); return;
    case 'permission': {
      const prId = el.dataset.pr;
      withBusy(`pr:${prId}`, () => api.answerPermission(prId, el.dataset.decision, el.dataset.scope)).then((res) => {
        if (!res) return;
        applyCard(res);
        toast(el.dataset.decision === 'deny' ? 'Denied. The agent is told why it can’t run that.' : 'Allowed. The agent can continue.');
        if (state.detail) refreshDetail(state.detail.cardId);
      });
      return;
    }
    case 'tab': if (state.detail) { state.detail = { ...state.detail, tab: el.dataset.tab }; update(); } return;
    case 'close-drawer': root.querySelector('dialog[data-dialog="drawer"]')?.close(); return;
    case 'close-dialog': el.closest('dialog')?.close(); return;
    case 'new-card': openNewCard(); return;
    case 'feedback-send': submitFeedback(); return;
    case 'palette': togglePalette(); return;
    case 'palette-run': { const hit = paletteNow()[Number(el.dataset.index)]; if (hit) runPalette(hit.item); return; }
    case 'workflow-library': openWorkflows(); return;
    case 'workflow-show-archived': openWorkflows(null, { includeArchived: !state.dialog.includeArchived }); return;
    case 'workflow-select': openWorkflows(el.dataset.workflow); return;
    case 'workflow-new': state.dialog = workflowIntent('edit', { draft: starterWorkflow() }); update(); return;
    case 'workflow-edit': state.dialog = workflowIntent('edit', { selected: state.dialog.selected, draft: structuredClone(state.dialog.selected.workflow.definition) }); update(); return;
    case 'workflow-preview': state.dialog = workflowIntent('preview', { selected: state.dialog.selected, previewVersion: state.dialog.selected.workflow.version }); update(); return;
    case 'workflow-archive': archiveWorkflow(); return;
    case 'workflow-add-step': case 'workflow-remove-step': {
      const form = root.querySelector('[data-form="workflow-publish"]'); if (!form || state.dialog.busy) return;
      const draft = workflowDraft(form);
      if (action === 'workflow-add-step' && draft.steps.length < 8) draft.steps.push({ title: '', body: '', acceptance: '', plan_approval: true });
      if (action === 'workflow-remove-step' && draft.steps.length > 1) draft.steps.splice(Number(el.dataset.position), 1);
      state.dialog = { ...state.dialog, draft }; update(); return;
    }
    case 'workflow-open-card': closePalette(); openSearchResult({ id: el.dataset.card, boardId: el.dataset.board }); return;
    case 'quick-add': openQuickAdd(); return;
    case 'quick-add-submit': commitTitles(parseTitles(root.querySelector('.quickadd-input')?.value), false); return;
    case 'quick-add-cancel': closeQuickAdd(); return;
    case 'quick-add-confirm': {
      const { confirm, keep } = state.quickAdd;
      const ta = root.querySelector('.quickadd-input');
      if (ta) { ta.value = ''; ta.focus(); }
      createQuick(confirm, keep);
      return;
    }
    case 'quick-add-decline': state.quickAdd = { ...state.quickAdd, confirm: null }; update(); root.querySelector('.quickadd-input')?.focus(); return;
    case 'theme': setTheme(el.dataset.next); return;
    case 'board-bg': setBg(el.dataset.bg); return;
    case 'theme-menu':
      state.themeMenu = !state.themeMenu;
      renderNow();
      if (state.themeMenu) root.querySelector('.theme-menu [aria-checked="true"]')?.focus();
      return;
    case 'reconnect': socket?.reconnectNow(); return;
    case 'clear-selection': setSelection(new Set()); return;
    case 'filter-chip': setFilters({ ...state.filters, chips: toggleIn(state.filters.chips, el.dataset.chip) }); return;
    case 'filter-label-off': setFilters({ ...state.filters, labels: state.filters.labels.filter((l) => l !== el.dataset.label) }); return;
    case 'filter-clear': setFilters(emptyFilters()); return;
    case 'toggle-done': state.showAllDone = !state.showAllDone; update(); return;
    case 'toggle-archived': setShowArchived(!state.showArchived); return;
    case 'archive': archiveCards([cardId]); return;
    case 'restore': restoreCards([cardId]); return;
    case 'bulk-archive': archiveCards([...state.selection].filter((id) => state.cards.has(id))); return;
    case 'bulk-restore': restoreCards([...state.selection].filter((id) => state.archived?.has(id))); return;
    case 'set-cover': setCover(cardId, el.dataset.cover); return;
    case 'labels-open': state.dialog = { kind: 'labels', busy: false, error: null }; update(); return;
    case 'label-rename-ask': state.dialog = { ...state.dialog, rename: el.dataset.label, confirmDelete: null }; update(); return;
    case 'label-delete-ask': state.dialog = { ...state.dialog, confirmDelete: el.dataset.label, rename: null }; update(); return;
    case 'label-cancel': state.dialog = { ...state.dialog, confirmDelete: null, rename: null }; update(); return;
    case 'label-delete': {
      const name = el.dataset.label;
      const strip = el.dataset.strip === '1';
      labelCall(() => api.deleteLabel(state.boardId, name, strip)).then((ok) => { if (ok) toast(strip ? `Removed ${name} from every card.` : `${name} has no colour now.`); });
      return;
    }
    case 'view': setView(el.dataset.view); return;
    case 'local-card-dismiss':
      state.localCardDismissed = true;
      try { localStorage.setItem('board-local-card', 'dismissed'); } catch { /* private mode */ }
      update();
      return;
    case 'integ-reload': loadIntegrations(); return;
    case 'integ-connect': connectIntegration(el.dataset.provider, el.dataset.kind); return;
    case 'integ-token-cancel': state.integ = { ...state.integ, tokenFor: null }; update(); return;
    case 'integ-activity': toggleActivity(el.dataset.conn); return;
    case 'integ-disconnect-ask': state.integ = { ...state.integ, confirmDisconnect: el.dataset.conn }; update(); return;
    case 'integ-disconnect-cancel': state.integ = { ...state.integ, confirmDisconnect: null }; update(); return;
    case 'integ-disconnect': disconnectIntegration(el.dataset.conn); return;
    case 'integ-paste': pasteInstead(el.dataset.provider); return;
    case 'integ-authorize': authorizePending(el.dataset.pending, el.dataset.provider); return;
    case 'integ-pending-cancel-ask': state.integ = { ...state.integ, confirmCancel: el.dataset.pending }; update(); return;
    case 'integ-pending-cancel-keep': state.integ = { ...state.integ, confirmCancel: null }; update(); return;
    case 'integ-pending-cancel': cancelPending(el.dataset.pending); return;
    case 'integ-link': linkIdentity(el.dataset.conn, el.dataset.provider); return;
    case 'integ-unlink': unlinkIdentity(el.dataset.conn); return;
    case 'integ-linked': toggleLinked(el.dataset.conn); return;
    case 'integ-revoke': revokeIdentity(el.dataset.conn, el.dataset.member); return;
    case 'dashboard-refresh': if (el.getAttribute('aria-disabled') !== 'true') loadJournal(); return;
    case 'table-sort': state.table = { ...state.table, sort: nextSort(state.table.sort, el.dataset.by) }; update(); return;
    case 'access-login': e.preventDefault(); location.reload(); return;
    case 'accept-invite': joinTeam('invites', { invite_id: el.dataset.invite }); return;
    case 'signout': signOut(); return;
    case 'copy-invite': copyInvite(el.dataset.what); return;
    case 'resend-invite': resendInvite(); return;
    default:
  }
}

function onSubmit(e) {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  submitDialogForm(form, e.submitter);
}

function onInput(e) {
  const el = e.target.closest?.('[data-input]');
  if (el?.dataset.input === 'filter-q') setFilters({ ...state.filters, q: el.value });
  if (el?.dataset.input === 'palette-q' && state.dialog?.kind === 'palette') {
    state.dialog = { ...state.dialog, query: el.value, index: 0 };
    if (state.dialog.scope === 'search') searchSoon();
    update();
  }
}

function onChange(e) {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const what = el.dataset.change;
  if (what === 'workflow-version' && state.dialog?.kind === 'workflows') {
    const fd = new FormData(root.querySelector('[data-form="workflow-apply"]'));
    state.dialog = { ...state.dialog, previewVersion: Number(el.value), request_id: crypto.randomUUID(), context: String(fd.get('context') ?? ''), title_prefix: String(fd.get('title_prefix') ?? '') }; update(); return;
  }
  if (what === 'board') { switchBoard(el.value); return; }
  if (what === 'integ-board') { setIntegrationBoard(el.dataset.conn, el.value); return; }
  if (what === 'give-target' && state.dialog?.kind === 'give') { state.dialog = { ...state.dialog, target: el.value }; loadPreview(); }
  if (what === 'give-ai' && state.dialog?.kind === 'give') { state.dialog = { ...state.dialog, ai: el.value }; update(); }
  if (what === 'give-budget-mode' && state.dialog?.kind === 'give') { state.dialog = { ...state.dialog, budget_mode: el.value }; update(); }
  if (what === 'give-budget' && state.dialog?.kind === 'give') state.dialog = { ...state.dialog, budget_usd: el.value };
  if (what === 'give-repo' && state.dialog?.kind === 'give') {
    const repo = state.repos?.find((r) => r.id === el.value);
    const form = el.form;
    state.dialog = { ...state.dialog, repo_id: el.value, base_ref: form?.base_ref?.value || repo?.default_branch || '' };
    loadPreview();
  }
  if (what === 'handover-kind' && state.dialog?.kind === 'handover') { state.dialog = { ...state.dialog, kind_: el.value }; update(); }
  if (what === 'move') moveCards([el.dataset.card], el.value);
  if (what === 'filter-label' && el.value) { setFilters({ ...state.filters, labels: [...state.filters.labels, el.value] }); el.value = ''; }
  if (what === 'filter-assignee') setFilters({ ...state.filters, assignee: el.value || null });
  if (what === 'bulk-move' && el.value) { moveCards([...state.selection], el.value); el.value = ''; }
  if (what === 'integ-autonomy') setAutonomy(el.dataset.conn, el.dataset.actionId, el.value);
  if (what === 'label-color' && el.value) {
    const name = el.dataset.label;
    labelCall(() => (el.dataset.registered ? api.patchLabel(state.boardId, name, { color: el.value }) : api.createLabel(state.boardId, name, el.value)));
  }
}

// Dialog close (Escape, backdrop, close buttons) is the one path back to state.
function onDialogClose(e) {
  const el = e.target;
  if (!(el instanceof HTMLDialogElement) || !el.dataset.dialog) return;
  if (el.dataset.dialog === 'drawer') { if (state.detail) closeDrawer(); } else if (state.dialog) { state.dialog = null; update(); }
}

// Keyboard drag: Space lifts the focused card, ←/→ pick a column, Space/Enter
// drops, Esc cancels. Space would also "click" the card open, so its keyup is
// swallowed whenever a keydown was ours.
let swallowSpaceUp = false;

function kbdKeydown(e) {
  if (state.kbd) {
    if (!['ArrowLeft', 'ArrowRight', ' ', 'Enter', 'Escape'].includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === ' ') swallowSpaceUp = true;
    const held = state.kbd;
    const { state: next, effect } = kbdKey(held, e.key);
    state.kbd = next;
    const count = held.ids.length;
    const key = viewOf(held.ids[0])?.key ?? 'Card';
    if (effect.type === 'drop') {
      moveCards(held.ids, effect.column);
      root.querySelector(`[data-card-id="${CSS.escape(held.ids[0])}"] .card-open`)?.focus();
    } else {
      say(announcement(effect, { key, count, from: held.from, over: (next ?? held).over }));
      update();
    }
    return true;
  }
  const open = e.key === ' ' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey ? e.target.closest?.('.card-open') : null;
  const cardEl = open?.closest('.card[data-draggable="true"]');
  if (!cardEl) return false;
  e.preventDefault();
  swallowSpaceUp = true;
  const id = cardEl.dataset.cardId;
  const ids = idsToDrag(state.selection, id);
  state.kbd = kbdStart(ids, viewOf(id).column);
  say(announcement({ type: 'pickup' }, { key: viewOf(id).key, count: ids.length }));
  update();
  return true;
}

function onKeyup(e) {
  if (e.key === ' ' && swallowSpaceUp) { swallowSpaceUp = false; e.preventDefault(); }
}

function onFocusout(e) {
  if (!state.kbd || !e.target.closest?.('.card-open') || e.relatedTarget === e.target) return;
  const held = state.kbd;
  state.kbd = null;
  say(announcement({ type: 'cancel' }, { key: viewOf(held.ids[0])?.key, count: held.ids.length, from: held.from }));
  update();
}

function themeMenuKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeThemeMenu({ refocus: true }); return true; }
  const items = [...root.querySelectorAll('.theme-menu [role="menuitemradio"]')];
  const i = items.indexOf(e.target.closest('[role="menuitemradio"]'));
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (step == null && e.key !== 'Home' && e.key !== 'End') return false;
  e.preventDefault();
  items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + step + items.length) % items.length]?.focus();
  return true;
}

function onKeydown(e) {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); togglePalette(); return; }
  if (e.target.dataset?.input === 'palette-q') { paletteKeydown(e); return; }
  if (kbdKeydown(e)) return;
  if (e.target.closest?.('.theme-menu') && themeMenuKey(e)) return;
  if (e.target.dataset?.input === 'quickadd') {
    if (e.key === 'Escape') { e.preventDefault(); closeQuickAdd(); }
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); commitTitles(parseTitles(e.target.value), e.shiftKey); }
    return;
  }
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'n' && state.auth === 'ok' && state.board && !root.querySelector('dialog[open]')) {
    e.preventDefault();
    if (!boardReadOnly() && !openQuickAdd()) openNewCard();
    return;
  }
  if (!typing && e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && state.view !== 'dashboard' && !root.querySelector('dialog[open]')) {
    e.preventDefault();
    root.querySelector('[data-input="filter-q"]')?.focus();
    return;
  }
  if (e.key === 'Escape' && e.target.dataset?.input === 'filter-q') {
    e.preventDefault();
    if (e.target.value) setFilters({ ...state.filters, q: '' }); else e.target.blur();
    return;
  }
  if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && !root.querySelector('dialog[open]')) {
    const cardEl = e.key === 'x' ? e.target.closest?.('.card-open')?.closest('.card[data-card-id]') : null;
    if (cardEl) { e.preventDefault(); setSelection(toggleSelection(state.selection, cardEl.dataset.cardId)); return; }
    if (e.key === 'Escape' && state.selection.size) { setSelection(new Set()); return; }
    if (e.key === 'Escape' && state.view !== 'dashboard' && isFiltering(state.filters)) { setFilters(emptyFilters()); return; }
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

// Pointer drag: human-owned cards only. Agent-driven cards move by run state.
installDnd({
  root,
  dragIds: (el) => idsToDrag(state.selection, el.dataset.cardId),
  start: (ids) => { state.drag = { ids, over: null, mode: 'pointer' }; update(); },
  hover: (over) => { if (state.drag) { state.drag = { ...state.drag, over }; update(); } },
  drop: (ids, column, rect) => moveCards(ids, column, { flipFrom: rect }).moves.length > 0,
  end: () => { state.drag = null; update(); },
});

function onImgError(e) {
  if (e.target instanceof HTMLImageElement && e.target.hasAttribute('data-avatar')) e.target.remove();
}

document.addEventListener('click', onClick);
document.addEventListener('submit', onSubmit);
document.addEventListener('change', onChange);
document.addEventListener('input', onInput);
document.addEventListener('keydown', onKeydown);
document.addEventListener('close', onDialogClose, true);
document.addEventListener('keyup', onKeyup);
document.addEventListener('paste', onPaste);
document.addEventListener('focusout', onFocusout);
document.addEventListener('error', onImgError, true);
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => update());

// Ages advance between pushes (§5.1): re-derive every face once a second.
setInterval(() => { if (state.auth === 'ok' && state.board) update(); }, 1000);
setInterval(() => { if (state.view === 'dashboard' && state.board && document.visibilityState === 'visible') loadJournal(); }, DASH_REFRESH_MS);
setInterval(() => { if (state.view === 'team' && document.visibilityState === 'visible') loadTeamOverview(); }, 15_000);

loadTheme();
loadLocalCard();
loadView();
loadFilters();
takeDevSecretFromHash();
takeFeedbackFromHash();
addEventListener('hashchange', takeFeedbackFromHash);
boot();
