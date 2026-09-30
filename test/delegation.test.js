// Delegation is gone: installs from when it existed are cleaned up by the
// Claude Code adapter, and its rule signal stays an inert opt-in.
const test = require('node:test');
const assert = require('node:assert/strict');

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
  assert.deepEqual(cmds('PreToolUse'), ['echo mine', 'node "/new/set-status.js" tool-use']);
  assert.deepEqual(cmds('UserPromptSubmit'), ['node "/new/set-status.js" prompt-submit']);
  assert.ok(!JSON.stringify(out).includes('delegate.js'));
});

// ── rules.js: delegated-read ────────────────────────────────────────────────
test('rules: delegated-read fires for 10 s after a session delegated something', () => {
  assert.ok(R.SIGNALS.some((s) => s.id === 'delegated-read' && s.kind === 'virtual'));
  const now = Date.parse('2026-09-10T10:00:00Z');
  const s = (ago) => ({ sessionId: 'a', signal: 'tool-use', cwd: '/p', updatedAt: new Date(now).toISOString(), delegated: { reads: 2, trims: 0, at: new Date(now - ago).toISOString() } });
  const fired = (ago) => R.virtualSessions([s(ago)], now).some((v) => v.signal === 'delegated-read');
  assert.equal(fired(3000), true);
  assert.equal(fired(R.DELEGATED_MS + 1), false);
  assert.equal(R.virtualSessions([{ sessionId: 'b', signal: 'tool-use', updatedAt: new Date(now).toISOString() }], now).some((v) => v.signal === 'delegated-read'), false);
  const rules = [...R.defaultRules(), { id: 'deleg', name: 'Delegated', enabled: true, when: { signal: ['delegated-read'] }, then: { pose: 'munch' } }];
  rules.unshift(rules.pop());
  assert.equal(R.resolve(rules, [s(1000)], now).look.pose, 'munch');
});
