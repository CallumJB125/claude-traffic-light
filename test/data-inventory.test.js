const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Inventory = require('../src/data-inventory.js');
const { fakeMac, put } = require('./helpers/data-rights-fixture.js');

const ROOT = path.join(__dirname, '..');

// Every file or folder Plexiform is known to write, by root. A new store
// added to the code without a home in src/data-inventory.js fails below.
const KNOWN = {
  data: ['config.json', 'rules/r.json', 'presets/p.json', 'window-bounds.json', 'session-snoozes.json', 'manual-override.json', 'claude-deny-rules.json', 'router-baseline.json', 'automation-explained.json', 'terminal-access.json', 'ai-tools.json', 'tasks-seen.json', 'morning-seen.json', 'away.json', 'clients.json', '.help-shown', '.onboarded', '.auto-launch-configured', '.calendar-granted',
    'sessions/s.json', 'requests/r.json', 'owned/o.json', 'senders/x.json', 'last-hook.json', 'hook-endpoint.json', 'burst-snapshot.json', 'burst-handover.json', 'burst-scripts/a.sh', 'git-signals.json', 'busy-ics-cache.json',
    'handovers/claude-code-1.md', 'app.log', 'app.log.old', 'one-key-approvals.jsonl', 'approval-counts.json',
    'stats.json', 'usage/daily/2026-10.json', 'compaction-stats.json', 'cost-guard.json', 'cost-guard-log.json', 'spend-gate.json',
    'memory/index.db', 'checkpoints/index.json', 'characters/u-nova/character.json', 'cameos/a.png', 'crash-reports/reports.jsonl', 'crash-reports/consent.json', 'feedback/draft.json',
    'token', 'port', 'approval-secret.json', 'entitlement.json', 'entitlement-clock.json', 'remote/identity.json', 'remote/audit.jsonl', 'remote.json', 'remote-state.json', 'sync/settings.json'],
  userData: ['work-capture.json', 'work-records.json', 'session-links.json', 'board/board.db', 'board/board.db-wal', 'tasks/store/tasks.jsonl', 'tasks/tasks.token', 'runner/k/x', 'plexiform-tasks/x', 'session-followups/outbox.bin',
    'buddy-accounts/a.sealed', 'buddy-devices/d.sealed', 'buddy-workspaces.json', 'setups-runtime-v2/t', 'native-board/x', 'updater.json', 'local-models.json',
    'Cookies', 'Local Storage/leveldb/1.log', 'Session Storage/1.log', 'Cache/x', 'GPUCache/x', 'Preferences', 'Local State', 'Partitions/p/x'],
};

function plant(roots) {
  for (const [root, rels] of Object.entries(KNOWN)) for (const rel of rels) put(path.join(roots[root === 'data' ? 'dataDir' : 'userDataDir'], rel));
}

test('every known store lands in a named store, not the catch-all', (t) => {
  const mac = fakeMac();
  t.after(mac.cleanup);
  plant(mac.roots);
  const rows = Inventory.inventory(mac.roots);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(byId['data-other'].paths, [], 'unclassified data-folder files');
  assert.deepEqual(byId['app-other'].paths, [], 'unclassified app-folder files');
  const covered = new Set(rows.flatMap((r) => r.paths));
  for (const [root, rels] of Object.entries(KNOWN)) {
    for (const rel of rels) {
      const top = path.join(mac.roots[root === 'data' ? 'dataDir' : 'userDataDir'], rel.split('/')[0]);
      assert.ok(covered.has(top), `${root}/${rel} is not in the inventory`);
    }
  }
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['bytes', 'deletable', 'detail', 'exportable', 'files', 'id', 'kind', 'label', 'path', 'paths', 'problem']);
    assert.equal(typeof r.bytes, 'number');
  }
  assert.ok(byId.keys.paths.length && !byId.keys.exportable && byId.keys.deletable);
  assert.ok(byId.memory.bytes > 0 && byId.memory.deletable);
  assert.ok(byId['session-followups'].bytes > 0 && byId['session-followups'].deletable && !byId['session-followups'].exportable);
});

test('the inventory list has unique ids and each named file has one home', () => {
  const ids = Inventory.STORES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const root of ['data', 'userData']) {
    const names = Inventory.STORES.filter((s) => s.root === root && s.names).flatMap((s) => s.names);
    assert.equal(new Set(names).size, names.length, `a ${root} name is in two stores`);
  }
});

test('the names main.js and the Buddy window write are all in the inventory', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const win = fs.readFileSync(path.join(ROOT, 'buddy-window', 'index.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'buddy-window', 'session-bridge.js'), 'utf8');
  const named = (root) => new Set(Inventory.STORES.filter((s) => s.root === root && s.names).flatMap((s) => s.names).concat(Object.keys(Inventory.KEEP[root])));
  const data = named('data');
  const app = named('userData');
  const missing = [];
  for (const m of main.matchAll(/join\(ROOT_DIR,\s*'([^'/]+)'/g)) if (!data.has(m[1])) missing.push(`data: ${m[1]}`);
  for (const m of main.matchAll(/join\(app\.getPath\('userData'\),\s*'([^'/]+)'/g)) if (!app.has(m[1]) && !/-dev-home$/.test(m[1])) missing.push(`userData: ${m[1]}`);
  for (const m of win.matchAll(/join\(userData,\s*(?:mode === 'dev' \? '[^']+' : )?'([^'/]+)'/g)) if (!app.has(m[1])) missing.push(`userData: ${m[1]}`);
  assert.deepEqual(missing, []);
});

test('a file no store names is still listed, as other data; other tools\' folders and hook programs are kept', (t) => {
  const mac = fakeMac();
  t.after(mac.cleanup);
  put(path.join(mac.roots.dataDir, 'future-store.json'));
  put(path.join(mac.roots.dataDir, '.omc', 'state.json'));
  put(path.join(mac.roots.dataDir, 'hooks-1.0.2', 'set-status.js'));
  put(path.join(mac.roots.dataDir, 'bin', 'buddy-hook'));
  put(path.join(mac.roots.userDataDir, 'SingletonLock'));
  const rows = Inventory.inventory(mac.roots);
  const other = rows.find((r) => r.id === 'data-other');
  assert.deepEqual(other.paths, [path.join(mac.roots.dataDir, 'future-store.json')]);
  const all = rows.flatMap((r) => r.paths);
  for (const n of ['.omc', 'hooks-1.0.2', 'bin']) assert.ok(!all.includes(path.join(mac.roots.dataDir, n)), `${n} must not be deletable`);
  assert.ok(!all.includes(path.join(mac.roots.userDataDir, 'SingletonLock')));
  const kept = Inventory.kept(mac.roots).map((k) => `${k.root}:${k.name}`);
  for (const k of ['data:.omc', 'data:hooks-1.0.2', 'data:bin', 'userData:SingletonLock']) assert.ok(kept.includes(k), k);
});

test('sizes are counted without following a link out of the data folder', (t) => {
  const mac = fakeMac();
  t.after(mac.cleanup);
  put(path.join(mac.roots.dataDir, 'handovers', 'a.md'), '12345');
  fs.writeFileSync(path.join(mac.outside, 'big.bin'), Buffer.alloc(1024 * 1024));
  fs.symlinkSync(mac.outside, path.join(mac.roots.dataDir, 'handovers', 'escape'));
  const h = Inventory.inventory(mac.roots).find((r) => r.id === 'handovers');
  assert.ok(h.bytes < 1024, `counted ${h.bytes} bytes through a link`);
});

test('roots that are home, an AI tool\'s folder or a link are refused', (t) => {
  const mac = fakeMac();
  t.after(mac.cleanup);
  const { home } = mac.roots;
  assert.match(Inventory.rootProblem(home, home), /top-level/);
  assert.match(Inventory.rootProblem(path.join(home, '.claude'), home), /AI tool/);
  assert.match(Inventory.rootProblem(path.join(home, '.claude', 'x'), home), /AI tool/);
  assert.match(Inventory.rootProblem(path.join(home, '.codex'), home), /AI tool/);
  assert.match(Inventory.rootProblem(path.join(home, 'Library', 'Application Support'), home), /top-level/);
  assert.match(Inventory.rootProblem(path.dirname(home), home), /contains your own/);
  assert.match(Inventory.rootProblem('relative/dir', home), /absolute/);
  const link = path.join(home, '.linked-data');
  fs.symlinkSync(mac.outside, link);
  assert.match(Inventory.rootProblem(link, home), /link/);
  assert.equal(Inventory.rootProblem(mac.roots.dataDir, home), null);
  const rows = Inventory.inventory({ ...mac.roots, dataDir: link });
  for (const r of rows.filter((x) => Inventory.byId.get(x.id).root === 'data')) {
    assert.equal(r.deletable, false);
    assert.deepEqual(r.paths, []);
  }
});
