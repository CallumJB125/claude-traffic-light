// Agent bus shapes (board/AGENT-BUS.md): the v1 envelope and the arguments of
// every bus op. Shared by the desktop's local bus (board/tasks-engine/bus/) and,
// in phase 2, the hub. Bodies are untrusted text: these only bound and type them.
import { z } from 'zod';

export const BUS_VERSION = 1;
export const TOPICS = Object.freeze(['handoff', 'claim', 'result', 'control']);
export const TIERS = Object.freeze(['person', 'run_capability', 'local_attested']);
export const PROVIDERS = Object.freeze(['claude', 'codex', 'gemini']);
// The providers a bus run may start on: the ones with an OS sandbox and network off (AC7).
export const BUS_RUN_PROVIDERS = Object.freeze(['claude', 'codex']);
export const REASONS = Object.freeze(['HALTED', 'SPEND_CAP', 'LOOP', 'RATE', 'NOT_MEMBER', 'TIER_NOT_ACCEPTED', 'NO_ELIGIBLE_AGENT', 'NO_LOCAL_CHECKOUT', 'NOT_FOUND', 'VALIDATION']);
export const KINDS = Object.freeze({
  handoff: ['handoff.offer', 'handoff.refused'],
  claim: ['claim.granted', 'claim.denied', 'claim.started', 'claim.released', 'claim.lost'],
  result: ['result.done', 'result.failed', 'result.outcome_unknown', 'result.expired'],
  control: ['control.halt', 'control.resume', 'control.cap_reached', 'control.policy_changed', 'control.card_paused'],
});
export const LIMITS = Object.freeze({ title: 200, brief: 3200, summary: 2000, file: 300, files: 50, branch: 200, evidence: 10 });

const requestId = z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/).describe('Unique request id; reuse exactly on retry.');
const cardId = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
const agentId = z.string().regex(/^[a-z]+:(?:local|run):[A-Za-z0-9_-]{1,64}$/);
const handoffId = z.string().regex(/^hof_[a-f0-9]{12,32}$/);
const to = z.object({ provider: z.enum(PROVIDERS).optional(), user: z.string().max(200).optional(), agent_id: agentId.optional() }).strict()
  .refine((t) => t.provider || t.agent_id, 'to needs a provider or an agent_id');
const handoffFields = {
  request_id: requestId, to, scope: z.enum(['local', 'team']).optional(), card_id: cardId.optional(),
  title: z.string().trim().min(1).max(LIMITS.title), brief: z.string().max(LIMITS.brief).optional(),
  files: z.array(z.string().max(LIMITS.file)).max(LIMITS.files).optional(), branch: z.string().max(LIMITS.branch).optional(),
  budget_usd: z.number().positive().max(100).optional(), ttl_s: z.number().int().min(60).max(86400).optional(),
};
const teamNeedsCard = (a) => a.scope !== 'team' || !!a.card_id;
const CARD_MSG = { message: 'card_id is required for scope team', path: ['card_id'] };

// The interactive surface (mcp-server.js bus_* through main's /bus relay).
export const HelloArgs = z.object({ provider: z.string().regex(/^[a-z]{2,12}$/), label: z.string().max(60).optional() }).strict();
export const HandoffArgs = z.object({ ...handoffFields, repo: z.string().min(1).max(1024).optional(), provider: z.string().regex(/^[a-z]{2,12}$/).optional(), label: z.string().max(60).optional() })
  .strict().refine(teamNeedsCard, CARD_MSG);
export const ReadArgs = z.object({ topic: z.enum(['handoff', 'result']), after_offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).optional(), card_id: cardId.optional(), provider: z.string().regex(/^[a-z]{2,12}$/).optional() }).strict();
export const WaitArgs = z.object({ handoff_id: handoffId, timeout_s: z.number().int().min(0).max(120).optional(), provider: z.string().regex(/^[a-z]{2,12}$/).optional() }).strict();
export const StatusArgs = z.object({ handoff_id: handoffId.optional() }).strict();

// The run surface (board/mcp/task-tools.js; source, hop and visited come from the run, never the caller).
export const RunHandoffArgs = z.object(handoffFields).strict().refine(teamNeedsCard, CARD_MSG);
export const ResultArgs = z.object({ request_id: requestId, outcome: z.enum(['done', 'failed']), summary: z.string().trim().min(1).max(LIMITS.summary), evidence: z.array(z.string().max(LIMITS.file)).max(LIMITS.evidence).optional() }).strict();

export const Envelope = z.object({
  v: z.literal(BUS_VERSION), id: z.string().regex(/^evt_[a-f0-9]{16,32}$/), request_id: z.string().max(100).nullable(),
  topic: z.enum(TOPICS), offset: z.number().int().min(0), scope: z.enum(['local', 'team']), org_id: z.string().nullable().optional(),
  board_id: z.string().nullable().optional(), card_id: z.string().nullable(), repo: z.object({ root: z.string().optional(), canonical_remote: z.string().optional() }).nullable(),
  source: z.object({ user_id: z.string().nullable().optional(), device_id: z.string(), agent_id: z.string(), provider: z.string(), tier: z.enum(TIERS), identity_source: z.enum(['hub_credential', 'hub_host_device', 'local_token']) }),
  to: z.object({ provider: z.string().optional(), user_id: z.string().optional(), agent_id: z.string().optional() }).nullable(),
  kind: z.string(), handoff_id: z.string().nullable(), body: z.string().max(LIMITS.brief).nullable(), data: z.record(z.string(), z.unknown()).nullable(),
  hop: z.number().int().min(0), visited: z.array(z.string()), caused_by: z.string().nullable(),
  created_at: z.number().int(), expires_at: z.number().int(), grants_execution: z.literal(false), approval: z.literal(false),
}).strict().refine((e) => KINDS[e.topic].includes(e.kind), 'kind does not belong to topic');

// Zod issue → one short line, never echoing the rejected value.
export const issue = (r) => { const i = r.error.issues[0]; return `${i.path.join('.') || 'args'}: ${i.message}`; };
