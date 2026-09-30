// Node-only persistence for the desktop: the device registry file, the
// desktop identity key, an audit log, and a pending-request store over the
// widget's existing requests directory (~/.claude-traffic-light/requests).
import fs from 'node:fs';
import path from 'node:path';
import { createIdentity, identityFromJwk } from '../keys.js';

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

// Pending requests as the PermissionRequest hook (hooks/set-status.js) writes
// them: <requestsDir>/<id>.json, answered by <id>.answer. The hook must also
// record the full `toolInput` — a request without it can't be hash-checked,
// so it is never answerable remotely (get → null).
//
// settle() creates the answer file with O_EXCL ('wx'): of several remote
// answers exactly one wins. The desk path must use 'wx' as well for the
// desk-vs-phone race to be first-wins too (see THREAT_MODEL.md).
export class WidgetRequestStore {
  constructor({ requestsDir, ownerId, describe = () => ({}), maxAgeMs = 90000, clock = () => Date.now() }) {
    Object.assign(this, { requestsDir, ownerId, describe, maxAgeMs, clock });
  }

  #paths(id) {
    if (typeof id !== 'string' || !/^[\w.-]{1,200}$/.test(id) || id.startsWith('.')) return null;
    return { req: path.join(this.requestsDir, `${id}.json`), ans: path.join(this.requestsDir, `${id}.answer`) };
  }

  async get(requestId) {
    const p = this.#paths(requestId);
    if (!p || fs.existsSync(p.ans)) return null;
    let r;
    try { r = JSON.parse(fs.readFileSync(p.req, 'utf8')); } catch { return null; }
    if (!r || r.id !== requestId || !r.toolInput || typeof r.toolInput !== 'object') return null;
    if (this.clock() - Date.parse(r.createdAt) > this.maxAgeMs) return null;
    // describe() adds what only the desktop knows: cardId, runner, assignees, repo labels.
    return {
      requestId, sessionId: r.sessionId, cardId: null, toolName: r.tool, toolInput: r.toolInput,
      cwd: r.cwd, ownerId: this.ownerId, createdAt: r.createdAt,
      ...this.describe(r),
    };
  }

  async settle(requestId, decision) {
    const p = this.#paths(requestId);
    if (!p || !fs.existsSync(p.req)) return false;
    try { fs.writeFileSync(p.ans, decision, { flag: 'wx' }); return true; } catch { return false; }
  }
}
