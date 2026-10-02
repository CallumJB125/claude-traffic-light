#!/usr/bin/env node
'use strict';
// FAKE local stand-in for `claude -p --input-format stream-json --output-format
// stream-json --replay-user-messages`, following the wire shapes recorded from
// a real claude 2.1.287 run (command_lifecycle, replayed user uuid,
// stream_event text_delta, result, control_request interrupt). Test-only; it
// is not proof of the real provider. Message text selects hostile behaviour.
const crypto = require('node:crypto');
const argv = process.argv.slice(2);
const sid = argv[argv.indexOf('--session-id') + 1];
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const as = (m, session = sid) => out({ ...m, session_id: session, uuid: m.uuid ?? crypto.randomUUID() });
let inited = false, holding = null;
const life = (cmd, state, session) => as({ type: 'command_lifecycle', command_uuid: cmd, state }, session);
function init(session = sid) { if (!inited) { inited = true; as({ type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'fake' }, session); } }
function reply(uuid, text) {
  for (const part of [text.slice(0, 3), text.slice(3)]) as({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } } });
  as({ type: 'stream_event', parent_tool_use_id: 'toolu_sub', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SUBAGENT' } } });
  as({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  as({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0 });
  life(uuid, 'completed');
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    const m = JSON.parse(line);
    if (m.type === 'control_request' && m.request?.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { still_queued: [] } }, session_id: sid });
      if (holding) { as({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' }); life(holding, 'completed'); holding = null; }
      continue;
    }
    if (m.type !== 'user') continue;
    const uuid = m.uuid, text = m.message.content.map((c) => c.text).join('');
    if (text === 'BADINIT') { init('00000000-0000-4000-8000-000000000000'); continue; }
    if (text === 'FOREIGN') {
      // Everything about our uuid, but in another session: never an ack.
      const other = crypto.randomUUID();
      life(uuid, 'queued', other); life(uuid, 'started', other);
      as({ type: 'user', isReplay: true, uuid, message: m.message }, other);
      as({ type: 'result', subtype: 'success', is_error: false, result: 'foreign' }, other);
      continue;
    }
    if (text === 'STATUSONLY') {
      init();
      as({ type: 'system', subtype: 'status', status: 'requesting' });
      as({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'looks delivered' } } });
      as({ type: 'result', subtype: 'success', is_error: false, result: 'looks delivered' });
      life(crypto.randomUUID(), 'started');
      continue;
    }
    if (text === 'GARBAGE') { process.stdout.write('{not json\nnull\n[1,2]\n"str"\n{"type":"result"}\n'); process.stdout.write(`${'x'.repeat(4 * 1024 * 1024 + 10)}\n`); }
    life(uuid, 'queued'); init(); life(uuid, 'started');
    as({ type: 'user', isReplay: true, uuid, parent_tool_use_id: null, message: m.message });
    if (text === 'DIE') process.exit(3);
    if (text === 'APPROVAL') as({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', reason: 'denied' });
    if (text === 'HOLD') { holding = uuid; continue; }
    if (text === 'ENV') { reply(uuid, JSON.stringify({ argv, env: Object.keys(process.env).sort() })); continue; }
    reply(uuid, `echo:${text}`);
  }
});
process.stdin.on('end', () => process.exit(0));
