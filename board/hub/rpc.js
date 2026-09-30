// Runner RPC methods (CONTRACT §6.6). Each runs inside the card's board
// queue after verifyRun() (run token HMAC, run unended, fence current,
// repo_id = the run's repo). Network work (GitHub) happens before the queue.

import { randomUUID } from 'node:crypto';
import { RPC_METHODS } from '../shared/protocol.js';
import { PLAN_APPROVAL_LABEL } from '../shared/states.js';
import { HubError } from './db.js';
import { parseRunToken } from './auth.js';
import { prNumberOf } from './github.js';

const EVIDENCE_KINDS = ['pr', 'commit', 'test_run', 'screenshot', 'log', 'url', 'no_tests_reason'];
const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
export const relPath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 500 && !p.startsWith('/') && !p.startsWith('~')
  && !/^[a-z]:/i.test(p) && !p.includes('\0') && !p.split('/').includes('..');

export function verifyRun(hub, device, msg) {
  const tok = parseRunToken(hub.secret, msg.run_token);
  if (!tok || tok.run_id !== msg.run_id || tok.card_id !== msg.card_id) throw new HubError('UNAUTHENTICATED', 'bad run token');
  const run = hub.run(msg.run_id);
  const row = hub.card(msg.card_id);
  if (!run || !row || run.card_id !== row.id) throw new HubError('NOT_FOUND', 'run not found');
  if (run.device_id !== device.id) throw new HubError('FORBIDDEN', 'run belongs to another device');
  if (msg.repo_id !== run.repo_id) throw new HubError('FORBIDDEN', 'repo_id does not match the run (out of scope)');
  if (tok.fence !== row.fence || msg.fence !== row.fence) throw new HubError('FENCED', `fence ${msg.fence} is not current (${row.fence})`);
  if (run.ended_at) throw new HubError('RUN_ENDED', 'run has ended');
  if (row.active_run_id !== run.id) throw new HubError('FENCED', 'run is no longer the active run');
  return { run, row };
}

function brief(hub, row) {
  return { key: row.key, title: row.title, column: row.column_name, run_state: row.run_state ?? 'todo' };
}

const METHODS = {
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
    let sql = 'SELECT * FROM cards WHERE board_id = ? AND repo_id = ?';
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
      pre: () => hub.db.insert('asks', {
        id, run_id: run.id, card_id: row.id, kind: params.kind, text: clip(params.text, 2000),
        options: params.options ? JSON.stringify(params.options.slice(0, 10).map((o) => clip(o, 200))) : null, state: 'open', created_at: hub.iso(),
      }),
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
    const res = hub.apply(row.id, { type: 'complete', fence: row.fence }, {
      ctx: { evidence_ok: code && tests },
      pre: () => {
        if (params.summary) {
          hub.db.run('UPDATE runs SET status_summary = ? WHERE id = ?', clip(params.summary, 140), run.id);
          hub.feed(row.id, 'progress', { text: clip(params.summary, 500) }, { run });
        }
      },
    });
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

  board_declare_plan(hub, { run, row }, params) {
    if (!Array.isArray(params.paths)) throw new HubError('VALIDATION', 'paths must be an array');
    const paths = [...new Set(params.paths.filter(relPath))].slice(0, 200);
    hub.txn(() => {
      hub.db.run('UPDATE runs SET planned_paths = ? WHERE id = ?', JSON.stringify(paths), run.id);
      if (params.summary) hub.feed(row.id, 'plan_declared', { summary: clip(params.summary, 500), paths: paths.slice(0, 20) }, { run });
    });
    hub.recomputeOverlaps(run.repo_id);
    return { overlaps: hub.overlapViews(hub.card(row.id)) };
  },

  board_check_overlap(hub, { run, row }) {
    return { overlaps: hub.overlapViews(row), locks: [] };
  },

  board_recall(hub, { run, row }, params) {
    const kinds = Array.isArray(params.kinds) ? params.kinds.filter((k) => k === 'handoff') : ['handoff'];
    if (!kinds.length) return { memories: [] };
    let rows = hub.db.all("SELECT * FROM memories WHERE repo_id = ? AND kind = 'handoff' AND status != 'archived' ORDER BY created_at DESC LIMIT 100", run.repo_id);
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
    const repoPolicy = hub.runners.get(run.device_id)?.repos.get(run.repo_id);
    const approvers = [...new Set([run.on_behalf_of, run.dispatched_by, ...hub.assignees(row.id), ...(repoPolicy?.approvals_from ?? [])].filter(Boolean))];
    const id = randomUUID();
    const res = hub.apply(row.id, { type: 'block', fence: row.fence, kind: 'permission' }, {
      pre: () => hub.db.insert('permission_requests', {
        id, run_id: run.id, card_id: row.id, tool: clip(params.tool_name, 100), input_summary: clip(params.input_summary ?? '', 300),
        state: 'open', approvers: JSON.stringify(approvers), created_at: hub.iso(),
      }),
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
      if (withdrawable) {
        const res = hub.apply(row.id, { type: 'withdraw', fence: row.fence }, { ctx: { open_asks_remaining: open } });
        if (!res.ok) throw new HubError(res.error.code, res.error.message);
      }
      hub.later(() => hub.broadcastCard(row.id));
    });
    return { state: 'cancelled' };
  },

  team_context(hub, { run }) {
    return hub.teamContext(run.id);
  },
};

async function attachEvidence(hub, device, msg) {
  const params = msg.params ?? {};
  if (!EVIDENCE_KINDS.includes(params.kind)) throw new HubError('VALIDATION', `kind must be one of ${EVIDENCE_KINDS.join('|')}`);
  if (typeof params.ref !== 'string' || !params.ref || params.ref.length > 500) throw new HubError('VALIDATION', 'ref required');
  if (params.result != null && !['pass', 'fail'].includes(params.result)) throw new HubError('VALIDATION', 'result must be pass|fail');
  const { run, row } = verifyRun(hub, device, msg);
  const canonical = hub.repo(run.repo_id)?.canonical_url;
  let verified = false;
  try {
    if (params.kind === 'pr') {
      const pull = await hub.github.getPull(canonical, prNumberOf(params.ref));
      verified = !!pull && (pull.head_ref === run.branch || String(pull.head_ref ?? '').startsWith(`board/${row.key}-r`));
    } else if (params.kind === 'commit') {
      verified = !!(await hub.github.getCommit(canonical, params.ref.trim()));
    }
  } catch (e) {
    hub.log.warn('evidence verification failed', { card_id: row.id, err: e });
  }
  return hub.withBoard(row.board_id, () => {
    const again = verifyRun(hub, device, msg);
    const id = randomUUID();
    const verification = verified ? 'hub_verified' : 'self_reported';
    hub.txn(() => {
      hub.db.insert('evidence', {
        id, card_id: row.id, run_id: again.run.id, kind: params.kind, ref: params.ref, summary: params.summary == null ? null : clip(params.summary, 500),
        result: params.kind === 'test_run' ? params.result ?? null : null, verification, verified_at: verified ? hub.iso() : null, created_at: hub.iso(),
      });
      hub.feed(row.id, 'evidence', { kind: params.kind, ref: params.ref, verification, result: params.result ?? null }, { run: again.run });
      hub.later(() => hub.broadcastCard(row.id));
    });
    return { evidence_id: id, verification };
  });
}

export async function handleRpc(hub, device, msg) {
  if (!RPC_METHODS.includes(msg.method)) throw new HubError('VALIDATION', `unknown method ${msg.method}`);
  if (msg.method === 'board_attach_evidence') return attachEvidence(hub, device, msg);
  const row = hub.card(msg.card_id);
  if (!row) throw new HubError('NOT_FOUND', 'card not found');
  return hub.withBoard(row.board_id, () => {
    const c = verifyRun(hub, device, msg);
    return METHODS[msg.method](hub, c, msg.params ?? {});
  });
}

