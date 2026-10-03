'use strict';
// Main-only capability broker for terminal Claude Code sessions which explicitly
// load Plexiform's MCP channel. A transport write is NEVER a provider receipt.
const http = require('node:http'); // privacy-flow: claude-terminal-channel
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const closed = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
const text = (v, max) => typeof v === 'string' && v.length > 0 && !v.includes('\0') && Buffer.byteLength(v) <= max;
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const unavailable = () => new Error('Claude terminal channel is unavailable; reconnect it in that terminal.');
const unconfirmed = () => Object.assign(new Error('No channel receipt was confirmed. Claude may still act; do not resend automatically.'), { code: 'DELIVERY_UNCONFIRMED' });

function createClaudeChannelSession({ now = Date.now, ackMs = 30_000, replyMs = 5 * 60 * 1000, leaseMs = 30_000, grantMs = 12 * 60 * 60 * 1000 } = {}) {
  const grants = new Map(), events = new EventEmitter();
  let server = null, origin = null, stopped = false;
  const emit = e => events.emit('event', e);
  function retire(g) {
    if (!grants.has(g.target)) return;
    grants.delete(g.target);
    const pending = g.pending;
    clearTimeout(pending?.timer);
    if (pending?.accepted) emit({ kind: 'turn-completed', target: g.target, turnId: pending.id, status: 'failed', error: 'The channel ended before a correlated reply. The terminal may still be working.' });
    pending?.reject(pending.written && !pending.accepted ? unconfirmed() : unavailable());
    g.pending = null;
    if (g.poll) { g.poll.end(); g.poll = null; }
    emit({ kind: 'closed', target: g.target });
  }
  const valid = g => !stopped && grants.get(g.target) === g && now() < g.cutoff && (!g.connected || now() - g.seen < leaseMs);
  function sweep() { for (const g of grants.values()) if (!valid(g)) retire(g); }
  const ticker = setInterval(sweep, 1000); ticker.unref?.();
  const reply = (res, code, value) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } };
  async function body(req) {
    if (req.headers['content-type'] !== 'application/json') throw unavailable();
    let bytes = 0, chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 20_000) throw unavailable(); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  function deliver(g) {
    if (!g.poll || !g.pending || g.pending.written) return;
    g.pending.written = true;
    const res = g.poll; g.poll = null;
    reply(res, 200, { message_id: g.pending.id, content: g.pending.text });
  }
  async function request(req, res) {
    // Reject browser callers and DNS rebinding. No CORS, query routes or redirects.
    if (!origin || req.headers.origin !== undefined || req.headers.host !== new URL(origin).host || req.socket.remoteAddress !== '127.0.0.1') return reply(res, 403, { error: 'forbidden' });
    const bearer = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '')?.[1];
    const g = bearer && [...grants.values()].find(row => equal(row.token, bearer));
    if (!g || !valid(g)) { if (g) retire(g); return reply(res, 403, { error: 'forbidden' }); }
    if (req.method === 'POST' && req.url === '/connect') {
      const value = await body(req);
      if (!valid(g)) { retire(g); return reply(res, 403, { error: 'forbidden' }); }
      if (!closed(value, ['protocol']) || value.protocol !== 1 || g.connected) return reply(res, 409, { error: 'unavailable' });
      g.connected = true; g.seen = now(); g.link = crypto.randomBytes(32).toString('hex');
      return reply(res, 200, { link: g.link });
    }
    if (!g.connected || !equal(g.link, req.headers['x-plexiform-link'])) return reply(res, 403, { error: 'forbidden' });
    g.seen = now();
    if (req.method === 'GET' && req.url === '/next') {
      if (g.poll) return reply(res, 409, { error: 'unavailable' });
      g.poll = res;
      const timer = setTimeout(() => { if (g.poll === res) { g.poll = null; reply(res, 200, null); } }, 1000);
      res.once('close', () => { clearTimeout(timer); if (g.poll === res) g.poll = null; });
      deliver(g); return;
    }
    if (req.method !== 'POST' || !['/accept', '/reply'].includes(req.url)) return reply(res, 404, { error: 'unavailable' });
    const value = await body(req), pending = g.pending;
    if (!valid(g)) { retire(g); return reply(res, 403, { error: 'forbidden' }); }
    if (!closed(value, ['message_id', 'text']) || !UUID.test(value.message_id || '') || !pending || value.message_id !== pending.id || !pending.written) return reply(res, 409, { error: 'stale' });
    if (req.url === '/accept') {
      if (pending.accepted || value.text !== pending.text) return reply(res, 409, { error: 'stale' });
      pending.accepted = true; clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        if (g.pending === pending) {
          g.pending = null;
          emit({ kind: 'turn-completed', target: g.target, turnId: pending.id, status: 'failed', error: 'Claude did not return a channel reply before its deadline. The terminal may still be working.' });
          retire(g);
        }
      }, replyMs);
      emit({ kind: 'turn-started', target: g.target, turnId: pending.id });
      emit({ kind: 'input-recorded', target: g.target, turnId: pending.id, clientId: pending.id, text: pending.text });
      pending.resolve({ turnId: pending.id, mode: 'new-turn' });
      return reply(res, 200, { ok: true });
    }
    if (!pending.accepted || !text(value.text, 16_000)) return reply(res, 409, { error: 'stale' });
    emit({ kind: 'message', target: g.target, turnId: pending.id, text: value.text });
    emit({ kind: 'turn-completed', target: g.target, turnId: pending.id, status: 'completed' });
    clearTimeout(pending.timer);
    g.pending = null;
    return reply(res, 200, { ok: true });
  }
  async function start() {
    if (origin) return origin;
    if (stopped || server) throw unavailable();
    server = http.createServer((req, res) => { request(req, res).catch(() => reply(res, 400, { error: 'invalid' })); }); // privacy-flow: claude-terminal-channel
    server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxHeadersCount = 20;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`; server.unref?.();
    return origin;
  }
  function createGrant({ cwd, title = 'Claude Code terminal' }) {
    sweep();
    if (!origin || stopped || grants.size >= 32 || typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0') || !text(title, 120)) throw unavailable();
    const target = crypto.randomUUID(), token = crypto.randomBytes(32).toString('hex');
    grants.set(target, { target, token, cwd, title, cutoff: now() + grantMs, seen: now(), connected: false, link: null, pending: null, poll: null, usedIds: new Set() });
    // This object is main-only and must be persisted by an approved private-file
    // writer. It is never renderer metadata, provider argv or a log record.
    return { target, env: { PLEXIFORM_CLAUDE_CHANNEL_ORIGIN: origin, PLEXIFORM_CLAUDE_CHANNEL_TOKEN: token } };
  }
  async function send({ target, text: content, clientId, expectedTurnId = null }) {
    const g = grants.get(target);
    if (!g || !valid(g) || !g.connected || g.pending || expectedTurnId || !UUID.test(clientId || '') || g.usedIds.has(clientId) || g.usedIds.size >= 1000 || !text(content, 8192)) throw unavailable();
    g.usedIds.add(clientId);
    return new Promise((resolve, reject) => {
      const pending = { id: clientId, text: content, resolve, reject, accepted: false, written: false };
      pending.timer = setTimeout(() => {
        if (g.pending === pending) {
          g.pending = null;
          reject(unconfirmed());
          // A written notification can still run later. Quarantine the grant,
          // rather than letting the next message silently stack onto it.
          retire(g);
        }
      }, ackMs);
      g.pending = pending; deliver(g);
    });
  }
  function stop() { stopped = true; clearInterval(ticker); for (const g of [...grants.values()]) retire(g); server?.closeAllConnections(); server?.close(); origin = null; }
  return {
    provider: 'claude-channel', label: 'Claude Code terminal channel',
    capabilities: Object.freeze({ existingSessions: true, newTurn: true, steer: false, interrupt: false, stream: false, ack: 'channel-accept-tool', echo: 'channel-accept-exact-text' }),
    precondition: 'Only terminals explicitly started with the Plexiform channel are reachable. They retain their own permissions; channel messages can run tools under those permissions.',
    start, createGrant, revoke(target) { const g = grants.get(target); if (g) retire(g); },
    discover() { sweep(); return [...grants.values()].filter(g => g.connected).map(g => ({ id: g.target, title: g.title, project: g.cwd, status: g.pending?.accepted ? 'active' : 'idle', updatedAt: g.seen })); },
    async attach({ target }) { const g = grants.get(target); if (!g || !valid(g) || !g.connected) throw unavailable(); return { target, status: g.pending?.accepted ? 'active' : 'idle', permissions: { approvalPolicy: 'unknown', sandbox: 'unknown' } }; },
    send, release({ target }) { const g = grants.get(target); if (g) retire(g); }, stop, alive: () => !!origin && !stopped,
    on(fn) { events.on('event', fn); return () => events.off('event', fn); },
  };
}
// Main-only POSIX publication. Caller supplies an already private canonical app
// directory; this never edits .mcp.json or any Claude/user/project settings.
// Windows must supply a separately reviewed native publication boundary.
function writeClaudeChannelConfig({ grant, directory, command, args, electronRunAsNode = false, platform = process.platform }) {
  if (platform === 'win32' || typeof process.getuid !== 'function' || !closed(grant, ['target', 'env']) || !UUID.test(grant.target || '') || !closed(grant.env, ['PLEXIFORM_CLAUDE_CHANNEL_ORIGIN', 'PLEXIFORM_CLAUDE_CHANNEL_TOKEN']) || !/^[0-9a-f]{64}$/.test(grant.env.PLEXIFORM_CLAUDE_CHANNEL_TOKEN || '') || !path.isAbsolute(directory || '') || fs.realpathSync(directory) !== directory || !path.isAbsolute(command || '') || !Array.isArray(args) || args.length > 4 || args.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 4096)) throw unavailable();
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw unavailable();
  const file = path.join(directory, `claude-channel-${grant.target}.json`);
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ mcpServers: { plexiform: { command, args, env: { ...grant.env, ...(electronRunAsNode === true ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } } } }) + '\n');
    fs.fsyncSync(fd);
    const opened = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (!opened.isFile() || opened.uid !== process.getuid() || (opened.mode & 0o077) || opened.nlink !== 1 || opened.dev !== named.dev || opened.ino !== named.ino || named.isSymbolicLink()) throw unavailable();
  } finally { fs.closeSync(fd); }
  const parent = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  // Only this safe recipe crosses into the UI. Capability bytes do not.
  return { file, claudeArgs: ['--mcp-config', file, '--dangerously-load-development-channels', 'server:plexiform'] };
}
module.exports = { createClaudeChannelSession, writeClaudeChannelConfig };
