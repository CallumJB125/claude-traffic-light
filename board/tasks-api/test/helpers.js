import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockServer, SCHEMA } from '../mock-server.js';
import { connect } from '../client.js';
import { validate } from '../validate.js';

export { SCHEMA };

export function tmpDir() {
  // Short base: AF_UNIX paths are capped at 104 bytes on macOS.
  return fs.mkdtempSync(path.join(os.platform() === 'darwin' ? '/tmp' : os.tmpdir(), 'bt-'));
}

export async function startMock(opts = {}) {
  const dir = opts.dir ?? tmpDir();
  const srv = await startMockServer({ dir, speed: 50, hbMs: 200, ...opts });
  const client = await connect({ socketPath: srv.socketPath, tokenPath: srv.tokenPath });
  return {
    srv, client, dir,
    async close() {
      client.close();
      await srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function assertValid(def, value, label = def) {
  const e = validate(SCHEMA, def, value);
  if (e) throw new Error(`${label} does not match ${def}: ${e.path}: ${e.message}\n${JSON.stringify(value).slice(0, 600)}`);
}

export async function waitFor(fn, { timeoutMs = 8000, stepMs = 10, label = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export async function stateOf(client, id) {
  return (await client.getTask(id)).state;
}

export function byScript(srv, script) {
  return [...srv.tasks.values()].find((t) => t.script === script);
}
