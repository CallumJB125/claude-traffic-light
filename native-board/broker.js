'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http'); // privacy-flow: local-mcp
const { callTool } = require('./tools');

const TARGETS = ['codex', 'claude-code', 'claude-desktop'];
const ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const LIMIT = 48 * 1024;
const digest = (v) => crypto.createHash('sha256').update(v).digest();

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || (process.getuid && s.uid !== process.getuid())) throw new Error('Unsafe connector directory.');
  if (process.platform !== 'win32' && (s.mode & 0o077)) throw new Error('Connector directory must be private.');
}
function atomic(file, value) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, value); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
}

function createBroker({ dir, seal, unseal, resolveWorkspace }) {
  privateDir(dir);
  const socketDir = path.join(os.tmpdir(), `plexiform-board-${digest(dir).toString('hex').slice(0, 16)}`);
  if (process.platform !== 'win32') privateDir(socketDir);
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\plexiform-board-${digest(dir).toString('hex').slice(0, 16)}` : path.join(socketDir, 'bridge.sock');
  const recordsPath = path.join(dir, 'connections.bin');
  let grants = new Map();
  let server = null;
  let inFlight = 0;
  const sockets = new Set();
  const grantPath = (target) => { if (!TARGETS.includes(target)) throw new Error('Unknown app.'); return path.join(dir, `${target}.json`); };
  function save() { atomic(recordsPath, seal(JSON.stringify([...grants.values()].map(({ token, ...g }) => g)))); }
  function publish(g) { atomic(grantPath(g.target), JSON.stringify({ version: 1, socketPath, token: g.token, mode: g.mode }) + '\n'); }
  function safeRecord(g) {
    return g && TARGETS.includes(g.target) && ['read', 'collaborate'].includes(g.mode) && typeof g.workspaceId === 'string' && g.workspaceId.length <= 350 && typeof g.userId === 'string' && g.userId.length <= 100 && Array.isArray(g.boardIds) && g.boardIds.length > 0 && g.boardIds.length <= 32 && g.boardIds.every((id) => typeof id === 'string' && ID_RE.test(id));
  }
  try {
    const records = JSON.parse(unseal(fs.readFileSync(recordsPath)));
    if (!Array.isArray(records)) throw new Error('Invalid connector records.');
    for (const g of records) {
      if (!safeRecord(g) || grants.has(g.target)) throw new Error('Invalid connector records.');
      grants.set(g.target, { ...g, token: crypto.randomBytes(32).toString('hex') });
    }
  } catch (err) { if (err.code !== 'ENOENT') throw new Error('Connector permissions could not be read securely. Reconnect the apps.'); }
  const view = (g) => ({ target: g.target, workspaceId: g.workspaceId, boardIds: [...g.boardIds], mode: g.mode });
  const authorized = (token) => {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const d = digest(token);
    return [...grants.values()].find((g) => crypto.timingSafeEqual(d, digest(g.token))) ?? null;
  };
  async function dispatch(token, request) {
    const g = authorized(token);
    if (!g) return { ok: false, code: 'UNAUTHENTICATED', error: 'Connection removed. Reconnect it in Plexiform.' };
    const ctx = await resolveWorkspace(g.workspaceId);
    if (!ctx || ctx.userId !== g.userId) return { ok: false, code: 'UNAUTHENTICATED', error: 'Sign in with the account that connected this app.' };
    const r = await callTool({ grant: g, ...ctx }, request.name, request.args ?? {});
    // A sign-out or Undo while a read was in flight must not return its data.
    const current = await resolveWorkspace(g.workspaceId);
    if (grants.get(g.target) !== g || current?.userId !== g.userId) return { ok: false, code: 'UNAUTHENTICATED', error: 'Connection removed or account changed.' };
    return r;
  }
  async function start() {
    if (server) return;
    // Never unlink a path owned by another process. The app's single-instance
    // lock is held before start; a stale socket is the only allowed leftover.
    if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
      const s = fs.lstatSync(socketPath);
      if (!s.isSocket() || (process.getuid && s.uid !== process.getuid())) throw new Error('Unsafe connector socket.');
      fs.unlinkSync(socketPath);
    }
    server = http.createServer(async (req, res) => {
      const reply = (status, body) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' }); res.end(JSON.stringify(body)); } };
      if (req.method !== 'POST' || req.url !== '/call') { reply(404, { ok: false }); return; }
      const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!authorized(token)) { reply(401, { ok: false, code: 'UNAUTHENTICATED' }); return; }
      if (inFlight >= 8) { reply(429, { ok: false, code: 'BUSY', error: 'Try again shortly.' }); return; }
      inFlight += 1;
      try {
        const chunks = []; let n = 0;
        for await (const chunk of req) { n += chunk.length; if (n > LIMIT) { reply(413, { ok: false, code: 'TOO_LARGE' }); req.destroy(); return; } chunks.push(chunk); }
        let r;
        try { r = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, { ok: false, code: 'VALIDATION' }); return; }
        if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some((k) => !['name', 'args'].includes(k))) { reply(400, { ok: false, code: 'VALIDATION' }); return; }
        reply(200, await dispatch(token, r));
      } catch { reply(400, { ok: false, code: 'VALIDATION', error: 'The board request could not be completed.' }); }
      finally { inFlight -= 1; }
    });
    server.requestTimeout = 20000; server.headersTimeout = 5000; server.timeout = 20000;
    server.on('connection', (s) => { if (sockets.size >= 16) { s.destroy(); return; } sockets.add(s); s.on('close', () => sockets.delete(s)); });
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); }); }); }
    catch (e) { server = null; throw e; }
    if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
    for (const g of grants.values()) publish(g);
  }
  return {
    start, grantPath, status: () => [...grants.values()].map(view),
    async connect({ target, workspaceId, boardIds, mode }) {
      const ctx = await resolveWorkspace(workspaceId);
      const g = { target, workspaceId, boardIds: [...new Set(boardIds ?? [])], mode, userId: ctx?.userId, token: crypto.randomBytes(32).toString('hex') };
      if (!safeRecord(g) || !ctx) throw new Error('Choose a signed-in workspace and its boards.');
      const team = await ctx.client.me();
      if (!team.ok) throw new Error(team.error || 'Team is unavailable.');
      const boards = team.teams?.find((t) => t.id === ctx.workspace.teamId)?.boards ?? [];
      const role = team.teams?.find((t) => t.id === ctx.workspace.teamId)?.role;
      if (g.mode === 'collaborate' && !['owner', 'admin', 'member'].includes(role)) throw new Error('Your role in this team can only read boards.');
      if (g.boardIds.some((id) => !boards.some((b) => b.id === id))) throw new Error('Choose boards belonging to this workspace.');
      const prior = grants.get(target);
      grants.set(target, g);
      try { save(); publish(g); } catch (err) { if (prior) grants.set(target, prior); else grants.delete(target); save(); throw err; }
      return view(g);
    },
    revoke(target) {
      grantPath(target);
      const g = grants.get(target);
      grants.delete(target);
      try { save(); } catch (err) { if (g) grants.set(target, g); throw err; }
      fs.rmSync(grantPath(target), { force: true });
    },
    async stop() { if (!server) return; const s = server; server = null; for (const conn of sockets) conn.destroy(); await new Promise((resolve) => s.close(resolve)); if (process.platform !== 'win32') fs.rmSync(socketPath, { force: true }); },
    // Explicit test seam; it is never sent to a renderer or MCP client.
    dispatch,
  };
}
module.exports = { createBroker, TARGETS, privateDir };
