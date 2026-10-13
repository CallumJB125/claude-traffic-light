'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Digest = require('../src/digest.js');
const Delivery = require('../src/digest-delivery.js');

const NOW = new Date(2026, 9, 8, 19, 30).getTime();
const H = 3600_000;
const HOME = '/Users/alice';
const opts = { home: HOME, username: 'alice' };
const turn = (msAgo, model = 'claude-sonnet-4-5', out = 1000) => ({ ts: NOW - msAgo, modelKey: model === 'mystery' ? null : model.includes('opus') ? 'opus' : 'sonnet', model, input: 1000, output: out, cacheRead: 0, cacheWrite: 0, cwd: `${HOME}/code/shop` });
const task = (o) => ({ id: 'tsk_1', title: 'Fix login', state: 'in_review', stateSince: NOW - H, ...o });
const record = (o) => ({ record_id: 'i:claude:s1', adapter: 'claude', folder: 'shop', branch: 'fix-cart', status: 'review', title: 'please refactor the secret billing code in /Users/alice/code/shop/billing.js', goal: 'please refactor the secret billing code', updated_at: new Date(NOW - 2 * H).toISOString(), ...o });
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('an empty day reads as a quiet day with no spend', () => {
  const d = Digest.compose(Digest.gather({ period: 'day', now: NOW, ...opts }));
  assert.equal(d.title, `Your daily digest, ${new Date(NOW).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}`);
  assert.deepEqual(d.sections.map((s) => s.id), ['quiet', 'spend']);
  assert.match(d.text, /A quiet day: nothing finished and nothing is waiting on you\./);
  assert.match(d.text, /No AI spend recorded today\./);
  assert.equal(d.team, null);
  assert.equal(Digest.compose(Digest.gather({ period: 'day', now: NOW, ...opts })).text, d.text, 'deterministic');
});

test('a busy day lists what finished and what is stuck, with spend, savings and waste, and no prompts or paths', () => {
  const data = Digest.gather({
    period: 'day', now: NOW, ...opts,
    tasks: [task({}), task({ id: 'tsk_2', title: 'Ship docs', state: 'done', stateSince: NOW - 3 * H }), task({ id: 'tsk_3', title: 'Migrate db', state: 'blocked', openAsk: { text: 'Which db?' } }),
      task({ id: 'tsk_4', title: 'Old', state: 'done', stateSince: NOW - 30 * H }), task({ id: 'tsk_5', title: 'Broken build', state: 'failed', stateSince: NOW - 4 * H })],
    records: [record({}), record({ record_id: 'i:codex:s2', adapter: 'codex', status: 'waiting', branch: null, folder: 'api' })],
    turns: [turn(H), turn(2 * H), turn(25 * H), turn(3 * 24 * H)],
    report: { receipt: { teaser: false, headline: 'Plexiform saved you about $3.00–$6.00 in October 2026' }, waste: { days: 7, findings: [{ kind: 'reread', path: `${HOME}/code/shop/src/app.js`, count: 6, approxTokens: 1200 }] } },
  });
  const d = Digest.compose(data);
  const finished = d.sections.find((s) => s.id === 'finished').items;
  assert.deepEqual(finished, ['Fix login: ready for review', 'Claude Code session in shop (branch fix-cart): ready for review', 'Ship docs: done']);
  assert.deepEqual(d.sections.find((s) => s.id === 'stuck').items, ['Migrate db: has a question for you', 'Codex session in api: waiting for you', 'Broken build: failed'], 'newest first');
  const spend = d.sections.find((s) => s.id === 'spend').items;
  assert.match(spend[0], /^\$0\.\d\d today, up \$0\.\d\d on yesterday\.$/);
  assert.match(spend[1], /over the last 7 days\./);
  assert.deepEqual(d.sections.find((s) => s.id === 'saved').items, ['Plexiform saved you about $3.00–$6.00 in October 2026']);
  assert.match(d.sections.find((s) => s.id === 'waste').items[0], /^app\.js was read 6 times/);
  for (const out of [d.text, d.markdown, d.slack]) {
    assert.doesNotMatch(out, /alice|\/Users|refactor the secret|billing/);
  }
  assert.match(d.markdown, /^# Your daily digest/);
  assert.match(d.markdown, /\n## Finished today\n- Fix login: ready for review/);
});

test('unpriced replies are called out and not counted', () => {
  const d = Digest.compose(Digest.gather({ period: 'day', now: NOW, ...opts, turns: [turn(H, 'mystery'), turn(2 * H, 'mystery'), turn(H)] }));
  const spend = d.sections.find((s) => s.id === 'spend').items;
  assert.ok(spend.includes('2 replies from models without a known price are not counted.'), spend.join(' | '));
  const s = Digest.spendOf([turn(H, 'mystery')], 'day', NOW);
  assert.deepEqual(s, { current: 0, previous: 0, week: 0, unpriced: 1, turns: 1 });
});

test('the weekly digest compares with last week', () => {
  const d = Digest.compose(Digest.gather({ period: 'week', now: NOW, ...opts, turns: [turn(H), turn(9 * 24 * H), turn(10 * 24 * H)], tasks: [task({ stateSince: NOW - 4 * 24 * H })] }));
  assert.match(d.title, /^Your weekly digest, week to /);
  assert.deepEqual(d.sections.find((s) => s.id === 'finished').items, ['Fix login: ready for review']);
  assert.match(d.sections.find((s) => s.id === 'spend').items[0], /this week, down \$\d+\.\d\d on last week\./);
});

test('clean removes paths, usernames and secrets', () => {
  assert.equal(Digest.clean(`edited ${HOME}/code/x.js and ~/notes/a.md`, 160, opts), 'edited a file and a file');
  assert.equal(Digest.clean('alice fixed C:\\Users\\alice\\x.txt', 160, opts), '[user] fixed a file');
  assert.match(Digest.clean('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', 160, opts), /\[redacted\]/);
  assert.equal(Digest.clean('$4.20/day and/or src/app.js', 160, opts), '$4.20/day and/or src/app.js');
});

test('Slack incoming-webhook validation rejects other hosts and plain http', () => {
  const good = 'https://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx';
  assert.deepEqual(Delivery.validateWebhook(` ${good} `), { ok: true, url: good });
  for (const bad of [
    'http://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx',
    'https://hooks.slack.com.evil.example/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx',
    'https://evil.example/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx',
    'https://user:pw@hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx',
    'https://hooks.slack.com:8443/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx',
    'https://hooks.slack.com/workflows/T0000000/B0000000/abcdefghijklmnopqrstuvwx',
    'https://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx?x=1',
    'not a url', '', null,
  ]) assert.equal(Delivery.validateWebhook(bad).ok, false, String(bad));
  assert.match(Delivery.validateWebhook('http://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx').error, /https/);
});

test('schedule: due once per slot after the chosen time, weekly only on Mondays', () => {
  const at = (h, m = 0, day = 8) => new Date(2026, 9, day, h, m).getTime();
  const s = Delivery.sanitize({ period: 'day', time: '09:00', slack: true, notify: true });
  assert.deepEqual(Delivery.due(s, at(8, 59)), []);
  assert.deepEqual(Delivery.due(s, at(9, 0)).map((x) => x.channel), ['slack', 'notify']);
  assert.deepEqual(Delivery.due({ ...s, sent: { slack: 'day:2026-10-08', notify: 'day:2026-10-08' } }, at(23)), []);
  assert.deepEqual(Delivery.due({ ...s, sent: { slack: 'day:2026-10-08' } }, at(9, 0, 9)).map((x) => x.channel), ['slack', 'notify']);
  const w = { ...s, period: 'week' };
  assert.deepEqual(Delivery.due(w, at(10)), [], 'Thursday');
  assert.deepEqual(Delivery.due(w, at(10, 0, 12)).map((x) => x.slot), ['week:2026-10-12', 'week:2026-10-12'], 'Monday');
  assert.deepEqual(Delivery.due(Delivery.sanitize({}), at(23)), [], 'everything is off by default');
});

function fakeSeal() { return { seal: (s) => Buffer.from(`sealed:${s}`), unseal: (b) => { const t = Buffer.from(b).toString(); assert.ok(t.startsWith('sealed:')); return t.slice(7); } }; }

async function withServer(fn) {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => { got.push({ method: req.method, type: req.headers['content-type'], body: JSON.parse(body) }); res.end('ok'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const local = `http://127.0.0.1:${server.address().port}/hook`;
  const asked = [];
  // The delivery only ever gets the validated Slack URL; this fetch stands in for the network and lands on the local server.
  const fetch = (url, init) => { asked.push(url); return globalThis.fetch(local, init); };
  try { await fn({ fetch, got, asked }); } finally { await new Promise((r) => server.close(r)); }
}

const WEBHOOK = 'https://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx';

test('webhook is sealed, shown as its last 4 characters, and the test message reaches the server', async () => {
  await withServer(async ({ fetch, got, asked }) => {
    const dir = tmp();
    const del = Delivery.createDelivery({ dir, fetch, ...fakeSeal(), digest: async () => ({ slack: 'x', text: 'x' }), now: () => NOW });
    assert.equal(del.saveWebhook('https://example.com/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx').ok, false);
    const r = del.saveWebhook(WEBHOOK);
    assert.deepEqual(r.settings.webhook, { tail: 'uvwx' });
    const onDisk = fs.readFileSync(path.join(dir, Delivery.WEBHOOK_FILE), 'utf8') + fs.readFileSync(path.join(dir, Delivery.SETTINGS_FILE), 'utf8');
    assert.doesNotMatch(onDisk, /hooks\.slack\.com/);
    assert.deepEqual(await del.test(), { ok: true });
    assert.deepEqual(asked, [WEBHOOK]);
    assert.deepEqual(got, [{ method: 'POST', type: 'application/json', body: { text: Delivery.TEST_TEXT } }]);
  });
});

test('Slack needs a preview before it can be turned on, then posts the scrubbed digest once per day across restarts', async () => {
  await withServer(async ({ fetch, got }) => {
    const dir = tmp(), store = tmp();
    let clock = new Date(2026, 9, 8, 8, 0).getTime();
    fs.writeFileSync(path.join(store, 'tasks.jsonl'), JSON.stringify({ task: task({ title: 'Fix login in /Users/alice/code/shop/a.js', stateSince: clock - 60_000 }) }));
    const digest = Digest.createDigest({ tasksStoreDir: store, recordsFile: path.join(dir, 'none.json'), turns: async () => [{ ...turn(0), ts: clock - 60_000 }], now: () => clock, home: HOME, username: 'alice' });
    const make = () => Delivery.createDelivery({ dir, fetch, ...fakeSeal(), digest: (p) => digest.build(p), now: () => clock });
    let del = make();
    del.saveWebhook(WEBHOOK);
    assert.equal(del.set({ slack: true }).ok, false, 'no preview yet');
    assert.equal(del.set({ time: '9am' }).ok, false);
    assert.equal(del.set({ time: '09:00' }).ok, true);
    const p = await del.preview();
    assert.match(p.text, /^\*Your daily digest/);
    assert.equal(del.set({ slack: true }).settings.slack, true);
    assert.deepEqual(await del.tick(), [], 'before 09:00');
    clock = new Date(2026, 9, 8, 9, 1).getTime();
    assert.deepEqual(await del.tick(), ['slack']);
    del = make();
    assert.deepEqual(await del.tick(), [], 'a restart does not send again');
    clock = new Date(2026, 9, 8, 22, 0).getTime();
    assert.deepEqual(await del.tick(), []);
    assert.equal(got.length, 1);
    assert.equal(got[0].body.text, p.text);
    assert.match(got[0].body.text, /Fix login in a file: ready for review/);
    assert.doesNotMatch(got[0].body.text, /alice|\/Users/);
    clock = new Date(2026, 9, 9, 9, 0).getTime();
    assert.deepEqual(await make().tick(), ['slack'], 'next day');
    assert.equal(got.length, 2);
  });
});

test('ticks that overlap send once, a failed post is recorded and not retried in the same slot, and the notification fires', async () => {
  const dir = tmp();
  let calls = 0, release;
  const gate = new Promise((r) => { release = r; });
  const notes = [];
  const fetch = async () => { calls += 1; await gate; return { ok: false, status: 500 }; };
  let clock = new Date(2026, 9, 8, 8, 0).getTime();
  const del = Delivery.createDelivery({ dir, fetch, ...fakeSeal(), digest: async () => ({ slack: 's', text: 't' }), notify: (d) => notes.push(d.text), now: () => clock });
  del.saveWebhook(WEBHOOK);
  await del.preview();
  del.set({ slack: true, notify: true, time: '09:00' });
  clock = new Date(2026, 9, 8, 9, 30).getTime();
  const a = del.tick(), b = del.tick();
  release();
  assert.deepEqual(await b, []);
  assert.deepEqual(await a, ['notify']);
  assert.equal(calls, 1);
  assert.deepEqual(notes, ['t']);
  assert.match(del.settings().failed.error, /HTTP 500/);
  assert.deepEqual(await del.tick(), []);
  assert.equal(calls, 1);
});

test('turning a channel on after today\'s time starts tomorrow, and removing the webhook turns Slack off', async () => {
  const dir = tmp();
  const del = Delivery.createDelivery({ dir, fetch: async () => ({ ok: true }), ...fakeSeal(), digest: async () => ({ slack: 's', text: 't' }), notify: () => {}, now: () => new Date(2026, 9, 8, 20, 0).getTime() });
  del.set({ notify: true, time: '09:00' });
  assert.deepEqual(await del.tick(), []);
  del.saveWebhook(WEBHOOK); await del.preview(); del.set({ slack: true });
  assert.equal(del.removeWebhook().settings.slack, false);
  assert.equal(del.settings().webhook, null);
});

test('Home\'s Digest card renders the digest, switches period, and keeps Slack off until a preview', async () => {
  const { JSDOM } = require('jsdom');
  const ROOT = path.join(__dirname, '..');
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'home.html'), 'utf8'), { runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.setInterval = () => 0;
  const calls = [];
  let settings = { period: 'day', time: '18:00', slack: false, notify: false, webhook: { tail: 'uvwx' }, previewed: false, failed: null };
  const busy = Digest.compose(Digest.gather({ period: 'day', now: NOW, ...opts, tasks: [task({})] }));
  dom.window.homeApi = { digest: {
    get: async (p) => { calls.push(['get', p]); return { digest: p === 'week' ? Digest.compose(Digest.gather({ period: 'week', now: NOW, ...opts })) : busy, delivery: settings }; },
    preview: async () => { settings = { ...settings, previewed: true }; return { text: busy.slack, settings }; },
    set: async (patch) => { calls.push(['set', patch]); settings = { ...settings, ...patch }; return { ok: true, settings }; },
    copy: async (p, as) => { calls.push(['copy', p, as]); return { ok: true }; },
  } };
  const tick = () => new Promise((r) => setImmediate(r));
  try {
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'home-digest.js'), 'utf8'));
    await tick();
    const doc = dom.window.document, sec = doc.getElementById('digest');
    assert.match(sec.querySelector('.body').textContent, /Fix login: ready for review/);
    const slackBox = () => sec.querySelector('.delivery-slack input[type="checkbox"]');
    assert.equal(slackBox().disabled, true, 'no preview yet');
    [...sec.querySelectorAll('.delivery-slack button')].find((b) => b.textContent === 'See what will be sent').click();
    await tick(); await tick();
    assert.match(sec.querySelector('.digest-preview').textContent, /^\*Your daily digest/);
    assert.equal(slackBox().disabled, false);
    sec.querySelector('[data-period="week"]').click();
    await tick();
    assert.deepEqual(calls.filter((c) => c[0] === 'get').map((c) => c[1]), ['day', 'week']);
    assert.match(sec.querySelector('.body').textContent, /A quiet week/);
    sec.querySelector('.digest-actions button').click();
    await tick();
    assert.deepEqual(calls.at(-1), ['copy', 'week', 'text']);
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'home-digest.js'), 'utf8'), /innerHTML/);
  } finally { dom.window.close(); }
});

test('repeating recipes that ran, were skipped or failed in the window get their own section', () => {
  const scheduled = [
    { id: 'nightly-tests', title: 'Run the tests tonight', at: NOW - 2 * H, result: 'started', note: '', taskId: 'tsk_1' },
    { id: 'weekly-report', title: 'Weekly report for /Users/alice/code', at: NOW - 3 * H, result: 'skipped', note: 'Skipped: the daily limit is reached.', taskId: null },
    { id: 'old', title: 'Old', at: NOW - 30 * H, result: 'started', note: '', taskId: null },
    { id: 'bad', title: 'Bad', at: NOW - H, result: 'failed', note: 'Supervisor unreachable.', taskId: null },
  ];
  const d = Digest.compose(Digest.gather({ period: 'day', now: NOW, scheduled, ...opts }));
  const sec = d.sections.find((s) => s.id === 'repeats');
  assert.equal(sec.heading, 'Repeating recipes today');
  assert.deepEqual(sec.items, ['Bad: did not start (Supervisor unreachable.)', 'Run the tests tonight: ran', 'Weekly report for a file: skipped (Skipped: the daily limit is reached.)']);
  assert.doesNotMatch(d.text, /alice/);
  assert.equal(Digest.compose(Digest.gather({ period: 'day', now: NOW, ...opts })).sections.some((s) => s.id === 'repeats'), false, 'no section when nothing repeated');
  assert.equal(Digest.compose(Digest.gather({ period: 'week', now: NOW, scheduled, ...opts })).sections.find((s) => s.id === 'repeats').items.length, 4, 'the week includes yesterday\'s run');
});
