#!/usr/bin/env node
// Generates tasks-api/schema.json (JSON Schema draft 2020-12) from the
// constants in tasks-api/protocol.js and shared/states.js, so the enums can't
// drift. `npm run tasks:schema` rewrites it; test/schema.test.js fails when
// the committed file differs from this output.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATES, BLOCKED_KINDS, FAIL_KINDS } from '../../shared/states.js';
import { PARTY_KINDS, MSG_MAX_BYTES } from '../mesh.js';
import {
  TASKS_PROTOCOL_VERSION, METHODS, ACTIONS, EVENT_TYPES, AIS, AI_CHOICES, SURFACES, PERMISSION_LEVELS,
  SOURCES, PARK_REASONS, OUTCOMES, CAPABILITIES, ERRORS, MAX_TRANSCRIPT_CHUNK, MAX_PATCH_BYTES,
} from '../protocol.js';

const ref = (n) => ({ $ref: `#/$defs/${n}` });
const nullable = (s) => ({ anyOf: [s, { type: 'null' }] });
// Every string has a cap (security review): 256 unless the field says otherwise.
const str = (extra = {}) => ({ type: 'string', maxLength: 256, ...extra });
const PATH = { maxLength: 1024 };
const LONG = { maxLength: 20000 };
const DOC = { maxLength: 65536 };
const int = (extra = {}) => ({ type: 'integer', minimum: 0, ...extra });
const num = (extra = {}) => ({ type: 'number', minimum: 0, ...extra });
const bool = { type: 'boolean' };
const arr = (items, extra = {}) => ({ type: 'array', items, ...extra });
const en = (values) => ({ enum: [...values] });
const obj = (properties, required = Object.keys(properties), extra = {}) => ({
  type: 'object', properties, required, additionalProperties: false, ...extra,
});
const optional = (properties, required) => obj(properties, required);

const ASK_KINDS = [...BLOCKED_KINDS, 'limit', 'auth'];
const HANDOVER_PROVENANCE = ['continuous', 'checkpoint_complete', 'checkpoint_incomplete', 'takeover', 'frozen'];
const packetArtifact = { oneOf: [obj({ kind: { const: 'path' }, path: str(PATH) }), obj({ kind: { const: 'commit' }, sha: str({ minLength: 40, maxLength: 64 }) }), obj({ kind: { const: 'pr' }, url: str({ maxLength: 1024 }) })] };
const packetDataProps = {
  brief: str({ maxLength: 4000 }), decisions: arr(str({ maxLength: 500 })), progress: str({ maxLength: 4000 }),
  nextAction: str({ maxLength: 2000 }), artifacts: arr(packetArtifact), reportedChecks: arr(str({ maxLength: 500 })),
};
const packet = obj({ schemaVersion: { const: 1 }, version: int({ minimum: 1 }), at: int(),
  author: obj({ kind: en(['human', 'agent', 'remote', 'supervisor']), id: str(), source: en([...SOURCES, 'engine']) }),
  provenance: en([...HANDOVER_PROVENANCE, 'participant']), ...packetDataProps,
  observed: obj({ state: en(STATES), tests: nullable(en(['pass', 'fail', 'none'])) }),
});

const faceProps = {
  green: bool,
  label: str(),
  tone: str(),
  reason: str({ maxLength: 1024 }),
  actions: arr(en(ACTIONS), { uniqueItems: true }),
  confirm: arr(en(ACTIONS), { uniqueItems: true }),
};

const leaseView = obj({
  hb_age_ms: nullable(int()),
  child_alive: bool,
  activity_age_ms: nullable(int()),
  tool_in_flight: nullable(obj({ name: str(), summary: str(), age_ms: int(), bash_timeout_ms: int() }, ['name', 'summary', 'age_ms'])),
  wake_age_ms: nullable(int()),
  post_wake_activity: bool,
  green: bool,
});

const taskSpec = optional({
  text: str({ minLength: 1, maxLength: 20000 }),
  title: str({ maxLength: 120 }),
  cwd: str({ minLength: 1, ...PATH }),
  repo: str(PATH),
  ai: en(AI_CHOICES),
  model: str(),
  surface: en(SURFACES),
  permissionLevel: en(PERMISSION_LEVELS),
  planFirst: bool,
  budgetUsd: num(),
  baseBranch: str(),
  workInPlace: bool,
  startAfter: int(),
  window: obj({ from: str({ maxLength: 5 }), to: str({ maxLength: 5 }) }),
  afterReset: bool,
  source: en(SOURCES),
  sourceMeta: optional({
    userId: str(), displayName: str(), channel: str(), messageId: str(),
    boardId: str(), cardId: str(), deviceId: str(), parentSessionId: str(),
  }, []),
  templateId: str(),
}, ['text', 'cwd']);

const taskViewProps = {
  id: str(),
  title: str(),
  state: en(STATES),
  blockedKind: nullable(en(BLOCKED_KINDS)),
  failKind: nullable(en(FAIL_KINDS)),
  parkReason: nullable(en(PARK_REASONS)),
  outcome: nullable(en(OUTCOMES)),
  ...faceProps,
  ai: obj({ id: en(AIS), reason: nullable(str()), model: nullable(str()) }),
  surface: en(SURFACES),
  permissionLevel: en(PERMISSION_LEVELS),
  planFirst: bool,
  source: en(SOURCES),
  awaitingConfirm: bool,
  repo: nullable(obj({ root: str(PATH), name: str() })),
  branch: nullable(str()),
  workInPlace: bool,
  cost: obj({ usd: num(), budgetUsd: nullable(num()) }),
  stateAgeMs: int(),
  createdAgeMs: int(),
  lastSeq: int(),
  hub: nullable(obj({ boardId: str(), cardId: str(), cardKey: str() })),
  live: nullable(ref('LeaseView')),
};

const approvalOpen = obj({ approvalId: str(), tool: str(), inputSummary: str({ maxLength: 1024 }), requestedAgeMs: int() });
const choice = obj({ id: str(), label: str(), action: en(ACTIONS), payload: { type: 'object' } });
const openAsk = obj({
  askId: str(), kind: en(ASK_KINDS), text: str(LONG), options: nullable(arr(str())), choices: nullable(arr(choice)), askedAgeMs: int(),
});

const taskDetailProps = {
  ...taskViewProps,
  text: str(LONG),
  spec: ref('TaskSpec'),
  finalPrompt: nullable(str(DOC)),
  worktree: nullable(str(PATH)),
  baseBranch: nullable(str()),
  sessionId: nullable(str()),
  aiDetail: obj({ id: en(AIS), version: nullable(str()), model: nullable(str()), reason: nullable(str()), capabilities: ref('Capabilities') }),
  handover: nullable(obj({ version: int({ minimum: 1 }), markdown: str(DOC), provenance: en(HANDOVER_PROVENANCE), syncedAgeMs: int() })),
  checkpoint: nullable(ref('Checkpoint')),
  evidence: nullable(ref('Evidence')),
  pr: nullable(obj({ number: int(), url: str(), state: en(['open', 'merged', 'closed']) })),
  limitResetsInMs: nullable(int()),
  openApprovals: arr(approvalOpen),
  openAsk: nullable(openAsk),
  audit: arr(ref('AuditEntry')),
  messages: arr(ref('Message')),
};

const party = obj({ kind: en(PARTY_KINDS), id: str({ minLength: 1 }), label: str() });
const messageProps = {
  id: str(), seq: int({ minimum: 1 }), taskId: str(), direction: en(['in', 'out']),
  from: ref('Party'), to: ref('Party'), body: str({ minLength: 1, maxLength: MSG_MAX_BYTES }),
  replyTo: nullable(str()), createdAt: int(), deliveredAt: nullable(int()), readAt: nullable(int()),
  source: nullable(en(['live', 'notes'])), quarantined: bool, flags: arr(en(['suspected_injection'])),
};

const base = { seq: int({ minimum: 1 }), taskId: str(), at_age_ms: int() };
const ev = (type, props, req = Object.keys(props)) => obj({ ...base, type: { const: type }, ...props }, ['type', 'seq', 'taskId', 'at_age_ms', ...req]);

const events = {
  StateEvent: ev('state', {
    state: en(STATES), prevState: nullable(en(STATES)),
    blockedKind: nullable(en(BLOCKED_KINDS)), failKind: nullable(en(FAIL_KINDS)),
    parkReason: nullable(en(PARK_REASONS)), outcome: nullable(en(OUTCOMES)),
    ...faceProps, live: nullable(ref('LeaseView')),
  }),
  TranscriptEvent: ev('transcript', {
    role: en(['assistant', 'user', 'system']), text: str({ maxLength: MAX_TRANSCRIPT_CHUNK }), turn: int(), partial: bool,
  }, ['role', 'text', 'turn']),
  ToolEvent: ev('tool', {
    phase: en(['start', 'end']), toolUseId: str(), name: str(), summary: str(), ok: bool, durationMs: int(),
  }, ['phase', 'toolUseId', 'name', 'summary']),
  DiffEvent: ev('diff', {
    files: arr(obj({ path: str(PATH), status: en(['added', 'modified', 'deleted', 'renamed']), added: int(), removed: int() })),
    stat: ref('DiffStat'), patch: nullable(str({ maxLength: MAX_PATCH_BYTES })), truncated: bool,
  }),
  ApprovalEvent: ev('approval', {
    approvalId: str(), phase: en(['requested', 'answered', 'expired']), tool: str(), inputSummary: str({ maxLength: 1024 }),
    decision: nullable(en(['allow', 'deny'])), scope: nullable(en(['once', 'task'])), answeredBy: nullable(str()),
  }),
  AskEvent: ev('ask', {
    askId: str(), phase: en(['asked', 'answered', 'expired']), kind: en(ASK_KINDS), text: str(LONG),
    options: nullable(arr(str())), choices: nullable(arr(choice)), answer: nullable(str(LONG)),
  }),
  CostEvent: ev('cost', { usd: num(), budgetUsd: nullable(num()), numTurns: int() }),
  HandoverEvent: ev('handover', { version: int({ minimum: 1 }), provenance: en(HANDOVER_PROVENANCE), markdown: nullable(str({ maxLength: MAX_TRANSCRIPT_CHUNK })) }),
  ClaimsEvent: ev('claims', { repo: str(PATH), claims: arr(ref('Claim')) }),
  OverlapEvent: ev('overlap', {
    otherTaskId: str(), level: str(), kind: en(['overlapping', 'adjacent']), paths: arr(str(PATH)), reasons: arr(str({ maxLength: 1024 })),
  }),
  ErrorEvent: ev('error', { code: en(ERRORS), message: str({ maxLength: 1024 }), fatal: bool }),
  MessageEvent: obj({ type: { const: 'message' }, at_age_ms: int(), ...messageProps }, ['type', 'at_age_ms', ...Object.keys(messageProps)]),
  MessageStateEvent: obj({
    type: { const: 'message-state' }, seq: int({ minimum: 1 }), taskId: str(), at_age_ms: int(), id: str(),
    deliveredAt: nullable(int()), readAt: nullable(int()), source: nullable(en(['live', 'notes'])),
  }, ['type', 'seq', 'taskId', 'at_age_ms', 'id']),
};

const payloads = {
  pause: optional({}, []),
  resume: optional({ when: en(['now', 'reset']) }, []),
  stop: optional({}, []),
  takeover: optional({ mode: en(['tab', 'tmux', 'print']), confirm: bool }, []),
  handback: optional({ note: str({ maxLength: 4000 }) }, []),
  message: optional({ body: str({ minLength: 1, maxLength: MSG_MAX_BYTES }) }, ['body']),
  approve: optional({ approvalId: str(), scope: en(['once', 'task']) }, ['approvalId']),
  deny: optional({ approvalId: str(), message: str({ maxLength: 2000 }) }, ['approvalId']),
  answer: optional({ askId: str(), answer: str({ minLength: 1, maxLength: 20000 }) }, ['askId', 'answer']),
  merge: optional({ strategy: en(['merge', 'squash', 'ff']), deleteBranch: bool }, []),
  openPr: optional({ draft: bool, title: str(), body: str(LONG) }, []),
  discard: optional({ confirm: { const: true } }, ['confirm']),
  retry: optional({ fresh: bool }, []),
  switchAi: optional({ ai: en(AIS) }, ['ai']),
};

const errorObj = obj({ code: en(ERRORS), message: str({ maxLength: 1024 }), details: { type: 'object' } }, ['code', 'message']);

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://plexiform.local/board/tasks-api/schema.json',
  title: `Plexiform local Tasks API, protocol ${TASKS_PROTOCOL_VERSION}`,
  description: 'Generated by tasks-api/scripts/build-schema.js from tasks-api/protocol.js and shared/states.js. Do not edit by hand. Prose: board/TASKS-CONTRACT.md.',
  $defs: {
    TaskSpec: taskSpec,
    LeaseView: leaseView,
    TaskView: obj(taskViewProps),
    TaskDetail: obj(taskDetailProps, Object.keys(taskDetailProps).filter((k) => k !== 'checkpoint')),
    CheckpointData: obj(packetDataProps),
    Checkpoint: packet,
    Capabilities: obj(Object.fromEntries(CAPABILITIES.map((c) => [c, bool]))),
    DiffStat: obj({ files: int(), added: int(), removed: int() }),
    Evidence: obj({
      tests: nullable(en(['pass', 'fail', 'none'])), testCommand: nullable(str({ maxLength: 1024 })), testTail: nullable(str({ maxLength: 8192 })),
      diffStat: ref('DiffStat'), commits: int(), summary: str({ maxLength: 4096 }), costUsd: num(), durationMs: int(),
    }),
    AuditEntry: obj({
      at_age_ms: int(), actor: obj({ kind: en(['user', 'agent', 'supervisor', 'remote']), source: en(SOURCES), name: nullable(str()) }),
      action: str(), detail: nullable(str({ maxLength: 1024 })),
    }),
    Claim: obj({ taskId: str(), branch: nullable(str()), paths: arr(str(PATH)), areas: arr(str()), note: nullable(str({ maxLength: 1024 })), claimedAgeMs: int() }),
    AiInfo: obj({
      id: en(AIS), installed: bool, bin: nullable(str(PATH)), version: nullable(str()), loggedIn: nullable(bool),
      models: arr(str()), capabilities: ref('Capabilities'), notes: arr(str({ maxLength: 1024 })), health: en(['ok', 'warn', 'missing']),
    }),
    Limits: obj({
      maxParallel: int({ minimum: 1 }), maxParallelDefault: int({ minimum: 1 }),
      perAi: optional(Object.fromEntries(AIS.map((a) => [a, int({ minimum: 0 })])), []),
      ramGb: num(), running: int(), queued: int(),
    }),
    TakeoverResult: obj({
      argv: arr(str(PATH), { minItems: 1 }), cwd: str(PATH), env: { type: 'object', additionalProperties: str(PATH) },
      mode: en(['tab', 'tmux', 'print']), sessionId: nullable(str()), resumed: bool, note: str({ maxLength: 1024 }),
    }),
    Error: errorObj,
    Party: party,
    Message: obj(messageProps),
    ...events,
    Event: { oneOf: Object.keys(events).map(ref) },
    ActPayloads: obj(payloads, []),
    Request: obj({ id: str({ minLength: 1, maxLength: 128 }), method: en(METHODS), params: { type: 'object' }, token: str() }),
    Response: {
      oneOf: [
        obj({ id: str(), result: {} }),
        obj({ id: nullable(str()), error: errorObj }),
      ],
    },
    Push: {
      oneOf: [
        obj({ push: { const: 'event' }, sub: str(), event: ref('Event') }),
        obj({ push: { const: 'hb' }, epoch: str(), uptimeMs: int(), tasks: arr(obj({ id: str(), state: en(STATES), green: bool })) }),
        obj({ push: { const: 'lagged' }, sub: str(), lastSeq: int() }),
        obj({ push: { const: 'reset' }, sub: str(), reason: en(['epoch', 'gap']), latestSeq: int() }),
        obj({ push: { const: 'bye' }, reason: str() }),
      ],
    },
    // method params / results
    HelloParams: obj({ protocol: int({ minimum: 1 }), client: obj({ name: str(), version: str() }) }, ['protocol']),
    HelloResult: obj({ protocol: int({ minimum: 1 }), serverVersion: str(), epoch: str(), mock: bool }),
    CreateTaskParams: obj({ requestId: str({ minLength: 8, maxLength: 128 }), spec: ref('TaskSpec') }),
    CreateTaskResult: obj({ id: str(), duplicate: bool }),
    // Pages: `after` = the last id of the previous page (tasks in creation order), `limit` 1-500 (default 200).
    ListTasksParams: optional({ includeDone: bool, after: str({ maxLength: 64 }), limit: int({ minimum: 1, maximum: 500 }) }, []),
    ListTasksResult: arr(ref('TaskView')),
    GetTaskParams: obj({ id: str() }),
    GetTaskResult: ref('TaskDetail'),
    SaveCheckpointParams: obj({ id: str(), expectedVersion: int(), data: ref('CheckpointData'), requestId: str({ minLength: 8, maxLength: 128 }) }),
    SaveCheckpointResult: obj({ checkpoint: ref('Checkpoint') }),
    SubscribeParams: obj({ id: str({ minLength: 1 }), fromSeq: int(), epoch: str() }, ['id']),
    SubscribeResult: obj({ sub: str(), epoch: str(), latestSeq: int(), replayed: int() }),
    UnsubscribeParams: obj({ sub: str() }),
    ActParams: obj({ id: str(), action: en(ACTIONS), payload: { type: 'object' }, requestId: str({ minLength: 8, maxLength: 128 }) }, ['id', 'action', 'requestId']),
    ActResult: obj({
      ok: { const: true }, task: ref('TaskView'), messageId: str(), takeover: ref('TakeoverResult'), pr: obj({ number: int(), url: str() }),
    }, ['ok', 'task']),
    ListMessagesParams: obj({ id: str(), afterSeq: int() }, ['id']),
    ListMessagesResult: arr(ref('Message')),
    DetectAIsResult: arr(ref('AiInfo')),
    GetLimitsResult: ref('Limits'),
    SetLimitsParams: optional({ maxParallel: int({ minimum: 1, maximum: 8 }), perAi: optional(Object.fromEntries(AIS.map((a) => [a, int({ maximum: 8 })])), []) }, []),
    GetClaimsParams: obj({ repo: str({ minLength: 1, ...PATH }) }),
    GetClaimsResult: obj({ repo: str(PATH), claims: arr(ref('Claim')) }),
    // thin clients
    SpinOffInput: optional({
      task: str({ minLength: 1, maxLength: 20000 }), cwd: str(PATH), backend: en(AI_CHOICES), surface: en(SURFACES),
      planFirst: bool, permissionLevel: en(PERMISSION_LEVELS.filter((p) => p !== 'bypass')), budgetUsd: num(), baseBranch: str(),
    }, ['task']),
    SpinOffOutput: obj({ taskId: str(), state: en(STATES), reason: str(), duplicate: bool }),
    BuddyMessageInput: optional({ to: str({ minLength: 3, maxLength: 300 }), text: str({ minLength: 1, maxLength: MSG_MAX_BYTES }), reply_to: str() }, ['to', 'text']),
    BuddyMessageOutput: obj({ message_id: str(), delivered: en(['live', 'queued']), recipients: int() }, ['message_id', 'delivered']),
    CheckMessagesInput: optional({ since: str() }, []),
    CheckMessagesOutput: arr(obj({
      message_id: str(), from: str(), to: str(), text: str({ maxLength: 16384 }), at_age_ms: int(), reply_to: nullable(str()), quarantined: bool,
    })),
  },
};

export function buildSchema() {
  return schema;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema.json');
  fs.writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`);
  process.stdout.write(`wrote ${out}\n`);
}
