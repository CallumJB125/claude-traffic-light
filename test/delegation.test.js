// Delegation is gone: installs from when it existed are cleaned up by the
// Claude Code adapter.
const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('path');
const R = require('../rules.js');
const Claude = require('../adapters/claude-code.js');
const Runtime = require('../adapters/runtime.js');

test('reinstall strips delegate.js entries an earlier version registered; set-status and foreign hooks stay', () => {
  const rt = Runtime.make({ execPath: null, hooksDir: '/new', dataDir: '/d' });
  const foreign = { matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] };
  const settings = {
    hooks: {
      PreToolUse: [foreign, { matcher: '', hooks: [{ type: 'command', command: 'node "/old/hooks/delegate.js"' }] }, { matcher: '', hooks: [{ type: 'command', command: 'node "/old/hooks/set-status.js" tool-use' }] }],
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'node "/old/hooks/delegate.js"' }] }],
    },
  };
  const out = Claude.apply(settings, rt);
  const cmds = (ev) => (out.hooks[ev] || []).flatMap((h) => h.hooks.map((x) => x.command));
  const ss = path.join('/new', 'set-status.js');
  assert.deepEqual(cmds('PreToolUse'), ['echo mine', `node "${ss}" tool-use`]);
  assert.deepEqual(cmds('UserPromptSubmit'), [`node "${ss}" prompt-submit`]);
  assert.ok(!JSON.stringify(out).includes('delegate.js'));
});
