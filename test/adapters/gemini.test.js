// Recorded gemini hook payloads through normalize(), emit.js and /hook/:adapter.
const { suite, tmp } = require('./helpers.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const State = require('../../hooks/session-state.js');
const Machine = require('../../hooks/session-machine.js');
const Gemini = require('../../adapters/gemini.js');

suite(Gemini);

test('gemini: a ToolPermission notification shows waiting at once, and the next tool event clears it', () => {
  const dir = path.join(tmp(), 'sessions');
  const send = (event, payload) => { for (const e of Gemini.normalize(event, { session_id: 'g1', cwd: '/w', ...payload })) State.applyAdapterEvent(dir, { host: 'h', source: 'gemini', event: e, fallbackSession: 'default', waitMs: 100 }); };
  const read = () => JSON.parse(fs.readFileSync(State.sessionFileFor(dir, 'h', 'gemini', 'g1'), 'utf8'));
  fs.mkdirSync(dir, { recursive: true });
  send('BeforeTool', { tool_name: 'run_shell_command' });
  send('Notification', { notification_type: 'ToolPermission', message: 'Allow?' });
  assert.equal(read().askKind, 'request');
  assert.equal(Machine.presentSignal(read(), Date.now()), 'permission-ask');
  send('AfterTool', { tool_name: 'run_shell_command' });
  assert.notEqual(Machine.presentSignal(read(), Date.now()), 'permission-ask');
});
