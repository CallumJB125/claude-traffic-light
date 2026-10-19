// AI review before Review (step 6; CONTRACT "AI review before Review (066)").
// Row 31's review_request effect asks for a second AI's review of the run
// that just finished; the review itself runs on the author run owner's
// machine (board/runner/review.js) and comes back as review.result. The
// reviewer's reply is untrusted: shared/review.js parses it into a closed
// shape and this file removes secrets from every string it stores. A review
// never changes the card's state; its actions go through the ordinary
// request_changes and approve_done transitions.

import { randomUUID } from 'node:crypto';
import sessionRouter from '../shared/session-router.cjs';
import { HubError, json } from './db.js';
import { can } from './permissions.js';
import { AI_LABELS, AI_CAPABILITIES, aiOfDispatch, acceptsAi } from '../shared/ai.js';
import {
  reviewSettings, parseReviewOutput, reviewFixComment, oneLine, REVIEW_PROVIDERS, REVIEW_MODELS, REVIEW_TIMEOUT_MS,
  REVIEW_DISCLOSURE, REVIEW_CAP_MIN_USD, REVIEW_CAP_MAX_USD, REVIEW_FILES_MAX, REVIEW_SIGNALS_MAX,
} from '../shared/review.js';
import { redactSecrets } from '../shared/secret-patterns.mjs';
import { cardView } from './views.js';

const GOAL_MAX = 4000;
const scrub = (s) => redactSecrets(String(s ?? ''), { classes: ['credential', 'likely'], docExamples: false, replace: () => '[redacted]' });
const capped = (ai) => AI_CAPABILITIES[ai]?.budget !== 'none';

function testsOf(hub, runId) {
  const rows = runId ? hub.db.all("SELECT kind, result FROM evidence WHERE run_id = ? AND kind IN ('test_run','no_tests_reason') ORDER BY created_at, rowid", runId) : [];
  const t = [...rows].reverse().find((e) => e.kind === 'test_run');
  return t ? (['pass', 'fail'].includes(t.result) ? t.result : null) : rows.length ? 'none' : null;
}

export class CardReviews {
  constructor(hub) {
    this.hub = hub;
    this.db = hub.db;
  }

  settings(boardId) {
    return reviewSettings(this.hub.boardSettings(boardId).ai_review);
  }

  row(id) { return this.db.get('SELECT * FROM card_reviews WHERE id = ?', id); }

  // The review_request effect: inside apply()'s transaction.
  request(env) {
    const card = env.row;
    const s = this.settings(card.board_id);
    const run = this.hub.run(env.runId);
    if (!s.enabled || !run) return null;
    const id = randomUUID();
    const now = this.hub.iso();
    const capCents = Math.round(s.spend_cap_usd * 100);
    const daily = this.hub.dailyRemainingCents(card.board_id);
    const blocked = daily != null && daily < capCents ? "the board's daily spend cap does not leave enough for a review" : null;
    this.db.insert('card_reviews', {
      id, card_id: card.id, board_id: card.board_id, run_id: run.id, status: blocked ? 'unavailable' : 'pending',
      author_ai: aiOfDispatch(run), cap_cents: capCents, findings: '[]', flags: '[]', error: blocked, created_at: now, completed_at: blocked ? now : null,
    });
    this.hub.journal({ board_id: card.board_id, card_id: card.id, run_id: run.id, kind: 'card_review.request', payload: { review_id: id, status: blocked ? 'unavailable' : 'pending' } });
    if (!blocked) this.hub.later(() => this.offer(id));
    return id;
  }

  // Ready devices of the author run's owner that can run a review in this repo,
  // and per reviewer AI the first such device.
  reviewers(card, run, s) {
    const out = new Map();
    for (const c of this.hub.runners.values()) {
      if (!c.ready || c.review !== true || c.member_id !== run.on_behalf_of || !c.repos?.has(card.repo_id)) continue;
      for (const ai of REVIEW_PROVIDERS) {
        if (out.has(ai) || (!capped(ai) && !s.allow_uncapped)) continue;
        if (acceptsAi(c, ai, capped(ai) ? s.spend_cap_usd : null)) out.set(ai, c);
      }
    }
    return out;
  }

  /** The reviewer for a card: the board's preference, else suggest() over the AIs that are not the author's. */
  choose(card, run, s) {
    const avail = this.reviewers(card, run, s);
    if (!avail.size) return null;
    const author = aiOfDispatch(run);
    let provider = s.provider !== 'auto' && avail.has(s.provider) ? s.provider : null;
    if (!provider) {
      const providers = [...avail.keys()].map((id) => ({ provider: id, label: AI_LABELS[id], available: true }));
      const record = { v: 1, record_id: `card:${card.id}`, adapter: author, title: card.title, goal: card.acceptance ?? '' };
      provider = sessionRouter.suggest({ record }, providers)?.provider ?? null;
    }
    if (!provider || !avail.has(provider)) return null;
    return { provider, conn: avail.get(provider), independence: provider === author ? 'same_provider' : 'other_provider' };
  }

  offerFrame(rev, card, run, choice, s) {
    const repo = this.hub.repo(card.repo_id);
    const goal = `${card.title}${card.body ? `\n\n${card.body}` : ''}`.slice(0, GOAL_MAX);
    return {
      type: 'review.offer', review_id: rev.id, card_id: card.id, repo_id: card.repo_id, key: card.key, ai: choice.provider,
      model: choice.provider === 'claude' ? s.model : null, budget_usd: capped(choice.provider) ? rev.cap_cents / 100 : null,
      base_ref: run.base_ref ?? repo?.default_branch ?? 'main', heads: [run.last_snapshot_sha, run.branch].filter((x) => typeof x === 'string' && x),
      goal, acceptance: String(card.acceptance ?? '').slice(0, GOAL_MAX), tests: testsOf(this.hub, run.id), author_ai: rev.author_ai ?? 'claude',
    };
  }

  /** Sends a pending review to a device that can run it; stays pending when none can. */
  offer(id) {
    const rev = this.row(id);
    if (!rev || rev.status !== 'pending') return false;
    const offeredTo = rev.device_id ? this.hub.runners.get(rev.device_id) : null;
    const card = this.hub.card(rev.card_id), run = this.hub.run(rev.run_id);
    if (!card || !run || card.archived_at) return false;
    const s = this.settings(card.board_id);
    const choice = this.choose(card, run, s);
    if (!choice) return false;
    // A device that already has it keeps it; the runner dedupes by review_id.
    if (offeredTo?.ready && offeredTo.review === true && offeredTo !== choice.conn && rev.provider) return false;
    this.db.run('UPDATE card_reviews SET provider = ?, model = ?, independence = ?, device_id = ? WHERE id = ? AND status = \'pending\'',
      choice.provider, choice.provider === 'claude' ? s.model : null, choice.independence, choice.conn.device_id, id);
    if (!rev.provider) this.hub.journal({ board_id: card.board_id, card_id: card.id, run_id: run.id, kind: 'card_review.request', payload: { review_id: id, provider: choice.provider, independence: choice.independence } });
    choice.conn.send(this.offerFrame(rev, card, run, choice, s));
    this.hub.broadcastCard(card.id);
    return true;
  }

  /** On a runner's advertise: every pending review it could take. */
  offerPending(deviceId) {
    const conn = this.hub.runners.get(deviceId);
    if (!conn?.review) return;
    for (const r of this.db.all("SELECT r.id FROM card_reviews r JOIN runs u ON u.id = r.run_id WHERE r.status = 'pending' AND u.on_behalf_of = ?", conn.member_id)) this.offer(r.id);
  }

  // review.result from a runner connection.
  async onResult(conn, msg) {
    const rev0 = this.row(msg.review_id);
    if (!rev0 || rev0.card_id !== msg.card_id || rev0.device_id !== conn.device_id) throw new HubError('NOT_FOUND', 'review not found');
    const card0 = this.hub.card(rev0.card_id);
    if (!card0 || card0.repo_id !== msg.repo_id) throw new HubError('FORBIDDEN', 'review result for another repo');
    return this.hub.withBoard(card0.board_id, () => this.hub.txn(() => {
      const rev = this.row(msg.review_id);
      if (rev.status !== 'pending' || rev.device_id !== conn.device_id) return;
      const now = this.hub.iso();
      const cost = Number.isFinite(msg.cost_usd) && msg.cost_usd >= 0 && msg.cost_usd <= 1000 ? Math.round(msg.cost_usd * 100) : null;
      let set;
      if (!msg.ok) {
        set = { status: 'failed', error: oneLine(scrub(msg.error ?? 'the review did not finish'), 300), cost_cents: cost, completed_at: now };
      } else {
        const files = (msg.files ?? []).filter((f) => typeof f === 'string').slice(0, REVIEW_FILES_MAX);
        const signals = (msg.signals ?? []).filter((x) => x && typeof x === 'object').slice(0, REVIEW_SIGNALS_MAX)
          .map((x) => ({ file: typeof x.file === 'string' ? x.file : null, line: Number.isSafeInteger(x.line) ? x.line : 0 }));
        const r = parseReviewOutput(msg.output ?? '', { files, signals, truncated: msg.truncated === true, tests: testsOf(this.hub, rev.run_id) });
        if (cost != null && rev.cap_cents != null && cost > rev.cap_cents) r.flags.push('over_cap');
        set = {
          status: 'done', verdict: r.verdict, summary: oneLine(scrub(r.summary), 1000), cost_cents: cost, completed_at: now,
          findings: JSON.stringify(r.findings.map((f) => ({ ...f, file: oneLine(scrub(f.file), 300), rationale: oneLine(scrub(f.rationale), 200) }))),
          flags: JSON.stringify([...new Set(r.flags)]),
          model: REVIEW_MODELS.includes(msg.model) ? msg.model : rev.model,
        };
      }
      const keys = Object.keys(set);
      this.db.run(`UPDATE card_reviews SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => set[k]), rev.id);
      this.hub.journal({ board_id: card0.board_id, card_id: rev.card_id, run_id: rev.run_id, actor_kind: 'runner', actor_id: conn.device_id, kind: 'card_review.result',
        payload: { review_id: rev.id, status: set.status, verdict: set.verdict ?? null, findings: set.findings ? json(set.findings, []).length : 0, cost_cents: cost } });
      this.hub.later(() => this.hub.broadcastCard(rev.card_id));
      if (set.status === 'done' && cost != null) this.hub.later(() => this.hub.noteDailyCap(rev.card_id));
    }));
  }

  /** Pending reviews past REVIEW_TIMEOUT_MS end as failed (offered) or unavailable (no runner could take them). */
  sweep() {
    const cutoff = new Date(this.hub.wallMs() - REVIEW_TIMEOUT_MS).toISOString();
    for (const r of this.db.all("SELECT * FROM card_reviews WHERE status = 'pending' AND created_at < ?", cutoff)) {
      const offered = !!r.device_id;
      this.hub.txn(() => {
        this.db.run("UPDATE card_reviews SET status = ?, error = ?, completed_at = ? WHERE id = ? AND status = 'pending'",
          offered ? 'failed' : 'unavailable', offered ? 'the runner did not return the review in time' : 'no runner that can review was online', this.hub.iso(), r.id);
        this.hub.journal({ board_id: r.board_id, card_id: r.card_id, run_id: r.run_id, kind: 'card_review.result', payload: { review_id: r.id, status: offered ? 'failed' : 'unavailable', verdict: null, findings: 0, cost_cents: null } });
        this.hub.later(() => this.hub.broadcastCard(r.card_id));
      });
    }
  }

  spentCents(boardId, since) {
    return this.db.get('SELECT COALESCE(SUM(cost_cents), 0) AS c FROM card_reviews WHERE board_id = ? AND created_at >= ?', boardId, since).c;
  }

  // ── read models ───────────────────────────────────────────────────────────
  view(r) {
    const findings = json(r.findings, []).map((f, index) => ({ index, ...f }));
    return {
      id: r.id, run_id: r.run_id, status: r.status, verdict: r.verdict ?? null, summary: r.summary ?? null, findings,
      open_findings: findings.filter((f) => !f.dismissed).length, flags: json(r.flags, []),
      provider: r.provider ?? null, provider_label: r.provider ? AI_LABELS[r.provider] ?? r.provider : null, model: r.model ?? null,
      author_ai: r.author_ai ?? null, author_label: r.author_ai ? AI_LABELS[r.author_ai] ?? r.author_ai : null, independence: r.independence ?? null,
      device_name: r.device_id ? this.hub.device(r.device_id)?.name ?? null : null,
      cap_usd: r.cap_cents == null ? null : r.cap_cents / 100, cost_usd: r.cost_cents == null ? null : r.cost_cents / 100,
      error: r.error ?? null, human_action: r.human_action ?? null, human_action_by_name: r.human_action_by ? this.hub.memberName(r.human_action_by) : null,
      created_age_ms: this.hub.ageOf(r.created_at), completed_age_ms: this.hub.ageOf(r.completed_at),
    };
  }

  /** CardView.review: the latest review of the card's latest run, or null. */
  summary(row) {
    const run = this.hub.latestRun(row.id);
    const r = run && this.db.get('SELECT * FROM card_reviews WHERE card_id = ? AND run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', row.id, run.id);
    if (!r) return null;
    const v = this.view(r);
    return { id: v.id, status: v.status, verdict: v.verdict, provider: v.provider, provider_label: v.provider_label, independence: v.independence, open_findings: v.open_findings, findings_count: v.findings.length, cost_usd: v.cost_usd, human_action: v.human_action };
  }

  list(cardId) {
    return this.db.all('SELECT * FROM card_reviews WHERE card_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20', cardId).map((r) => this.view(r));
  }

  // ── member routes ─────────────────────────────────────────────────────────
  reviewFor(api, member, cardId, reviewId) {
    const card = api.cardFor(member, cardId);
    const r = this.db.get('SELECT * FROM card_reviews WHERE id = ? AND card_id = ?', reviewId, card.id);
    if (!r) throw new HubError('NOT_FOUND', 'review not found');
    return { card, r };
  }

  read(api, member, cardId) {
    api.cardFor(member, cardId);
    return { reviews: this.list(cardId) };
  }

  mark(api, member, cardId, reviewId, action, payload = {}, cred = null) {
    const { card } = this.reviewFor(api, member, cardId, reviewId);
    return api.withWritableBoard(card.board_id, (current) => this.hub.txn(() => {
      const r = this.db.get('SELECT * FROM card_reviews WHERE id = ? AND card_id = ?', reviewId, cardId);
      if (!r) throw new HubError('NOT_FOUND', 'review not found');
      if (action === 'dismiss') {
        const findings = json(r.findings, []);
        const i = payload.finding;
        if (!Number.isSafeInteger(i) || i < 0 || i >= findings.length) throw new HubError('NOT_FOUND', 'finding not found');
        if (!findings[i].dismissed) findings[i] = { ...findings[i], dismissed: { by_name: oneLine(current.display_name, 100), at: this.hub.iso() } };
        this.db.run('UPDATE card_reviews SET findings = ? WHERE id = ?', JSON.stringify(findings), r.id);
      } else {
        this.db.run('UPDATE card_reviews SET human_action = ?, human_action_by = ? WHERE id = ?', action === 'fix' ? 'fix_requested' : 'approved', current.id, r.id);
      }
      this.hub.journal({ board_id: card.board_id, card_id: cardId, run_id: r.run_id, actor_kind: 'member', actor_id: current.id, kind: 'card_review.action', payload: { review_id: r.id, action, ...(action === 'dismiss' ? { finding: payload.finding } : {}) } });
      this.hub.later(() => this.hub.broadcastCard(cardId));
      return this.view(this.row(r.id));
    }), { member, cred });
  }

  // "Ask author to fix": request_changes to the author's original AI, seeded with the open findings.
  async fix(api, member, cardId, reviewId, body, cred = null) {
    const { r } = this.reviewFor(api, member, cardId, reviewId);
    if (r.status !== 'done') throw new HubError('CONFLICT', 'this review has no result to send');
    const comment = reviewFixComment(this.view(r), { reviewerLabel: r.provider ? AI_LABELS[r.provider] ?? r.provider : 'a second AI' });
    const res = await api.action(member, cardId, 'request_changes', { request_id: body.request_id, comment, ...(body.target_member_id ? { target_member_id: body.target_member_id } : {}) }, { cred });
    const review = await this.mark(api, member, cardId, reviewId, 'fix', {}, cred);
    return { ...res, review };
  }

  // Approve moves the card to Done: a person only, never an integration acting through a member.
  async approve(api, member, cardId, reviewId, body, cred = null) {
    if (this.hub.viaScope.getStore()) throw new HubError('FORBIDDEN', 'a person must approve work');
    this.reviewFor(api, member, cardId, reviewId);
    const res = await api.action(member, cardId, 'approve_done', { request_id: body.request_id }, { cred });
    const review = await this.mark(api, member, cardId, reviewId, 'approve', {}, cred);
    return { ...res, review };
  }

  async dismiss(api, member, cardId, reviewId, index, cred = null) {
    const review = await this.mark(api, member, cardId, reviewId, 'dismiss', { finding: Number(index) }, cred);
    return { review, card: cardView(this.hub, this.hub.card(cardId), member.id) };
  }

  readSettings(api, member, boardId) {
    api.boardFor(member, boardId);
    return {
      settings: this.settings(boardId), disclosure: REVIEW_DISCLOSURE, providers: REVIEW_PROVIDERS.map((id) => ({ id, label: AI_LABELS[id], spend_cap: capped(id) })),
      models: REVIEW_MODELS, cap_min_usd: REVIEW_CAP_MIN_USD, cap_max_usd: REVIEW_CAP_MAX_USD, can_edit: can(member, 'board.rename'),
    };
  }

  async writeSettings(api, member, boardId, body, cred = null) {
    member = api.currentWriter(member, cred);
    api.boardFor(member, boardId);
    if (!can(member, 'board.rename')) throw new HubError('FORBIDDEN', 'only admins can change AI review');
    const patch = {};
    if ('enabled' in body) { if (typeof body.enabled !== 'boolean') throw new HubError('VALIDATION', 'enabled must be true or false'); patch.enabled = body.enabled; }
    if ('provider' in body) { if (body.provider !== 'auto' && !REVIEW_PROVIDERS.includes(body.provider)) throw new HubError('VALIDATION', `provider must be auto or one of ${REVIEW_PROVIDERS.join(', ')}`); patch.provider = body.provider; }
    if ('model' in body) { if (!REVIEW_MODELS.includes(body.model)) throw new HubError('VALIDATION', `model must be one of ${REVIEW_MODELS.join(', ')}`); patch.model = body.model; }
    if ('spend_cap_usd' in body) {
      const c = body.spend_cap_usd;
      if (!(typeof c === 'number' && Number.isFinite(c) && c >= REVIEW_CAP_MIN_USD && c <= REVIEW_CAP_MAX_USD)) throw new HubError('VALIDATION', `spend_cap_usd must be between ${REVIEW_CAP_MIN_USD} and ${REVIEW_CAP_MAX_USD}`);
      patch.spend_cap_usd = Math.round(c * 100) / 100;
    }
    if ('allow_uncapped' in body) { if (typeof body.allow_uncapped !== 'boolean') throw new HubError('VALIDATION', 'allow_uncapped must be true or false'); patch.allow_uncapped = body.allow_uncapped; }
    return api.withWritableBoard(boardId, (current) => this.hub.txn(() => {
      if (!can(current, 'board.rename')) throw new HubError('FORBIDDEN', 'only admins can change AI review');
      const settings = this.hub.boardSettings(boardId);
      const before = reviewSettings(settings.ai_review);
      const next = { ...(settings.ai_review ?? {}), ...patch };
      // The disclosure is acknowledged each time review is switched on or sent to another provider.
      if (next.enabled === true && (!before.enabled || ('provider' in patch && patch.provider !== before.provider) || ('allow_uncapped' in patch && patch.allow_uncapped && !before.allow_uncapped))) {
        if (body.acknowledge_disclosure !== true) throw new HubError('VALIDATION', 'acknowledge what is sent to the reviewing AI before turning AI review on', { reason: 'DISCLOSURE_REQUIRED' });
        Object.assign(next, { disclosure_ack: true, disclosure_ack_by: current.id, disclosure_ack_at: this.hub.iso() });
      }
      if (next.enabled !== true) next.disclosure_ack = false;
      const after = reviewSettings(next);
      this.db.run('UPDATE boards SET settings = ? WHERE id = ?', JSON.stringify({ ...settings, ai_review: next }), boardId);
      this.hub.journal({ board_id: boardId, actor_kind: 'member', actor_id: current.id, kind: 'board.ai_review', payload: { enabled: after.enabled, provider: after.provider, model: after.model, spend_cap_usd: after.spend_cap_usd, allow_uncapped: after.allow_uncapped, disclosure_ack: after.disclosure_ack } });
      api.audit(current.id, 'board.ai_review', boardId);
      return { settings: after };
    }), { member, cred });
  }
}

export function registerReviewRoutes(route, { hub, api }) {
  const r = hub.reviews;
  route('GET', '/api/cards/:card_id/reviews', ({ member, params }) => r.read(api, member, params.card_id));
  route('POST', '/api/cards/:card_id/reviews/:review_id/fix', ({ member, params, body, ident }) => r.fix(api, member, params.card_id, params.review_id, body, ident?.cred ?? null), { collaboration: true, maxBody: 2048 });
  route('POST', '/api/cards/:card_id/reviews/:review_id/approve', ({ member, params, body, ident }) => r.approve(api, member, params.card_id, params.review_id, body, ident?.cred ?? null), { collaboration: true, maxBody: 1024 });
  route('POST', '/api/cards/:card_id/reviews/:review_id/findings/:index/dismiss', ({ member, params, ident }) => r.dismiss(api, member, params.card_id, params.review_id, params.index, ident?.cred ?? null), { collaboration: true, maxBody: 1024 });
  route('GET', '/api/boards/:board_id/review-settings', ({ member, params }) => r.readSettings(api, member, params.board_id));
  route('PATCH', '/api/boards/:board_id/review-settings', ({ member, params, body, ident }) => r.writeSettings(api, member, params.board_id, body, ident?.cred ?? null), { maxBody: 2048 });
}
