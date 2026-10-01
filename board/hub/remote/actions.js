import { createHash } from 'node:crypto';
import native from '../../shared/collaboration-tools.cjs';
import { Api } from '../api.js';
import { TeamCommunication } from '../communication.js';
import { HubError } from '../db.js';
import { cardView, selectedContext } from '../views.js';
import { redact } from '../../shared/scope.js';
import { createRemoteContext } from './context.js';
import { UUID, invalid } from './validation.js';

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const unavailable = () => new HubError('NOT_FOUND', 'resource unavailable to this connection');
const basicWrites = ['plexiform_create_card', 'plexiform_update_card', 'plexiform_add_comment'];
// Remote material is never carried back into task narratives or returned data.
function publicText(value) {
  if (typeof value === 'string') return redact(value, null);
  if (Array.isArray(value)) return value.map(publicText);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicText(item)]));
  return value;
}
export class RemoteActions {
  constructor(hub, authority = hub.remoteAuthority) {
    this.hub = hub; this.db = hub.db; this.authority = authority;
    this.api = new Api(hub); this.communication = new TeamCommunication(hub); this.pending = new Map(); this.pendingCount = 0;
  }
  catalog(token, kind = 'integration') {
    const scope = this.authority.authenticate(token, kind);
    return native.listTools(scope.mode).map(tool => basicWrites.includes(tool.name) ? {
      ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
        request_id: { type: 'string', pattern: UUID.source, maxLength: 36 } }, required: [...tool.inputSchema.required, 'request_id'] },
    } : tool);
  }
  validate(name, args) {
    try {
      if (basicWrites.includes(name)) {
        if (!UUID.test(args?.request_id ?? '')) throw invalid();
        const { request_id, ...input } = args;
        return native.validate(name, input);
      }
      return native.validate(name, args);
    } catch { throw invalid(); }
  }
  card(scope, id) {
    const row = this.communication.card(id, scope.member);
    if (!scope.boardIds.includes(row.board_id)) throw unavailable();
    return row;
  }
  guard(token, kind, name, args, write = false) {
    const definition = this.validate(name, args), scope = this.authority.authenticate(token, kind, write || !definition.read);
    if (args.board_id && !scope.boardIds.includes(args.board_id)) throw unavailable();
    if (args.card_id) scope.row = this.card(scope, args.card_id);
    if (name === 'plexiform_send_message') {
      for (const id of args.recipient_run_ids) this.communication.recipient(scope, id);
      if (args.reply_to) {
        const reply = this.db.get('SELECT * FROM task_messages WHERE id = ?', args.reply_to);
        if (!reply || !this.communication.visibleMessage(scope, reply)) throw unavailable();
      }
    }
    return scope;
  }
  pointer(name, args, result) {
    switch (name) {
      case 'plexiform_create_card': case 'plexiform_update_card': return { card_id: result.card?.id ?? result.card_id };
      case 'plexiform_add_comment': return { card_id: args.card_id, comment_id: result.comment?.id ?? result.comment_id };
      case 'plexiform_write_packet': return { card_id: args.card_id, packet_id: result.packet?.id ?? result.packet_id };
      case 'plexiform_send_message': return { card_id: args.card_id, message_id: result.message?.id ?? result.message_id };
      default: throw invalid();
    }
  }
  commentIdentity(comment) {
    const grant = this.db.get("SELECT g.application, g.user_id FROM remote_actions a JOIN remote_grants g ON g.id = a.grant_id WHERE a.tool = 'plexiform_add_comment' AND json_extract(a.response, '$.comment_id') = ? LIMIT 1", comment.id);
    return grant ? { ...comment, identity_source: 'remote_grant', account_id: grant.user_id,
      application: grant.application, application_verified: false } : comment;
  }
  visibleCard(scope, id) {
    try { this.card(scope, id); return true; } catch { return false; }
  }
  formerRun(row) {
    const run = this.hub.run(row.active_run_id) ?? this.hub.latestRun(row.id);
    return run && run.repo_id !== row.repo_id;
  }
  cardProjection(scope, view) {
    const row = this.card(scope, view.id), selected = selectedContext(this.hub, { card: view }, scope.boardIds).card;
    const result = { ...selected, parent_card_id: this.visibleCard(scope, selected.parent_card_id) ? selected.parent_card_id : null,
      depends_on: selected.depends_on.filter(id => this.visibleCard(scope, id)),
      overlaps: selected.overlaps.filter(peer => {
        try { return this.card(scope, peer.other_card_id).repo_id === row.repo_id; } catch { return false; }
      }) };
    if (result.client_feedback?.source_item_id) {
      const item = this.db.get('SELECT card_id FROM client_items WHERE id = ?', result.client_feedback.source_item_id);
      if (!item || !this.visibleCard(scope, item.card_id)) result.client_feedback = { ...result.client_feedback, source_item_id: null };
    }
    if (this.formerRun(row)) Object.assign(result, { run: null, branch: null, live: null, ask: null, handover: null,
      target: null, overlaps: [], pr: null, pr_link_status: null, evidence: null, device_kind: null });
    return result;
  }
  projectMutation(name, args, result, scope) {
    const receipt = this.pointer(name, args, result), row = this.card(scope, receipt.card_id);
    if (name === 'plexiform_create_card' ? row.board_id !== args.board_id : row.id !== args.card_id) throw unavailable();
    switch (name) {
      case 'plexiform_create_card': case 'plexiform_update_card':
        return publicText({ card: this.cardProjection(scope, cardView(this.hub, row, scope.member.id)) });
      case 'plexiform_add_comment': {
        const comment = this.db.get('SELECT * FROM comments WHERE id = ? AND card_id = ?', receipt.comment_id, row.id);
        if (!comment) throw unavailable();
        return publicText({ comment: this.commentIdentity({ id: comment.id, author_name: this.hub.memberName(comment.author_member_id),
          source: comment.source, trusted: !!comment.trusted, body: comment.body, for_agent: !!comment.for_agent,
          reply_to: null, created_age_ms: this.hub.ageOf(comment.created_at) }) });
      }
      case 'plexiform_write_packet': {
        const packet = this.db.get('SELECT * FROM task_packets WHERE id = ? AND card_id = ?', receipt.packet_id, row.id);
        if (!packet || packet.repo_id !== row.repo_id) throw unavailable();
        return publicText({ packet: this.communication.packetProjection(packet) });
      }
      case 'plexiform_send_message': {
        const message = this.db.get('SELECT * FROM task_messages WHERE id = ? AND card_id = ?', receipt.message_id, row.id);
        if (!message || !this.communication.visibleMessage({ ...scope, row }, message)) throw unavailable();
        return publicText({ message: this.communication.messageProjection({ ...scope, row }, message) });
      }
      default: throw invalid();
    }
  }
  detail(scope, cardId) {
    const row = this.card(scope, cardId), result = selectedContext(this.hub, this.api.detail(scope.member, cardId), scope.boardIds);
    // A former repository's runner context cannot be exported through a card
    // that has since changed its selected repository.
    result.card = this.cardProjection(scope, result.card); result.overlaps = result.card.overlaps;
    if (this.formerRun(row)) {
      result.run = null; result.handover = null; result.feed = []; result.evidence = []; result.memories = [];
      result.permission_requests = []; result.asks = [];
    }
    result.comments = result.comments.filter(comment => {
      const author = this.db.get('SELECT author_run_id FROM comments WHERE id = ?', comment.id), run = author?.author_run_id && this.hub.run(author.author_run_id);
      return !author?.author_run_id || run?.repo_id === row.repo_id;
    }).map(comment => {
      const parent = comment.reply_to && this.db.get('SELECT card_id FROM comments WHERE id = ?', comment.reply_to);
      let visible = false; try { if (parent) { this.card(scope, parent.card_id); visible = true; } } catch { /* private reply reference */ }
      return this.commentIdentity({ ...comment, reply_to: visible ? comment.reply_to : null });
    });
    return publicText(result);
  }
  projectRead(name, args, result, scope) {
    switch (name) {
      case 'plexiform_list_boards': return publicText({ boards: scope.boardIds.map(id => {
        const board = this.hub.board(id); return { id, name: board.name, key_prefix: board.key_prefix, archived: false };
      }) });
      case 'plexiform_list_cards': {
        const snapshot = selectedContext(this.hub, this.api.snapshot(scope.member, args.board_id), scope.boardIds), query = (args.query ?? '').toLowerCase();
        return publicText({ board: { id: snapshot.board.id, name: snapshot.board.name }, cards: snapshot.cards.filter(card => {
          try { this.card(scope, card.id); return `${card.key} ${card.title}`.toLowerCase().includes(query); } catch { return false; }
        }).map(card => this.cardProjection(scope, card)) });
      }
      case 'plexiform_get_card': return this.detail(scope, args.card_id);
      case 'plexiform_read_handover': return { card_id: args.card_id, handover: this.detail(scope, args.card_id).handover };
      case 'plexiform_read_packet': {
        if (!result.packet) return { packet: null };
        const packet = this.db.get('SELECT * FROM task_packets WHERE id = ? AND card_id = ?', result.packet.id, args.card_id);
        if (!packet || packet.repo_id !== scope.row.repo_id) throw unavailable();
        return publicText({ packet: this.communication.packetProjection(packet) });
      }
      case 'plexiform_list_messages': return publicText({ ...result, messages: result.messages.flatMap(message => {
        const current = this.db.get('SELECT * FROM task_messages WHERE id = ?', message.id);
        return current && this.communication.visibleMessage(scope, current) ? [this.communication.messageProjection(scope, current)] : [];
      }), peers: this.communication.staffPeers(scope) });
      default: throw invalid();
    }
  }
  async call(token, kind, name, input) {
    if (this.hub.viaScope.getStore()) throw new HubError('FORBIDDEN', 'remote operations require their own authority');
    this.validate(name, input);
    const args = publicText(JSON.parse(JSON.stringify(input))); // immutable request choice across waits
    const initial = this.guard(token, kind, name, args), definition = this.validate(name, args);
    const bound = { grant: initial.grant.id, token: initial.tokenHash, user: initial.member.user_id,
      member: initial.member.id, org: initial.member.org_id, client: initial.grant.client_id, family: initial.grant.family_id };
    const authorize = write => {
      const scope = this.guard(token, kind, name, args, write);
      if (scope.grant.id !== bound.grant || scope.tokenHash !== bound.token || scope.member.user_id !== bound.user
        || scope.member.id !== bound.member || scope.member.org_id !== bound.org || scope.grant.client_id !== bound.client
        || scope.grant.family_id !== bound.family) throw unavailable();
      if (initial.row && (scope.row?.board_id !== initial.row.board_id || scope.row?.repo_id !== initial.row.repo_id)) throw unavailable();
      return scope;
    };
    const fingerprint = createHash('sha256').update(canonical({ name, args })).digest('hex');
    const remote = createRemoteContext({ authorize,
      replay: scope => {
        const prior = this.db.get('SELECT * FROM remote_actions WHERE grant_id = ? AND request_id = ?', scope.grant.id, args.request_id);
        if (!prior) return null;
        if (prior.request_hash !== fingerprint || prior.tool !== name) throw new HubError('CONFLICT', 'request id belongs to another remote operation');
        return JSON.parse(prior.response);
      },
      record: (result, scope) => {
        if (this.db.get('SELECT count(*) n FROM remote_actions WHERE grant_id = ?', scope.grant.id).n >= this.authority.limit('familyActions', 1000)
          || this.db.get('SELECT count(*) n FROM remote_actions').n >= this.authority.limit('totalActions', 100_000)) throw new HubError('QUOTA_EXCEEDED', 'remote action receipt limit reached');
        this.db.insert('remote_actions', { grant_id: scope.grant.id, request_id: args.request_id, request_hash: fingerprint,
          tool: name, response: JSON.stringify(this.pointer(name, args, result)), created_at: this.hub.iso() });
      },
      project: (result, scope) => this.projectMutation(name, args, result, scope),
    });
    const execute = async () => {
      const scope = authorize(false), member = scope.member;
      const { request_id, ...body } = args;
      let result;
      switch (name) {
        case 'plexiform_list_boards': case 'plexiform_list_cards': case 'plexiform_get_card': case 'plexiform_read_handover': result = {}; break;
        case 'plexiform_create_card': { const { board_id, ...data } = body; result = await this.api.createCard(member, board_id, data, { remote }); break; }
        case 'plexiform_update_card': { const { card_id, ...data } = body; result = await this.api.patchCard(member, card_id, data, { remote }); break; }
        case 'plexiform_add_comment': result = await this.api.comment(member, args.card_id, { body: args.body, for_agent: false }, { remote }); break;
        case 'plexiform_read_packet': result = await this.communication.staffReadPacket(member, args.card_id, {}, null, { remote }); break;
        case 'plexiform_write_packet': { const { card_id, ...data } = args; result = await this.communication.staffWritePacket(member, card_id, data, null, { remote }); break; }
        case 'plexiform_list_messages': result = await this.communication.staffListMessages(member, args.card_id, null, { remote }); break;
        case 'plexiform_send_message': { const { card_id, ...data } = args; result = await this.communication.staffSendMessage(member, card_id, data, null, { remote }); break; }
        default: throw invalid();
      }
      const current = authorize(false);
      return definition.read ? this.projectRead(name, args, result, current) : this.projectMutation(name, args, result, current);
    };
    if (definition.read) return execute();
    // Do not wrap already queued API/033 methods in another board queue. Only
    // the actor/request retry gate is serialised here; authority is reread
    // after the wait and by the ordinary queue before replay and writes.
    if (this.pendingCount >= 128) throw new HubError('RATE_LIMITED', 'too many pending remote operations');
    this.pendingCount++;
    const key = `${bound.grant}:${args.request_id}`, previous = this.pending.get(key) ?? Promise.resolve();
    const pending = previous.then(execute, execute); this.pending.set(key, pending);
    const clear = () => { this.pendingCount--; if (this.pending.get(key) === pending) this.pending.delete(key); };
    pending.then(clear, clear);
    return pending;
  }
}
