'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Demo = require('../src/demo-mode.js');
const Home = require('../src/home-main.js');
const Recipes = require('../src/recipes.js');

const ROOT = path.join(__dirname, '..');

function tree(dir) {
  const out = {};
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n), st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = `${st.size}:${st.mtimeMs}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
    }
  })(dir);
  return out;
}

// A fake home with real-looking stores in it.
function seededHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-demo-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, '.claude-traffic-light');
  for (const [rel, text] of [['sessions/abc.json', '{"sessionId":"abc"}'], ['config.json', '{"dailyBudget":10}'], ['spend-snapshot.json', '{"day":1}'], ['handovers/claude-code-abc.md', '# Handover'], ['recipes/my-x.json', '{}'], ['tasks-seen.json', '{}']]) {
    fs.mkdirSync(path.dirname(path.join(data, rel)), { recursive: true });
    fs.writeFileSync(path.join(data, rel), text);
  }
  return { home, data };
}

const NETWORK = ['http', 'https', 'net', 'tls', 'dgram'];
function watchWrites(t) {
  const hits = [];
  const restore = [];
  const spy = (mod, name, label) => { const orig = mod[name]; mod[name] = function (...a) { hits.push(`${label}.${name}`); return orig.apply(this, a); }; restore.push(() => { mod[name] = orig; }); };
  for (const n of ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'copyFileSync', 'writeFile', 'appendFile', 'rename', 'mkdir', 'rm', 'unlink']) spy(fs, n, 'fs');
  for (const n of ['writeFile', 'appendFile', 'rename', 'mkdir', 'rm', 'unlink']) spy(fs.promises, n, 'fs.promises');
  for (const m of NETWORK) { const mod = require(m); for (const n of ['request', 'get', 'connect', 'createConnection', 'createSocket']) if (typeof mod[n] === 'function') spy(mod, n, m); }
  t.after(() => restore.forEach((r) => r()));
  return hits;
}

test('the fixtures are clearly sample data: realistic sessions, a question, spend and a sample board', () => {
  const s = Demo.fixtures(1000);
  assert.equal(s.demo, true);
  assert.ok(s.running.items.length >= 3);
  assert.ok(s.running.items.some((i) => i.status === 'Waiting on you'));
  assert.equal(s.needs.total, 1);
  assert.ok(s.today.spend.spent > 0);
  assert.ok(s.team.cards.length && s.team.cards.every((c) => c.board === 'Sample board' && c.key.startsWith('DEMO-')));
  assert.doesNotMatch(JSON.stringify(s), /\/Users\/|\/home\/|@/, 'no real paths or addresses');
});

test('the demo module reaches nothing: no fs, process, or network module is required', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'demo-mode.js'), 'utf8');
  assert.deepEqual([...src.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]), []);
  const banner = fs.readFileSync(path.join(ROOT, 'demo-banner.js'), 'utf8');
  assert.doesNotMatch(banner, /fetch\(|XMLHttpRequest|WebSocket|localStorage|innerHTML/);
});

test('Home in the demo answers from fixtures only, never reads the real stores, and Exit demo restores the real view', async () => {
  const handlers = new Map(), reads = [];
  const demo = Demo.create();
  Home.register({
    ipcMain: { handle: (c, f) => handlers.set(c, f) }, allowed: () => true, demo, now: () => 5000,
    state: () => { reads.push('state'); return { sessions: [], inputs: [], spend: null }; },
    localSessions: (s) => s, tools: () => { reads.push('tools'); return [{ id: 'claude', installed: true, connected: false }]; },
    myDay: { snapshot: async () => { reads.push('myday'); return { sources: [] }; }, open: async () => { reads.push('open'); return true; } },
    morning: () => { reads.push('morning'); return { state: () => null, markSeen: () => { reads.push('seen'); return true; } }; },
    costGuard: () => { reads.push('cost'); return null; }, openPage() {}, openAiTools() {},
  });
  const real = await handlers.get('home:state')({});
  assert.equal(real.demo, undefined);
  assert.equal(real.canDemo, true, 'nothing connected: Home offers the demo');
  reads.length = 0;
  demo.start();
  const s = await handlers.get('home:state')({});
  assert.deepEqual(s, Demo.fixtures(5000));
  assert.equal(await handlers.get('home:open-card')({}, 'demo-1'), false);
  assert.equal(await handlers.get('home:morning-seen')({}), false);
  assert.deepEqual(reads, [], 'no real store was read while the demo was on');
  demo.exit();
  const back = await handlers.get('home:state')({});
  assert.equal(back.demo, undefined);
  assert.ok(reads.includes('state'));
});

test('Home offers the demo only when no AI tool is connected', async () => {
  const run = async (rows) => {
    const handlers = new Map();
    Home.register({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, allowed: () => true, demo: Demo.create(), state: () => null, localSessions: () => [], tools: () => rows, myDay: { snapshot: async () => ({ sources: [] }) }, morning: () => null, openPage() {}, openAiTools() {}, now: () => 1 });
    return (await handlers.get('home:state')({})).canDemo;
  };
  assert.equal(await run([]), true);
  assert.equal(await run([{ id: 'codex', installed: true, connected: true }]), false);
  const handlers = new Map();
  Home.register({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, allowed: () => true, state: () => null, localSessions: () => [], tools: () => [], myDay: { snapshot: async () => ({ sources: [] }) }, morning: () => null, openPage() {}, openAiTools() {}, now: () => 1 });
  assert.equal((await handlers.get('home:state')({})).canDemo, false, 'no demo wired, no button');
});

test('isolation: a whole demo visit (start, Home, Tasks recipes, Exit) writes nothing, opens no connection, and leaves every real store byte-for-byte', async (t) => {
  const { home, data } = seededHome(t);
  const before = tree(home);
  const handlers = new Map();
  const ipcMain = { handle: (c, f) => handlers.set(c, f) };
  const demo = Demo.create();
  Demo.register({ ipcMain, demo, allowed: (e) => ['home', 'tasks', 'help'].includes(e.page) });
  Home.register({ ipcMain, allowed: (e) => e.page === 'home', demo, state: () => assert.fail('real state read'), localSessions: (s) => s, tools: () => [], myDay: { snapshot: async () => assert.fail('real board read'), open: async () => assert.fail('real card opened') }, morning: () => assert.fail('real morning read'), openPage() {}, openAiTools() {} });
  const created = [];
  Recipes.register({
    ipcMain, allowed: (e) => e.page === 'tasks', home, demo: () => demo.active(),
    recipes: Recipes.create({ builtInDir: path.join(ROOT, 'recipes'), dataDir: path.join(data, 'recipes'), home }),
    tasks: () => ({ folderOf: () => home, create: async (d) => { created.push(d); return { ok: true }; }, composerInfo: async () => ({ canSchedule: true }) }),
    confirm: async () => assert.fail('no dialog in the demo'), pickSave: async () => assert.fail('no save dialog'), pickOpen: async () => assert.fail('no open dialog'), readFile: () => null, writeFile: () => assert.fail('no write'),
  });
  const hits = watchWrites(t);
  const call = (ch, page, ...a) => handlers.get(ch)({ page }, ...a);
  assert.equal(await call('demo:start', 'memory'), null, 'only Home, Tasks and Help can start it');
  assert.deepEqual(await call('demo:start', 'help'), { active: true });
  assert.deepEqual(await call('demo:state', 'tasks'), { active: true });
  const s = await call('home:state', 'home');
  assert.equal(s.demo, true);
  assert.equal(await call('home:open-card', 'home', 'demo-1'), false);
  assert.equal(await call('home:morning-seen', 'home'), false);
  assert.equal((await call('recipes:list', 'tasks')).demo, true);
  assert.match((await call('recipes:run', 'tasks', 'weekly-report', 'h', 'now')).error, /demo/);
  assert.match((await call('recipes:export', 'tasks')).error, /demo/);
  assert.match((await call('recipes:import', 'tasks')).error, /demo/);
  assert.deepEqual(await call('demo:exit', 'tasks'), { active: false });
  assert.deepEqual(hits, [], 'no file write and no network call during the demo');
  assert.deepEqual(created, [], 'no task was started');
  assert.deepEqual(tree(home), before, 'every real store is untouched');
});

test('the pages carry the banner and the way in: Home, Tasks, Help', () => {
  for (const f of ['home.html', 'tasks.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(html, /demo-banner\.js/, f); assert.match(html, /demo-banner\.css/, f);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'help.html'), 'utf8'), /id="start-demo"[^>]*>Try the demo</);
  assert.match(fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'), /destination === 'demo'\) \{ Demo\.start\(\); openBuddy\('home'\)/);
  for (const f of ['home-preload.js', 'tasks-preload.js']) assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /exposeInMainWorld\('demoApi'/);
});
