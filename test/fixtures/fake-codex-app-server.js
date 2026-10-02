#!/usr/bin/env node
'use strict';
// FAKE local stand-in for `codex app-server` (stdio JSON-RPC), following the
// wire shapes of codex-cli 0.159.2's generated schema. Integration-test only;
// it is not proof of the real provider.
const crypto = require('node:crypto');
const threads = new Map();
let initialized = false;
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const note = (method, params) => out({ method, params });
function finish(threadId, turnId, reply) {
  const t = threads.get(threadId);
  note('item/agentMessage/delta', { threadId, turnId, itemId: 'a', delta: reply.slice(0, 3) });
  note('item/agentMessage/delta', { threadId, turnId, itemId: 'a', delta: reply.slice(3) });
  note('item/completed', { threadId, turnId, completedAtMs: Date.now(), item: { type: 'agentMessage', id: 'a', text: reply } });
  note('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
  t.active = null;
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const m = JSON.parse(line);
    const p = m.params ?? {};
    if (m.method === 'initialize') { out({ id: m.id, result: { userAgent: 'fake', codexHome: '/nonexistent', platformFamily: 'unix', platformOs: 'macos' } }); continue; }
    if (m.method === 'initialized') { initialized = true; continue; }
    if (!initialized) { out({ id: m.id, error: { code: -32002, message: 'not initialized' } }); continue; }
    if (m.method === 'thread/start') {
      const id = crypto.randomUUID(); threads.set(id, { active: null, inputs: [] });
      out({ id: m.id, result: { thread: { id }, cwd: p.cwd, model: 'fake', modelProvider: 'fake', approvalPolicy: p.approvalPolicy, approvalsReviewer: 'user', sandbox: { type: 'readOnly' } } });
      continue;
    }
    const t = threads.get(p.threadId);
    if (!t) { out({ id: m.id, error: { code: -32600, message: 'thread not found' } }); continue; }
    const text = (p.input ?? []).map((i) => i.text).join('');
    if (m.method === 'turn/start') {
      if (t.active) { out({ id: m.id, error: { code: -32600, message: 'turn already active' } }); continue; }
      const turnId = crypto.randomUUID(); t.active = turnId;
      // Notification before the response, as a real server may interleave.
      note('turn/started', { threadId: p.threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
      out({ id: m.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
      note('item/completed', { threadId: p.threadId, turnId, completedAtMs: Date.now(), item: { type: 'userMessage', id: 'u', clientId: p.clientUserMessageId ?? null, content: p.input } });
      if (text.includes('APPROVAL')) out({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: p.threadId, turnId, itemId: 'c' } });
      if (!text.includes('HOLD')) finish(p.threadId, turnId, `echo:${text}`);
    } else if (m.method === 'turn/steer') {
      if (!t.active || t.active !== p.expectedTurnId) { out({ id: m.id, error: { code: -32600, message: 'expected turn mismatch' } }); continue; }
      out({ id: m.id, result: { turnId: t.active } });
      note('item/completed', { threadId: p.threadId, turnId: t.active, completedAtMs: Date.now(), item: { type: 'userMessage', id: 'u2', clientId: p.clientUserMessageId ?? null, content: p.input } });
      finish(p.threadId, t.active, `steered:${text}`);
    } else if (m.method === 'turn/interrupt') {
      out({ id: m.id, result: {} });
      note('turn/completed', { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted', items: [] } });
      t.active = null;
    } else if (m.method === 'thread/unsubscribe') {
      threads.delete(p.threadId); out({ id: m.id, result: { status: 'unsubscribed' } });
    } else out({ id: m.id, error: { code: -32601, message: 'unknown method' } });
  }
});
process.stdin.on('end', () => process.exit(0));
