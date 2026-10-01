// HTTP client for CONTRACT §5.2. Every mutation carries a fresh request_id
// (D8) and Content-Type: application/json; errors come back as ApiError with
// the hub's code and any extra fields (e.g. answered_by).
import { clockOffset } from './metrics.js';

export class ApiError extends Error {
  constructor(status, body) {
    const e = body?.error ?? {};
    super(e.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = e.code ?? (status === 0 ? 'NETWORK' : 'INTERNAL');
    this.extra = e;
  }
}

export const requestId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `r-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// One sign-in can belong to several orgs; the chosen one rides every call.
let org = null;
export const setOrg = (id) => { org = id ?? null; };
export const currentOrg = () => org;
// Accounts mode with a cookie session: every mutation carries X-CSRF-Token (from /api/me).
let csrf = null;
export const setCsrf = (t) => { csrf = t ?? null; };

async function call(method, path, body, { fetchImpl = globalThis.fetch, headers = {}, signal, onResponse } = {}) { // privacy-flow: board-view
  let res;
  try {
    res = await fetchImpl(path, { // privacy-flow: board-view
      method,
      credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' }), ...(org ? { 'Board-Org': org } : {}), ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch {
    throw new ApiError(0, { error: { code: 'NETWORK', message: "Can't reach the board." } });
  }
  onResponse?.(res);
  let text;
  // A timeout can land mid-body as well as mid-connect.
  try { text = await res.text(); } catch {
    throw new ApiError(0, { error: { code: 'NETWORK', message: "Can't reach the board." } });
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const enc = encodeURIComponent;
const mut = (method, path, body = {}) => call(method, path, { request_id: requestId(), ...body });

export const api = {
  health: () => call('GET', '/api/health'),
  me: () => call('GET', '/api/me'),
  // Accounts mode (ACCOUNTS-API.md): which sign-ins the hub offers, a first team, joining one.
  methods: () => call('GET', '/api/auth/methods'),
  setupAccount: () => mut('POST', '/api/account/setup'),
  boards: (includeArchived = false) => call('GET', `/api/boards${includeArchived ? '?include_archived=1' : ''}`),
  search: (q) => call('GET', `/api/search?${new URLSearchParams({ q })}`),
  teamOverview: () => call('GET', '/api/team-overview'),
  workflows: (includeArchived = false) => call('GET', `/api/workflows${includeArchived ? '?include_archived=1' : ''}`),
  workflow: (id) => call('GET', `/api/workflows/${enc(id)}`),
  publishWorkflow: (id, body) => mut('POST', id ? `/api/workflows/${enc(id)}/versions` : '/api/workflows', body),
  archiveWorkflow: (id, archived) => mut('POST', `/api/workflows/${enc(id)}/archive`, { archived }),
  applyWorkflow: (boardId, id, body) => mut('POST', `/api/boards/${enc(boardId)}/workflows/${enc(id)}/apply`, body),
  createBoard: (body) => mut('POST', '/api/boards', body),
  renameBoard: (id, name) => mut('PATCH', `/api/boards/${enc(id)}`, { name }),
  archiveBoard: (id) => mut('POST', `/api/boards/${enc(id)}/archive`),
  restoreBoard: (id) => mut('POST', `/api/boards/${enc(id)}/restore`),
  signout: () => mut('POST', '/api/auth/signout'),
  createTeam: (name) => mut('POST', '/api/teams', { name }),
  acceptInvite: (body) => mut('POST', '/api/invites/accept', body),
  createInvite: (teamId, email, role) => mut('POST', `/api/teams/${enc(teamId)}/invites`, { email, role }),
  listInvites: (teamId) => call('GET', `/api/teams/${enc(teamId)}/invites`),
  resendInvite: (teamId, id) => mut('POST', `/api/teams/${enc(teamId)}/invites/${enc(id)}/resend`),
  // The hub prints a per-process dev secret at startup (never behind a proxy/tunnel).
  devLogin: (github_login, secret) => call('POST', '/api/dev/login', { github_login }, { headers: { 'Board-Dev-Secret': secret ?? '' } }),
  board: (id, { includeArchived = false } = {}) => call('GET', `/api/boards/${enc(id)}${includeArchived ? '?include_archived=1' : ''}`),
  labels: (boardId) => call('GET', `/api/boards/${enc(boardId)}/labels`),
  createLabel: (boardId, name, color) => mut('POST', `/api/boards/${enc(boardId)}/labels`, { name, color }),
  patchLabel: (boardId, name, patch) => mut('PATCH', `/api/boards/${enc(boardId)}/labels/${enc(name)}`, patch),
  deleteLabel: (boardId, name, strip) => mut('DELETE', `/api/boards/${enc(boardId)}/labels/${enc(name)}`, { strip: !!strip }),
  archiveCard: (id) => mut('POST', `/api/cards/${enc(id)}/archive`),
  restoreCard: (id) => mut('POST', `/api/cards/${enc(id)}/restore`),
  presence: (boardId) => call('GET', `/api/boards/${enc(boardId)}/presence`),
  card: (id) => call('GET', `/api/cards/${enc(id)}`),
  createCard: (boardId, body) => mut('POST', `/api/boards/${enc(boardId)}/cards`, body),
  patchCard: (id, body) => mut('PATCH', `/api/cards/${enc(id)}`, body),
  action: (id, action, body) => mut('POST', `/api/cards/${enc(id)}/actions/${enc(action)}`, body),
  answerPermission: (id, decision, scope) => mut('POST', `/api/permission-requests/${enc(id)}/answer`, { decision, ...(scope ? { scope } : {}) }),
  comment: (id, body, for_agent) => mut('POST', `/api/cards/${enc(id)}/comments`, { body, for_agent }),
  overlapPreview: (id, target, repo) => {
    const q = new URLSearchParams(); if (target) q.set('target_member_id', target); if (repo) q.set('repo_id', repo);
    return call('GET', `/api/cards/${enc(id)}/overlap-preview${q.size ? `?${q}` : ''}`);
  },
  repos: () => call('GET', '/api/repos'),
  // Integrations (team-level; admins connect, configure and disconnect).
  integrations: () => call('GET', '/api/integrations'),
  connectToken: (provider, token) => mut('POST', `/api/integrations/${enc(provider)}/token`, { token }),
  startConnect: (provider, input) => mut('POST', `/api/integrations/${enc(provider)}/start`, input && Object.keys(input).length ? { input } : undefined),
  patchIntegration: (id, patch) => mut('PATCH', `/api/integrations/${enc(id)}`, patch),
  // D97: target is a provider (start) or a pending id (the pasted fields).
  prepareIntegration: (target, input) => mut('POST', `/api/integrations/${enc(target)}/prepare`, { input }),
  authorizeIntegration: (id) => mut('POST', `/api/integrations/${enc(id)}/authorize`),
  disconnectIntegration: (id) => mut('DELETE', `/api/integrations/${enc(id)}`),
  // Admins only (D42): members get 403, so the page shows them no Activity.
  integrationAudit: (id) => call('GET', `/api/integrations/${enc(id)}/audit?limit=50`),
  // D98: a member links and unlinks only their own account; admins list and revoke.
  startIdentityLink: (id) => mut('POST', `/api/integrations/${enc(id)}/identity/start`),
  unlinkIdentity: (id) => mut('DELETE', `/api/integrations/${enc(id)}/identity`),
  linkedMembers: (id) => call('GET', `/api/integrations/${enc(id)}/identities`),
  revokeIdentity: (id, memberId) => mut('DELETE', `/api/integrations/${enc(id)}/identities/${enc(memberId)}`),
  // Also returns offset_ms (hub clock − ours, from the Date header): journal
  // times are hub times. A page gets 30 s before it counts as unreachable.
  journal: async (boardId, afterSeq = 0, limit = 1000) => {
    const sent = Date.now();
    let offset_ms = null;
    const data = await call('GET', `/api/boards/${enc(boardId)}/journal?after_seq=${enc(afterSeq)}&limit=${enc(limit)}`, undefined, {
      signal: AbortSignal.timeout(30_000),
      onResponse: (res) => { offset_ms = clockOffset(res.headers.get('Date'), sent, Date.now()); },
    });
    return { ...data, offset_ms };
  },
};

// Human copy for the hub's error codes (CONTRACT §8).
export function errorText(err) {
  switch (err?.code) {
    case 'ALREADY_ANSWERED': return `Already answered by ${err.extra?.answered_by?.name ?? err.extra?.answered_by ?? 'a teammate'}.`;
    case 'VERSION_CONFLICT': return 'Someone changed this card a moment ago. It has been refreshed; try again.';
    case 'CONFLICT':
      if (err.extra?.reason === 'PREFIX_TAKEN') return 'This key prefix is already used by another board. Choose a different prefix or leave it blank.';
      if (err.extra?.reason === 'LAST_ACTIVE_BOARD') return 'Keep at least one active board. Create or restore another board first.';
      if (err.extra?.reason === 'ACTIVE_RUN') return 'Stop active runs before archiving this board.';
      if (err.extra?.reason === 'BOARD_ARCHIVED') return 'This board is archived and read-only. Restore it before making changes.';
      if (err.extra?.reason === 'ARCHIVED') return 'This card is archived. Restore it first.';
      if (err.extra?.reason === 'RUN_ACTIVE') return 'Stop, cancel or finish the run before archiving.';
      if (err.extra?.reason === 'TOO_MANY_CARDS') return 'That label is on too many cards to change at once.';
      return err.message && /label/.test(err.message) ? err.message : 'That clashes with the card’s current run.';
    case 'QUOTA_EXCEEDED': return err.message ?? 'Your plan’s limit is reached.';
    case 'ILLEGAL_TRANSITION': return 'The card moved on before that landed. Check its state and try again.';
    case 'FORBIDDEN': return err.message && !/^guard /.test(err.message) ? err.message : 'You’re not allowed to do that on this card.';
    case 'POLICY_DENIED': return `Blocked by policy${err.message ? `: ${err.message}` : ''}.`;
    case 'NO_REPO': return 'Pick a repo first. Claude only works inside a repo.';
    case 'BUDGET_EXCEEDED': return 'The budget for this card or today is used up.';
    case 'CONFIRM_REQUIRED': return 'Confirm the take over first.';
    case 'RATE_LIMITED': return 'Too many requests. Wait a few seconds and try again.';
    case 'NETWORK': return 'Can’t reach the board. Check the connection and try again.';
    case 'UNAUTHENTICATED': return 'Your session ended. Sign in again.';
    case 'VALIDATION': return err.message ?? 'Some fields need fixing.';
    default: return err?.message ?? 'Something went wrong.';
  }
}
