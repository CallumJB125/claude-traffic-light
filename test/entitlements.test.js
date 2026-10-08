const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const E = require('../src/entitlements');
const { registerAll } = require('../src/paid-wiring');

const DAY = 86400e3;
const T0 = Date.UTC(2026, 9, 7);
const pair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }), privateKey };
};
const KEY = pair();
const OTHER = pair();

function sign(claims, { privateKey = KEY.privateKey, header = { alg: 'EdDSA', typ: 'JWT' } } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc(header)}.${enc(claims)}`;
  return `${data}.${crypto.sign(null, Buffer.from(data), privateKey).toString('base64url')}`;
}
const claims = (over = {}) => ({ sub: 'u1', plan: 'plus', iat: (T0 - DAY) / 1000, period_end: (T0 + 30 * DAY) / 1000, exp: (T0 + 44 * DAY) / 1000, ...over });

function setup(t, { token, raw, clock = T0, keys = [KEY.pub] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (raw !== undefined) fs.writeFileSync(path.join(root, E.TOKEN_FILE), raw);
  else if (token !== undefined) fs.writeFileSync(path.join(root, E.TOKEN_FILE), JSON.stringify({ token }));
  const now = { t: clock };
  E.configure({ root, publicKeys: keys, now: () => now.t });
  return { root, now };
}

test('feature keys and limits are frozen, and every key names a plan', () => {
  assert.ok(Object.isFrozen(E.FEATURES) && Object.isFrozen(E.LIMITS) && Object.isFrozen(E.LIMITS.free));
  for (const [k, p] of Object.entries(E.FEATURES)) assert.ok(E.PLANS.includes(p), k);
  assert.equal(E.LIMITS.free['checkpoints.turns'], 3);
  assert.equal(E.LIMITS.free['memory.days'], 7);
  assert.equal(E.LIMITS.free.devices, 0);
  assert.equal(E.LIMITS.plus.devices, 3);
  assert.equal(E.LIMITS.plus['memory.days'], Infinity);
});

test('no token file → free; free features on, paid off, unknown keys off', (t) => {
  setup(t);
  assert.equal(E.plan(), 'free');
  assert.equal(E.status().reason, 'missing');
  assert.equal(E.has('setups.personal'), true);
  assert.equal(E.has('checkpoints'), true);
  assert.equal(E.has('phone'), false);
  assert.equal(E.has('setups.team'), false);
  assert.equal(E.has('nope'), false);
  assert.equal(E.has(undefined), false);
  assert.equal(E.has('__proto__'), false);
  assert.deepEqual(E.limits(), E.LIMITS.free);
});

test('a valid signed token unlocks its plan, offline', (t) => {
  setup(t, { token: sign(claims()) });
  assert.equal(E.plan(), 'plus');
  assert.equal(E.has('phone'), true);
  assert.equal(E.has('setups.team'), false);
  assert.equal(E.limits()['checkpoints.turns'], Infinity);
  assert.equal(E.status().inGrace, false);
});

test('team includes plus; a features claim adds only known keys', (t) => {
  setup(t, { token: sign(claims({ plan: 'team' })) });
  assert.equal(E.has('setups.team'), true);
  assert.equal(E.has('phone'), true);
  const s2 = setup(t, { token: sign(claims({ features: ['setups.team', 'bogus', 7] })) });
  assert.ok(s2);
  assert.equal(E.has('setups.team'), true);
  assert.deepEqual([...E.status().features], ['setups.team']);
});

test('corrupt, oversized, wrong-shape files → free', (t) => {
  for (const raw of ['', 'not json', '{"token":5}', '{"token":"a.b"}', '{"token":"a.b.c"}', 'x'.repeat(20000), JSON.stringify({ token: 'x'.repeat(20000) })]) {
    setup(t, { raw });
    assert.equal(E.plan(), 'free', raw.slice(0, 30));
    assert.equal(E.has('phone'), false);
  }
});

test('a token file that is a directory is free, not a crash', (t) => {
  const { root } = setup(t);
  fs.mkdirSync(path.join(root, E.TOKEN_FILE));
  assert.equal(E.plan(), 'free');
});

test('bad signature, wrong key, wrong alg, no pinned key → free', (t) => {
  setup(t, { token: sign(claims(), { privateKey: OTHER.privateKey }) });
  assert.equal(E.status().reason, 'invalid');
  const good = sign(claims());
  const [h, , s] = good.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify(claims({ plan: 'team' }))).toString('base64url')}.${s}`;
  setup(t, { token: forged });
  assert.equal(E.plan(), 'free');
  setup(t, { token: sign(claims(), { header: { alg: 'none' } }) });
  assert.equal(E.plan(), 'free');
  setup(t, { token: good, keys: [] });
  assert.equal(E.plan(), 'free');
  setup(t, { token: good, keys: ['not a pem', KEY.pub] });
  assert.equal(E.plan(), 'plus', 'a bad pinned key is skipped');
});

test('the shipped build pins no key yet, so a token alone never unlocks anything', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, E.TOKEN_FILE), JSON.stringify({ token: sign(claims()) }));
  E.configure({ root, now: () => T0 });
  assert.equal(E.plan(), 'free');
});

test('unknown plan, missing exp/iat or exp before iat → free', (t) => {
  for (const c of [claims({ plan: 'free' }), claims({ plan: 'gold' }), claims({ exp: undefined }), claims({ iat: 'x' }), claims({ exp: claims().iat })]) {
    setup(t, { token: sign(c) });
    assert.equal(E.plan(), 'free', JSON.stringify(c));
  }
});

test('offline grace: plus through the grace window, free at exp', (t) => {
  const { now } = setup(t, { token: sign(claims()) });
  now.t = T0 + 31 * DAY;
  assert.equal(E.plan(), 'plus');
  assert.equal(E.status().inGrace, true);
  now.t = T0 + 43 * DAY;
  assert.equal(E.plan(), 'plus');
  now.t = T0 + 44 * DAY;
  assert.equal(E.plan(), 'free');
  assert.equal(E.status().reason, 'expired');
});

test('turning the clock back cannot revive an expired token (last-seen persists across restarts)', (t) => {
  const { root, now } = setup(t, { token: sign(claims()) });
  now.t = T0 + 45 * DAY;
  assert.equal(E.plan(), 'free');
  const saved = JSON.parse(fs.readFileSync(path.join(root, E.CLOCK_FILE), 'utf8'));
  assert.equal(saved.lastSeen, T0 + 45 * DAY);
  assert.equal((fs.statSync(path.join(root, E.CLOCK_FILE)).mode & 0o777), 0o600);
  const clock = { t: T0 };
  E.configure({ root, publicKeys: [KEY.pub], now: () => clock.t });
  assert.equal(E.plan(), 'free', 'restart with the clock rolled back still sees day 45');
});

test("a clock earlier than the token's own iat counts from iat", (t) => {
  setup(t, { token: sign(claims({ iat: (T0 + 40 * DAY) / 1000 })), clock: T0 - 365 * DAY });
  assert.equal(E.plan(), 'plus');
  setup(t, { token: sign(claims({ iat: (T0 + 50 * DAY) / 1000, exp: (T0 + 51 * DAY) / 1000 })), clock: T0 + 60 * DAY });
  assert.equal(E.plan(), 'free');
});

test('a corrupt clock file is ignored', (t) => {
  const { root } = setup(t, { token: sign(claims()) });
  fs.writeFileSync(path.join(root, E.CLOCK_FILE), '{nope');
  E.configure({ root, publicKeys: [KEY.pub], now: () => T0 });
  assert.equal(E.plan(), 'plus');
});

test('a token written later is picked up without a restart', (t) => {
  const { root } = setup(t);
  assert.equal(E.plan(), 'free');
  fs.writeFileSync(path.join(root, E.TOKEN_FILE), JSON.stringify({ token: sign(claims({ plan: 'team' })) }));
  assert.equal(E.plan(), 'team');
});

test('the module opens no network or process channel', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'entitlements.js'), 'utf8');
  // ./entitlement-keys is the build-time list of pinned public keys: data only, no requires of its own.
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) assert.ok(['fs', 'os', 'path', 'crypto', './entitlement-keys'].includes(m[1]), m[1]);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'src', 'entitlement-keys.js'), 'utf8'), /require\(|import\(/);
  assert.doesNotMatch(src, /\bfetch\(|child_process|https?\.|\bnet\b|WebSocket|privacy-flow/);
});

test('paid wiring: absent packages are skipped, a throwing one is logged, the rest still register', () => {
  const seen = [];
  const logs = [];
  const out = registerAll({ log: (m) => logs.push(m), marker: 1 }, [
    ['absent', () => { throw Object.assign(new Error('nf'), { code: 'MODULE_NOT_FOUND' }); }, () => { throw new Error('never loaded'); }],
    ['boom', () => 'x', () => ({ register() { throw new Error('kaput'); } })],
    ['bare', () => 'x', () => ({})],
    ['ok', () => 'x', () => ({ register(ctx) { seen.push(ctx); } })],
  ]);
  assert.deepEqual(out.map((r) => r.status), ['absent', 'failed', 'skipped', 'ok']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].marker, 1);
  assert.equal(seen[0].entitlements, E);
  assert.match(logs[0], /boom failed to register: kaput/);
});

test('paid wiring with the real package list never throws, today none are present', () => {
  const out = registerAll({ log: () => {} });
  assert.ok(out.every((r) => ['absent', 'ok', 'skipped', 'failed'].includes(r.status)));
});

test('main.js wires paid packages once, inside a try, after the consts it uses are declared', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const lines = main.split('\n');
  const at = lines.findIndex((l) => l.includes("require('./src/paid-wiring.js')"));
  assert.ok(at > 0);
  assert.equal(lines.filter((l) => /require\([^)]*paid-wiring/.test(l)).length, 1);
  assert.match(lines[at], /^try \{ require\('\.\/src\/paid-wiring\.js'\)\.registerAll\(.*\} catch \(e\) \{/);
  for (const decl of [/^const ROOT_DIR = /, /^const fromUtilityPage = /, /^let buddyWin = /, /^const \{ onQuit \} = /]) {
    const d = lines.findIndex((l) => decl.test(l));
    assert.ok(d >= 0 && d < at, String(decl));
  }
});
