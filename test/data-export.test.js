const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Export = require('../src/data-export.js');
const { fakeMac, put } = require('./helpers/data-rights-fixture.js');

const GH = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const ANT = 'sk-ant-api03-Zq9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa9Zy8Xw7Vu6Ts5Rq4Po3Nm2Lk1Ji0HgFeDcBa-AbCdEfAA';
const AWS = 'AKIAQ7XKJ3MNP2RSTUVW';
const RAW = 'f3c9a1e07b5d2468ace13579bdf02468';
const SECRETS = [GH, ANT, AWS, RAW, 'hunter2-correct-horse'];

function walk(dir) {
  const out = [];
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    const st = fs.lstatSync(p);
    if (st.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

function plantStores(mac) {
  const d = mac.roots.dataDir;
  put(path.join(d, 'config.json'), JSON.stringify({ sounds: true, githubToken: GH, hub: { apiKey: ANT, url: 'https://hub.example' }, note: `my key is ${AWS}`, password: 'hunter2-correct-horse', inputTokens: 1234 }));
  put(path.join(d, 'handovers', 'claude-code-1.md'), `# Handover\n\nRan with ANTHROPIC_API_KEY=${ANT} and token=${GH}.\nNext: finish the login page.\n`);
  put(path.join(d, 'sessions', 's1.json'), JSON.stringify({ sessionId: 's1', cwd: '/Users/jdoe/work', signal: 'stop', auth: { bearer: GH } }));
  put(path.join(d, 'one-key-approvals.jsonl'), `${JSON.stringify({ tool: 'Bash', summary: `curl -H "Authorization: Bearer ${GH}"` })}\n`);
  put(path.join(d, 'app.log'), `2026-10-07T09:00:51.827Z [log] [state] 3f6c8081 tool-use → stop (stop)\n2026-10-07T09:01:00.000Z [warn] [hub] retry with token=${GH}\n2026-10-07T09:02:00.000Z [log] =SUM(A1) "quoted", comma\n`);
  put(path.join(d, 'token'), RAW);
  put(path.join(d, 'approval-secret.json'), JSON.stringify({ v: 1, sealed: false, data: RAW }));
  put(path.join(d, 'cameos', 'me.png'), '\x89PNG\r\n\x1a\nfake');
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.join(d, 'memory'), { recursive: true });
  const db = new DatabaseSync(path.join(d, 'memory', 'index.db'));
  db.exec('CREATE TABLE sessions (sid TEXT, title TEXT, cost REAL); CREATE VIRTUAL TABLE turns USING fts5(sid, text);');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('s1', 'Fix login', 1.5);
  db.prepare('INSERT INTO turns VALUES (?, ?)').run('s1', `export GITHUB_TOKEN=${GH} then deploy`);
  db.close();
  put(path.join(mac.roots.userDataDir, 'work-records.json'), JSON.stringify({ records: [{ card: 'Login page', cost: 2.1, access_token: GH }] }));
  put(path.join(mac.roots.userDataDir, 'tasks', 'tasks.token'), RAW);
  put(path.join(mac.roots.userDataDir, 'buddy-accounts', 'hub.sealed'), RAW);
  put(path.join(mac.roots.userDataDir, 'Cookies'), `session=${RAW}`);
  put(path.join(mac.outside, 'notes.md'), 'outside content must not be exported');
  fs.symlinkSync(mac.outside, path.join(d, 'handovers', 'escape'));
}

test('the export holds every exportable store, with no planted credential anywhere', async (t) => {
  const mac = fakeMac();
  t.after(mac.cleanup);
  plantStores(mac);
  const out = path.join(mac.base, 'export');
  fs.mkdirSync(out);
  const r = await Export.exportData({ ...mac.roots, outDir: out, now: Date.UTC(2026, 9, 8, 12, 0), appVersion: '1.0.2' });
  const files = walk(r.dir);
  const all = files.map((f) => fs.readFileSync(f, 'latin1')).join('\n');
  for (const s of SECRETS) assert.ok(!all.includes(s), `export leaked ${s.slice(0, 12)}…`);
  assert.ok(!all.includes('outside content'), 'followed a link out of the data folder');
  const rel = files.map((f) => path.relative(r.dir, f)).sort();
  for (const want of ['README.txt', 'audit/activity-log.csv', 'settings/config.json', 'handovers/handovers/claude-code-1.md', 'sessions/sessions/s1.json', 'memory/memory/index.db.sessions.jsonl', 'memory/memory/index.db.turns.jsonl', 'work/work-records.json', 'characters/cameos/me.png', 'activity/one-key-approvals.jsonl']) {
    assert.ok(rel.includes(want), `missing ${want}; got ${rel.join(', ')}`);
  }
  for (const no of ['keys/token', 'accounts/buddy-accounts/hub.sealed', 'tasks/tasks/tasks.token', 'browser/Cookies']) assert.ok(!rel.includes(no), `${no} must not be exported`);
  const cfg = JSON.parse(fs.readFileSync(path.join(r.dir, 'settings', 'config.json'), 'utf8'));
  assert.equal(cfg.sounds, true);
  assert.equal(cfg.inputTokens, 1234);
  assert.equal(cfg.hub.url, 'https://hub.example');
  assert.match(fs.readFileSync(path.join(r.dir, 'handovers', 'handovers', 'claude-code-1.md'), 'utf8'), /finish the login page/);
  assert.match(fs.readFileSync(path.join(r.dir, 'memory', 'memory', 'index.db.sessions.jsonl'), 'utf8'), /Fix login/);
  const readme = fs.readFileSync(path.join(r.dir, 'README.txt'), 'utf8');
  for (const want of ['Settings, rules and presets', 'Memory search index', 'Keys and local tokens: keys and sign-ins are never exported', 'Window storage and caches', 'team hub', '~/.claude', 'Nothing was sent']) assert.ok(readme.includes(want), `README lacks ${want}`);
  assert.equal(r.stores.find((s) => s.id === 'keys'), undefined);
});

test('the activity log exports as CSV: header, parsed columns, escaped cells, no token', (t) => {
  const mac = fakeMac();
  t.after(mac.cleanup);
  plantStores(mac);
  const csv = Export.activityCsv(mac.roots.dataDir).trim().split('\n');
  assert.equal(csv[0], 'time,level,source,message');
  assert.equal(csv[1], '2026-10-07T09:00:51.827Z,log,state,3f6c8081 tool-use → stop (stop)');
  assert.ok(!csv.join('\n').includes(GH));
  assert.equal(csv[3], `2026-10-07T09:02:00.000Z,log,,"'=SUM(A1) ""quoted"", comma"`);
});

test('an export into one of Plexiform\'s own folders is refused', async (t) => {
  const mac = fakeMac();
  t.after(mac.cleanup);
  await assert.rejects(Export.exportData({ ...mac.roots, outDir: path.join(mac.roots.dataDir, 'x') }), /outside/);
  await assert.rejects(Export.exportData({ ...mac.roots, outDir: 'relative' }), /folder/);
});

test('redactDeep blanks credential-named fields but keeps counts', () => {
  assert.deepEqual(Export.redactDeep({ token: 'abc', input_tokens: 5, refreshToken: 'x', nested: [{ client_secret: 's' }], title: 'ok' }), { token: '[redacted]', input_tokens: 5, refreshToken: '[redacted]', nested: [{ client_secret: '[redacted]' }], title: 'ok' });
});
