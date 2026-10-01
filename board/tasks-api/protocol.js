// Local Tasks API constants (TASKS-CONTRACT.md is the prose law, schema.json
// the shapes; this file is the machine-readable list both are checked
// against: test/protocol.test.js fails if a name here is missing from
// TASKS-CONTRACT.md or schema.json).
//
// Browser-safe, dependency-free.

export const TASKS_PROTOCOL_VERSION = 1;

export const MAX_FRAME_BYTES = 1 << 20;          // 1 MiB per NDJSON line, both directions
export const MAX_TRANSCRIPT_CHUNK = 64 * 1024;   // a transcript event's text
export const MAX_PATCH_BYTES = 256 * 1024;       // a diff event's inline patch
export const HB_PUSH_MS = 5000;                  // supervisor → client heartbeat push
export const GREEN_TTL_MS = 15000;               // a green signal is believed for at most this long
export const RING_EVENTS = 10000;                // replay ring (events kept for resume-from-seq)
export const BACKPRESSURE_BYTES = 4 * 1024 * 1024; // socket write buffer before a subscription is dropped as lagged
export const REQUEST_CACHE_MS = 24 * 60 * 60 * 1000; // createTask requestId memory
export const ACT_CACHE_MS = 10 * 60 * 1000;      // act requestId memory (board D8)
export const TAKEOVER_TIMEOUT_MS = 4 * 60 * 1000; // client timeout for act takeover (> T_HANDOVER_MS)

// Its own socket in the engine's data dir; the runner's control socket stays runner.sock.
export const SOCKET_NAME = 'tasks.sock';
export const TOKEN_NAME = 'tasks.token';

export const METHODS = Object.freeze([
  'hello', 'createTask', 'listTasks', 'getTask', 'subscribe', 'unsubscribe', 'act',
  'detectAIs', 'getLimits', 'setLimits', 'getClaims', 'listMessages',
]);

export const ACTIONS = Object.freeze([
  'pause', 'resume', 'stop', 'takeover', 'handback', 'message', 'approve', 'deny', 'answer',
  'merge', 'openPr', 'discard', 'retry', 'switchAi',
]);

export const EVENT_TYPES = Object.freeze([
  'state', 'transcript', 'tool', 'diff', 'approval', 'ask', 'cost', 'handover', 'claims', 'overlap', 'error',
  'message', 'message-state',
]);

export const PUSH_KINDS = Object.freeze(['event', 'hb', 'lagged', 'reset', 'bye']);

export const AIS = Object.freeze(['claude', 'codex', 'gemini']);
export const AI_CHOICES = Object.freeze([...AIS, 'auto']);
export const SURFACES = Object.freeze(['background', 'tmux', 'tab']);
export const PERMISSION_LEVELS = Object.freeze(['plan', 'ask', 'auto-edits', 'auto', 'bypass']);
export const SOURCES = Object.freeze(['local', 'mcp', 'cli', 'board', 'phone', 'slack', 'voice']);
export const LOCAL_SOURCES = Object.freeze(['local', 'cli']);
export const REMOTE_SOURCES = Object.freeze(['board', 'phone', 'slack', 'voice']);
export const PARK_REASONS = Object.freeze(['user', 'limit', 'auth', 'ask_timeout', 'approval_timeout', 'message_loop']);
export const OUTCOMES = Object.freeze(['merged', 'pr_opened', 'pr_merged', 'discarded']);
export const CAPABILITIES = Object.freeze(['background', 'resume', 'hooks', 'mcp', 'permissionRouting', 'modelSelect', 'costReport', 'sandbox']);

// Board error codes reused verbatim (shared/protocol.js ERRORS), plus the
// tasks-only codes below them.
export const ERRORS = Object.freeze([
  'VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'POLICY_DENIED', 'NOT_FOUND', 'ILLEGAL_TRANSITION',
  'CONFLICT', 'ALREADY_ANSWERED', 'PAYLOAD_TOO_LARGE', 'BUDGET_EXCEEDED', 'PROTOCOL_UNSUPPORTED',
  'CONFIRM_REQUIRED', 'RATE_LIMITED', 'INTERNAL', 'HUB_UNREACHABLE',
  // tasks-only
  'UNKNOWN_METHOD', 'AI_UNAVAILABLE', 'CAPABILITY_MISSING', 'NO_HANDOVER', 'IN_PLACE_BUSY',
  'SESSION_BUSY', 'MERGE_CONFLICT', 'DISK_FULL', 'HUB_OWNED', 'TIMEOUT', 'NO_ROUTE', 'SUPERVISOR_UNREACHABLE',
]);

// Agent-facing MCP tools (thin clients over this API / the supervisor relay).
export const MCP_TASK_TOOLS = Object.freeze(['buddy_spin_off', 'buddy_message', 'check_messages']);

// `buddy <subcommand>` registry: implemented now / later.
export const CLI_SUBCOMMANDS = Object.freeze({ run: 'now', give: 'later', status: 'later', ask: 'later' });
