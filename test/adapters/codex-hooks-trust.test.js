'use strict';
// Codex runs a user hook only once the person trusted it, by a hash of the
// handler; a changed handler turns "modified" and stops running
// (outputs/awareness-stepA-findings.md §2, §9.6). Agent awareness therefore
// lives inside emit.js, and the installed lifecycle handlers stay byte for
// byte what they were before it (origin/main ced79f92). Plexiform never
// writes hooks.state trusted_hash itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Codex = require('../../adapters/codex.js');
const Runtime = require('../../adapters/runtime.js');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('the installed Codex lifecycle handlers are byte for byte unchanged', () => {
  const packaged = Runtime.make({ execPath: '/Applications/Plexiform.app/Contents/MacOS/Plexiform', platform: 'darwin', dataDir: '/Users/u/.claude-traffic-light', hooksDir: '/Applications/Plexiform.app/Contents/Resources/hooks' });
  const dev = Runtime.make({ hooksDir: '/repo/hooks', dataDir: '/Users/u/.claude-traffic-light', node: true });
  assert.equal(JSON.stringify(Codex.applyActivity({}, packaged).hooks.SessionStart),
    '[{"hooks":[{"type":"command","command":"ELECTRON_RUN_AS_NODE=1 \'/Applications/Plexiform.app/Contents/MacOS/Plexiform\' \'/Applications/Plexiform.app/Contents/Resources/hooks/emit.js\' --adapter codex --lifecycle SessionStart","timeout":3,"statusMessage":"Plexiform Codex activity v1"}]}]');
  assert.equal(sha(JSON.stringify(Codex.applyActivity({}, packaged))), '773303de48ae464d20bffee79c586284bd066787498b0fab9cd5fa7db8779bc7');
  assert.equal(sha(JSON.stringify(Codex.applyActivity({}, dev))), 'f47a3b08ac37f83fb657877fcdf76a52615cfa2dfb67afbf38c73df6473025f3');
  assert.deepEqual(Codex.LIFECYCLE_EVENTS, ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd', 'SubagentStart', 'SubagentStop']);
});

test('no hook handler carries an additionalContextLimit (no hooks.json shape change), and nothing writes Codex hook trust', () => {
  const rt = Runtime.make({ hooksDir: '/repo/hooks', dataDir: '/Users/u/.claude-traffic-light', node: true });
  for (const groups of Object.values(Codex.applyActivity({}, rt).hooks)) for (const g of groups) for (const h of g.hooks) assert.deepEqual(Object.keys(h).sort(), ['command', 'statusMessage', 'timeout', 'type']);
  const root = path.join(__dirname, '..', '..');
  for (const f of ['adapters/codex.js', 'hooks/emit.js', 'hooks/awareness.js', 'src/agent-awareness.js', 'main.js']) assert.ok(!/trusted_hash/.test(fs.readFileSync(path.join(root, f), 'utf8')), f);
});
