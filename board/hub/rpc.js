// Runner RPC methods (CONTRACT §6.6). Each runs inside the card's board
// queue after verifyRun() (run token HMAC, run unended, fence current,
// repo_id = the run's repo). Network work (GitHub) happens before the queue.

import { randomUUID } from 'node:crypto';
import { RPC_METHODS, TOOL_SCOPES, CODEX_PLAN_PERMISSION } from '../shared/protocol.js';
import { PLAN_APPROVAL_LABEL, POLICY_LABELS } from '../shared/states.js';
import { HubError } from './db.js';
import { parseRunToken } from './auth.js';
import { prBound, prNumberOf } from './github.js';
import { limitOrThrow } from './ratelimit.js';
import { runnerConnectionProblem } from './runner-authority.js';
import { TeamCommunication } from './communication.js';
import { ownershipPath } from './ownership.js';
import { insertCardRecord } from './card-record.js';

const EVIDENCE_KINDS = ['pr', 'commit', 'test_run', 'screenshot', 'log', 'url', 'no_tests_reason'];
const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
export const relPath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 500 && !p.startsWith('/') && !p.startsWith('~')
  && !/^[a-z]:/i.test(p) && !p.includes('\0') && !p.split('/').includes('..');

export function verifyRun(hub, device, msg, connection = null) {
  if (!device) throw new HubError('FORBIDDEN', 'runner device unavailable');
  if (connection) {
    if (connection.device_id !== device.id || runnerConnectionProblem(hub, connection)) throw new HubError('FORBIDDEN', 'runner connection no longer authorized');
  } else if (hub.config.auth === 'accounts') throw new HubError('FORBIDDEN', 'authenticated runner connection required');
  const tok = parseRunToken(hub.secret, msg.run_token);
  if (!tok || tok.run_id !== msg.run_id || tok.card_id !== msg.card_id) throw new HubError('UNAUTHENTICATED', 'bad run token');
  const run = hub.run(msg.run_id);
  const row = hub.card(msg.card_id);
  if (!run || !row || run.card_id !== row.id) throw new HubError('NOT_FOUND', 'run not found');
  if (run.device_id !== device.id) throw new HubError('FORBIDDEN', 'run belongs to another device');
  const dev = hub.device(device.id);
  if (!dev || dev.revoked_at || !hub.activeMember(dev.member_id)) throw new HubError('FORBIDDEN', 'device revoked or member removed');
  if (msg.repo_id !== run.repo_id) throw new HubError('FORBIDDEN', 'repo_id does not match the run (out of scope)');
  if (tok.fence !== row.fence || msg.fence !== row.fence) throw new HubError('FENCED', `fence ${msg.fence} is not current (${row.fence})`);
  if (run.ended_at) throw new HubError('RUN_ENDED', 'run has ended');
  if (row.active_run_id !== run.id) throw new HubError('FENCED', 'run is no longer the active run');
  if (row.archived_at) throw new HubError('CONFLICT', 'this card is archived', { reason: 'ARCHIVED' });
  return { run, row, connection };
}

const optText = (v, max, what) => {
  if (v == null) return null;
  if (typeof v !== 'string' || v.length > max) throw new HubError('VALIDATION', `${what} must be a string of at most ${max} characters`);
  return v.trim() || null;
};

// The member a run works for must still be able to write (not a viewer).
function runMember(hub, run) {
  const m = hub.activeMember(run.on_behalf_of);
  if (!hub.canWrite(m)) throw new HubError('FORBIDDEN', 'the member this run is for cannot write to this board');
  return m;
}

function brief(hub, row) {
  return { key: row.key, title: row.title, column: row.column_name, run_state: row.run_state ?? 'todo' };
}

const planPermission = (hub, run) => hub.db.get('SELECT * FROM permission_requests WHERE run_id = ? AND tool = ? ORDER BY created_at, rowid LIMIT 1', run.id, CODEX_PLAN_PERMISSION);

function currentPlanApprover(hub, run, row, memberId) {
  const member = hub.activeMember(memberId);
  if (!member || !hub.canWrite(member) || member.org_id !== hub.board(row.board_id)?.org_id) return false;
  const repoPolicy = hub.runners.get(run.device_id)?.repos.get(run.repo_id);
  return hub.isAdmin(member) || [run.on_behalf_of, run.dispatched_by, ...hub.assignees(row.id), ...(repoPolicy?.approvals_from ?? [])].includes(member.id);
}

const METHODS = {
  board_send_message(hub, ctx, params) { return new TeamCommunication(hub).runnerSendMessage(ctx, params); },
  board_list_messages(hub, ctx, params) { return new TeamCommunication(hub).runnerListMessages(ctx, params); },
  board_ack_message(hub, ctx, params) { return new TeamCommunication(hub).runnerAckMessage(ctx, params); },
  runner_messages_received(hub, ctx, params) { return new TeamCommunication(hub).runnerReceivedMessages(ctx, params); },
  board_read_packet(hub, ctx, params) { return new TeamCommunication(hub).runnerReadPacket(ctx, params); },
  board_write_packet(hub, ctx, params) { return new TeamCommunication(hub).runnerWritePacket(ctx, params); },
  board_get_card(hub, { run, row }, params) {
    let target = row;
    if (params.key != null) {
      target = hub.cardByKey(row.board_id, String(params.key));
      const related = target && (target.id === row.id || target.id === row.parent_card_id || target.parent_card_id === row.id);
      if (!related) throw new HubError('NOT_FOUND', 'only this card, its parent or its children');
    }
    const h = hub.handoverDoc(target.id);
    return {
      card: { ...brief(hub, target), body: target.body, labels: hub.labels(target) },
      acceptance: target.acceptance,
      handover_md: h?.markdown ?? null,
      open_asks: hub.openAsks(target.id).map((a) => ({ id: a.id, kind: a.kind, text: a.text })),
      comments: hub.db.all('SELECT * FROM comments WHERE card_id = ? AND trusted = 1 ORDER BY created_at DESC, rowid DESC LIMIT 50', target.id).reverse()
        .map((c) => ({ id: c.id, author_name: c.author_member_id ? hub.memberName(c.author_member_id) : 'Claude', source: c.source, body: c.body, created_age_ms: hub.ageOf(c.created_at) })),
    };
  },

  board_list_cards(hub, { run, row }, params) {
    const args = [row.board_id, row.repo_id];
    let sql = 'SELECT * FROM cards WHERE board_id = ? AND repo_id = ? AND archived_at IS NULL';
    if (params.column != null) { sql += ' AND column_name = ?'; args.push(String(params.column)); }
    if (params.mine === true) { sql += ' AND id IN (SELECT card_id FROM runs WHERE on_behalf_of = ?)'; args.push(run.on_behalf_of); }
    return { cards: hub.db.all(`${sql} ORDER BY created_at LIMIT 200`, ...args).map((c) => brief(hub, c)) };
  },

  board_ask_human(hub, { run, row }, params) {
    if (!['question', 'clarify', 'decision'].includes(params.kind)) throw new HubError('VALIDATION', 'kind must be question|clarify|decision');
    if (typeof params.text !== 'string' || !params.text.trim()) throw new HubError('VALIDATION', 'text required');
    if (params.options != null && (!Array.isArray(params.options) || params.options.some((o) => typeof o !== 'string'))) throw new HubError('VALIDATION', 'options must be strings');
    if (hub.openAsks(row.id).length) throw new HubError('ONE_OPEN_ASK', 'this card already has an open question');
    const id = randomUUID();
    const res = hub.apply(row.id, { type: 'block', fence: row.fence, kind: params.kind }, {
      ctx: { require_plan_approval: hub.labels(row).includes(PLAN_APPROVAL_LABEL) },
      pre: () => {
        hub.db.insert('asks', {
          id, run_id: run.id, card_id: row.id, kind: params.kind, text: clip(params.text, 2000),
          options: params.options ? JSON.stringify(params.options.slice(0, 10).map((o) => clip(o, 200))) : null, state: 'open', created_at: hub.iso(),
        });
        hub.journal({ board_id: row.board_id, card_id: row.id, run_id: run.id, actor_kind: 'runner', actor_id: run.device_id, kind: 'ask.create', payload: { ask_id: id, kind: params.kind } });
      },
    });
    if (!res.ok) throw new HubError(res.error.code, res.error.message);
    return { ask_id: id };
  },

  board_complete(hub, { run, row }, params) {
    const ids = Array.isArray(params.evidence_ids) ? params.evidence_ids.filter((x) => typeof x === 'string') : [];
    const ev = ids.length
      ? hub.db.all(`SELECT * FROM evidence WHERE card_id = ? AND id IN (${ids.map(() => '?').join(',')})`, row.id, ...ids)
      : [];
    const code = ev.some((e) => (e.kind === 'pr' || e.kind === 'commit') && e.verification === 'hub_verified');
    const tests = ev.some((e) => e.kind === 'test_run' || e.kind === 'no_tests_reason');
    if(hub.workflowGuard.runMarker(run.id))hub.workflowGuard.selectedEvidence(run,ids);
    const res = hub.workflowGuard.completion(run,ids,()=>hub.apply(row.id, { type: 'complete', fence: row.fence }, {
      ctx: { evidence_ok: code && tests },
      pre: () => {
        if (params.summary) {
          hub.db.run('UPDATE runs SET status_summary = ? WHERE id = ?', clip(params.summary, 140), run.id);
          hub.feed(row.id, 'progress', { text: clip(params.summary, 500) }, { run });
        }
      },
    }));
    if (!res.ok) {
      if (res.error.code === 'EVIDENCE_MISSING') throw new HubError('EVIDENCE_MISSING', 'needs a hub-verified PR or pushed commit and a test_run or no_tests_reason');
      throw new HubError(res.error.code, res.error.message);
    }
    return { state: 'in_review' };
  },

  board_release(hub, { run, row }, params) {
    const requeue = params.requeue === true;
    const labels = hub.labels(row);
    const res = hub.apply(row.id, { type: 'release', fence: row.fence, requeue, reason: clip(params.reason ?? '', 500) || null }, {
      ctx: { policy_allows_requeue: !labels.includes('never_auto') },
    });
    if (!res.ok) throw new HubError(res.error.code, res.error.message);
    return { state: res.to };
  },

  board_declare_plan(hub, ctx, params) {
    const { run, row } = ctx;
    if (!Array.isArray(params.paths)) throw new HubError('VALIDATION', 'paths must be an array');
    const paths = [...new Set(params.paths.map(ownershipPath).filter(Boolean))].slice(0, 200);
    hub.txn(() => {
      hub.ownership.declare(ctx, paths, params.ownership_generation);
      hub.db.run('UPDATE runs SET planned_paths = ? WHERE id = ?', JSON.stringify(paths), run.id);
      hub.workflowGuard.declared(run,paths);
      hub.journal({ board_id: row.board_id, card_id: row.id, run_id: run.id, actor_kind: 'runner', actor_id: run.device_id, kind: 'plan.declare', payload: { paths } });
      if (params.summary) hub.feed(row.id, 'plan_declared', { summary: clip(params.summary, 500), paths: paths.slice(0, 20) }, { run });
    });
    hub.recomputeOverlaps(run.repo_id);
    let permission = planPermission(hub, run);
    if (run.ai === 'codex' && hub.db.get('SELECT plan_required FROM task_ownership WHERE run_id=?', run.id)?.plan_required && !permission) {
      const approvers = [...new Set([run.on_behalf_of, run.dispatched_by, ...hub.assignees(row.id), ...(hub.runners.get(run.device_id)?.repos.get(run.repo_id)?.approvals_from ?? [])].filter(Boolean))];
      const id = randomUUID();
      const res = hub.apply(row.id, { type: 'block', fence: row.fence, kind: 'permission' }, {
        pre: () => {
          hub.db.insert('permission_requests', { id, run_id: run.id, card_id: row.id, tool: CODEX_PLAN_PERMISSION,
            input_summary: clip(`${params.summary ?? 'Declared plan'}; paths: ${paths.join(', ')}`, 300),
            state: 'open', approvers: JSON.stringify(approvers), created_at: hub.iso() });
          hub.journal({ board_id: row.board_id, card_id: row.id, run_id: run.id, actor_kind: 'runner', actor_id: run.device_id,
            kind: 'permission.create', payload: { permission_request_id: id, tool: CODEX_PLAN_PERMISSION, paths } });
        },
      });
      if (!res.ok) throw new HubError(res.error.code, res.error.message);
      permission = planPermission(hub, run);
    }
    return { overlaps: hub.overlapViews(hub.card(row.id)), ...hub.ownership.snapshot(ctx), ...(permission ? { plan_permission_request_id: permission.id, plan_authorization: permission.state } : {}) };
  },

  runner_plan_status(hub, { run, row }) {
    if (run.ai !== 'codex') throw new HubError('NOT_AVAILABLE', 'this run does not use Codex');
    // Removing the label cannot widen a run launched with a plan gate. A
    // reserved request, current fence and a live human approver are required.
    const permission = planPermission(hub, run);
    const member = permission && hub.activeMember(permission.answered_by);
    const allowed = permission?.state === 'allowed' && currentPlanApprover(hub, run, row, permission.answered_by) && hub.workflowGuard.planAllowed(run,permission);
    return { required: true, decision: allowed ? 'allow' : permission?.state === 'denied' ? 'deny' : 'pending',
      permission_request_id: permission?.id ?? null,
      answered_by: allowed ? { member_id: member.id, name: member.display_name } : null };
  },

  board_check_overlap(hub, ctx) {
    const ownership = hub.ownership.runnerRead(ctx);
    return { overlaps: hub.overlapViews(ctx.row), locks: [], ...ownership };
  },

  board_recall(hub, { run, row }, params) {
    const kinds = Array.isArray(params.kinds) ? params.kinds.filter((k) => k === 'handoff') : ['handoff'];
    if (!kinds.length) return { memories: [] };
    let rows = hub.db.all("SELECT * FROM memories WHERE repo_id = ? AND card_id IN (SELECT id FROM cards WHERE board_id = ?) AND kind = 'handoff' AND status != 'archived' ORDER BY created_at DESC LIMIT 100", run.repo_id, row.board_id);
    if (Array.isArray(params.paths) && params.paths.length) {
      const ps = params.paths.filter((p) => typeof p === 'string');
      rows = rows.filter((m) => m.path == null || ps.some((p) => p.startsWith(m.path) || m.path.startsWith(p)));
    }
    if (typeof params.query === 'string' && params.query.trim()) {
      const q = params.query.toLowerCase();
      rows = rows.filter((m) => m.body.toLowerCase().includes(q));
    }
    return {
      memories: rows.slice(0, 20).map((m) => ({
        id: m.id, kind: m.kind, body: m.status === 'stale' ? `[STALE: code moved since this note; verify] ${m.body}` : m.body,
        path: m.path, status: m.status, card_key: m.card_id ? hub.card(m.card_id)?.key ?? null : null, age_ms: hub.ageOf(m.created_at),
      })),
    };
  },

  approval(hub, { run, row }, params) {
    if (typeof params.tool_name !== 'string' || !params.tool_name) throw new HubError('VALIDATION', 'tool_name required');
    if (params.tool_name === CODEX_PLAN_PERMISSION) throw new HubError('FORBIDDEN', 'plan authorization is created only by the declared-plan route');
    const repoPolicy = hub.runners.get(run.device_id)?.repos.get(run.repo_id);
    const approvers = [...new Set([run.on_behalf_of, run.dispatched_by, ...hub.assignees(row.id), ...(repoPolicy?.approvals_from ?? [])].filter(Boolean))];
    const id = randomUUID();
    const res = hub.apply(row.id, { type: 'block', fence: row.fence, kind: 'permission' }, {
      pre: () => {
        hub.db.insert('permission_requests', {
          id, run_id: run.id, card_id: row.id, tool: clip(params.tool_name, 100), input_summary: clip(params.input_summary ?? '', 300),
          state: 'open', approvers: JSON.stringify(approvers), created_at: hub.iso(),
        });
        hub.journal({ board_id: row.board_id, card_id: row.id, run_id: run.id, actor_kind: 'runner', actor_id: run.device_id, kind: 'permission.create', payload: { permission_request_id: id, tool: clip(params.tool_name, 100) } });
      },
    });
    if (!res.ok) throw new HubError(res.error.code, res.error.message);
    return { permission_request_id: id };
  },

  // The CLI cancelled the held prompt: withdraw the request so nobody answers
  // a prompt that no longer exists, and unblock the card when nothing else is open.
  approval_cancel(hub, { run, row }, params) {
    const pr = typeof params.permission_request_id === 'string'
      ? hub.db.get('SELECT * FROM permission_requests WHERE id = ? AND run_id = ?', params.permission_request_id, run.id) : null;
    if (!pr) throw new HubError('NOT_FOUND', 'permission request not found');
    if (pr.state !== 'open') return { state: pr.state };
    const open = hub.openAsks(row.id).length + hub.openPermissions(row.id).filter((p) => p.id !== pr.id).length;
    const withdrawable = row.run_state === 'blocked' || row.resume_to === 'blocked';
    hub.txn(() => {
      hub.db.run("UPDATE permission_requests SET state = 'cancelled', answered_at = ? WHERE id = ? AND state = 'open'", hub.iso(), pr.id);
      hub.journal({ board_id: row.board_id, card_id: row.id, run_id: run.id, actor_kind: 'runner', actor_id: run.device_id, kind: 'permission.cancel', payload: { permission_request_id: pr.id } });
      if (withdrawable) {
        const res = hub.apply(row.id, { type: 'withdraw', fence: row.fence }, { ctx: { open_asks_remaining: open } });
        if (!res.ok) throw new HubError(res.error.code, res.error.message);
      }
      hub.later(() => hub.broadcastCard(row.id));
    });
    return { state: 'cancelled' };
  },

  // D31: a follow-up card, as a child of this run's card, on the same board
  // and repo, in todo. Never dispatched, assigned or budgeted here; the only
  // labels are the parent's policy labels, so a child cannot shed never_auto.
  board_create_card(hub, { run, row }, params) {
    const title = optText(params.title, 200, 'title');
    if (!title) throw new HubError('VALIDATION', 'title required');
    const body = optText(params.body, 20_000, 'body') ?? '';
    const acceptance = optText(params.acceptance, 10_000, 'acceptance');
    const member = runMember(hub, run);
    if (!hub.db.get('SELECT 1 AS x FROM board_repos WHERE board_id = ? AND repo_id = ?', row.board_id, run.repo_id)) throw new HubError('FORBIDDEN', 'this repo is no longer on the board');
    limitOrThrow(hub, 'agent_card_member', member.id);
    const id = randomUUID();
    const now = hub.iso();
    const labels = JSON.stringify(hub.labels(row).filter((l) => POLICY_LABELS.includes(l)));
    let key;
    hub.txn(() => {
      const child = insertCardRecord(hub, row.board_id, member.id, {
        title, body, acceptance, repo_id: run.repo_id, base_ref: row.base_ref ?? null, labels,
        parent_card_id: row.id, created_by_run_id: run.id,
      }, { id, now });
      key = child.key;
      hub.journal({ board_id: row.board_id, card_id: id, run_id: run.id, actor_kind: 'runner', actor_id: run.device_id, kind: 'card.create', payload: {
        key, title, body, acceptance, repo_id: run.repo_id, base_ref: row.base_ref ?? null, labels, budget_cents: null, column_name: 'todo', assignees: [], parent_card_id: row.id, request_id: null,
      } });
      hub.feed(id, 'created', { parent_key: row.key }, { run });
      hub.later(() => hub.broadcastCard(id));
    });
    return { card_id: id, key, column: 'todo', parent_key: row.key };
  },

  // D32: append-only, org- and repo-scoped; exact repeats return the first row.
  board_add_lesson(hub, { run, row }, params) {
    const text = optText(params.text, 2000, 'text')?.replace(/\s+/g, ' ');
    if (!text || text.length < 10 || text.length > 500) throw new HubError('VALIDATION', 'text must be 10–500 characters');
    const evidence = optText(params.evidence, 1000, 'evidence');
    const member = runMember(hub, run);
    // Before the lookup: "is this text already a lesson?" must not be free to ask.
    limitOrThrow(hub, 'agent_lesson_member', member.id);
    const orgId = hub.board(row.board_id).org_id;
    const dup = hub.db.get('SELECT id FROM lessons WHERE org_id = ? AND repo_id = ? AND text = ?', orgId, run.repo_id, text);
    if (dup) return { lesson_id: dup.id, status: 'suggested', duplicate: true };
    const id = randomUUID();
    hub.txn(() => {
      hub.db.insert('lessons', {
        id, org_id: orgId, repo_id: run.repo_id, card_id: row.id, author_run_id: run.id, author_member_id: member.id, text, evidence, created_at: hub.iso(),
      });
      hub.journal({ board_id: row.board_id, card_id: row.id, run_id: run.id, actor_kind: 'runner', actor_id: run.device_id, kind: 'lesson.create', payload: { lesson_id: id, repo_id: run.repo_id } });
    });
    return { lesson_id: id, status: 'suggested' };
  },

  team_context(hub, { run }) {
    return hub.teamContext(run.id);
  },
};

// The scope (protocol TOOL_SCOPES) each runner RPC is held to, runner-only
// plumbing included. A method missing here is refused, so a new RPC cannot
// ship without a declared scope.
export const METHOD_SCOPES = Object.freeze({
  board_get_card: 'card:read',
  board_list_cards: 'repo:read',
  board_ask_human: 'card:write',
  board_attach_evidence: 'card:write',
  board_complete: 'card:write',
  board_release: 'card:write',
  board_declare_plan: 'card:write',
  board_check_overlap: 'repo:read',
  board_recall: 'repo:read',
  approval: 'permission:ask',
  team_context: 'repo:read',
  approval_cancel: 'permission:ask',
  board_create_card: 'card:create_child',
  board_add_lesson: 'lesson:suggest',
  runner_plan_status: 'card:read',
  board_send_message: 'message:write',
  board_list_messages: 'message:read',
  board_ack_message: 'message:read',
  runner_messages_received: 'message:read',
  board_read_packet: 'card:read',
  board_write_packet: 'card:write',
});

async function attachEvidence(hub, device, msg, connection) {
  const params = msg.params ?? {};
  if (!EVIDENCE_KINDS.includes(params.kind)) throw new HubError('VALIDATION', `kind must be one of ${EVIDENCE_KINDS.join('|')}`);
  if (typeof params.ref !== 'string' || !params.ref || params.ref.length > 500) throw new HubError('VALIDATION', 'ref required');
  if (params.result != null && !['pass', 'fail'].includes(params.result)) throw new HubError('VALIDATION', 'result must be pass|fail');
  const { run, row } = verifyRun(hub, device, msg, connection);
  const canonical = hub.repo(run.repo_id)?.canonical_url;
  const owned=hub.workflowGuard.runMarker(run.id),sourceHmac=owned?hub.workflowGuard.sourceHmac(row):null;
  let verified = false;
  let binding = null;
  let ref = params.ref;
  try {
    if (params.kind === 'pr') {
      const n = prNumberOf(params.ref);
      const pull = await hub.github.getPull(canonical, n);
      verified = owned?hub.workflowGuard.exactPull(run,pull):prBound(pull, { branch: run.branch, key: row.key, baseRef: run.base_ref });
      if (verified) {
        binding = { head_repo_id: pull.head_repo_id, base_repo_id: pull.base_repo_id, base_ref: pull.base_ref,head_sha:pull.head_sha??null };
        // The hub checked PR n of the run's repo, whatever else the runner's
        // text named: store that, so nothing downstream reads a runner's URL.
        ref = `https://${canonical}/pull/${n}`;
      }
    } else if (params.kind === 'commit') {
      const commit=await hub.github.getCommit(canonical,params.ref.trim());verified=!!commit;
      if(owned){verified=!!commit&&/^[0-9a-f]{40}$/.test(commit.sha??'');if(verified)ref=commit.sha;}
    }
  } catch (e) {
    hub.log.warn('evidence verification failed', { card_id: row.id, err: e });
  }
  return hub.withBoard(row.board_id, () => {
    const again = verifyRun(hub, device, msg, connection);
    if(owned&&(hub.repo(again.run.repo_id)?.canonical_url!==canonical||hub.workflowGuard.sourceHmac(again.row)!==sourceHmac))throw new HubError('CONFLICT','Workflow evidence source changed while verifying.');
    const id = randomUUID();
    const verification = verified ? 'hub_verified' : 'self_reported';
    hub.txn(() => {
      hub.db.insert('evidence', {
        id, card_id: row.id, run_id: again.run.id, kind: params.kind, ref, summary: params.summary == null ? null : clip(params.summary, 500),
        result: params.kind === 'test_run' ? params.result ?? null : null, verification, verified_at: verified ? hub.iso() : null, created_at: hub.iso(),
        pr_head_repo_id: binding?.head_repo_id ?? null, pr_base_repo_id: binding?.base_repo_id ?? null, pr_base_ref: binding?.base_ref ?? null,
      });
      if(owned&&verified&&params.kind==='pr')hub.db.insert('workflow_verified_pr',{evidence_id:id,run_id:again.run.id,repo_hmac:hub.refHash(canonical),head_sha:binding.head_sha,base_ref:binding.base_ref,head_repo_id:binding.head_repo_id,base_repo_id:binding.base_repo_id});
      hub.feed(row.id, 'evidence', { kind: params.kind, ref, verification, result: params.result ?? null }, { run: again.run });
      hub.journal({ board_id: row.board_id, card_id: row.id, run_id: again.run.id, actor_kind: 'runner', actor_id: device.id, kind: 'evidence.create', payload: { evidence_id: id, kind: params.kind, ref, verification, result: params.result ?? null } });
      hub.later(() => hub.broadcastCard(row.id));
    });
    return { evidence_id: id, verification };
  });
}

export async function handleRpc(hub, device, msg, { connection = null } = {}) {
  if (!RPC_METHODS.includes(msg.method)) throw new HubError('VALIDATION', `unknown method ${msg.method}`);
  if (!Object.hasOwn(METHOD_SCOPES, msg.method) || !TOOL_SCOPES[METHOD_SCOPES[msg.method]]) throw new HubError('FORBIDDEN', `method ${msg.method} has no declared scope`);
  if (msg.method === 'board_attach_evidence') return attachEvidence(hub, device, msg, connection);
  const row = hub.card(msg.card_id);
  if (!row) throw new HubError('NOT_FOUND', 'card not found');
  return hub.withBoard(row.board_id, () => {
    const c = verifyRun(hub, device, msg, connection);
    return METHODS[msg.method](hub, c, msg.params ?? {});
  });
}
