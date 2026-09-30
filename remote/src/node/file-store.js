// Node-only persistence for the desktop: the device registry file, the
// desktop identity key, an audit log, and a pending-request store over the
// widget's existing requests directory (~/.claude-traffic-light/requests).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createIdentity, identityFromJwk } from '../keys.js';
import { hashToolInput } from '../canonical.js';

// The widget's answer protocol (random ids, link-based first-wins, hook ack).
const Answer = createRequire(import.meta.url)('../../../hooks/answer-file.js');

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

// {load, save} for DeviceRegistry: atomic rename, 0600, dir 0700.
export function fileStorage(file) {
  return {
    async load() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        if (e.code === 'ENOENT') return null;
        // A corrupt registry must not silently become "no devices, re-pair":
        // it fails loudly so nobody mistakes it for a revoke.
        throw new Error(`device registry unreadable: ${file}: ${e.message}`);
      }
    },
    async save(data) { writePrivate(file, JSON.stringify(data, null, 2)); },
  };
}

export async function loadOrCreateIdentity(file) {
  try {
    return await identityFromJwk(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const id = await createIdentity();
  writePrivate(file, JSON.stringify(id.jwk));
  return id;
}

// Append-only JSONL, 0600. Events carry the tool input's hash, never the input.
export function jsonlAudit(file) {
  return (event) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(event) + '\n', { mode: 0o600 });
  };
}

// Where RemoteApprovals should continue the audit hash chain after a restart.
export function readAuditHead(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  const last = text.trimEnd().split('\n').pop();
  try { const e = JSON.parse(last); return typeof e.hash === 'string' ? { head: e.hash, seq: e.seq } : undefined; } catch { return undefined; }
}

// Pending requests as the PermissionRequest hook (hooks/set-status.js) writes
// them: <requestsDir>/<id>.json with the full `toolInput` and its hash. A
// request without them is never answerable remotely (get → null).
//
// settle() goes through hooks/answer-file.js: the answer is created exactly
// once (link, EEXIST = someone else won), carries a mac under the request's
// key (keyFor: the app's in-memory requestKeys; without one nothing can be
// answered), and counts as applied only after the hook renames it to
// <id>.taken.
export class WidgetRequestStore {
  // maxAgeMs stays under the hook's own wait (CLAUDE_TRAFFIC_LIGHT_ASK_MS,
  // default 55 s) so a phone rarely races the hook's deadline; the ack makes
  // that race safe anyway.
  constructor({ requestsDir, ownerId, describe = () => ({}), keyFor = () => null, maxAgeMs = 45000, ackTimeoutMs = 1500, clock = () => Date.now() }) {
    Object.assign(this, { requestsDir, ownerId, describe, keyFor, maxAgeMs, ackTimeoutMs, clock });
  }

  async get(requestId) {
    const p = Answer.paths(this.requestsDir, requestId);
    if (!p || fs.existsSync(p.ans)) return null;
    let r;
    try { r = JSON.parse(fs.readFileSync(p.req, 'utf8')); } catch { return null; }
    if (!r || r.id !== requestId || !r.toolInput || typeof r.toolInput !== 'object' || typeof r.toolInputHash !== 'string') return null;
    // A phone answers allow/deny only: tool permissions and plans. A question
    // needs its answers and an MCP elicitation its action, so neither is
    // offered remotely (hooks/pending-input.js).
    if (r.kind !== undefined && r.kind !== 'permission' && r.kind !== 'plan') return null;
    const t = Date.parse(r.createdAt);
    const now = this.clock();
    if (!Number.isFinite(t) || now - t > this.maxAgeMs || t > now + 5000) return null;
    try { if ((await hashToolInput(r.toolInput)) !== r.toolInputHash) return null; } catch { return null; }
    // The whole request (kind, tool, suggestions) must still be what the hook wrote.
    if (!Answer.requestIntact(r)) return null;
    // describe() adds what only the desktop knows (cardId, runner, assignees,
    // repo labels); it can never replace the input, owner or identity fields.
    return {
      cardId: null,
      ...this.describe(r),
      requestId, sessionId: r.sessionId, toolName: r.tool, toolInput: r.toolInput,
      cwd: r.cwd, ownerId: this.ownerId, createdAt: r.createdAt,
    };
  }

  async settle(requestId, decision) {
    const w = Answer.writeAnswer(this.requestsDir, requestId, decision, { by: 'remote', ack: true, key: this.keyFor(requestId) });
    if (!w.ok) return 'already-answered';
    const taken = await Answer.awaitTaken(this.requestsDir, requestId, w.nonce, { timeoutMs: this.ackTimeoutMs });
    return taken === 'applied' ? 'applied' : taken === 'refused' ? 'refused' : taken === 'lost' ? 'already-answered' : 'unconfirmed';
  }
}
