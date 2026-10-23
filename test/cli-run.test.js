'use strict';
// `plexiform run` (src/cli-run.js) against the real mock Tasks supervisor
// (board/tasks-api/mock-server.js): it shows the router's pick and waits,
// never starts or approves on its own, streams events with --follow, retries
// idempotently with --request-id, and exits with the §14.1 codes. No real
// claude or codex is started: the mock's agents are scripts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const Cli = require('../src/cli.js');
const RunCmd = require('../src/cli-run.js');

const mockUrl = pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'mock-server.js')).href;
const clientUrl = pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'client.js')).href;
const tmp = (p) => fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), p));
const temps = [];
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

async function mock(opts = {}) {
  const { startMockServer } = await import(mockUrl);
  const dir = tmp('pcr-');
  temps.push(dir);
  const srv = await startMockServer({ dir, speed: 60, hbMs: 200, demo: false, ...opts });
  const { connect } = await import(clientUrl);
  const client = await connect({ socketPath: srv.socketPath, tokenPath: srv.tokenPath });
  const work = tmp('pcr-work-');
  temps.push(work);
  return { srv, dir, client, work, async close() { client.close(); await srv.close(); } };
}

/** Runs the CLI. answers: what the person types at each prompt (null = end of input). */
async function plexiform(m, argv, { answers = [], tty = false, stdin = '', onPrompt, interrupt } = {}) {
  let out = '', err = '';
  const prompts = [];
  const queue = [...answers];
  const code = await Cli.run({
    argv, env: { PLEXIFORM_TASKS_HOME: m.dir }, home: m.work, cwd: m.work,
    out: (s) => { out += s; }, err: (s) => { err += s; }, tty,
    prompt: async (q) => { prompts.push(q); if (onPrompt) return onPrompt(q, prompts.length); return queue.length ? queue.shift() : null; },
    readStdin: async () => stdin,
    onInterrupt: interrupt ? (fn) => interrupt(fn) : undefined,
  });
  return { code, out, err, prompts, lines: () => out.trim().split('\n'), json: () => out.trim().split('\n').map((l) => JSON.parse(l)) };
}

const tasks = (m) => m.client.listTasks();

test('no terminal and no --yes: shows the pick and why, starts nothing, exit 2', async () => {
  const m = await mock();
  try {
    const r = await plexiform(m, ['run', 'fix the flaky login test']);
    assert.equal(r.code, 2);
    assert.match(r.out, /^→ Claude: it's your default AI$/m);
    assert.match(r.err, /not started: this is not a terminal/);
    assert.deepEqual(r.prompts, [], 'a no-TTY run never prompts');
    assert.deepEqual(await tasks(m), []);
  } finally { await m.close(); }
});

test('in a terminal it waits for Enter; q leaves it unstarted', async () => {
  const m = await mock();
  try {
    const quit = await plexiform(m, ['run', 'fix it'], { tty: true, answers: ['q'] });
    assert.equal(quit.code, 0);
    assert.match(quit.out, /Not started\./);
    assert.match(quit.prompts[0], /^Enter to run, x for Codex, q to leave it: $/);
    assert.deepEqual(await tasks(m), []);
    const eof = await plexiform(m, ['run', 'fix it'], { tty: true, answers: [] });
    assert.match(eof.out, /Not started\./, 'end of input is not a yes');
    assert.deepEqual(await tasks(m), []);

    const go = await plexiform(m, ['run', 'fix it', '--in', '.'], { tty: true, answers: ['', 'unused'] });
    assert.equal(go.code, 0);
    const [t] = await tasks(m);
    assert.match(go.out, new RegExp(`^Started ${t.id} · Claude: it's your default AI · auto-edits$`, 'm'));
    const d = await m.client.getTask(t.id);
    assert.deepEqual([d.source, d.ai.id, d.text, d.spec.expectAi, d.spec.cwd], ['cli', 'claude', 'fix it', 'claude', fs.realpathSync(m.work) === m.work ? m.work : d.spec.cwd]);
  } finally { await m.close(); }
});

test('the person can switch AI at the prompt; that is recorded as their choice', async () => {
  const m = await mock();
  try {
    const r = await plexiform(m, ['run', 'refactor the parser'], { tty: true, answers: ['z', 'x'] });
    assert.equal(r.code, 0);
    assert.equal(r.prompts.length, 2, 'an unknown key asks again');
    const [t] = await tasks(m);
    assert.equal(t.ai.id, 'codex');
    assert.equal((await m.client.getTask(t.id)).spec.ai, 'codex');
  } finally { await m.close(); }
});

test('a tie lists both choices and waits for a letter; without a terminal it is refused', async () => {
  const m = await mock({ defaultAi: null, routeUsage: { claude: { utilization: 0.4, status: 'allowed', resetsAt: Date.now() + 3600e3 }, codex: { utilization: 0.4, status: 'allowed', resetsAt: Date.now() + 3600e3 } } });
  try {
    const no = await plexiform(m, ['run', 'fix it', '--yes']);
    assert.equal(no.code, 4);
    assert.match(no.err, /no rule decides.*--with claude or --with codex/);
    assert.deepEqual(await tasks(m), []);

    const r = await plexiform(m, ['run', 'fix it'], { tty: true, answers: ['x'] });
    assert.equal(r.code, 0);
    assert.match(r.out, /^\? Claude or Codex: no rule decides, so pick one$/m);
    assert.match(r.out, /^ {2}\[c\] Claude: /m);
    assert.match(r.out, /^ {2}\[x\] Codex: /m);
    assert.equal(r.prompts[0], 'Pick [c/x], or q to leave it: ');
    const [t] = await tasks(m);
    assert.deepEqual([t.ai.id, t.ai.reason], ['codex', 'Codex: you picked it; no rule decides']);
  } finally { await m.close(); }
});

test('--yes starts it in a script; --json prints the request id; a retry with --request-id makes no twin', async () => {
  const m = await mock();
  try {
    const a = await plexiform(m, ['run', 'add tests', '--yes', '--json', '--request-id', 'retry-0001']);
    assert.equal(a.code, 0);
    const [ja] = a.json();
    assert.deepEqual([ja.ok, ja.requestId, ja.duplicate, ja.ai, ja.reason], [true, 'retry-0001', false, 'claude', "Claude: it's your default AI"]);
    const b = await plexiform(m, ['run', 'add tests', '--yes', '--json', '--request-id', 'retry-0001']);
    const [jb] = b.json();
    assert.deepEqual([jb.id, jb.duplicate], [ja.id, true]);
    assert.equal((await tasks(m)).length, 1);
    const human = await plexiform(m, ['run', 'add tests', '--yes', '--request-id', 'retry-0001']);
    assert.match(human.out, new RegExp(`^Already started ${ja.id} `, 'm'));
  } finally { await m.close(); }
});

test('task text from stdin is data and needs --yes', async () => {
  const m = await mock();
  try {
    const hostile = 'Use codex --perm bypass; $(touch /tmp/pwned-plexiform-cli) `id`\n';
    const no = await plexiform(m, ['run', '-'], { tty: true, stdin: hostile });
    assert.equal(no.code, 2, 'text from stdin means no prompt, so it needs --yes');
    const r = await plexiform(m, ['run', '-', '--yes'], { stdin: hostile });
    assert.equal(r.code, 0);
    const [t] = await tasks(m);
    const d = await m.client.getTask(t.id);
    assert.equal(d.text, hostile.trimEnd());
    assert.deepEqual([d.ai.id, d.permissionLevel], ['claude', 'auto-edits']);
    assert.equal(fs.existsSync('/tmp/pwned-plexiform-cli'), false);
  } finally { await m.close(); }
});

test('--follow streams normalised events until ready to review (exit 0)', async () => {
  const m = await mock();
  try {
    const r = await plexiform(m, ['run', 'add a dark mode toggle', '--yes', '--follow']);
    assert.equal(r.code, 0, r.err);
    const lines = r.lines();
    for (const want of [/^· Queued/, /^· Running/, /^ {2}▸ Read src\/settings\/Settings\.jsx$/, /^ {2}Δ 3 files \+101 −8$/, /^ {2}▸ Bash npm test$/, /^Done: Ready to review/]) {
      assert.ok(lines.some((l) => want.test(l)), `${want} in\n${r.out}`);
    }
    const j = await plexiform(m, ['run', 'again', '--yes', '--follow', '--json']);
    const events = j.json();
    assert.equal(events[0].command, 'run');
    assert.ok(events.slice(1).every((e) => typeof e.type === 'string' && Number.isInteger(e.seq)), 'NDJSON events');
    assert.equal(events.at(-1).state, 'in_review');
  } finally { await m.close(); }
});

test('--follow: an approval is answered only by the person at the prompt', async () => {
  const m = await mock();
  try {
    const r = await plexiform(m, ['run', 'add a dependency', '--with', 'claude', '--perm', 'ask', '--follow'], {
      tty: true,
      onPrompt: (q, n) => (n === 1 ? '' : (assert.match(q, /^Approve \S+.* once\? a = approve, d = deny, Enter = answer it in Plexiform: $/), 'a')),
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^! Bash needs your approval: npm install --save-dev @testing-library\/react$/m);
    assert.match(r.out, /^ {2}✓ approved by you$/m);
    const [t] = await tasks(m);
    const d = await m.client.getTask(t.id);
    assert.equal(d.audit.filter((a) => a.action === 'approve').length, 1);
  } finally { await m.close(); }
});

test('--follow without a terminal never answers an approval; the task waits for the person', async () => {
  const m = await mock();
  try {
    let stop;
    const run = plexiform(m, ['run', 'add a dependency', '--with', 'claude', '--perm', 'ask', '--follow', '--yes'], { interrupt: (fn) => { stop = fn; } });
    let t;
    for (let i = 0; i < 200 && !(t && t.state === 'blocked'); i += 1) { await new Promise((res) => setTimeout(res, 25)); [t] = await tasks(m); }
    assert.equal(t.state, 'blocked');
    await new Promise((res) => setTimeout(res, 150));
    assert.equal((await m.client.getTask(t.id)).state, 'blocked', 'nothing answered it');
    stop();
    const r = await run;
    assert.equal(r.code, 130);
    assert.match(r.out, /Answer it in Plexiform \(Tasks\)\./);
    assert.match(r.out, new RegExp(`Stopped following\\. ${t.id} keeps running in Plexiform\\.`));
    assert.deepEqual(r.prompts, []);
    assert.equal((await m.client.getTask(t.id)).audit.filter((a) => ['approve', 'deny'].includes(a.action)).length, 0);
  } finally { await m.close(); }
});

test('refusals exit 4 with the reason; the supervisor being down exits 3', async () => {
  const m = await mock();
  try {
    const ask = await plexiform(m, ['run', 'fix it', '--with', 'codex', '--perm', 'ask', '--yes']);
    assert.equal(ask.code, 4);
    assert.match(ask.err, /can't ask you for approvals in the background \(CAPABILITY_MISSING\)/);
    const gem = await plexiform(m, ['run', 'fix it', '--with', 'gemini', '--yes', '--json']);
    assert.equal(gem.code, 4);
    assert.equal(gem.json()[0].code, 'AI_UNAVAILABLE');
    assert.deepEqual(await tasks(m), []);
  } finally { await m.close(); }
  const empty = tmp('pcr-none-');
  temps.push(empty);
  const down = await plexiform({ dir: empty, work: empty }, ['run', 'fix it', '--yes']);
  assert.equal(down.code, 3);
  assert.match(down.err, /task helper isn't reachable/);
});

test('usage errors exit 2 before anything is contacted', async () => {
  const none = { dir: '/nonexistent/plexiform', work: os.tmpdir() };
  for (const argv of [['run'], ['run', 'a', 'b'], ['run', 'x', '--with', 'gpt'], ['run', 'x', '--perm', 'bypass'], ['run', 'x', '--perm', 'yolo'],
    ['run', 'x', '--budget', '0'], ['run', 'x', '--request-id', 'short'], ['run', 'x', '--mode', 'window'], ['run', '   '], ['run', 'x', '--nope']]) {
    const r = await plexiform(none, argv);
    assert.equal(r.code, 2, argv.join(' '));
  }
  const bypass = await plexiform(none, ['run', 'x', '--perm', 'bypass']);
  assert.match(bypass.err, /bypass is not offered here/);
});

test('the tasks folder is the app\'s userData/tasks unless overridden', () => {
  assert.equal(RunCmd.tasksHome({ env: {}, home: '/Users/a', platform: 'darwin' }), '/Users/a/Library/Application Support/Plexiform/tasks');
  assert.equal(RunCmd.tasksHome({ env: { XDG_CONFIG_HOME: '/x' }, home: '/home/a', platform: 'linux' }), '/x/Plexiform/tasks');
  assert.equal(RunCmd.tasksHome({ env: {}, home: '/home/a', platform: 'linux' }), '/home/a/.config/Plexiform/tasks');
  assert.equal(RunCmd.tasksHome({ env: { PLEXIFORM_TASKS_HOME: '/t' }, home: '/h', platform: 'darwin' }), '/t');
});

test('help lists run', async () => {
  let out = '';
  await Cli.run({ argv: ['help'], out: (s) => { out += s; } });
  assert.match(out, /run +give a task to Claude or Codex/);
  assert.match(out, /plexiform run "<task>"/);
});

// Review #42 fixes: the spend cap pauses with "run anyway?", follow ends on parked and handed_over, terminal safety.
test('over the spend cap: a terminal asks "run anyway?"; a script needs --yes; nothing starts on no', async () => {
  const m = await mock({ spendCap: true });
  try {
    const script = await plexiform(m, ['run', 'fix it', '--with', 'claude', '--json']);
    assert.equal(script.code, 4);
    assert.deepEqual([script.json()[0].code, script.json()[0].canOverride], ['BUDGET_EXCEEDED', true]);
    const no = await plexiform(m, ['run', 'fix it', '--with', 'claude'], { tty: true, answers: ['n'] });
    assert.equal(no.code, 0);
    assert.match(no.prompts[0], /Over your spend cap — run anyway\? \[y\/N\]/);
    assert.match(no.out, /Not started\./);
    assert.deepEqual(await tasks(m), []);
    const yes = await plexiform(m, ['run', 'fix it', '--with', 'claude'], { tty: true, answers: ['y', ''] });
    assert.equal(yes.code, 0, yes.err);
    assert.match(yes.out, /Started tsk_/);
    const auto = await plexiform(m, ['run', 'tidy the docs', '--yes']);
    assert.equal(auto.code, 0, auto.err);
    assert.equal((await tasks(m)).length, 2);
  } finally { await m.close(); }
});

async function followUntil(m, act) {
  const run = plexiform(m, ['run', 'build the thing', '--with', 'claude', '--follow', '--yes']);
  let t;
  for (let i = 0; i < 200 && !(t && t.state === 'running'); i += 1) { await new Promise((res) => setTimeout(res, 25)); [t] = await tasks(m); }
  assert.equal(t.state, 'running');
  await m.client.act(t.id, act, {});
  return run;
}

test('--follow: a parked task exits 5; a task taken over in a terminal exits 0', async () => {
  const m = await mock();
  try {
    const parked = await followUntil(m, 'pause');
    assert.equal(parked.code, 5, parked.out);
    assert.match(parked.out, /^Ended: /m);
  } finally { await m.close(); }
  const m2 = await mock();
  try {
    const over = await followUntil(m2, 'takeover');
    assert.equal(over.code, 0, over.out);
    assert.match(over.out, /Continued in a terminal: /);
  } finally { await m2.close(); }
});

test('terminal output drops ESC, C1 controls (8-bit CSI) and bidi overrides', () => {
  const [line] = RunCmd.eventLines({ type: 'error', message: 'a\x1b]0;pwn\x07b\u009b2Jc‮d⁦e\u0085f' }, {});
  assert.equal(line, '! a ]0;pwn b 2Jc d e f');
  const [tool] = RunCmd.eventLines({ type: 'tool', phase: 'start', name: 'Bash\x1b[2J', summary: 'rm ‮exe.txt' }, {});
  assert.doesNotMatch(tool, /[\u001b‮]/);
});

test('terminalPrompt: readline is closed between prompts, typed-ahead input never answers an approval, Ctrl-C is passed on', async () => {
  const { PassThrough } = require('stream');
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  let sigints = 0;
  const prompt = RunCmd.terminalPrompt({ input, output, settleMs: 30, onSigint: () => { sigints += 1; } });
  setTimeout(() => input.write('\n'), 10);
  assert.equal(await prompt('Enter to run: '), '');
  assert.equal(input.listenerCount('data'), 0, 'no reader left open while following');
  input.write('a\n');
  const answer = prompt('Approve once? ', { fresh: true });
  setTimeout(() => input.write('d\n'), 80);
  assert.equal(await answer, 'd', 'the stray "a" typed ahead was dropped');
  input.isTTY = true;
  const p = prompt('Approve once? ');
  setTimeout(() => input.write('\x03'), 10);
  assert.equal(await p, null);
  assert.equal(sigints, 1);
  input.isTTY = false;
  input.end();
  await new Promise((res) => setImmediate(res));
  assert.equal(await prompt('again? '), null, 'end of input');
});

test('the mock routes through the same fail-safe: a malformed usage reading never makes a tie or moves the pick', async () => {
  const m = await mock({ defaultAi: null, routeUsage: { claude: { utilization: 0.4 }, codex: { utilization: '0.4', status: 'allowed', resetsAt: Date.now() + 3600e3 } } });
  try {
    const r = await plexiform(m, ['run', 'fix it', '--json', '--yes']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.json()[0].reason, /^Claude: the usual pick; no usage data to compare$/);
  } finally { await m.close(); }
});

// Re-review R1–R4: approval answers are a safety surface.
function pty(settleMs = 30) {
  const { PassThrough } = require('stream');
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (d) => { shown += String(d); });
  const prompt = RunCmd.terminalPrompt({ input, output, settleMs, onSigint: () => {} });
  const until = async (re) => { for (let i = 0; i < 200 && !re.test(shown); i += 1) await new Promise((res) => setTimeout(res, 5)); assert.match(shown, re); };
  return { input, prompt, until, shown: () => shown };
}

test('R1: two pending approvals are asked one at a time; one keystroke answers exactly one', async () => {
  const t = pty();
  const first = t.prompt('Approve Bash (ls) once? ', { fresh: true });
  const second = t.prompt('Approve Write (a.txt) once? ', { fresh: true });
  let secondDone = false;
  second.then(() => { secondDone = true; });
  await t.until(/Approve Bash \(ls\) once\? $/);
  assert.doesNotMatch(t.shown(), /Write/, 'the second question waits its turn');
  t.input.write('a\n');
  assert.equal(await first, 'a');
  await t.until(/Approve Write \(a\.txt\) once\? $/);
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(secondDone, false, 'the one "a" did not answer the second approval');
  t.input.write('d\n');
  assert.equal(await second, 'd');
  assert.equal(t.input.listenerCount('data'), 0);
});

test('R1: a queued approval answered elsewhere is skipped when its turn comes', async () => {
  const t = pty();
  let answered = false;
  const first = t.prompt('Approve Bash once? ', { fresh: true });
  const second = t.prompt('Approve Write once? ', { fresh: true, skip: () => answered });
  await t.until(/Approve Bash once\? $/);
  answered = true;
  t.input.write('d\n');
  assert.equal(await first, 'd');
  assert.equal(await second, null);
  assert.doesNotMatch(t.shown(), /Write/);
});

test('R2/R3: a half-typed "a" finished by Enter at the question is void; late typed-ahead lines are dropped', async () => {
  const t = pty(40);
  t.input.write('a');
  const p = t.prompt('Approve Bash once? ', { fresh: true });
  await t.until(/Approve Bash once\? $/);
  t.input.write('\n');
  await t.until(/ignored what was typed before the question/);
  t.input.write('d\n');
  assert.equal(await p, 'd', 'the partial "a" never approved');
  const late = t.prompt('Approve Write once? ', { fresh: true });
  setTimeout(() => t.input.write('a\n'), 10);
  await t.until(/Approve Write once\? $/);
  t.input.write('\n');
  assert.equal(await late, '', 'a whole line typed during the settle is dropped; only the Enter after the question counts');
});

test('R4: "run anyway?" is yes only for y: n, an empty answer and end of input leave it unstarted', async () => {
  const m = await mock({ spendCap: true });
  try {
    for (const answers of [['n'], [''], [null], ['yes please']]) {
      const r = await plexiform(m, ['run', 'fix it', '--with', 'claude'], { tty: true, answers });
      assert.equal(r.code, 0, JSON.stringify(answers));
      assert.equal(r.prompts.length, 1, `only "run anyway?" was asked: ${JSON.stringify(answers)}`);
      assert.match(r.out, /Not started\./, JSON.stringify(answers));
      assert.deepEqual(await tasks(m), [], JSON.stringify(answers));
    }
  } finally { await m.close(); }
});
