'use strict';
// PR 0s: the terminal-presence interface (plan-agent-terminal §R2.4, §R2.5, §R3.1, §R3.11).
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/terminal-presence');

const mac = { platform: 'darwin' };
const presence = (state, reason = null) => ({ state, reason });
const open = (openIn, p, extra = {}) => P.resolveOpenIn({ openIn, ...extra }, p, mac);
const picks = (code) => ({ app: null, quiet: false, code, offerGet: false });

test('the stub detect() says not-installed, so nothing routes anywhere new', async () => {
  for (const fresh of [false, true]) {
    assert.deepEqual(await P.detect({ fresh, now: () => 5 }), { state: 'not-installed', reason: null, app: null, keeper: null, checkedAt: 5 });
  }
  const real = await P.detect();
  assert.equal(real.state, 'not-installed');
  assert.deepEqual(P.resolveOpenIn({}, real, mac), { app: 'Terminal', quiet: true, code: null, offerGet: true }, 'the default falls back to today\'s Terminal quietly');
  assert.deepEqual(await P.reveal('k1'), { ok: false, code: 'NOT_INSTALLED' });
});

test('resolveOpenIn: the §R2.4 table with Revision 3', () => {
  // auto
  assert.deepEqual(open('auto', presence('ready')), { app: 'Plexiform Terminal', quiet: false, code: null, offerGet: false });
  assert.deepEqual(open('auto', presence('keeper-outdated')), { app: 'Plexiform Terminal', quiet: false, code: null, offerGet: false }, 'new sessions go to the new keeper');
  assert.deepEqual(open('auto', presence('not-installed')), { app: 'Terminal', quiet: true, code: null, offerGet: true });
  assert.deepEqual(open('auto', presence('not-installed'), { usual: 'iTerm' }), { app: 'iTerm', quiet: true, code: null, offerGet: true });
  assert.deepEqual(open('auto', presence('unverified', 'unsigned-release')), { app: 'Terminal', quiet: true, code: null, offerGet: false }, 'the one quiet unverified (§R3.1)');
  for (const reason of P.REASONS.unverified.filter((r) => r !== 'unsigned-release')) assert.deepEqual(open('auto', presence('unverified', reason)), picks('UNVERIFIED'), reason);
  assert.deepEqual(open('auto', presence('keeper-down')), picks('KEEPER_DOWN'));
  assert.deepEqual(open('auto', presence('incompatible', 'keeper-major')), picks('INCOMPATIBLE'));
  // an explicit plexiform choice is never dropped quietly
  assert.deepEqual(open('plexiform', presence('ready')), { app: 'Plexiform Terminal', quiet: false, code: null, offerGet: false });
  assert.deepEqual(open('plexiform', presence('not-installed')), picks('NOT_INSTALLED'));
  assert.deepEqual(open('plexiform', presence('unverified', 'unsigned-release')), picks('UNVERIFIED'));
  assert.deepEqual(open('plexiform', presence('keeper-down')), picks('KEEPER_DOWN'));
  assert.deepEqual(open('plexiform', presence('incompatible')), picks('INCOMPATIBLE'));
  // any other app opens there, exactly as today, whatever the Terminal's state
  for (const app of ['Terminal', 'iTerm', 'Ghostty', 'Ghostty Dock']) for (const state of P.STATES) {
    assert.deepEqual(open(app, presence(state)), { app, quiet: false, code: null, offerGet: false }, `${app}/${state}`);
  }
  // Linux and Windows: today's behaviour
  for (const platform of ['linux', 'win32']) for (const openIn of P.OPEN_IN) {
    assert.deepEqual(P.resolveOpenIn({ openIn }, presence('ready'), { platform }), picks('UNSUPPORTED_PLATFORM'), `${platform}/${openIn}`);
  }
  assert.deepEqual(open('auto', presence('unsupported-platform')), picks('UNSUPPORTED_PLATFORM'));
  assert.deepEqual(open('auto', null), { app: 'Terminal', quiet: true, code: null, offerGet: true }, 'no presence reads as not installed');
});

test('normalizeTerminalConfig: the §R2.4 keys and defaults', () => {
  assert.deepEqual(P.normalizeTerminalConfig(undefined), { openIn: 'auto', openInChosen: false, usual: 'Terminal' });
  assert.deepEqual(P.normalizeTerminalConfig({ openIn: 'Warp', openInChosen: 'yes', usual: 'plexiform' }), { openIn: 'auto', openInChosen: false, usual: 'Terminal' });
  assert.deepEqual(P.normalizeTerminalConfig({ openIn: 'Ghostty Dock', openInChosen: true, usual: 'iTerm' }), { openIn: 'Ghostty Dock', openInChosen: true, usual: 'iTerm' });
  for (const bad of [null, [], 'auto', 7]) assert.equal(P.normalizeTerminalConfig(bad).openIn, 'auto');
});

test('the enums: 7 states, 13 result codes, LAUNCH_UNCONFIRMED gone', () => {
  assert.equal(P.STATES.length, 7);
  assert.equal(P.RESULT_CODES.length, 13);
  assert.ok(!P.RESULT_CODES.includes('LAUNCH_UNCONFIRMED') && P.RESULT_CODES.includes('TERMINAL_DIDNT_START'));
  assert.deepEqual(Object.keys(P.REASONS).sort(), ['incompatible', 'keeper-down', 'not-installed', 'unverified']);
  assert.ok(Object.isFrozen(P.STATES) && Object.isFrozen(P.REASONS.unverified));
});
