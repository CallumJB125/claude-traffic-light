'use strict';
// FAKE stand-in for Codex's shared app-server daemon control socket: a
// WebSocket server on a private Unix socket (0600, in a 0700 directory) behind
// a rendezvous symlink, following codex-cli 0.159.2's generated schema shapes.
// It is deliberately hostile: thread metadata carries a `preview`, resume
// returns turns even when asked not to, other clients' turns stream to every
// connection, and approvals are broadcast. Integration-test only; it is not
// proof of the real provider.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const SECRET = 'SECRET-TRANSCRIPT';

async function startFakeDaemon({ socketMode = 0o600 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdx-'));
  fs.chmodSync(dir, 0o700);
  const real = path.join(dir, 's.sock');
  fs.mkdirSync(path.join(dir, 'app-server-control'), { mode: 0o700 });
  const socketPath = path.join(dir, 'app-server-control', 'app-server-control.sock');
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const calls = [], responses = [], clients = new Set();
  const threads = new Map();
  let connections = 0, requestSeq = 9000;
  const all = (m) => { for (const c of clients) c.send(JSON.stringify(m)); };
  const note = (method, params) => all({ method, params });
  const addThread = (over = {}) => {
    const id = over.id ?? crypto.randomUUID();
    threads.set(id, { id, name: 'Fix the build', cwd: '/Users/me/projects/app', preview: `${SECRET} first prompt`, path: `/Users/me/.codex/sessions/${id}.jsonl`, gitInfo: { branch: 'secret-branch' }, source: 'cli', ephemeral: false, status: { type: 'idle' }, updatedAt: 1700000000, loaded: true, active: null, approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: ['/Users/me/projects/app'] }, ...over });
    return id;
  };
  function reply(threadId, turnId, itemId, textOut) {
    note('item/started', { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: '' } });
    note('item/agentMessage/delta', { threadId, turnId, itemId, delta: textOut.slice(0, 3) });
    note('item/agentMessage/delta', { threadId, turnId, itemId, delta: textOut.slice(3) });
    note('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: textOut } });
  }
  function complete(threadId, turnId, status = 'completed') {
    const t = threads.get(threadId);
    if (t) { t.active = null; t.status = { type: 'idle' }; }
    note('turn/completed', { threadId, turn: { id: turnId, status, items: [] } });
    note('thread/status/changed', { threadId, status: { type: 'idle' } });
  }
  function startTurn(threadId) {
    const t = threads.get(threadId), turnId = crypto.randomUUID();
    t.active = turnId; t.status = { type: 'active', activeFlags: [] };
    note('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
    note('thread/status/changed', { threadId, status: t.status });
    return turnId;
  }
  const handlers = {
    initialize: () => ({ userAgent: 'fake' }),
    'thread/loaded/list': () => ({ data: [...threads.values()].filter((t) => t.loaded).map((t) => t.id), nextCursor: null }),
    'thread/list': () => ({ data: [...threads.values()].map(({ loaded, active, approvalPolicy, sandbox, ...t }) => ({ ...t, turns: [] })), nextCursor: null }),
    'thread/resume': (p) => {
      const t = threads.get(p.threadId);
      if (!t || !t.loaded) throw new Error('no such thread');
      const { loaded, active, approvalPolicy, sandbox, ...thread } = t;
      return { thread: { ...thread, turns: [{ id: 'old', items: [{ type: 'userMessage', content: [{ type: 'text', text: `${SECRET} old turn` }] }] }] }, model: 'x', cwd: t.cwd, approvalPolicy, sandbox };
    },
    'turn/start': (p) => {
      const t = threads.get(p.threadId);
      if (!t || !t.loaded) throw new Error('no such thread');
      if (t.active) throw new Error('thread busy');
      const turnId = startTurn(p.threadId), text = p.input?.[0]?.text ?? '';
      setImmediate(() => {
        note('item/completed', { threadId: p.threadId, turnId, item: { type: 'userMessage', id: 'u', clientId: p.clientUserMessageId, content: p.input } });
        if (text === 'HOLD') return;
        reply(p.threadId, turnId, 'a', `echo:${text}`);
        complete(p.threadId, turnId);
      });
      return { turn: { id: turnId, status: 'inProgress', items: [] } };
    },
    'turn/steer': (p) => {
      const t = threads.get(p.threadId);
      if (!t || t.active !== p.expectedTurnId) throw new Error('expectedTurnId does not match the active turn');
      const text = p.input?.[0]?.text ?? '';
      setImmediate(() => {
        note('item/completed', { threadId: p.threadId, turnId: p.expectedTurnId, item: { type: 'userMessage', id: 's', clientId: p.clientUserMessageId, content: p.input } });
        reply(p.threadId, p.expectedTurnId, 'steer-item', `steered:${text}`);
        complete(p.threadId, p.expectedTurnId);
      });
      return { turnId: p.expectedTurnId };
    },
    'turn/interrupt': (p) => { const t = threads.get(p.threadId); if (t?.active === p.turnId) setImmediate(() => complete(p.threadId, p.turnId, 'interrupted')); return {}; },
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
    'thread/read': (p) => ({ thread: { ...threads.get(p.threadId), turns: [{ items: [{ type: 'agentMessage', text: SECRET }] }] } }),
  };
  wss.on('connection', (ws) => {
    connections++; clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (!Object.hasOwn(m, 'method')) { responses.push(m); return; }
      calls.push({ method: m.method, params: m.params });
      if (!Object.hasOwn(m, 'id')) return;
      const h = handlers[m.method];
      try {
        if (!h) throw new Error('unknown method');
        const result = h(m.params ?? {});
        ws.send(JSON.stringify({ id: m.id, result }));
        if (fake.duplicateResponses) ws.send(JSON.stringify({ id: m.id, result: { turn: { id: 'forged-duplicate' }, turnId: 'forged-duplicate' } }));
      } catch (e) { ws.send(JSON.stringify({ id: m.id, error: { code: -32600, message: e.message } })); }
    });
  });
  await new Promise((resolve) => server.listen(real, resolve));
  fs.chmodSync(real, socketMode);
  fs.symlinkSync(real, socketPath);
  const fake = {
    socketPath, realPath: real, calls, responses, threads, addThread, duplicateResponses: false,
    get connections() { return connections; },
    // The human's own turn in their terminal: other clients see it stream.
    foreignTurn(threadId) {
      const turnId = startTurn(threadId);
      note('item/completed', { threadId, turnId, item: { type: 'userMessage', id: 'h', content: [{ type: 'text', text: `${SECRET} human prompt` }] } });
      reply(threadId, turnId, 'h-a', `${SECRET} reply to the human`);
      return turnId;
    },
    finish: (threadId, turnId) => complete(threadId, turnId),
    approval(threadId, turnId) { const id = ++requestSeq; all({ id, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'cmd', command: `${SECRET} rm -rf` } }); return id; },
    note,
    dropAll() { for (const c of clients) c.terminate(); },
    async close() { for (const c of clients) c.terminate(); await new Promise((r) => wss.close(() => server.close(() => r()))); fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return fake;
}

module.exports = { startFakeDaemon, SECRET };
