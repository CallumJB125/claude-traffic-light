const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../src/deploy-status.js');
const Main = require('../src/deploy-status-main.js');
const { deployCommandOf } = require('../hooks/deploy-hint.js');
const R = require('../rules.js');
const Lane = require('../src/widget-lane-main.js');

const reader = (files) => async (rel) => (rel in files ? files[rel] : null);
const CWD = '/work/shop';

test('detects Vercel, Netlify and Cloudflare targets from the files their CLIs leave', async () => {
  const t = await D.detectTargets(CWD, reader({
    '.vercel/project.json': JSON.stringify({ projectId: 'prj_1', orgId: 'team_9', projectName: 'shop' }),
    '.netlify/state.json': JSON.stringify({ siteId: 'site-1' }),
    'wrangler.toml': 'name = "edge"\naccount_id = "acc1"\npages_build_output_dir = "dist"\n[vars]\nname = "nope"\n',
  }));
  assert.deepEqual(t.map((x) => [x.provider, x.id, x.kind || null]), [['vercel', 'prj_1', null], ['netlify', 'site-1', null], ['cloudflare', 'edge', 'pages']]);
  assert.equal(t[0].org, 'team_9');
  assert.equal(t[2].account, 'acc1');
  const w = await D.detectTargets(CWD, reader({ 'wrangler.jsonc': '{ // c\n "name": "api", }', 'netlify.toml': '' }));
  assert.deepEqual(w.map((x) => [x.provider, x.kind || null, !!x.unlinked]), [['netlify', null, true], ['cloudflare', 'workers', false]]);
  assert.deepEqual(await D.detectTargets(CWD, reader({ '.vercel/project.json': '{"projectId":"../x"}' })), [], 'ids are held to a safe shape');
});

test('pre-deploy check names .env files a deploy would upload, never their contents', () => {
  const names = ['.env', '.env.local', '.env.example', 'Dockerfile', 'src'];
  const none = D.envCheck({ names, vercel: true, files: { '.vercelignore': null, '.dockerignore': 'node_modules\n.env*\n!.env.local' } });
  assert.deepEqual(none.map((c) => [c.file, c.missing]), [['.vercelignore', ['.env', '.env.local']], ['.dockerignore', ['.env.local']]]);
  assert.match(none[0].text, /there is no such file/);
  assert.deepEqual(D.envCheck({ names, vercel: true, files: { '.vercelignore': '/.env*', '.dockerignore': '**/.env*' } }), []);
  assert.deepEqual(D.envCheck({ names: ['.env.example'], vercel: true, files: {} }), []);
});

test('host answers normalise to building / live / failed', () => {
  assert.deepEqual(D.vercelList({ deployments: [{ uid: 'dpl_1', readyState: 'ERROR', url: 'shop-x.vercel.app', createdAt: 5 }] }), [{ id: 'dpl_1', state: 'failed', url: 'https://shop-x.vercel.app', at: 5, error: null }]);
  assert.equal(D.netlifyList([{ id: 'd1', state: 'enqueued', created_at: '2026-10-19T00:00:00Z' }])[0].state, 'building');
  assert.equal(D.cloudflarePagesList({ result: [{ id: 'c1', url: 'https://a.pages.dev', latest_stage: { name: 'deploy', status: 'success' } }] })[0].state, 'live');
  assert.equal(D.cloudflarePagesList({ result: [{ id: 'c2', latest_stage: { name: 'build', status: 'failure' } }] })[0].state, 'failed');
  const table = D.vercelTable('  Age  Deployment  Status\n  2m   https://shop-abc.vercel.app   ● Building  Preview\n  1h   https://shop-old.vercel.app   ● Ready  Production\n');
  assert.deepEqual(table.map((d) => d.state), ['building', 'live']);
});

test('build logs become one plain-English line', () => {
  assert.match(D.summarise(['x', "Module not found: Error: Can't resolve './Nav' in '/vercel/path0/src'"]), /imports "\.\/Nav"/);
  assert.match(D.summarise(['Type error: Property \'x\' does not exist']), /^TypeScript stopped the build/);
  assert.match(D.summarise(['npm ERR! Missing script: "build"']), /no "build" script/);
  assert.match(D.summarise(['Error: Command "npm run build" exited with 1']), /exit code 1/);
  assert.match(D.summarise([], 'Build script returned non-zero exit code: 2'), /^The deploy failed: Build script/);
  assert.match(D.summarise(['all good', 'something odd']), /did not say why/);
  const prompt = D.errorPrompt({ provider: 'vercel', name: 'shop', summary: 'S', logTail: ['token=abc', 'boom'] }, (t) => t.replace('abc', '[redacted]'));
  assert.match(prompt, /My Vercel deploy of shop just failed/);
  assert.match(prompt, /token=\[redacted\]\nboom/);
});

test('polling backs off on errors and waits long when no CLI or token is there', () => {
  assert.equal(D.nextDelay({ state: 'ok' }), D.IDLE_MS);
  assert.equal(D.nextDelay({ state: 'ok', building: true }), D.BUSY_MS);
  assert.equal(D.nextDelay({ state: 'ok', hinted: true }), D.BUSY_MS);
  assert.equal(D.nextDelay({ state: 'no-cli' }), D.UNAVAILABLE_MS);
  assert.equal(D.nextDelay({ state: 'backoff', failures: 3 }), 240000);
  assert.equal(D.nextDelay({ state: 'backoff', failures: 20 }), 30 * 60 * 1000);
});

// A fake world: one Vercel project, a clock, and a scripted host.
function world({ token = null, script }) {
  let t = Date.parse('2026-10-19T12:00:00Z');
  const calls = [];
  const target = { provider: 'vercel', id: 'prj_1', org: 'team_9', name: 'shop', cwd: CWD };
  let online = true;
  const w = D.create({
    now: () => t,
    online: () => online,
    tokens: () => (token ? { vercel: token } : {}),
    detect: async () => [target],
    check: async () => [{ file: '.vercelignore', missing: ['.env'], text: '.env is not in .vercelignore' }],
    http: async (url, tok) => { calls.push(['http', url, tok]); return script.http(url, t); },
    run: async (bin, args, opts) => { calls.push(['run', bin, args, opts.cwd]); return script.run(bin, args, t); },
  });
  return { w, calls, advance: (ms) => { t += ms; }, now: () => t, setOnline: (v) => { online = v; } };
}

test('a deploy seen building then ready fires deploy-live once, with its URL', async () => {
  let state = 'BUILDING';
  const env = world({ token: 'tok', script: { http: (url, t) => ({ status: 200, body: { deployments: [{ uid: 'dpl_1', readyState: state, url: 'shop-1.vercel.app', createdAt: t - 1000 }] } }) } });
  assert.deepEqual(await env.w.tick({ sessions: [{ cwd: CWD }] }), []);
  assert.match(env.calls[0][1], /^https:\/\/api\.vercel\.com\/v6\/deployments\?projectId=prj_1&limit=5&teamId=team_9$/);
  assert.equal(env.calls[0][2], 'tok');
  assert.equal(env.w.status()[0].state, 'building');
  env.advance(D.BUSY_MS);
  state = 'READY';
  const fired = await env.w.tick({ sessions: [{ cwd: CWD }] });
  assert.deepEqual(fired.map((e) => [e.signal, e.url, e.title]), [['deploy-live', 'https://shop-1.vercel.app', 'Vercel · shop']]);
  assert.equal(env.w.active().length, 1);
  env.advance(D.IDLE_MS);
  assert.deepEqual(await env.w.tick({ sessions: [{ cwd: CWD }] }), [], 'fires once');
  assert.equal(env.w.active().length, 0, 'held for a couple of minutes only');
  const row = env.w.status()[0];
  assert.equal(row.state, 'live');
  assert.equal(env.w.urlFor(row.handle), 'https://shop-1.vercel.app');
  assert.deepEqual(row.checks.map((c) => c.missing), [['.env']]);
});

test('a failed deploy fetches the log tail, explains it and builds the prompt', async () => {
  const env = world({ token: 'tok', script: { http: (url, t) => (url.includes('/events')
    ? { status: 200, body: [{ type: 'stderr', text: 'Error: Command "npm run build" exited with 1' }, { type: 'stderr', text: "Module not found: Can't resolve 'lodash'" }] }
    : { status: 200, body: { deployments: [{ uid: 'dpl_2', readyState: 'ERROR', url: 'shop-2.vercel.app', createdAt: t - 60000 }] } }) } });
  const fired = await env.w.tick({ sessions: [{ cwd: CWD }] });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].signal, 'deploy-failed');
  assert.match(fired[0].summary, /lodash/);
  const row = env.w.status()[0];
  assert.equal(row.state, 'failed');
  assert.equal(row.url, null);
  assert.match(env.w.prompt(row.handle), /```\n[\s\S]*lodash[\s\S]*```/);
  assert.equal(env.w.prompt('vercel:other'), null);
});

test('without a token the signed-in CLI is used; no CLI means a long rest, offline means no calls', async () => {
  const env = world({ script: { run: (bin) => (bin === 'vercel' ? { notFound: true, code: 1, stdout: '', stderr: '' } : null) } });
  await env.w.tick({ sessions: [{ cwd: CWD }] });
  assert.deepEqual(env.calls[0].slice(0, 4), ['run', 'vercel', ['ls'], CWD]);
  assert.match(env.w.status()[0].problem, /Install the vercel CLI/);
  env.advance(D.IDLE_MS);
  await env.w.tick({ sessions: [{ cwd: CWD }] });
  assert.equal(env.calls.length, 1, 'rests for half an hour');
  env.advance(D.UNAVAILABLE_MS);
  env.setOnline(false);
  await env.w.tick({ sessions: [{ cwd: CWD }] });
  assert.equal(env.calls.length, 1, 'offline: nothing asked');
  assert.deepEqual(await env.w.tick({ sessions: [{ cwd: CWD }], enabled: false }), []);
});

test('a session that just ran a deploy is looked at again within seconds', async () => {
  const env = world({ token: 'tok', script: { http: () => ({ status: 200, body: { deployments: [] } }) } });
  await env.w.tick({ sessions: [{ cwd: CWD }] });
  env.advance(D.BUSY_MS);
  await env.w.tick({ sessions: [{ cwd: CWD }] });
  assert.equal(env.calls.length, 1, 'idle projects wait five minutes');
  await env.w.tick({ sessions: [{ cwd: CWD, deployAt: new Date(env.now()).toISOString() }] });
  assert.equal(env.calls.length, 2);
});

test('a refused token and HTTP errors back off instead of hammering', async () => {
  let status = 500;
  const env = world({ token: 'tok', script: { http: () => ({ status, body: null }) } });
  await env.w.tick({ sessions: [{ cwd: CWD }] });
  env.advance(30000);
  await env.w.tick({ sessions: [{ cwd: CWD }] });
  assert.equal(env.calls.length, 1, 'first backoff is a minute');
  status = 401;
  env.advance(60000);
  await env.w.tick({ sessions: [{ cwd: CWD }] });
  assert.match(env.w.status()[0].problem, /Sign in to the vercel CLI, or paste a token/);
});

test('the hook spots deploy commands and keeps only the host', () => {
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
  assert.equal(deployCommandOf(bash('vercel --prod')), 'vercel');
  assert.equal(deployCommandOf(bash('npx vercel deploy')), 'vercel');
  assert.equal(deployCommandOf(bash('vercel')), 'vercel');
  assert.equal(deployCommandOf(bash('vercel ls')), null);
  assert.equal(deployCommandOf(bash('netlify deploy --prod')), 'netlify');
  assert.equal(deployCommandOf(bash('npx wrangler pages deploy dist')), 'cloudflare');
  assert.equal(deployCommandOf(bash('wrangler dev')), null);
  assert.equal(deployCommandOf({ tool_name: 'Read', tool_input: { command: 'vercel' } }), null);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'set-status.js'), 'utf8'), /deployAt: \(resolved === 'tool-done' \|\| resolved === 'tool-failed'\) && deployCommandOf\(data\) \? now : prev\?\.deployAt/);
});

test('deploy-live and deploy-failed are rule triggers; live also celebrates as deploy-finished', () => {
  const ids = R.SIGNALS.map((s) => s.id);
  assert.ok(ids.includes('deploy-live') && ids.includes('deploy-failed'));
  const s = R.gitSessions({ git: [{ signal: 'deploy-live', cwd: CWD, provider: 'vercel' }] });
  assert.deepEqual(s.map((x) => x.signal), ['deploy-live', 'deploy-finished']);
  const { look } = R.resolve(R.defaultRules(), [], Date.now(), { git: [{ signal: 'deploy-live', cwd: CWD }] });
  assert.equal(look.pose, 'party');
});

test('the widget lane shows a live deploy and a hosted failure with its summary', () => {
  let events = [];
  const w = Lane.createWatcher({ state: () => ({ sessions: [] }), git: { active: () => events } }, { now: () => 1000 });
  w.observe();
  events = [
    { id: 'host:vercel:d1:deploy-live', signal: 'deploy-live', provider: 'vercel', title: 'Vercel · shop' },
    { id: 'host:netlify:d2:deploy-failed', signal: 'deploy-failed', provider: 'netlify', title: 'Netlify · blog', summary: 'The build ran out of time on the host.' },
  ];
  const got = w.observe().events.map((e) => [e.kind, e.text]);
  assert.deepEqual(got, [['deployed', 'Live · Vercel · shop'], ['ci-failed', 'Deploy failed · Netlify · blog · The build ran out of time on the host.']]);
});

// ── main side ──
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`sealed:${s}`), decryptString: (b) => String(b).replace(/^sealed:/, '') };

test('tokens are sealed on disk, never returned to a page, and removable', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-')), 'deploy-status.json');
  const store = Main.createStore({ file, safeStorage: fakeSafe });
  assert.equal(store.save('vercel', 'abc123').ok, true);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('abc123'), 'not in the clear');
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  assert.deepEqual(store.saved(), { vercel: true, netlify: false, cloudflare: false });
  assert.deepEqual(store.tokens(), { vercel: 'abc123' });
  store.remove('vercel');
  assert.deepEqual(store.tokens(), {});
  assert.equal(Main.createStore({ file, safeStorage: { isEncryptionAvailable: () => false } }).save('vercel', 'x').ok, false);
});

test('the HTTP side only talks to the three API hosts, with a bearer token', async () => {
  const seen = [];
  const http = Main.httpWith(async (url, opts) => { seen.push([url, opts.headers.Authorization, opts.redirect]); return { status: 200, json: async () => ({ ok: 1 }) }; });
  assert.deepEqual(await http('https://api.netlify.com/api/v1/sites/s/deploys', 't1'), { status: 200, body: { ok: 1 } });
  assert.deepEqual(seen, [['https://api.netlify.com/api/v1/sites/s/deploys', 'Bearer t1', 'error']]);
  await assert.rejects(http('https://evil.example/x', 't1'));
  await assert.rejects(http('http://api.vercel.com/x', 't1'));
});

test('IPC answers only its own pages, and copies the prompt to the clipboard', async () => {
  const handlers = new Map();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-')), 'deploy-status.json');
  const copied = [];
  const home = { id: 'home' };
  const settings = { id: 'settings' };
  const d = Main.install({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, file, safeStorage: fakeSafe, fetch: async () => ({ status: 200, json: async () => ({}) }), clipboard: { writeText: (t) => copied.push(t) }, shell: { openExternal: async () => {} }, sessions: () => [], online: () => true, allowedHome: (e) => e.sender === home, allowedSettings: (e) => e.sender === settings, paused: true });
  assert.equal(handlers.get('home:deploys')({ sender: settings }), null);
  assert.deepEqual(handlers.get('home:deploys')({ sender: home }), { rows: [] });
  assert.deepEqual(await handlers.get('home:deploy-act')({ sender: home }, 'copy-prompt', 'vercel:nope'), { ok: false, error: 'That deploy is no longer failing.' });
  assert.deepEqual(await handlers.get('home:deploy-act')({ sender: home }, 'rm', 'x'), { ok: false });
  assert.equal(handlers.get('deploy:settings')({ sender: home }), null);
  assert.deepEqual(handlers.get('deploy:token-save')({ sender: settings }, 'vercel', 'two words'), { ok: false, error: 'Paste the token on its own.' });
  assert.deepEqual(handlers.get('deploy:token-save')({ sender: settings }, 'heroku', 'x'), { ok: false });
  assert.deepEqual(handlers.get('deploy:token-save')({ sender: settings }, 'vercel', 'tok'), { ok: true });
  assert.deepEqual(handlers.get('deploy:settings')({ sender: settings }), { enabled: true, saved: { vercel: true, netlify: false, cloudflare: false } });
  assert.deepEqual(handlers.get('deploy:set-enabled')({ sender: settings }, false), { ok: true, enabled: false });
  assert.equal(handlers.get('home:deploys')({ sender: home }), null, 'off: Home shows nothing');
  assert.deepEqual(d.active(), []);
  assert.equal(copied.length, 0);
});

test('the Home section and Settings fields are wired and packaged', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('home.html'), /id="deploys"[\s\S]*home-deploys-view\.js/);
  assert.match(read('settings.html'), /id="deploySignals"[\s\S]*settings-deploys\.js/);
  const files = JSON.parse(read('package.json')).build.files;
  assert.ok(files.includes('home-deploys-view.js') && files.includes('settings-deploys.js'));
  assert.match(read('board/CONTRACT.md'), /`home:deploy-act`/);
  assert.match(read('PRIVACY.md'), /flow:deploy-status/);
});
