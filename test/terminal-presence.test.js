'use strict';
// PR 0s: the terminal-presence interface (plan-agent-terminal §R2.4, §R2.5, §R3.1, §R3.11).
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/terminal-presence');

const mac = { platform: 'darwin' };
const presence = (state, reason = null) => ({ state, reason });
const open = (openIn, p, extra = {}) => P.resolveOpenIn({ openIn, ...extra }, p, mac);
const picks = (code) => ({ app: null, quiet: false, code, offerGet: false });

// detect() with everything injected: no real /Applications, plutil or keeper.
const HOME = '/Users/fixture';
const APP = '/Applications/Plexiform Terminal.app';
const plist = (extra = {}) => ({ CFBundleIdentifier: 'dev.plexiform.terminal', CFBundleShortVersionString: '0.2.0', ...extra });
const fakeFs = (paths) => ({ existsSync: (p) => paths.includes(p) });
const detect = (o = {}) => P.detect({ fresh: true, now: () => 5, platform: 'darwin', home: HOME, fs: fakeFs([`${APP}/Contents/Info.plist`]), readPlist: async () => plist(), keeper: async () => true, ...o });

test('detect: nothing in either Applications folder is not-installed, and auto falls back to Terminal quietly', async () => {
  const real = await detect({ fs: fakeFs([]) });
  assert.deepEqual(real, { state: 'not-installed', reason: null, app: null, keeper: null, checkedAt: 5 });
  assert.deepEqual(P.resolveOpenIn({}, real, mac), { app: 'Terminal', quiet: true, code: null, offerGet: true }, 'the default falls back to today\'s Terminal quietly');
  assert.equal((await detect({ readPlist: async () => plist({ CFBundleIdentifier: 'com.example.other' }) })).state, 'not-installed', 'another bundle with that name is not it');
  assert.deepEqual(await detect({ readPlist: async () => { throw new Error('x'); } }), { state: 'not-installed', reason: 'search-failed', app: null, keeper: null, checkedAt: 5 });
  assert.equal((await P.detect({ fresh: true, platform: 'linux' })).state, 'unsupported-platform');
  assert.deepEqual(await P.reveal('k1'), { ok: false, code: 'NOT_INSTALLED' });
});

test('detect: an installed Terminal reports its path, version and keeper; unsigned builds never route take-overs to it', async () => {
  const p = await detect();
  assert.deepEqual(p, { state: 'unverified', reason: 'unsigned-release', app: { path: APP, version: '0.2.0', preview: false, takeover: false }, keeper: { running: true }, checkedAt: 5 });
  assert.equal(P.resolveOpenIn({}, p, mac).app, 'Terminal', 'quiet fallback under auto (§R3.1)');
  const home = await detect({ fs: fakeFs([`${HOME}/Applications/Plexiform Terminal.app/Contents/Info.plist`]), keeper: async () => false });
  assert.equal(home.app.path, `${HOME}/Applications/Plexiform Terminal.app`);
  assert.deepEqual(home.keeper, { running: false });
  const preview = await detect({ signed: true, verify: async () => true, readPlist: async () => plist({ PlexiformDevelopmentPreview: true, PlexiformTakeover: true }) });
  assert.deepEqual([preview.state, preview.reason, preview.app.preview], ['unverified', 'unsigned-release', true], 'a development preview is never handed a take-over');
});

test('detect: a signed build reaches ready only with a verified signature, a running keeper and take-over support', async () => {
  const signed = (o) => detect({ signed: true, verify: async () => true, readPlist: async () => plist({ PlexiformTakeover: true }), ...o });
  assert.deepEqual([(await detect({ signed: true })).state, (await detect({ signed: true })).reason], ['unverified', 'signature'], 'no team-pinned check yet → never ready');
  assert.equal((await signed({ keeper: async () => false })).state, 'keeper-down');
  assert.deepEqual([(await signed({ readPlist: async () => plist() })).state, (await signed({ readPlist: async () => plist() })).reason], ['incompatible', 'terminal-protocols']);
  const ready = await signed();
  assert.equal(ready.state, 'ready');
  assert.equal(P.resolveOpenIn({}, ready, mac).app, 'Plexiform Terminal');
});

test('detect caches for 60 s unless fresh', async () => {
  let reads = 0, t = 1000;
  const o = { platform: 'darwin', home: '/Users/cache', now: () => t, fs: fakeFs(['/Applications/Plexiform Terminal.app/Contents/Info.plist']), readPlist: async () => { reads++; return plist(); }, keeper: async () => false };
  await P.detect({ ...o, fresh: true });
  await P.detect(o);
  assert.equal(reads, 1);
  t += 61000;
  await P.detect(o);
  assert.equal(reads, 2);
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
