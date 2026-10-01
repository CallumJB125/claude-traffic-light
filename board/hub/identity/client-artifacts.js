// Exact stored deliverables; client approval cannot dispatch any work.
import { randomUUID } from 'node:crypto';
import { constants, mkdirSync, lstatSync, openSync, writeFileSync, readFileSync, closeSync, fstatSync, fsyncSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { HubError } from '../db.js';
import { sha256hex } from '../auth.js';
import { can } from '../permissions.js';
import { clientOnly as only, clientText as text, clientMissing as missing } from './clients.js';

export const CLIENT_FILE_MAX = 8 * 1024 * 1024;
export const CLIENT_UPLOAD_BODY_MAX = Math.ceil(CLIENT_FILE_MAX / 3) * 4 + 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIME_EXT = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt' });
const conflict = (message) => new HubError('CONFLICT', message);

function bytesFor(body) {
  only(body, ['request_id', 'name', 'mime', 'data_base64']);
  const request_id = text(body.request_id, 100, true), name = text(body.name, 200, true);
  if (/[\\/\p{C}]/u.test(name) || !MIME_EXT[body.mime]) throw new HubError('VALIDATION', 'choose a PNG, JPEG, WebP, PDF or plain text file');
  const ext = name.split('.').at(-1).toLowerCase();
  if (ext !== MIME_EXT[body.mime] && !(body.mime === 'image/jpeg' && ext === 'jpeg')) throw new HubError('VALIDATION', 'file extension must match its type');
  const b64 = body.data_base64;
  if (typeof b64 !== 'string' || !b64.length || b64.length > Math.ceil(CLIENT_FILE_MAX / 3) * 4) throw new HubError('PAYLOAD_TOO_LARGE', 'deliverable must be 1 byte to 8 MiB');
  if (b64.length % 4 || /[^A-Za-z0-9+/=]/.test(b64)) throw new HubError('VALIDATION', 'invalid file encoding');
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > CLIENT_FILE_MAX) throw new HubError('PAYLOAD_TOO_LARGE', 'deliverable must be 1 byte to 8 MiB');
  if (!bytes.length || bytes.toString('base64') !== b64) throw new HubError('VALIDATION', 'invalid file encoding');
  let valid = false;
  if (body.mime === 'image/png') valid = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.subarray(12, 16).toString('ascii') === 'IHDR';
  if (body.mime === 'image/jpeg') valid = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  if (body.mime === 'image/webp') valid = bytes.length >= 16 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.subarray(12, 16).toString('ascii'));
  if (body.mime === 'application/pdf') valid = bytes.subarray(0, 5).toString('ascii') === '%PDF-' && bytes.subarray(-1024).toString('latin1').includes('%%EOF');
  if (body.mime === 'text/plain') { try { const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); valid = !/[\p{C}&&[^\n\r\t]]/v.test(decoded); } catch { /* not UTF-8 text */ } }
  if (!valid) throw new HubError('VALIDATION', 'file contents do not match its declared type');
  return { bytes, request_id, name, mime: body.mime, hash: sha256hex(bytes) };
}

export class ClientArtifacts {
  constructor(hub) {
    this.hub = hub; this.db = hub.db; this.clients = hub.clients; this.dir = join(hub.config.dataDir, 'client-artifacts');
    // A crash between the exclusive file write and SQLite commit may leave
    // an orphan. It cannot consume uncounted storage across restarts.
    if (existsSync(this.dir)) {
      const info = lstatSync(this.dir); if (!info.isDirectory() || info.isSymbolicLink()) throw conflict('deliverable storage directory is unavailable');
      for (const name of readdirSync(this.dir)) {
        const id = name.slice(0, -4);
        if (name.endsWith('.bin') && UUID.test(id) && !this.db.get('SELECT 1 x FROM client_artifact_versions WHERE id = ?', id)) rmSync(join(this.dir, name), { force: true });
      }
    }
  }
  now() { return this.hub.iso(); }
  credential(cred) { if (cred && !this.hub.accounts.credValid(cred)) throw new HubError('UNAUTHENTICATED', 'sign in again'); }
  item(id) { return this.db.get('SELECT i.*, p.workspace_id, p.board_id FROM client_items i JOIN client_projects p ON p.id = i.project_id WHERE i.id = ?', id); }
  staff(member, id, cred, write = false) {
    this.clients.staff(member, 'team.settings', cred);
    const item = this.item(id); if (!item || item.workspace_id !== member.org_id || item.unpublished_at) throw missing();
    if (write && this.hub.board(item.board_id)?.archived_at) throw new HubError('CONFLICT', 'board is archived', { reason: 'BOARD_ARCHIVED' });
    return item;
  }
  access(user, id, scope = 'artifacts.read', cred = null) {
    this.credential(cred);
    const item = this.item(id); if (!item || item.unpublished_at) throw missing();
    const allowed = this.clients.projects(user, item.workspace_id).projects.find((p) => p.id === item.project_id && p.scopes.includes(scope));
    if (!allowed) throw missing(); return item;
  }
  latest(id) { return this.db.get('SELECT * FROM client_artifact_versions WHERE item_id = ? ORDER BY version_number DESC LIMIT 1', id); }
  version(itemId, id) { const v = this.db.get('SELECT * FROM client_artifact_versions WHERE id = ? AND item_id = ?', id, itemId); if (!v) throw missing(); return v; }
  view(v) { return { id: v.id, item_id: v.item_id, version_number: v.version_number, name: v.name, mime: v.mime, byte_length: v.byte_length, sha256: v.sha256, created_at: v.created_at, current: this.latest(v.item_id)?.id === v.id, content_url: `/api/client/items/${v.item_id}/artifacts/${v.id}/content` }; }
  quota(item, length) {
    const plan = this.clients.workspace(item.workspace_id).plan;
    const defaults = { workspaceBytes: plan === 'pro' ? 1024 ** 3 : 256 * 1024 ** 2, workspaceVersions: plan === 'pro' ? 2000 : 500, itemVersions: plan === 'pro' ? 200 : 50 };
    const limits = Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, Math.max(1, Math.min(v, Number.isSafeInteger(this.hub.config.clientArtifactLimits?.[k]) ? this.hub.config.clientArtifactLimits[k] : v))]));
    const total = this.db.get('SELECT COUNT(*) n, COALESCE(SUM(v.byte_length), 0) bytes FROM client_artifact_versions v JOIN client_items i ON i.id = v.item_id JOIN client_projects p ON p.id = i.project_id WHERE p.workspace_id = ?', item.workspace_id);
    const n = this.db.get('SELECT COUNT(*) n FROM client_artifact_versions WHERE item_id = ?', item.id).n;
    if (total.bytes + length > limits.workspaceBytes || total.n >= limits.workspaceVersions || n >= limits.itemVersions) throw new HubError('QUOTA_EXCEEDED', 'client deliverable storage limit reached', { resource: 'client_artifacts', ...limits });
  }
  file(id) { if (!UUID.test(id)) throw missing(); return join(this.dir, `${id}.bin`); }
  upload(member, id, body, { ip, cred = null }) {
    const initial = this.staff(member, id, cred), input = bytesFor(body);
    return this.hub.withBoard(initial.board_id, () => {
      let file = null;
      try {
        return this.hub.txn(() => {
          const item = this.staff(member, id, cred, true);
          const prev = this.db.get('SELECT * FROM client_artifact_versions WHERE created_by = ? AND request_id = ?', member.id, input.request_id);
          if (prev) {
            if (prev.item_id !== id || prev.sha256 !== input.hash || prev.name !== input.name || prev.mime !== input.mime) throw conflict('request id already belongs to another deliverable');
            return { artifact: this.view(prev) };
          }
          this.quota(item, input.bytes.length); // before a directory or file write
          const v = { id: randomUUID(), item_id: id, version_number: (this.latest(id)?.version_number ?? 0) + 1, name: input.name, mime: input.mime, byte_length: input.bytes.length, sha256: input.hash, created_by: member.id, created_at: this.now(), request_id: input.request_id };
          mkdirSync(this.dir, { recursive: true, mode: 0o700 });
          if (!lstatSync(this.dir).isDirectory() || lstatSync(this.dir).isSymbolicLink()) throw conflict('deliverable storage is unavailable');
          file = this.file(v.id);
          const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { writeFileSync(fd, input.bytes); fsyncSync(fd); } finally { closeSync(fd); }
          this.db.insert('client_artifact_versions', v);
          this.db.run('UPDATE client_approval_requests SET superseded_at = COALESCE(superseded_at, ?) WHERE item_id = ?', this.now(), id);
          this.clients.audit('client.artifact.publish', { member, target: v.id, ip });
          return { artifact: this.view(v) };
        });
      } catch (e) { if (file) rmSync(file, { force: true }); throw e; }
    });
  }
  list(user, id, cred = null) { this.access(user, id, 'artifacts.read', cred); return { artifacts: this.db.all('SELECT * FROM client_artifact_versions WHERE item_id = ? ORDER BY version_number DESC', id).map((v) => this.view(v)), approvals: this.approvals(user, id) }; }
  get(user, itemId, id, cred) { this.access(user, itemId, 'artifacts.read', cred); return { artifact: this.view(this.version(itemId, id)) }; }
  read(v) {
    let fd;
    try {
      if (lstatSync(this.dir).isSymbolicLink()) throw new Error('storage link');
      fd = openSync(this.file(v.id), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = fstatSync(fd); if (!info.isFile() || info.size !== v.byte_length || info.size > CLIENT_FILE_MAX) throw new Error('wrong bytes');
      const bytes = readFileSync(fd); if (sha256hex(bytes) !== v.sha256) throw new Error('changed bytes');
      return bytes;
    } catch { throw conflict('this exact deliverable version is unavailable; ask your team to publish it again'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  content(user, itemId, id, cred) {
    this.access(user, itemId, 'artifacts.read', cred); const v = this.version(itemId, id), bytes = this.read(v);
    this.access(user, itemId, 'artifacts.read', cred);
    return { bytes, mime: v.mime, disposition: `attachment; filename="deliverable-v${v.version_number}.${MIME_EXT[v.mime]}"; filename*=UTF-8''${encodeURIComponent(v.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}` };
  }
  guestFor(user, item, scope = 'approvals.decide') {
    const g = this.clients.liveGuest(user.id, item.workspace_id);
    const scopes = g && this.clients.grantsFor(g.id).find((p) => p.project_id === item.project_id)?.scopes;
    if (!g || !scopes?.includes(scope) || !scopes.includes('artifacts.read')) throw missing(); return g;
  }
  approvalView(user, a) {
    const item = this.access(user, a.item_id), member = this.db.get('SELECT * FROM members WHERE org_id = ? AND user_id = ? AND removed_at IS NULL', item.workspace_id, user.id);
    const staff = can(member, 'board.read'), guest = staff ? null : this.guestFor(user, item);
    const recipients = this.db.all('SELECT r.guest_id, u.display_name, d.decision, d.comment, d.decided_at FROM client_approval_recipients r JOIN client_guests g ON g.id = r.guest_id JOIN users u ON u.id = g.user_id LEFT JOIN client_approval_decisions d ON d.approval_id = r.approval_id AND d.guest_id = r.guest_id WHERE r.approval_id = ? ORDER BY r.guest_id', a.id);
    if (!staff && !recipients.some((r) => r.guest_id === guest.id)) throw missing();
    const current = this.latest(item.id)?.id === a.artifact_version_id && !a.superseded_at && !a.withdrawn_at;
    const own = guest && recipients.find((r) => r.guest_id === guest.id);
    const status = a.withdrawn_at ? 'withdrawn' : !current ? 'superseded' : staff ? recipients.some((r) => r.decision === 'reject') ? 'rejected' : recipients.every((r) => r.decision === 'approve') ? 'approved' : 'pending' : own.decision === 'approve' ? 'approved' : own.decision === 'reject' ? 'rejected' : 'pending';
    return { id: a.id, item_id: a.item_id, artifact_version_id: a.artifact_version_id, sha256: a.content_hash, version_number: this.version(item.id, a.artifact_version_id).version_number, requested_at: a.requested_at, status, current: !!current, can_decide: !!guest && !!current && !own.decision && !this.hub.board(item.board_id)?.archived_at, decisions: (staff ? recipients : [own]).map((r) => ({ name: r.display_name, decision: r.decision, comment: r.comment, decided_at: r.decided_at, ...(staff ? { guest_id: r.guest_id } : {}) })) };
  }
  approvals(user, id) {
    const rows = this.db.all('SELECT * FROM client_approval_requests WHERE item_id = ? ORDER BY requested_at DESC, id', id);
    return rows.flatMap((a) => { try { return [this.approvalView(user, a)]; } catch (e) { if (e.code === 'NOT_FOUND') return []; throw e; } });
  }
  decorate(user, items) {
    return items.map((i) => { try { this.access(user, i.id); const v = this.latest(i.id); return { ...i, artifact: v ? this.view(v) : null, approvals: this.approvals(user, i.id) }; } catch (e) { if (e.code === 'NOT_FOUND') return i; throw e; } });
  }
  request(member, id, body, { ip, cred = null }) {
    only(body, ['request_id', 'artifact_version_id', 'guest_ids']);
    const key = text(body.request_id, 100, true), initial = this.staff(member, id, cred);
    if (!Array.isArray(body.guest_ids) || !body.guest_ids.length || body.guest_ids.length > 25 || body.guest_ids.some((g) => typeof g !== 'string') || new Set(body.guest_ids).size !== body.guest_ids.length) throw new HubError('VALIDATION', 'choose 1–25 clients for this approval');
    return this.hub.withBoard(initial.board_id, () => this.hub.txn(() => {
      const item = this.staff(member, id, cred, true), v = this.version(id, body.artifact_version_id);
      if (this.latest(id)?.id !== v.id) throw conflict('request approval for the current deliverable version');
      this.read(v); // A request is never made for missing or modified bytes.
      for (const guestId of body.guest_ids) {
        const g = this.db.get('SELECT * FROM client_guests WHERE id = ? AND workspace_id = ?', guestId, member.org_id);
        if (!g || this.guestFor({ id: g.user_id }, item).id !== guestId) throw missing();
      }
      const prev = this.db.get('SELECT * FROM client_approval_requests WHERE requested_by = ? AND request_id = ?', member.id, key);
      if (prev) {
        const gs = this.db.all('SELECT guest_id FROM client_approval_recipients WHERE approval_id = ? ORDER BY guest_id', prev.id).map((g) => g.guest_id);
        if (prev.item_id !== id || prev.artifact_version_id !== v.id || JSON.stringify(gs) !== JSON.stringify([...body.guest_ids].sort())) throw conflict('request id already belongs to another approval');
        return { approval: this.approvalView({ id: member.user_id }, prev) };
      }
      if (this.db.get('SELECT COUNT(*) n FROM client_approval_requests WHERE item_id = ?', id).n >= 200) throw new HubError('QUOTA_EXCEEDED', 'client approval history limit reached', { resource: 'client_approvals', limit: 200 });
      const a = { id: randomUUID(), item_id: id, artifact_version_id: v.id, content_hash: v.sha256, requested_by: member.id, requested_at: this.now(), request_id: key };
      this.db.insert('client_approval_requests', a);
      for (const g of body.guest_ids) this.db.insert('client_approval_recipients', { approval_id: a.id, guest_id: g });
      this.clients.audit('client.approval.request', { member, target: a.id, ip });
      return { approval: this.approvalView({ id: member.user_id }, a) };
    }));
  }
  approval(user, id, cred) { this.credential(cred); const a = this.db.get('SELECT * FROM client_approval_requests WHERE id = ?', id); if (!a) throw missing(); return { approval: this.approvalView(user, a) }; }
  decide(user, id, body, { ip, cred = null }) {
    only(body, ['request_id', 'decision', 'comment', 'artifact_version_id', 'sha256']);
    const a = this.db.get('SELECT * FROM client_approval_requests WHERE id = ?', id); if (!a) throw missing();
    const initial = this.access(user, a.item_id, 'approvals.decide', cred), assigned = this.guestFor(user, initial);
    if (!this.db.get('SELECT 1 x FROM client_approval_recipients WHERE approval_id = ? AND guest_id = ?', id, assigned.id)) throw missing();
    if (!['approve', 'reject'].includes(body.decision)) throw new HubError('VALIDATION', 'choose approve or reject');
    const comment = text(body.comment, 1000);
    return this.hub.withBoard(initial.board_id, () => this.hub.txn(() => {
      const item = this.access(user, a.item_id, 'approvals.decide', cred), g = this.guestFor(user, item);
      if (!this.db.get('SELECT 1 x FROM client_approval_recipients WHERE approval_id = ? AND guest_id = ?', id, g.id)) throw missing();
      if (this.hub.board(item.board_id)?.archived_at) throw new HubError('CONFLICT', 'board is archived', { reason: 'BOARD_ARCHIVED' });
      const live = this.db.get('SELECT * FROM client_approval_requests WHERE id = ?', id), v = this.version(item.id, live.artifact_version_id);
      if (live.superseded_at || live.withdrawn_at || this.latest(item.id)?.id !== v.id || live.content_hash !== v.sha256 || body.artifact_version_id !== v.id || body.sha256 !== v.sha256) throw conflict('this approval is for an older or withdrawn deliverable; refresh the project');
      this.read(v);
      const prev = this.db.get('SELECT * FROM client_approval_decisions WHERE approval_id = ? AND guest_id = ?', id, g.id);
      if (prev) { if (prev.decision !== body.decision || prev.comment !== comment) throw conflict('this client already decided this exact version'); return { approval: this.approvalView(user, live) }; }
      this.db.insert('client_approval_decisions', { approval_id: id, guest_id: g.id, decision: body.decision, comment, decided_at: this.now() });
      this.clients.audit('client.approval.decide', { user, workspace: item.workspace_id, target: id, ip });
      return { approval: this.approvalView(user, live) };
    }));
  }
  withdraw(member, id, { ip, cred = null }) {
    const a = this.db.get('SELECT * FROM client_approval_requests WHERE id = ?', id); if (!a) throw missing(); const initial = this.staff(member, a.item_id, cred);
    return this.hub.withBoard(initial.board_id, () => this.hub.txn(() => { this.staff(member, a.item_id, cred, true); this.db.run('UPDATE client_approval_requests SET withdrawn_at = COALESCE(withdrawn_at, ?) WHERE id = ?', this.now(), id); this.clients.audit('client.approval.withdraw', { member, target: id, ip }); return { ok: true }; }));
  }
}
