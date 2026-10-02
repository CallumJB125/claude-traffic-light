#!/usr/bin/env node
'use strict';
// FAKE ACP agent (JSON-RPC 2.0 over stdio) standing in for `gemini --acp`,
// following the Agent Client Protocol v1 docs (initialize, session/new,
// session/prompt -> stopReason, session/update agent_message_chunk,
// session/cancel, session/request_permission). Gemini CLI is NOT installed on
// the build machine: this fixture is the only thing the Gemini adapter has
// been run against. It is not proof of the real provider.
const crypto = require('node:crypto');
const sessions = new Map();
const out = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const update = (sessionId, u) => out({ method: 'session/update', params: { sessionId, update: u } });
const chunk = (sessionId, text) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
let permissionReply = null;
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  buf += data;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    const p = m.params ?? {};
    if (m.id === 900 && !m.method) { permissionReply = m; continue; }
    if (m.method === 'initialize') { out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } }); continue; }
    if (m.method === 'session/new') { const id = `sess_${crypto.randomUUID()}`; sessions.set(id, { prompt: null }); out({ id: m.id, result: { sessionId: id } }); continue; }
    if (m.method === 'session/cancel') {
      const s = sessions.get(p.sessionId);
      if (s?.prompt != null) { out({ id: s.prompt, result: { stopReason: 'cancelled' } }); s.prompt = null; }
      continue;
    }
    if (m.method !== 'session/prompt') { out({ id: m.id, error: { code: -32601, message: 'unknown' } }); continue; }
    const s = sessions.get(p.sessionId);
    if (!s) { out({ id: m.id, error: { code: -32602, message: 'unknown session' } }); continue; }
    const text = (p.prompt ?? []).map((b) => b.text).join('');
    if (text === 'FOREIGN') {
      // Updates for some other session, then silence: never an ack.
      chunk(`sess_${crypto.randomUUID()}`, 'not yours');
      continue;
    }
    if (text === 'DIE') { chunk(p.sessionId, 'bye'); process.exit(4); }
    s.prompt = m.id;
    if (text === 'APPROVAL') {
      out({ id: 900, method: 'session/request_permission', params: { sessionId: p.sessionId, toolCall: { toolCallId: 'c1' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
      out({ id: 901, method: 'fs/read_text_file', params: { sessionId: p.sessionId, path: '/etc/hosts' } });
    }
    if (text === 'HOLD') { chunk(p.sessionId, 'working'); continue; }
    const reply = text === 'PERM?' ? `perm:${JSON.stringify(permissionReply?.result ?? null)}` : `echo:${text}`;
    chunk(p.sessionId, reply.slice(0, 3));
    if (text === 'GARBAGE') process.stdout.write(`{oops\nnull\n${'y'.repeat(4 * 1024 * 1024 + 5)}\n`);
    chunk(p.sessionId, reply.slice(3));
    out({ id: m.id, result: { stopReason: 'end_turn' } });
    s.prompt = null;
  }
});
process.stdin.on('end', () => process.exit(0));
