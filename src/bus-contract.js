'use strict';
// The agent bus's shared vocabulary (BACKBONE-AUDIT-AND-PLAN §4 contract). Owned by the bus core lane: enrolment
// and UI import it read-only and ask for changes rather than editing it. CommonJS so main (require) and the
// tasks utilityProcess (createRequire, as engine.js loads hooks/repo-scope.js) share one copy.
// Every value here can reach a model or a log line, so none of them carries a path, a body or a secret.

const freeze = (o) => Object.freeze(o);

// Identity tiers. person / run_capability / local_attested are the guard's existing ones (bus/guard.js);
// unverified_client and headless are the read-only tiers for callers Plexiform cannot bind to a live session.
const TIERS = freeze({
  PERSON: 'person',
  RUN_CAPABILITY: 'run_capability',
  LOCAL_ATTESTED: 'local_attested',
  UNVERIFIED_CLIENT: 'unverified_client',
  HEADLESS: 'headless',
});
// What each tier may do. A tier missing an op is refused with POLICY_DENIED.
const TIER_CAN = freeze({
  person: freeze(['peers', 'note', 'notes', 'handoff', 'card']),
  run_capability: freeze(['peers', 'handoff', 'result', 'card']),
  local_attested: freeze(['peers', 'note', 'notes', 'handoff', 'card']),
  unverified_client: freeze(['peers', 'card_personal']),
  headless: freeze(['peers']),
});

// Why a repository is not on the bus (bus_hello policy_summary.repo_reason, bus_handoff refusals). Present only
// when repo_enabled is false.
const REPO_REASON = freeze({
  EXCLUDED: 'EXCLUDED', // on the person's "never these" list
  PROTECTED: 'PROTECTED', // the home folder, a folder holding it, a dot folder in it, ~/Library, Plexiform's data
  LISTED_ONLY: 'LISTED_ONLY', // scope is "only these repositories" and this repo is not on the list
  NO_SESSION: 'NO_SESSION', // automatic mode, an unbound caller, and no session or task folder Plexiform sees in this repo
  NOT_GIT: 'NOT_GIT', // the folder is not inside a git checkout
  BUS_OFF: 'BUS_OFF', // the agent bus is turned off in Preferences or policy.json
});
// One sentence per reason, safe to show a model or a person.
const REPO_REASON_TEXT = freeze({
  EXCLUDED: 'This repository is on the "never these" list in Plexiform Preferences → Advanced → Agent bus.',
  PROTECTED: 'This folder is protected (your home folder, a hidden folder in it, ~/Library or Plexiform\'s data), so the bus never runs work here.',
  LISTED_ONLY: 'Plexiform Preferences → Advanced → Agent bus is set to "Only these repositories", and this repository is not on the list.',
  NO_SESSION: 'No Claude Code or Codex session Plexiform can see is working in this repository.',
  NOT_GIT: 'This folder is not a git checkout. Hand-offs need one, because the work runs in its own git worktree.',
  BUS_OFF: 'The agent bus is turned off in Plexiform Preferences.',
});
// Why a repository IS on the bus (repo_why, informational).
// AUTO: automatic mode, which takes every repository that is not excluded or protected for a bound caller. SESSION and
// WORKTREE: the same for an unbound caller, through a session or task folder in the repository (or a worktree of it).
const REPO_ALLOWED = freeze({ POLICY: 'POLICY', LISTED: 'LISTED', AUTO: 'AUTO', SESSION: 'SESSION', WORKTREE: 'WORKTREE' });

// Refusal codes a bus op can return as {reason, message}. The existing ones keep their meaning.
const BUS_REASON = freeze({
  VALIDATION: 'VALIDATION', HALTED: 'HALTED', RATE: 'RATE', LOOP: 'LOOP', SPEND_CAP: 'SPEND_CAP',
  TIER_NOT_ACCEPTED: 'TIER_NOT_ACCEPTED', POLICY_DENIED: 'POLICY_DENIED', NOT_FOUND: 'NOT_FOUND', CONFLICT: 'CONFLICT',
  NO_ELIGIBLE_AGENT: 'NO_ELIGIBLE_AGENT', NO_LOCAL_CHECKOUT: 'NO_LOCAL_CHECKOUT', NOT_BOUND: 'NOT_BOUND', HEADLESS: 'HEADLESS',
  UNAVAILABLE: 'UNAVAILABLE', AWARENESS_OFF: 'AWARENESS_OFF', UNKNOWN_PEER: 'UNKNOWN_PEER', INTERNAL: 'INTERNAL',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE', // every requested provider's breaker is open; carries {provider, retry_at}
});

// Providers. RECEIVE is the set that can be handed work today (a verified runner); the enum grows only after
// real acceptance. 'any' means the person's fallback order, filtered to RECEIVE.
const PROVIDERS = freeze(['claude', 'codex', 'gemini']);
const RECEIVE_PROVIDERS = freeze(['claude', 'codex']);
const ANY_PROVIDER = 'any';
const DEFAULT_FALLBACK = freeze(['claude', 'codex', 'gemini']);

// Provider health (circuit breaker), one per provider:
//   {provider, state, reason, retry_at, since, failures}
//   state: closed (healthy) | open (refusing until retry_at) | half_open (retry_at passed: runs start again, and the
//   next provider failure re-opens it at once)
//   reason: why it opened (null while closed); retry_at: epoch ms or null; since: epoch ms of the last state change.
const BREAKER_STATE = freeze({ CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' });
const BREAKER_REASON = freeze({ QUOTA: 'QUOTA', AUTH: 'AUTH', MISSING: 'MISSING', CRASH: 'CRASH' });
const BREAKER_COOLDOWN_MS = freeze({ QUOTA: 60 * 60_000, AUTH: 30 * 60_000, MISSING: 10 * 60_000, CRASH: 5 * 60_000 });
const CRASH_THRESHOLD = 3; // consecutive CRASH failures before the breaker opens; QUOTA/AUTH/MISSING open at once
function providerHealth(provider, over = {}) {
  return { provider, state: BREAKER_STATE.CLOSED, reason: null, retry_at: null, since: 0, failures: 0, ...over };
}

// Board routing (§3.5): first matching rule wins, and the answer always carries why.
//   {kind, why, name?, pending_route?}
//   kind: none | personal | team | choose
const BOARD_KIND = freeze({ NONE: 'none', PERSONAL: 'personal', TEAM: 'team', CHOOSE: 'choose' });
const BOARD_WHY = freeze({
  PERSONAL_MARK: 'personal_mark', // 1: the person marked the session personal → none
  INHERITED: 'inherited', // 2: started by a hand-off or card → the originator's board
  LINKED_REPO: 'linked_repo', // 3: repo linked to exactly one team board
  REPO_DEFAULT: 'repo_default', // 4: linked to several boards, the person's default for the repo
  CHOOSE: 'choose', // 4: linked to several, no default → My board with a "pick board" chip
  NO_LINK_SUGGESTED: 'no_link_suggested', // 5: not linked, but its GitHub org matches a team's → My board, suggest linking
  NO_LINK: 'no_link', // 5 fallthrough: not linked and nothing to suggest → My board
  NO_REPO: 'no_repo', // 6: not a git repo, or no remote → My board
  DEFERRED: 'deferred', // 7: hub offline or catalog incomplete → My board, pending_route, re-routed later
  READ_ONLY: 'read_only', // the person's role on the linked board is read-only → My board
  CARDS_OFF: 'cards_off', // automatic cards are off → none
});

// Trace (§3.6 observability). One JSONL line per bus op in <dataDir>/bus-trace.jsonl:
//   {t, trace_id, span, op, from_handle, to, provider, repo_key_hash, result, reason, ms, ref}
// trace_id: 'tr_' + 16 lowercase hex, minted at the first op of a collaboration (a note, a hand-off) and carried
// by everything it causes (notice, read, claim, run, result, card). span: 'sp_' + 8 hex, one per op.
// No field ever holds a note body, a brief, a title or an absolute path; repo_key_hash is sha256(repo)[:16].
const TRACE_ID_RE = /^tr_[0-9a-f]{16}$/;
const SPAN_ID_RE = /^sp_[0-9a-f]{8}$/;
const TRACE_OPS = freeze(['hello', 'peers', 'note', 'notes', 'notified', 'notice', 'handoff', 'claim', 'start', 'result',
  'returned', 'wait', 'read', 'status', 'card', 'route', 'breaker', 'halt', 'resume']);
// ref: the handoff_id or note_id the line is about (added 2026-11-06 with src/bus-trace.js; ids only, never text).
const TRACE_FIELDS = freeze(['t', 'trace_id', 'span', 'op', 'from_handle', 'to', 'provider', 'repo_key_hash', 'result', 'reason', 'ms', 'ref']);
const TRACE_RESULTS = freeze(['ok', 'refused', 'error', 'deferred']);
const isTraceId = (s) => typeof s === 'string' && TRACE_ID_RE.test(s);
const isSpanId = (s) => typeof s === 'string' && SPAN_ID_RE.test(s);

// Mid-turn notices (D3): one line, at most this often per session, never the body.
const NOTICE_MIN_INTERVAL_MS = 2 * 60_000;

// A note the bus writes itself (a hand-off result coming back): from_handle is this, from_provider 'plexiform'.
const SYSTEM_NOTE = freeze({ HANDLE: 'plexiform', PROVIDER: 'plexiform', KIND_RESULT: 'handoff_result' });

module.exports = {
  TIERS, TIER_CAN, REPO_REASON, REPO_REASON_TEXT, REPO_ALLOWED, BUS_REASON,
  PROVIDERS, RECEIVE_PROVIDERS, ANY_PROVIDER, DEFAULT_FALLBACK,
  BREAKER_STATE, BREAKER_REASON, BREAKER_COOLDOWN_MS, CRASH_THRESHOLD, providerHealth,
  BOARD_KIND, BOARD_WHY,
  TRACE_ID_RE, SPAN_ID_RE, TRACE_OPS, TRACE_FIELDS, TRACE_RESULTS, isTraceId, isSpanId,
  NOTICE_MIN_INTERVAL_MS, SYSTEM_NOTE,
};
