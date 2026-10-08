// W3-C encrypted sync, desktop side: keys (wrap, recovery code, rotation,
// blob binding), the op log (deterministic LWW merge, scrubbing, allowlist,
// transcripts only on opt-in), the local collector and the paid-wiring entry.
// No network: the hub round trips live in board/hub/test/sync.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Keys = require('../src/sync/keys');
const { createLog, sanitize } = require('../src/sync/log');
const Sync = require('../src/sync');

const API_KEY = `sk-ant-api03-${'Z'.repeat(80)}`;

function ringFor(uid = 'u1') {
  const a = Keys.createDeviceKey();
  const code = Keys.newRecoveryCode();
  const rk = Keys.recoveryKey(code, uid);
  return { a, code, rk, ring: Keys.newKeyring({ uid, deviceId: 'dev-a', devicePub: a.pub, recoveryPub: rk.pub }) };
}

test('wraps open only for their user, recipient and revision; any tampering fails', () => {
  const { a, ring } = ringFor();
  const w = Keys.wrapKeyring(ring, a.pub, 'dev-a');
  assert.deepEqual(Keys.unwrapKeyring(w, a.priv, { uid: 'u1', to: 'dev-a' }), ring);
  assert.equal(Keys.wrapRev(w), 1);
  assert.throws(() => Keys.unwrapKeyring(w, a.priv, { uid: 'u2', to: 'dev-a' }), { code: 'decrypt' });
  assert.throws(() => Keys.unwrapKeyring(w, a.priv, { uid: 'u1', to: 'dev-b' }), { code: 'decrypt' });
  assert.throws(() => Keys.unwrapKeyring(w.replace(/^w1\.1\./, 'w1.2.'), a.priv, { uid: 'u1', to: 'dev-a' }), { code: 'decrypt' }, 'rev is bound');
  const parts = w.split('.');
  const flip = (i) => { const p = [...parts]; const b = Buffer.from(p[i], 'base64url'); b[b.length - 1] ^= 1; p[i] = b.toString('base64url'); return p.join('.'); };
  for (const i of [3, 4, 5]) assert.throws(() => Keys.unwrapKeyring(flip(i), a.priv, { uid: 'u1', to: 'dev-a' }), Keys.SyncKeyError);
  assert.throws(() => Keys.unwrapKeyring(w, Keys.createDeviceKey().priv, { uid: 'u1', to: 'dev-a' }), { code: 'decrypt' }, 'another key');
  assert.throws(() => Keys.unwrapKeyring('w1.x', a.priv, { uid: 'u1', to: 'dev-a' }), { code: 'malformed' });
});

test('recovery codes: 160 bits, forgiving to type, bound to the user, deterministic', () => {
  const code = Keys.newRecoveryCode();
  assert.match(code, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.notEqual(Keys.newRecoveryCode(), code);
  assert.equal(Keys.parseRecoveryCode(code).length, 20);
  const typed = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
  assert.deepEqual(Keys.recoveryKey(typed, 'u1'), Keys.recoveryKey(code, 'u1'));
  assert.notDeepEqual(Keys.recoveryKey(code, 'u2').pub, Keys.recoveryKey(code, 'u1').pub);
  for (const bad of ['', 'short', `${code}X`, code.replace(/^./, 'U')]) assert.throws(() => Keys.parseRecoveryCode(bad), { code: 'bad-code' });
  const { rk, ring } = ringFor();
  const w = Keys.wrapAll(ring);
  assert.deepEqual(Keys.unwrapKeyring(w.recovery_wrap, rk.priv, { uid: 'u1', to: 'recovery' }), ring);
});

test('rotation: a new epoch key, the device dropped, old keys kept; a merge never loses a key', () => {
  const { a, ring } = ringFor();
  const b = Keys.createDeviceKey();
  const two = Keys.addDevice(ring, 'dev-b', b.pub);
  assert.equal(two.rev, 2);
  const three = Keys.rotate(two, { revoke: 'dev-b' });
  assert.deepEqual([three.current, three.rev, Object.keys(three.devices)], [2, 3, ['dev-a']]);
  assert.equal(three.keys[1], ring.keys[1]);
  assert.notEqual(three.keys[2], ring.keys[1]);
  assert.deepEqual(Object.keys(Keys.wrapAll(three).wraps), ['dev-a'], 'never wrapped to the revoked device');
  // The revoked device holds rev 2: blobs under epoch 2 do not open for it.
  const blob = Keys.sealBlob(three, { uid: 'u1', deviceId: 'dev-a' }, Buffer.from('new'));
  assert.equal(blob.epoch, 2);
  assert.throws(() => Keys.openBlob(two, { uid: 'u1', deviceId: 'dev-a' }, blob.bytes), { code: 'no-key' });
  assert.equal(Keys.openBlob(three, { uid: 'u1', deviceId: 'dev-a' }, blob.bytes).toString(), 'new');
  // Blob AAD: another device id or user does not open it.
  assert.throws(() => Keys.openBlob(three, { uid: 'u1', deviceId: 'dev-b' }, blob.bytes), { code: 'decrypt' });
  assert.throws(() => Keys.openBlob({ ...three, uid: 'u2' }, { uid: 'u2', deviceId: 'dev-a' }, blob.bytes), { code: 'decrypt' });
  const merged = Keys.mergeKeyring(three, two);
  assert.equal(merged.rev, 3);
  assert.deepEqual(Object.keys(merged.keys).sort(), ['1', '2']);
  assert.throws(() => Keys.mergeKeyring(three, ringFor('u9').ring), { code: 'bad-keyring' });
  assert.ok(a.pub && Keys.fingerprint(a.pub).match(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/));
});

test('the op log converges: every device applying the same ops in any order holds the same docs', () => {
  const devs = ['dev-a', 'dev-b', 'dev-c'].map((d) => createLog({ deviceId: d }));
  devs[0].put('memory:x:1', 'memory', { tool: 'x', sid: '1', title: 'from a' });
  devs[1].put('memory:x:1', 'memory', { tool: 'x', sid: '1', title: 'from b' });
  devs[2].put('memory:x:2', 'memory', { tool: 'x', sid: '2', title: 'c only' });
  devs[0].put('handover:h', 'handover', { key: 'h', text: 'v1' });
  devs[0].put('handover:h', 'handover', { key: 'h', text: 'v2' });
  devs[1].merge(devs[0].state().pending);
  devs[1].remove('handover:h'); // b deletes after seeing v2: the tombstone wins everywhere
  const all = devs.flatMap((d) => d.state().pending);
  let reference = null;
  for (let trial = 0; trial < 25; trial++) {
    const order = [...all, ...all.slice(0, 3)].sort(() => Math.random() - 0.5);
    const fresh = createLog({ deviceId: `viewer-${trial}` });
    fresh.merge(order);
    const docs = fresh.docs();
    if (reference) assert.deepEqual(docs, reference);
    reference = docs;
  }
  assert.equal(reference['memory:x:1'].data.title, 'from b', 'same Lamport time: the larger device id wins');
  assert.equal(reference['handover:h'], undefined, 'deleted');
  assert.equal(reference['memory:x:2'].data.title, 'c only');
  // An unchanged put makes no op; a change after merge outranks what was seen.
  const a = devs[0];
  a.merge(all);
  assert.equal(a.put('memory:x:2', 'memory', { tool: 'x', sid: '2', title: 'c only' }), null);
  const op = a.put('memory:x:1', 'memory', { tool: 'x', sid: '1', title: 'a again' });
  assert.ok(op.l > Math.max(...all.map((o) => o.l)));
  assert.equal(a.merge([{ ...op, v: { tool: 'x', sid: '1', title: 'replayed' } }]), 0, 'same clock: not applied twice');
  assert.equal(a.merge([{ id: 'bad id!', k: 'memory', l: 1, d: 'x', v: {} }, { id: 'ok', k: 'nope', l: 1, d: 'x', v: {} }, null]), 0, 'malformed ops are ignored');
});

test('only allowlisted fields sync, every string is scrubbed, and raw transcripts need an explicit opt-in', () => {
  const v = sanitize('memory', { tool: 'claude', sid: 's', title: `deploy with ${API_KEY}`, cwd: '/Users/me/secret-project', text: 'turn text', started: 1, cost: Infinity });
  assert.deepEqual(Object.keys(v).sort(), ['sid', 'started', 'title', 'tool']);
  assert.ok(!v.title.includes(API_KEY));
  assert.match(v.title, /<redacted:anthropic_key>/);
  assert.equal(sanitize('transcript', { sid: 's', text: 'raw' }), null);
  assert.deepEqual(sanitize('transcript', { sid: 's', text: 'raw' }, { allowTranscripts: true }), { sid: 's', text: 'raw' });
  assert.equal(createLog({ deviceId: 'd' }).put('t:1', 'transcript', { sid: 's', text: 'raw' }), null);
  assert.ok(createLog({ deviceId: 'd', allowTranscripts: true }).put('t:1', 'transcript', { sid: 's', text: 'raw' }));
  assert.equal(sanitize('unknown', { a: 1 }), null);
  assert.equal(sanitize('handover', { text: 'x'.repeat(70 * 1024) }).text.length, 64 * 1024);
});

test('collect: memory session rows (never turn text or paths), checkpoint summaries and handover docs, scrubbed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-collect-'));
  try {
    fs.mkdirSync(path.join(root, 'memory'));
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(root, 'memory', 'index.db'));
    db.exec('CREATE TABLE sessions(id INTEGER PRIMARY KEY, tool TEXT, sid TEXT, cwd TEXT, repo TEXT, branch TEXT, title TEXT, started INTEGER, ended INTEGER, cost REAL, source TEXT); CREATE TABLE turns(id INTEGER PRIMARY KEY, session INTEGER, text TEXT);');
    db.prepare('INSERT INTO sessions(tool, sid, cwd, repo, branch, title, started, ended, cost, source) VALUES (?,?,?,?,?,?,?,?,?,?)').run('claude', 's1', '/Users/me/PRIVATE-CWD', 'app', 'main', 'Fix login', 1, 2, 0.5, '/Users/me/.claude/projects/x.jsonl');
    db.prepare('INSERT INTO turns(session, text) VALUES (1, ?)').run('TURN-TEXT-NEVER-SYNCED');
    db.close();
    fs.mkdirSync(path.join(root, 'checkpoints'));
    fs.writeFileSync(path.join(root, 'checkpoints', 'index.json'), JSON.stringify({ sessions: { s1: { cwd: '/Users/me/PRIVATE-CWD', top: '/Users/me/PRIVATE-CWD/app', source: 'claude', updatedAt: 7, skip: null } } }));
    fs.mkdirSync(path.join(root, 'handovers'));
    fs.writeFileSync(path.join(root, 'handovers', 'claude-code-s1.md'), `# Handover: Fix login\n\nNext steps. Token ${API_KEY}\n`);
    fs.writeFileSync(path.join(root, 'handovers', 'huge.md'), 'x'.repeat(70 * 1024));
    const lg = createLog({ deviceId: 'd' });
    Sync.collect(root, lg);
    const docs = lg.docs();
    assert.deepEqual(Object.keys(docs).sort(), ['checkpoint:s1', 'handover:claude-code-s1', 'memory:claude:s1']);
    assert.deepEqual(docs['checkpoint:s1'].data, { sid: 's1', repo: 'app', source: 'claude', updatedAt: 7 });
    assert.equal(docs['handover:claude-code-s1'].data.title, 'Handover: Fix login');
    const text = JSON.stringify(lg.state());
    for (const never of ['TURN-TEXT-NEVER-SYNCED', 'PRIVATE-CWD', '.claude/projects', API_KEY]) assert.ok(!text.includes(never), never);
    assert.equal(lg.state().pending.length, 3);
    Sync.collect(root, lg);
    assert.equal(lg.state().pending.length, 3, 'unchanged docs make no new ops');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('register: a free install gets the upsell and makes no request; IPC answers only the Sync page; state files are 0600 in a 0700 dir', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-reg-'));
  const handlers = new Map();
  const quits = [];
  const opened = [];
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error('no network in tests'); };
  try {
    const out = Sync.register({
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, rootDir: root,
      entitlements: { has: () => false, plan: () => 'free' }, fromPage: (e, id) => e === 'page' && id === 'sync',
      buddy: () => ({ interactionHostIdentity: () => ({ origin: 'https://hub.example', userId: 'u1', token: () => 't' }), open: (id) => opened.push(id) }),
      onQuit: (fn) => quits.push(fn),
    });
    assert.ok(out);
    assert.deepEqual([...handlers.keys()].sort(), ['sync:approve', 'sync:disable', 'sync:enable', 'sync:new-code', 'sync:now', 'sync:open', 'sync:recover', 'sync:revoke', 'sync:state']);
    await handlers.get('sync:open')('other-page', 'upgrade');
    await handlers.get('sync:open')('page', 'upgrade');
    await handlers.get('sync:open')('page', 'settings');
    assert.deepEqual(opened, ['upgrade', 'account'], 'only the Sync page navigates, and only to Plan & billing or Account');
    assert.equal(await handlers.get('sync:state')('other-page'), null);
    const st = await handlers.get('sync:state')('page');
    assert.deepEqual([st.entitled, st.enabled, st.signedIn, st.hub], [false, false, true, null]);
    assert.equal((await handlers.get('sync:enable')('page')).code, 'PLAN_REQUIRED');
    assert.equal(fetched, 0, 'no request from a free install');
    const mode = (p) => fs.statSync(p).mode & 0o777;
    assert.equal(mode(path.join(root, 'sync')), 0o700);
    assert.equal(mode(path.join(root, 'sync', 'device.json')), 0o600);
    const { PACKAGES } = require('../src/paid-wiring');
    assert.ok(PACKAGES.some(([name, resolve]) => name === 'sync' && resolve() === require.resolve('../src/sync')));
  } finally {
    for (const fn of quits) fn();
    globalThis.fetch = realFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
