// Event triggers (docs/event-triggers.md, migration 069): a team admin's
// "when X happens, do Y" rules. Events arrive from verified GitHub and Sentry
// deliveries (observe() wraps those connectors' handlers, after the
// connector's own work) and from the journal (a card moving to Review).
//
// HARD RULE: no action here starts an editing AI run, dispatches, retries or
// moves a card, answers a permission, approves work, merges or pushes code.
// The only actions are TRIGGER_ACTIONS (shared/triggers.js); execute() has no
// other branch, and request_ai_review asks the existing read-only reviewer.
//
// Safety: every rule starts off; an admin turns on dry run (logged "would"),
// and only after DRY_RUN_MS of dry run may an admin enable it for real.
// Every change is audited. Per rule: max_per_hour actions (default 10), one
// firing per event id (the firing row is the dedupe record), and a loop guard:
// what a firing writes (journal rows as actor trigger:<id>, anything inside
// its scope) never triggers again. Statuses from integrations still never
// start an AI run; a trigger is a separate, explicit opt-in.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { HubError, json } from './db.js';
import { insertCardRecord } from './card-record.js';
import { defineConnector } from './integrations/connector.js';
import { githubTriggerEvents, sentryTriggerEvents } from './trigger-events.js';
import { columnOf } from '../shared/states.js';
import {
  TRIGGER_EVENTS, TRIGGER_ACTIONS, TRIGGER_MODES, DRY_RUN_MS, LOG_LIMIT, TRIGGERS_PER_TEAM, RATE_MAX,
  validateRule, filtersMatch, ruleSentence,
} from '../shared/triggers.js';

const KEEP_MS = 30 * 86_400_000;
const HOUR_MS = 3_600_000;
const NOTIFY_KEEP = 500;
const VIA = 'trigger';
const REVIEW_NOTE = 'A trigger asked the AI reviewer to review this card’s latest run. The review only reads the diff and reports findings on this card; it never edits code.';
const skip = (detail) => ({ ok: false, detail });

const asHubError = (e) => (e?.code === 'VALIDATION' && !(e instanceof HubError) ? new HubError('VALIDATION', e.message) : e);
const repoName = (repo) => {
  const u = String(repo?.canonical_url ?? '');
  return u.startsWith('github.com/') ? u.slice('github.com/'.length) : u || null;
};

export class Triggers {
  constructor(hub, { api, bus = null, log = null }) {
    this.hub = hub;
    this.db = hub.db;
    this.api = api;
    this.log = log ?? hub.log;
    // Set while a firing runs: an event raised from inside one is its own echo.
    this.firing = new AsyncLocalStorage();
    this.lastSweep = 0;
    bus?.subscribe('triggers', (row) => this.onJournal(row), { kinds: ['card.transition', 'card.update'] });
  }

  // ── rules ─────────────────────────────────────────────────────────────────

  row(id) { return this.db.get('SELECT * FROM event_triggers WHERE id = ? AND deleted_at IS NULL', id); }

  ruleOf(member, id) {
    const t = typeof id === 'string' ? this.row(id) : null;
    if (!t || t.org_id !== member.org_id) throw new HubError('NOT_FOUND', 'no such trigger');
    return t;
  }

  names(t) {
    const p = json(t.params, {});
    const board = p.board_id ? this.hub.board(p.board_id) : null;
    const member = p.member_id ? this.hub.member(p.member_id) : null;
    return { boardName: board?.org_id === t.org_id ? board.name : null, memberName: member?.org_id === t.org_id ? member.display_name : null };
  }

  view(t) {
    const rule = { event: t.event, action: t.action, filters: json(t.filters, {}), params: json(t.params, {}) };
    const since = t.mode === 'dry_run' && t.dry_run_since ? Date.parse(t.dry_run_since) : null;
    return {
      id: t.id, ...rule, mode: t.mode, max_per_hour: t.max_per_hour, sentence: ruleSentence(rule, this.names(t)),
      created_by_name: this.hub.member(t.created_by)?.display_name ?? null,
      enabled_by_name: t.enabled_by ? this.hub.member(t.enabled_by)?.display_name ?? null : null,
      dry_run_since: t.dry_run_since, can_enable_at: since == null ? null : new Date(since + DRY_RUN_MS).toISOString(),
      created_at: t.created_at,
    };
  }

  list(member) {
    const rows = this.db.all('SELECT * FROM event_triggers WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at, id', member.org_id);
    return {
      triggers: rows.map((t) => this.view(t)), events: TRIGGER_EVENTS, actions: TRIGGER_ACTIONS,
      dry_run_days: DRY_RUN_MS / 86_400_000, max_per_hour_max: RATE_MAX, can_edit: this.hub.isAdmin(member),
    };
  }

  admin(member, cred) {
    const current = this.api.currentWriter(member, cred);
    if (!this.hub.isAdmin(current)) throw new HubError('FORBIDDEN', 'only team admins can change triggers');
    return current;
  }

  create(member, body, cred = null) {
    const current = this.admin(member, cred);
    let rule;
    try { rule = validateRule(body); } catch (e) { throw asHubError(e); }
    const p = rule.params;
    if (p.board_id) {
      const b = this.hub.board(p.board_id);
      if (!b || b.org_id !== current.org_id || b.archived_at) throw new HubError('VALIDATION', 'that board is not one of this team’s open boards');
    }
    if (p.member_id) {
      const m = this.hub.activeMember(p.member_id);
      if (!m || m.org_id !== current.org_id) throw new HubError('VALIDATION', 'that person is not on this team');
    }
    const id = randomUUID(), now = this.hub.iso();
    this.hub.txn(() => {
      if (this.db.get('SELECT COUNT(*) AS n FROM event_triggers WHERE org_id = ? AND deleted_at IS NULL', current.org_id).n >= TRIGGERS_PER_TEAM) {
        throw new HubError('QUOTA_EXCEEDED', `a team can have at most ${TRIGGERS_PER_TEAM} triggers`, { resource: 'event_triggers', limit: TRIGGERS_PER_TEAM });
      }
      this.db.insert('event_triggers', {
        id, org_id: current.org_id, event: rule.event, filters: JSON.stringify(rule.filters), action: rule.action, params: JSON.stringify(p),
        mode: 'off', max_per_hour: rule.max_per_hour, created_by: current.id, created_at: now, updated_at: now,
      });
      this.api.audit(current.id, 'trigger.create', id, JSON.stringify({ event: rule.event, action: rule.action, max_per_hour: rule.max_per_hour }));
    });
    return { trigger: this.view(this.row(id)) };
  }

  /**
   * off → dry_run → on (and back to off at any time). `on` only from a dry run
   * at least DRY_RUN_MS old, with confirm: true; dry run again restarts the clock.
   */
  setMode(member, id, body, cred = null) {
    const current = this.admin(member, cred);
    const mode = body?.mode;
    if (!TRIGGER_MODES.includes(mode)) throw new HubError('VALIDATION', `mode must be one of ${TRIGGER_MODES.join(', ')}`);
    return this.hub.txn(() => {
      const t = this.ruleOf(current, id);
      if (t.mode === mode) return { trigger: this.view(t) };
      const now = this.hub.iso();
      const set = { mode, updated_at: now };
      if (mode === 'dry_run') Object.assign(set, { enabled_by: current.id, dry_run_since: now });
      if (mode === 'on') {
        if (t.mode !== 'dry_run' || !t.dry_run_since) throw new HubError('CONFLICT', 'run it in dry run first', { reason: 'DRY_RUN_FIRST' });
        const ready = Date.parse(t.dry_run_since) + DRY_RUN_MS;
        if (this.hub.wallMs() < ready) throw new HubError('CONFLICT', `dry run until ${new Date(ready).toISOString()} before enabling it for real`, { reason: 'DRY_RUN_FIRST', can_enable_at: new Date(ready).toISOString() });
        if (body.confirm !== true) throw new HubError('VALIDATION', 'confirm that it should act for real', { reason: 'CONFIRM_REQUIRED' });
        set.enabled_by = current.id;
      }
      const keys = Object.keys(set);
      this.db.run(`UPDATE event_triggers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => set[k]), t.id);
      this.api.audit(current.id, 'trigger.mode', t.id, JSON.stringify({ from: t.mode, to: mode }));
      return { trigger: this.view(this.row(t.id)) };
    });
  }

  remove(member, id, cred = null) {
    const current = this.admin(member, cred);
    return this.hub.txn(() => {
      const t = this.ruleOf(current, id);
      this.db.run("UPDATE event_triggers SET mode = 'off', deleted_at = ?, updated_at = ? WHERE id = ?", this.hub.iso(), this.hub.iso(), t.id);
      this.api.audit(current.id, 'trigger.delete', t.id, JSON.stringify({ mode: t.mode }));
      return { ok: true };
    });
  }

  /** The team's last LOG_LIMIT firings, newest first: ids and short codes only. */
  activity(member) {
    this.sweep();
    const rows = this.db.all(`SELECT id, trigger_id, event, action, mode, result, detail, subject, card_id, at FROM event_trigger_firings
      WHERE org_id = ? ORDER BY id DESC LIMIT ${LOG_LIMIT}`, member.org_id);
    return { firings: rows };
  }

  sweep() {
    const t = this.hub.wallMs();
    if (t - this.lastSweep < HOUR_MS) return;
    this.lastSweep = t;
    this.db.run('DELETE FROM event_trigger_firings WHERE at < ?', new Date(t - KEEP_MS).toISOString());
  }

  // ── events ────────────────────────────────────────────────────────────────

  /**
   * A connector whose verified deliveries can raise trigger events, wrapped:
   * the connector's own handler runs first and decides the answer; trigger
   * work after it never fails the delivery. Other connectors pass through.
   */
  observe(conn) {
    if (conn.id !== 'github' && conn.id !== 'sentry') return conn;
    const original = conn.handleWebhook;
    const { consumes, ...spec } = conn;
    return defineConnector({
      ...spec,
      ...(conn.onEvent ? { consumes } : {}),
      handleWebhook: async (args) => {
        await original(args);
        const { headers, payload, ctx } = args;
        try {
          const opts = { connectionId: ctx.connection.id, linked: (kind, id) => ctx.linked(kind, id) };
          const events = conn.id === 'github'
            ? githubTriggerEvents(String(headers?.['x-github-event'] ?? ''), payload, opts)
            : sentryTriggerEvents(payload, { ...opts, now: this.hub.wallMs(), config: ctx.connection.settings?.config ?? {} });
          for (const ev of events) await this.ingest({ ...ev, org_id: ctx.connection.org_id });
        } catch (e) {
          this.log?.warn?.('trigger evaluation failed', { integration: conn.id, err: e?.message });
        }
      },
    });
  }

  // card.transition / card.update journal rows: a card that entered Review.
  async onJournal(row) {
    // Loop guard: what a trigger wrote never triggers again.
    if (row.actor_kind === 'integration' && String(row.actor_id ?? '').startsWith(`${VIA}:`)) return;
    const p = row.payload ?? {};
    let moved = false;
    if (row.kind === 'card.transition') moved = p.state?.column_name === 'in_review' && columnOf(p.from) !== 'in_review';
    else if (row.kind === 'card.update') moved = Array.isArray(p.fields?.column_name) && p.fields.column_name[1] === 'in_review' && p.fields.column_name[0] !== 'in_review';
    if (!moved || !row.card_id) return;
    const card = this.hub.card(row.card_id);
    const board = card && this.hub.board(card.board_id);
    if (!board) return;
    await this.ingest({
      type: 'card.moved_to_review', id: `journal:${row.seq}`, org_id: board.org_id, card_id: card.id,
      repo: repoName(this.hub.repo(card.repo_id)), branch: this.hub.latestRun(card.id)?.branch ?? null, labels: json(card.labels, []), subject: card.key,
    });
  }

  /** Every live rule of the event's team that matches it fires once (per event id). */
  async ingest(ev) {
    if (this.firing.getStore()) return;
    if (!TRIGGER_EVENTS.includes(ev?.type) || typeof ev.id !== 'string' || !ev.id || ev.id.length > 200 || !ev.org_id) return;
    if (!this.db.get('SELECT 1 AS x FROM orgs WHERE id = ? AND deleted_at IS NULL', ev.org_id)) return;
    this.sweep();
    const rules = this.db.all("SELECT * FROM event_triggers WHERE org_id = ? AND event = ? AND mode IN ('dry_run', 'on') AND deleted_at IS NULL ORDER BY created_at, id", ev.org_id, ev.type);
    for (const t of rules) {
      if (!filtersMatch(json(t.filters, {}), ev)) continue;
      try { await this.fire(t, ev); } catch (e) { this.log?.warn?.('trigger firing failed', { trigger_id: t.id, err: e?.message }); }
    }
  }

  async fire(t, ev) {
    const at = this.hub.iso();
    // The firing row is the dedupe record: a second copy of the event stops here.
    const ins = this.db.run(`INSERT OR IGNORE INTO event_trigger_firings (trigger_id, org_id, event_id, event, action, mode, result, detail, subject, card_id, at)
      VALUES (?, ?, ?, ?, ?, ?, 'skipped', 'pending', ?, ?, ?)`, t.id, t.org_id, ev.id, t.event, t.action, t.mode, String(ev.subject ?? '').slice(0, 160) || null, ev.card_id ?? null, at);
    if (!Number(ins.changes)) return null;
    const firingId = Number(ins.lastInsertRowid);
    const record = (result, detail = null, cardId = ev.card_id ?? null) => {
      this.db.run('UPDATE event_trigger_firings SET result = ?, detail = ?, card_id = ? WHERE id = ?', result, detail, cardId, firingId);
      return result;
    };
    const used = this.db.get(`SELECT COUNT(*) AS n FROM event_trigger_firings WHERE trigger_id = ? AND id != ? AND at > ?
      AND (result IN ('done', 'would', 'failed') OR detail = 'pending')`, t.id, firingId, new Date(this.hub.wallMs() - HOUR_MS).toISOString()).n;
    if (used >= t.max_per_hour) return record('rate_limited', 'rate_limited');
    const plan = this.plan(t, ev);
    if (!plan.ok) return record('skipped', plan.detail);
    if (t.mode !== 'on') return record('would', t.action, plan.card?.id ?? null);
    try {
      const cardId = await this.firing.run({ trigger_id: t.id }, () => this.execute(t, ev));
      return cardId === false ? record('skipped', 'not_applicable') : record('done', t.action, cardId ?? plan.card?.id ?? null);
    } catch (e) {
      return record('failed', String(e?.code ?? 'failed').toLowerCase().slice(0, 64));
    }
  }

  /** What the rule would act on now, or why it can't: the same checks run again inside the board queue. */
  plan(t, ev) {
    if (!TRIGGER_ACTIONS.includes(t.action)) return skip('action_not_allowed');
    const actor = this.hub.activeMember(t.enabled_by);
    if (!actor || actor.org_id !== t.org_id || !this.hub.isAdmin(actor)) return skip('actor_unavailable');
    const p = json(t.params, {});
    if (t.action === 'create_card') {
      const board = this.hub.board(p.board_id);
      if (!board || board.org_id !== t.org_id || board.archived_at) return skip('board_unavailable');
      return { ok: true, actor, board };
    }
    const card = ev.card_id ? this.hub.card(ev.card_id) : null;
    const board = card && this.hub.board(card.board_id);
    if (!card || !board || board.org_id !== t.org_id) return skip('no_card');
    if (card.archived_at || board.archived_at) return skip('card_archived');
    if (t.action === 'request_ai_review') {
      if (!this.hub.reviews.settings(board.id).enabled) return skip('ai_review_off');
      const run = this.hub.latestRun(card.id);
      if (!run) return skip('no_run');
      if (!run.ended_at) return skip('run_in_progress');
      if (this.db.get('SELECT 1 AS x FROM card_reviews WHERE card_id = ? AND run_id = ?', card.id, run.id)) return skip('already_reviewed');
      return { ok: true, actor, board, card, run };
    }
    if (t.action === 'notify_member') {
      const m = this.hub.activeMember(p.member_id);
      if (!m || m.org_id !== t.org_id) return skip('member_unavailable');
      return { ok: true, actor, board, card, member: m };
    }
    if (t.action === 'label_card' && json(card.labels, []).some((l) => String(l).toLowerCase() === String(p.label).toLowerCase())) return skip('already_labelled');
    return { ok: true, actor, board, card };
  }

  /**
   * One allowed action, in the board queue, as the admin who enabled the rule
   * acting through the trigger (journal actor trigger:<id>; comments are
   * untrusted and never reach an agent). → card id, or false when it no longer applies.
   */
  execute(t, ev) {
    const boardId = t.action === 'create_card' ? json(t.params, {}).board_id : this.hub.card(ev.card_id)?.board_id;
    if (!boardId) return false;
    return this.hub.withBoard(boardId, () => {
      const plan = this.plan(t, ev);
      if (!plan.ok) return false;
      const via = { member_id: plan.actor.id, connection_id: `${VIA}:${t.id}`, name: VIA };
      return this.hub.actVia(via, () => this.hub.txn(() => {
        switch (t.action) {
          case 'create_card': return this.createCard(t, ev, plan);
          case 'add_comment': return this.comment(plan, this.commentText(t, ev));
          case 'request_ai_review': {
            const id = this.hub.reviews.request({ row: plan.card, runId: plan.run.id });
            if (!id) return false;
            this.comment(plan, REVIEW_NOTE);
            return plan.card.id;
          }
          case 'notify_member': return this.notify(plan);
          case 'label_card': return this.label(plan, json(t.params, {}).label);
          default: throw new HubError('POLICY_DENIED', 'not an allowed trigger action');
        }
      }));
    });
  }

  commentText(t, ev) {
    const text = json(t.params, {}).text;
    return ev.url ? `${text}\n${ev.url}` : text;
  }

  comment(plan, body) {
    const id = this.api.insertComment(plan.actor, plan.card.id, { body });
    this.hub.feed(plan.card.id, 'comment', { comment_id: id }, { actor: plan.actor.id });
    return plan.card.id;
  }

  // The card text comes from the provider: like an integration's card, the
  // journal keeps keyed hashes of it, never the text (D41).
  createCard(t, ev, plan) {
    const title = (ev.type === 'sentry.issue.new' ? ev.title ?? 'Sentry: new issue'
      : ev.type === 'github.checks.failed' ? `Checks failed: ${ev.subject}`
        : `${ev.type === 'github.pr.review_requested' ? 'Review requested' : 'Pull request'}: ${ev.subject}${ev.title ? ` ${ev.title}` : ''}`).slice(0, 200);
    const body = [ev.type === 'sentry.issue.new' ? ev.body : null, ev.url, 'Made by a team trigger from an outside event. Its text is untrusted.'].filter(Boolean).join('\n\n').slice(0, 20_000);
    const labels = JSON.stringify([`via:${VIA}`]);
    const id = randomUUID(), now = this.hub.iso();
    insertCardRecord(this.hub, plan.board.id, plan.actor.id, { title, body, acceptance: null, repo_id: null, base_ref: null, labels, budget_cents: null, cover: null }, { id, now });
    const c = this.hub.card(id);
    this.hub.journal({
      board_id: plan.board.id, card_id: id, actor_kind: 'member', actor_id: plan.actor.id, kind: 'card.create',
      payload: {
        key: c.key, repo_id: null, budget_cents: null, column_name: c.column_name, cover: null, assignees: [],
        title_hmac: this.hub.refHash(title), body_hmac: this.hub.refHash(body), acceptance_hmac: null, connection_id: `${VIA}:${t.id}`,
        external_ref_hmac: this.hub.refHash(ev.id), base_ref_hmac: null, request_id_hmac: this.hub.refHash(ev.id), labels,
      },
    });
    this.hub.feed(id, 'created', {}, { actor: plan.actor.id });
    this.hub.later(() => this.hub.broadcastCard(id));
    return id;
  }

  // The hub's notification path (hub.notify), addressed to one member.
  notify(plan) {
    const { card, member } = plan;
    const n = { id: randomUUID(), rule: VIA, card_id: card.id, key: card.key, board_id: card.board_id, to: [member.id], at: this.hub.iso() };
    this.hub.journal({ board_id: card.board_id, card_id: card.id, actor_kind: 'member', actor_id: plan.actor.id, kind: 'card.notify', payload: { rule: VIA, to: [member.id] } });
    this.hub.later(() => {
      this.hub.notifications.push(n);
      if (this.hub.notifications.length > NOTIFY_KEEP) this.hub.notifications.splice(0, this.hub.notifications.length - NOTIFY_KEEP);
      this.hub.emit('notify', n);
    });
    return card.id;
  }

  label(plan, label) {
    const { card } = plan;
    this.hub.workflowGuard.edit(card.id);
    const before = json(card.labels, []);
    const after = JSON.stringify([...before, label]);
    const external = this.api.externalCard(card.id);
    const fields = { [external ? 'labels_hmac' : 'labels']: external ? [this.hub.refHash(card.labels), this.hub.refHash(after)] : [card.labels, after] };
    this.hub.journal({ board_id: card.board_id, card_id: card.id, actor_kind: 'member', actor_id: plan.actor.id, kind: 'card.update', payload: { fields, request_id: null } });
    this.db.run('UPDATE cards SET labels = ?, version = version + 1, updated_at = ? WHERE id = ?', after, this.hub.iso(), card.id);
    this.hub.later(() => this.hub.broadcastCard(card.id));
    return card.id;
  }
}

export function registerTriggerRoutes(route, { hub }) {
  const t = hub.triggers;
  if (!t) return;
  route('GET', '/api/triggers', ({ member }) => t.list(member));
  route('GET', '/api/triggers/activity', ({ member }) => t.activity(member));
  route('POST', '/api/triggers', ({ member, body, ident }) => t.create(member, body, ident?.cred ?? null), { maxBody: 4096 });
  route('POST', '/api/triggers/:trigger_id/mode', ({ member, params, body, ident }) => t.setMode(member, params.trigger_id, body, ident?.cred ?? null), { maxBody: 1024 });
  route('DELETE', '/api/triggers/:trigger_id', ({ member, params, ident }) => t.remove(member, params.trigger_id, ident?.cred ?? null));
}
