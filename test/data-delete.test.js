const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Delete = require('../src/data-delete.js');
const { fakeMac, put } = require('./helpers/data-rights-fixture.js');

const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const dead = () => false;

function seed(mac) {
  const d = mac.roots.dataDir;
  put(path.join(d, 'config.json'), '{"rules":[]}');
  put(path.join(d, 'handovers', 'claude-code-1.md'), '# my secret plan for acme');
  put(path.join(d, 'sessions', 's1.json'), '{"cwd":"/Users/jdoe/work"}');
  put(path.join(d, 'app.log'), 'log');
  put(path.join(mac.roots.userDataDir, 'work-records.json'), '{}');
  put(path.join(mac.roots.backupsDir, '2026-10-01T06-02-19.493Z', 'config.json'), '{}');
}

test('the typed confirmation must be "delete", and only known stores are recorded', (t) => {
  const mac = fakeMac();
  t.after(mac.cleanup);
  const dataDir = mac.roots.dataDir;
  for (const confirm of ['', 'Delete please', 'remove', 'deleted', undefined, null, 1]) {
    assert.ok(Delete.requestDeletion({ ids: ['settings'], confirm, dataDir }).error, `accepted ${confirm}`);
  }
  assert.ok(Delete.requestDeletion({ ids: ['nope', '../x'], confirm: 'delete', dataDir }).error);
  assert.equal(Delete.pending({ dataDir }), null);
  const r = Delete.requestDeletion({ ids: ['settings', 'nope', 'settings', 'handovers'], confirm: '  DELETE ', dataDir, pid: 4242 });
  assert.deepEqual(r, { ok: true, ids: ['settings', 'handovers'] });
  assert.deepEqual(Delete.pending({ dataDir }).ids, ['settings', 'handovers']);
  assert.ok(Delete.cancelDeletion({ dataDir }));
  assert.equal(Delete.pending({ dataDir }), null);
});

test('a pending deletion removes only the chosen stores, inside the fake data folders', (t) => {
  const mac = fakeMac();
  t.after(mac.cleanup);
  seed(mac);
  const d = mac.roots.dataDir;
  Delete.requestDeletion({ ids: ['settings', 'handovers', 'work', 'backups'], confirm: 'delete', dataDir: d, pid: 999999 });
  const r = Delete.runPendingDeletion({ ...mac.roots, isAlive: dead, now: Date.UTC(2026, 9, 8) });
  assert.equal(r.ran, true);
  assert.ok(!exists(path.join(d, 'config.json')));
  assert.ok(!exists(path.join(d, 'handovers')));
  assert.ok(!exists(path.join(mac.roots.userDataDir, 'work-records.json')));
  assert.ok(!exists(mac.roots.backupsDir));
  assert.ok(exists(path.join(d, 'sessions', 's1.json')), 'an unchosen store was deleted');
  assert.ok(exists(path.join(d, 'app.log')));
  assert.ok(exists(path.join(mac.outside, 'precious.txt')));
  assert.ok(exists(path.join(mac.roots.home, '.claude', 'history.jsonl')), "an AI tool's history was touched");
  assert.ok(exists(path.join(mac.roots.home, 'code', 'repo', 'main.js')), 'a repository was touched');
  assert.equal(Delete.pending({ dataDir: d }), null, 'the request must run once');
  assert.deepEqual(r.results.map((x) => [x.id, x.status]), [['settings', 'deleted'], ['handovers', 'deleted'], ['work', 'deleted'], ['backups', 'deleted']]);
  assert.equal(Delete.runPendingDeletion({ ...mac.roots, isAlive: dead }).ran, false);
});

test('the receipt says what went and when, with no paths or personal content', (t) => {
  const mac = fakeMac();
  t.after(mac.cleanup);
  seed(mac);
  const d = mac.roots.dataDir;
  Delete.requestDeletion({ ids: ['handovers', 'sessions', 'memory'], confirm: 'delete', dataDir: d, now: Date.UTC(2026, 9, 8, 9) });
  const r = Delete.runPendingDeletion({ ...mac.roots, isAlive: dead, now: Date.UTC(2026, 9, 8, 10) });
  assert.ok(r.receiptFile.startsWith(path.join(d, 'deletion-receipts') + path.sep));
  const text = fs.readFileSync(r.receiptFile, 'utf8');
  const receipt = JSON.parse(text);
  assert.equal(receipt.deletedAt, '2026-10-08T10:00:00.000Z');
  assert.equal(receipt.requestedAt, '2026-10-08T09:00:00.000Z');
  assert.deepEqual(receipt.stores.map((s) => [s.id, s.status]), [['handovers', 'deleted'], ['sessions', 'deleted'], ['memory', 'nothing there']]);
  assert.equal(receipt.stores[0].files, 1);
  assert.ok(receipt.notCovered.some((n) => /team hub/.test(n)));
  for (const bad of [mac.base, mac.roots.home, 'jdoe', 'acme', 'secret plan', 'claude-code-1', '.md', '/']) {
    if (bad === '/') assert.ok(!/"\/|[A-Za-z]:\\/.test(text), 'a path in the receipt');
    else assert.ok(!text.includes(bad), `receipt holds ${bad}`);
  }
  assert.equal(fs.statSync(r.receiptFile).mode & 0o777, 0o600);
  assert.equal(Delete.lastReceipt({ dataDir: d }).deletedAt, receipt.deletedAt);
  assert.ok(exists(r.receiptFile), 'the receipt survives');
});

test('links are removed as links: their targets outside the data folder stay', (t) => {
  const mac = fakeMac();
  t.after(mac.cleanup);
  const d = mac.roots.dataDir;
  fs.symlinkSync(mac.outside, path.join(d, 'handovers'));
  put(path.join(d, 'sessions', 's1.json'));
  fs.symlinkSync(path.join(mac.outside, 'precious.txt'), path.join(d, 'sessions', 'escape.json'));
  fs.symlinkSync(path.join(mac.roots.home, '.claude'), path.join(d, 'sessions', 'claude'));
  const r = Delete.deleteStores({ ...mac.roots, ids: ['handovers', 'sessions'] });
  assert.deepEqual(r.map((x) => x.status), ['deleted', 'deleted']);
  assert.ok(!exists(path.join(d, 'handovers')) && !exists(path.join(d, 'sessions')));
  assert.equal(fs.readFileSync(path.join(mac.outside, 'precious.txt'), 'utf8'), 'outside the data folders');
  assert.ok(exists(path.join(mac.roots.home, '.claude', 'history.jsonl')));
});

test('a data folder that is a link, home or an AI tool\'s folder is refused whole', (t) => {
  const mac = fakeMac();
  t.after(mac.cleanup);
  put(path.join(mac.outside, 'config.json'), 'theirs');
  const link = path.join(mac.roots.home, '.linked');
  fs.symlinkSync(mac.outside, link);
  for (const dataDir of [link, mac.roots.home, path.join(mac.roots.home, '.claude')]) {
    const [r] = Delete.deleteStores({ ...mac.roots, home: mac.roots.home, dataDir, ids: ['settings'] });
    assert.equal(r.status, 'refused', dataDir);
    assert.equal(r.files, 0);
  }
  assert.ok(exists(path.join(mac.outside, 'config.json')));
  assert.ok(exists(path.join(mac.roots.home, '.claude', 'history.jsonl')));
  assert.match(Delete.requestDeletion({ ids: ['settings'], confirm: 'delete', dataDir: link }).error, /link/);
});

test('removeTree refuses anything outside its root', (t) => {
  const mac = fakeMac();
  t.after(mac.cleanup);
  const tally = { files: 0, bytes: 0 };
  assert.throws(() => Delete.removeTree(path.join(mac.outside, 'precious.txt'), mac.roots.dataDir, tally), /outside/);
  assert.throws(() => Delete.removeTree(mac.roots.dataDir, mac.roots.dataDir, tally), /outside/);
  assert.throws(() => Delete.removeTree(`${mac.roots.dataDir}-evil/x`, mac.roots.dataDir, tally), /outside/);
  assert.ok(exists(path.join(mac.outside, 'precious.txt')));
});

test('nothing is deleted while the requesting app or another copy still runs', (t) => {
  const mac = fakeMac();
  t.after(mac.cleanup);
  seed(mac);
  const d = mac.roots.dataDir;
  Delete.requestDeletion({ ids: ['settings'], confirm: 'delete', dataDir: d, pid: 4242 });
  const r = Delete.runPendingDeletion({ ...mac.roots, pid: 5000, isAlive: (p) => p === 4242 });
  assert.deepEqual(r, { ran: false, waiting: true });
  assert.ok(exists(path.join(d, 'config.json')));
  fs.symlinkSync('host.local-6000', path.join(mac.roots.userDataDir, 'SingletonLock'));
  assert.equal(Delete.runPendingDeletion({ ...mac.roots, pid: 5000, isAlive: (p) => p === 6000 }).waiting, true);
  assert.ok(exists(path.join(d, 'config.json')));
  assert.equal(Delete.runPendingDeletion({ ...mac.roots, pid: 5000, isAlive: dead }).ran, true);
  assert.ok(!exists(path.join(d, 'config.json')));
  assert.ok(exists(path.join(mac.roots.userDataDir, 'SingletonLock')), 'the app lock is not data');
});
test('encrypted follow-up store is explicitly deletable before the next app start',t=>{const mac=fakeMac();t.after(mac.cleanup);put(path.join(mac.roots.userDataDir,'session-followups','outbox.bin'),'synthetic sealed messages');put(path.join(mac.roots.userDataDir,'work-records.json'),'keep');Delete.requestDeletion({ids:['session-followups'],confirm:'delete',dataDir:mac.roots.dataDir,pid:999999});const r=Delete.runPendingDeletion({...mac.roots,isAlive:dead});assert.equal(r.ran,true);assert.equal(exists(path.join(mac.roots.userDataDir,'session-followups')),false);assert.equal(exists(path.join(mac.roots.userDataDir,'work-records.json')),true);});
