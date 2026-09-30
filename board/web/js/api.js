// HTTP client for CONTRACT §5.2. Every mutation carries a fresh request_id
// (D8) and Content-Type: application/json; errors come back as ApiError with
// the hub's code and any extra fields (e.g. answered_by).

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

async function call(method, path, body, { fetchImpl = globalThis.fetch, headers = {} } = {}) {
  let res;
  try {
    res = await fetchImpl(path, {
      method,
      credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' }), ...(org ? { 'Board-Org': org } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: { code: 'NETWORK', message: "Can't reach the board." } });
  }
  const text = await res.text();
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
  // The hub prints a per-process dev secret at startup (never behind a proxy/tunnel).
  devLogin: (github_login, secret) => call('POST', '/api/dev/login', { github_login }, { headers: { 'Board-Dev-Secret': secret ?? '' } }),
  board: (id) => call('GET', `/api/boards/${enc(id)}`),
  card: (id) => call('GET', `/api/cards/${enc(id)}`),
  createCard: (boardId, body) => mut('POST', `/api/boards/${enc(boardId)}/cards`, body),
  patchCard: (id, body) => mut('PATCH', `/api/cards/${enc(id)}`, body),
  action: (id, action, body) => mut('POST', `/api/cards/${enc(id)}/actions/${enc(action)}`, body),
  answerPermission: (id, decision, scope) => mut('POST', `/api/permission-requests/${enc(id)}/answer`, { decision, ...(scope ? { scope } : {}) }),
  comment: (id, body, for_agent) => mut('POST', `/api/cards/${enc(id)}/comments`, { body, for_agent }),
  overlapPreview: (id, target) => call('GET', `/api/cards/${enc(id)}/overlap-preview${target ? `?target_member_id=${enc(target)}` : ''}`),
  repos: () => call('GET', '/api/repos'),
  journal: (boardId, afterSeq = 0, limit = 1000) => call('GET', `/api/boards/${enc(boardId)}/journal?after_seq=${enc(afterSeq)}&limit=${enc(limit)}`),
};

// Human copy for the hub's error codes (CONTRACT §8).
export function errorText(err) {
  switch (err?.code) {
    case 'ALREADY_ANSWERED': return `Already answered by ${err.extra?.answered_by?.name ?? err.extra?.answered_by ?? 'a teammate'}.`;
    case 'VERSION_CONFLICT': return 'Someone changed this card a moment ago. It has been refreshed; try again.';
    case 'CONFLICT': return 'That clashes with the card’s current run.';
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
