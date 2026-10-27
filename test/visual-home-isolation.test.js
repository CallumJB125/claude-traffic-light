'use strict';
// The visual specs launch the app with an empty HOME of its own, so a baseline never depends on this machine's
// ~/.claude, ~/.codex or shell rc files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { homeEnv, HOME_POINTERS } = require('../test-visual/app.js');

test('visual launches: HOME is never the real home, and nothing inherited points back into it', () => {
  const base = { HOME: os.homedir(), USERPROFILE: os.homedir(), PATH: '/usr/bin', ZDOTDIR: os.homedir(), CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude'), CODEX_HOME: path.join(os.homedir(), '.codex'), XDG_CONFIG_HOME: os.homedir(), XDG_DATA_HOME: os.homedir(), XDG_STATE_HOME: os.homedir() };
  const env = homeEnv('/tmp/cbuddy-visual-user-x', base);
  assert.equal(env.HOME, '/tmp/cbuddy-visual-user-x');
  assert.equal(env.USERPROFILE, '/tmp/cbuddy-visual-user-x');
  assert.notEqual(env.HOME, os.homedir());
  for (const k of HOME_POINTERS) assert.equal(k in env, false, k);
  assert.equal(env.PATH, '/tmp/cbuddy-visual-user-x/.local/bin:/usr/bin'); // the fake providers come first
});

test('visual launches: launchApp builds the app env from homeEnv and cleans the temp home up', () => {
  const src = fs.readFileSync(path.join(__dirname, '../test-visual/app.js'), 'utf8');
  assert.match(src, /\.\.\.homeEnv\(userHome\),/);
  assert.match(src, /fs\.rmSync\(userHome, \{ recursive: true, force: true \}\)/);
});
