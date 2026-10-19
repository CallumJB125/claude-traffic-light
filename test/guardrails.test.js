const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const G = require('../src/guardrails.js');
const { createGuardrails } = require('../src/guardrails-main.js');
const CheckpointGit = require('../src/checkpoint-git.js');

const ROOT = path.join(__dirname, '..');
const OPENAI = 'sk-proj-' + 'abcdEFGH1234ijklMNOP5678qrstUVWX9012yzab';
const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2lnbmF0dXJlc2lnbmF0dXJl`;
const lines = (file, text) => text.split('\n').map((t, i) => ({ file, line: i + 1, text: t }));
const opts = { salt: 'salt', repo: '/r', turn: 4, sessionId: 's1' };

test('addedLines keeps only added lines with new-file line numbers', () => {
  const d = 'diff --git a/a b/a\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,3 @@\n keep\n+added\n-gone\n keep2\n+more\n--- a/old\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n';
  assert.deepEqual(G.addedLines(d), [{ file: 'a.js', line: 2, text: 'added' }, { file: 'a.js', line: 4, text: 'more' }]);
});

test('a secret a turn added becomes a finding with a redacted preview and never the key', () => {
  const [f] = G.secretFindings(lines('src/a.js', `const k = "${OPENAI}";`), opts);
  assert.equal(f.type, 'secret');
  assert.equal(f.title, 'Turn 4 added what looks like an OpenAI key at src/a.js:1');
  assert.equal(f.rotate, 'https://platform.openai.com/api-keys');
  assert.ok(!JSON.stringify(f).includes(OPENAI.slice(4)), 'the key must not be stored');
  assert.match(f.preview, /sk-p•+ \(48 characters\)/);
  // Stable: same key, same file, other line → same id; other salt → other id.
  const [moved] = G.secretFindings([{ file: 'src/a.js', line: 9, text: `x=${OPENAI}` }], opts);
  assert.equal(moved.id, f.id);
  assert.notEqual(G.secretFindings(lines('src/a.js', OPENAI), { ...opts, salt: 'other' })[0].id, f.id);
});

test('public keys are not secrets: anon JWTs, publishable keys', () => {
  assert.deepEqual(G.secretFindings(lines('a.js', `const k = "${jwt({ role: 'anon', iss: 'supabase' })}"`), opts), []);
  assert.deepEqual(G.browserFindings(lines('.env', `NEXT_PUBLIC_SUPABASE_ANON_KEY=${jwt({ role: 'anon' })}`), opts), []);
  assert.deepEqual(G.browserFindings(lines('.env', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_' + 'abcdefghijklmnop1234'), opts), []);
  assert.deepEqual(G.browserFindings(lines('.env', 'VITE_API_URL=https://example.com/api'), opts), []);
});

test('secrets behind browser-exposed names and service_role in client code are flagged', () => {
  const b = G.browserFindings(lines('.env.local', 'NEXT_PUBLIC_STRIPE_SECRET=sk_live_' + '51Habcdefghijklmnopqrstuvwx'), opts);
  assert.equal(b.length, 1);
  assert.match(b[0].title, /NEXT_PUBLIC_STRIPE_SECRET is sent to every visitor's browser/);
  assert.match(b[0].fix, /Anything named NEXT_PUBLIC_… is copied/);
  const svc = jwt({ role: 'service_role' });
  const v = G.browserFindings(lines('.env', `VITE_SUPABASE_KEY=${svc}`), opts);
  assert.equal(v[0].kind, 'supabase_service_role');
  const c = G.browserFindings(lines('src/components/List.tsx', `createClient(url, "${svc}")`), opts);
  assert.match(c[0].title, /service_role key is in code that runs in the browser/);
  assert.deepEqual(G.browserFindings(lines('supabase/functions/admin/index.ts', `createClient(url, "${svc}")`), opts), []);
  assert.equal(G.browserFindings(lines('src/app.tsx', 'const k = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY'), opts).length, 1);
  assert.equal(G.secretFindings(lines('a.js', svc), opts)[0].kind, 'supabase_service_role');
});

test('database rules that only look locked', () => {
  const sql = 'create table public.notes (id int);\ncreate table todos (id int);\nalter table todos enable row level security;\ncreate policy "all" on todos using (true);\ncreate policy "admin" on todos using ((auth.jwt() -> \'user_metadata\' ->> \'role\') = \'admin\');';
  const f = G.dbFindings(lines('supabase/migrations/001_init.sql', sql), opts);
  const kinds = f.map((x) => x.kind.split(':')[0]).sort();
  assert.deepEqual(kinds, ['no-rls', 'user-metadata', 'using-true']);
  assert.match(f.find((x) => x.kind.startsWith('no-rls')).fix, /ALTER TABLE notes ENABLE ROW LEVEL SECURITY/);
  const fr = G.dbFindings(lines('firestore.rules', "match /{doc=**} {\n  allow read, write: if true;\n}"), opts);
  assert.equal(fr.length, 1);
  assert.match(fr[0].title, /lets anyone in/);
  assert.deepEqual(G.dbFindings(lines('storage.rules', 'allow read: if request.auth != null;'), opts), []);
  assert.deepEqual(G.dbFindings(lines('src/db.sql', 'using (true)'), opts), [], 'only rule files');
});

test('.env files git would share, by name only; examples are fine', () => {
  const f = G.envFindings({ tracked: ['.env', 'apps/web/.env.example'], exposed: ['apps/web/.env.local'] }, opts);
  assert.deepEqual(f.map((x) => [x.file, x.kind]), [['.env', 'tracked'], ['apps/web/.env.local', 'exposed']]);
  assert.match(f[0].fix, /git rm --cached \.env/);
});

test('commands that cannot be taken back, with their target', () => {
  const d = (cmd) => G.destructive('Bash', { command: cmd, description: 'rm -rf /' });
  assert.deepEqual(d('rm -rf ./dist'), { shape: 'delete folders for good (rm -rf)', target: './dist' });
  assert.equal(d('git push --force origin main').target, 'origin main');
  assert.match(d('git reset --hard HEAD~2').shape, /git reset --hard/);
  assert.match(d('npx prisma migrate reset').shape, /prisma migrate reset/);
  assert.equal(d('supabase db reset --linked').target, 'the linked (remote) database');
  assert.match(d('vercel deploy --prod').shape, /production deploy/);
  assert.match(d('psql -c "DROP TABLE users"').shape, /DROP/);
  assert.equal(G.destructive('mcp__supabase__execute_sql', { query: 'truncate table orders' }).target, 'orders');
  for (const safe of ['rm file.txt', 'git push origin main', 'git reset HEAD file', 'ls -la', 'supabase db diff', 'vercel']) assert.equal(d(safe), null, safe);
  assert.equal(G.destructive('Read', { file_path: '/x' }), null);
});

test('reconcile: new, kept, resolved on rescan, dismissed stays', () => {
  const a = { id: 'a', type: 'secret', file: 'x.js' }, b = { id: 'b', type: 'secret', file: 'y.js' };
  let s = G.reconcile({}, [a, b], { repo: '/r', types: ['secret'], now: 1 });
  assert.equal(s.a.status, 'new');
  s.a.status = 'open'; s.b.status = 'dismissed';
  s = G.reconcile(s, [a], { repo: '/r', types: ['secret'], now: 2 });
  assert.equal(s.a.status, 'open');
  assert.equal(s.b.status, 'dismissed');
  s = G.reconcile(s, [], { repo: '/r', types: ['secret'], files: new Set(['y.js']), now: 3 });
  assert.equal(s.a.status, 'open', 'out of the file scope');
  s = G.reconcile(s, [], { repo: '/r', types: ['secret'], now: 4 });
  assert.equal(s.a.status, 'resolved');
  s = G.reconcile(s, [a], { repo: '/r', types: ['secret'], now: 5 });
  assert.equal(s.a.status, 'new', 'back again');
});

const gitBin = CheckpointGit.findGit();
test('end to end: a turn that adds a key and a tracked .env, then a fix', { skip: !gitBin }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'repo-')));
  const data = path.join(tmp, 'data');
  const g = (...a) => execFileSync(gitBin, ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  g('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.js'), 'ok\n');
  g('add', '.'); g('commit', '-qm', 'x');
  const git = CheckpointGit.createGit({ bin: gitBin });
  const r = await git.repoOf(repo);
  const before = await git.snapshot(r, { message: 'plexiform checkpoint start' });
  fs.writeFileSync(path.join(repo, 'a.js'), `ok\nconst k = "${OPENAI}";\n`);
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=never-read-this-value-123\n');
  g('add', '-f', '.env');
  const after = await git.snapshot(r, { message: 'plexiform checkpoint end' });
  let notified = 0;
  const restored = [];
  const gr = createGuardrails({ rootDir: data, git, notify: () => { notified += 1; }, confirm: async () => true, checkpoints: () => ({ restore: async (sid, t) => { restored.push([sid, t]); return { ok: true }; } }) });
  await gr.onTurnEnd({ sessionId: 's1', top: repo, turn: 2, before, after });
  const look = gr.applyLamp({ lamp: 'green' }, []);
  assert.equal(look.lamp, 'red', 'a new leak turns the lamp red');
  const v = gr.list();
  const secret = v.findings.find((f) => f.type === 'secret');
  assert.equal(secret.title, 'Turn 2 added what looks like an OpenAI key at a.js:2');
  assert.ok(secret.canRestore && secret.canRotate);
  assert.ok(v.findings.some((f) => f.type === 'env' && f.title === '.env is saved in git'));
  const stored = fs.readFileSync(path.join(data, 'guardrails', 'findings.json'), 'utf8');
  assert.ok(!stored.includes(OPENAI.slice(8)) && !stored.includes('never-read-this-value'), 'no secret on disk');
  assert.equal(gr.applyLamp({ lamp: 'green' }, []).lamp, 'green', 'seen on Home: lamp back to normal');
  assert.deepEqual(await gr.act(secret.id, 'restore'), { ok: true, note: 'Files are back to how they were before turn 2. The key may already have been seen, so still make a new one.' });
  assert.deepEqual(restored, [['s1', { turn: 2, which: 'before' }]]);
  fs.writeFileSync(path.join(repo, 'a.js'), 'ok\n');
  await gr.act(secret.id, 'recheck');
  assert.equal(gr.list().findings.find((f) => f.id === secret.id).status, 'resolved');
  assert.ok(notified > 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a destructive permission request turns the lamp red and saves a restore point when they are on', { skip: !gitBin }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'repo-')));
  execFileSync(gitBin, ['-C', repo, 'init', '-q']);
  fs.writeFileSync(path.join(repo, 'f'), 'x');
  const data = path.join(tmp, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'checkpoints.json'), '{"enabled":true}');
  const git = CheckpointGit.createGit({ bin: gitBin });
  let done;
  const saved = new Promise((r) => { done = r; });
  const gr = createGuardrails({ rootDir: data, git, notify: () => done() });
  const req = { id: 'r1', sessionId: 's9', cwd: repo, tool: 'Bash', toolInput: { command: 'git reset --hard' } };
  assert.equal(gr.applyLamp({ lamp: 'amber' }, [req]).lamp, 'red');
  assert.equal(gr.applyLamp({ lamp: 'amber' }, [{ ...req, id: 'r2', toolInput: { command: 'ls' } }]).lamp, 'amber');
  gr.applyLamp({ lamp: 'amber' }, [req]);
  await saved;
  const refs = execFileSync(gitBin, ['-C', repo, 'for-each-ref', 'refs/plexiform/cp/s9/'], { encoding: 'utf8' });
  assert.match(refs, /refs\/plexiform\/cp\/s9\/safety-\d+/);
  const careful = gr.list().careful;
  assert.equal(careful[0].title, 'Approve with care: throw away unsaved changes (git reset --hard)');
  assert.match(careful[0].note, /restore point was saved/);
  assert.ok(!JSON.stringify(careful).includes(repo), 'no paths to the page');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('database rules are opt-in per project', { skip: !gitBin }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'repo-')));
  execFileSync(gitBin, ['-C', repo, 'init', '-q']);
  fs.writeFileSync(path.join(repo, 'firestore.rules'), 'allow read, write: if true;\n');
  const gr = createGuardrails({ rootDir: path.join(tmp, 'data'), git: CheckpointGit.createGit({ bin: gitBin }) });
  await gr.scanRepo(repo, ['firestore.rules'], { dbFiles: ['firestore.rules'] });
  let v = gr.list();
  assert.equal(v.findings.length, 0);
  assert.equal(v.offers.length, 1);
  assert.deepEqual(await gr.act(v.offers[0].id, 'db-on'), { ok: true });
  v = gr.list();
  assert.equal(v.offers.length, 0);
  assert.equal(v.findings[0].type, 'db');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('wiring: main.js one-line install, Home page, preload, contract and privacy', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const main = read('main.js');
  assert.equal(main.match(/guardrails-main\.js/g).length, 2);
  assert.match(read('home.html'), /<section id="guardrails"/);
  assert.match(read('home.html'), /home-guardrails-view\.js/);
  assert.match(read('home-preload.js'), /guardrails:list/);
  assert.ok(require('../package.json').build.files.includes('home-guardrails-view.js'));
  const contract = read('board/CONTRACT.md');
  for (const ch of ['guardrails:list', 'guardrails:act']) assert.match(contract, new RegExp(`\`${ch}\``));
  assert.match(read('PRIVACY.md'), /flow:guardrails-rotate-link files=src\/guardrails-main\.js/);
  assert.match(read('src/checkpoints.js'), /events\.emit\('turn-end'/);
});
