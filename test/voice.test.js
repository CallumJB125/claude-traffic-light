const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const fs = require('fs');
const path = require('path');

const V = require('../src/voice.js');
const { createListener } = require('../src/voice-helper.js');

// ── Intents ────────────────────────────────────────────────────────────────
const intentOf = (t) => V.parseIntent(t).intent;

test('the four questions, as asked and as speech-to-text writes them', () => {
  for (const q of ["What's blocked?", 'what is blocked', 'Is anything stuck?', 'What needs me', 'anything waiting on me?', 'whats blokced', 'whats blocks']) assert.equal(intentOf(q), 'blocked', q);
  for (const q of ["What's Tonde's Claude doing?", 'What is my Claude doing', 'what are the sessions doing', "How's bondly going?", 'status of auto-loan']) assert.equal(intentOf(q), 'doing', q);
  for (const q of ['How much have I spent today?', 'how much did I spend', 'What have I spent', 'spend today', 'how much has it cost so far', 'how much money']) assert.equal(intentOf(q), 'spend', q);
  for (const q of ['What happened while I was out?', 'what did I miss', 'catch me up', 'what happened while i was away', 'recap']) assert.equal(intentOf(q), 'away', q);
  assert.equal(intentOf('what can you do'), 'help');
});

test('nothing, noise and ambiguity are not guessed at', () => {
  assert.equal(intentOf(''), 'empty');
  assert.equal(intentOf('   '), 'empty');
  assert.equal(intentOf('play some jazz'), 'unknown');
  assert.equal(intentOf('order a pizza'), 'unknown');
});

test('a name is pulled out of "what is X doing", and "my"/"Claude" mean every local session', () => {
  assert.equal(V.parseIntent("What's Tonde's Claude doing?").name, 'tonde');
  assert.equal(V.parseIntent('What is Tondes Claude doing').name, 'tondes');
  assert.equal(V.parseIntent("How's bondly going").name, 'bondly');
  assert.equal(V.parseIntent('What is my Claude doing?').name, null);
  assert.equal(V.parseIntent("What's Claude doing").name, null);
  assert.equal(V.parseIntent('what is everyone doing').name, null);
});

test('edit distance and hotkeys', () => {
  assert.equal(V.editDistance('blocked', 'blokced'), 1, 'a swap is one slip');
  assert.equal(V.editDistance('kitten', 'sitting'), 3);
  assert.equal(V.editDistance('spend', 'spent'), 1);
  assert.equal(V.hotkey('F13').keyCode, 105);
  assert.equal(V.hotkey('Cmd+Q'), null);
  for (const h of V.HOTKEYS) assert.ok(Number.isInteger(h.keyCode) && h.label, h.accelerator);
});

test('voice config: hotkey off until picked, long-press on, free-form off', () => {
  assert.deepEqual(V.normalizeConfig(undefined), { hotkey: null, longPress: true, askClaude: false });
  assert.deepEqual(V.normalizeConfig({ hotkey: 'F15', longPress: false, askClaude: true }), { hotkey: 'F15', longPress: false, askClaude: true });
  assert.equal(V.normalizeConfig({ hotkey: 'Command+Q' }).hotkey, null, 'only offered keys');
  assert.equal(V.normalizeConfig({ askClaude: 'yes' }).askClaude, false, 'only an explicit true');
});

// ── Answers, from fixture sessions ─────────────────────────────────────────
const S = (cwd, signal, extra = {}) => ({ sessionId: `${cwd}-id`, cwd: `/Users/x/work/${cwd}`, signal, updatedAt: '2026-09-30T10:00:00Z', ...extra });

test("what's blocked: asks, limits and failures first, then who's waiting on your turn", () => {
  assert.equal(V.answerBlocked({ sessions: [] }), 'No sessions are running, so nothing is blocked.');
  assert.equal(V.answerBlocked({ sessions: [S('bondly', 'tool-use', { tool: 'Bash' })] }), 'Nothing is blocked.');
  assert.equal(V.answerBlocked({ sessions: [S('bondly', 'stop'), S('auto-loan', 'tool-use')] }), 'Nothing is blocked. 1 session is done and waiting for your next message.');
  const a = V.answerBlocked({ sessions: [S('bondly', 'permission-ask', { tool: 'Bash' }), S('auto-loan', 'limit-hit'), S('ctl-voice', 'stop')] });
  assert.equal(a, '2 things need you. bondly wants permission to use Bash. auto loan is stuck on the usage limit. 1 session is done and waiting for your next message.');
  assert.match(V.answerBlocked({ sessions: [S('x', 'permission-ask', { askKind: 'question' })] }), /^One thing needs you\. x has a question for you\.$/);
  assert.match(V.answerBlocked({ sessions: [S('x', 'turn-failed', { failKind: 'rate_limit' })] }), /x stopped with an error, rate limit/);
});

test("what's blocked counts a widget permission request whose file still says working", () => {
  const a = V.answerBlocked({ sessions: [S('bondly', 'tool-use')], pending: [{ sessionId: 'bondly-id', cwd: '/w/bondly', tool: 'Edit' }] });
  assert.equal(a, 'One thing needs you. bondly wants permission to use Edit.');
});

test('more than three blocked: three named, the rest counted', () => {
  const sessions = ['a', 'b', 'c', 'd', 'e'].map((n) => S(n, 'limit-hit'));
  assert.match(V.answerBlocked({ sessions }), /^5 things need you\. a .*\. b .*\. c .*\. And 2 more\.$/);
});

test("what's X doing: every local session, one by folder, or an honest no for a person", () => {
  const sessions = [S('bondly', 'tool-use', { tool: 'Bash', agents: [{ name: 'w1', status: 'working' }, { name: 'w2', status: 'done' }] }), S('auto-loan', 'idle-nudge')];
  assert.equal(V.answerDoing({ sessions }), '2 sessions. bondly is working, using Bash, with 1 helper agent. auto loan is done and waiting for you.');
  assert.equal(V.answerDoing({ name: 'bondly', sessions }), 'bondly is working, using Bash, with 1 helper agent.');
  assert.equal(V.answerDoing({ name: 'auto loan', sessions }), 'auto loan is done and waiting for you.');
  assert.equal(V.answerDoing({ name: 'bondlys', sessions }), 'bondly is working, using Bash, with 1 helper agent.', 'a dropped apostrophe still finds it');
  assert.match(V.answerDoing({ name: 'tonde', sessions }), /^I can only see the Claude sessions on this Mac, and none is in a folder called tonde\. Seeing a teammate's Claude needs the team board\.$/);
  assert.equal(V.answerDoing({ sessions: [] }), 'No Claude sessions are running on this Mac.');
});

test('how much today: API-price estimate from the transcripts, by project and model', () => {
  const now = new Date(2026, 8, 30, 15, 0, 0).getTime();
  const mk = (over) => ({ id: Math.random(), ts: now - 3600000, sessionId: 's1', project: 'bondly', model: 'claude-opus-5', modelKey: 'opus', input: 0, output: 1e5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, ...over });
  assert.equal(V.answerSpend({ turns: [], now }), 'Nothing yet today. No Claude turns since midnight.');
  const yesterday = mk({ ts: now - 24 * 3600000 });
  assert.equal(V.answerSpend({ turns: [yesterday], now }), 'Nothing yet today. No Claude turns since midnight.', 'yesterday does not count');
  const a = V.answerSpend({ turns: [mk(), mk(), mk({ project: 'auto-loan' }), yesterday], now });
  assert.match(a, /^About \d+ dollars( \d+)? today at API prices, over 3 turns, mostly opus\. Most of it in bondly\.$/);
  assert.match(V.answerSpend({ turns: [mk()], now }), /All of it in bondly\.$/);
});

test('what happened while I was out: the latest state per session, asks first', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const t = (min, session, project, from, to, extra = {}) => ({ at: new Date(now - min * 60000).toISOString(), session, project, from, to, cause: 'hook signal', unlogged: 0, ...extra });
  const transitions = [
    t(5, 'a1', 'work/bondly', 'tool-use', 'stop'),
    t(30, 'a1', 'work/bondly', 'prompt-submit', 'tool-use'),
    t(20, 'b2', 'work/auto-loan', 'tool-use', 'permission-ask'),
    t(10, 'c3', 'work/ctl-voice', 'tool-use', 'turn-failed', { failKind: 'rate_limit' }),
    t(200, 'd4', 'work/old', 'tool-use', 'stop'),
  ];
  const a = V.answerWhileOut({ transitions, since: now - 45 * 60000, now, awayKnown: true });
  assert.equal(a, 'While you were out, 45 minutes: auto loan is waiting for your permission. ctl voice failed with rate limit. bondly finished.');
  assert.equal(V.answerWhileOut({ transitions, now }), 'In the last hour: auto loan is waiting for your permission. ctl voice failed with rate limit. bondly finished.');
  assert.equal(V.answerWhileOut({ transitions: [], now }), 'In the last hour, nothing changed.');
  assert.match(V.answerWhileOut({ transitions, since: now - 3 * 3600000, now, awayKnown: true }), /^While you were out, about 3 hours: /);
});

test('answer() routes each intent, and unknowns get the help line', () => {
  assert.equal(V.answer({ intent: 'help' }), V.HELP);
  assert.equal(V.answer({ intent: 'unknown' }), `I can't answer that yet. ${V.HELP}`);
  assert.equal(V.answer({ intent: 'empty' }), "I didn't catch that.");
  assert.equal(V.answer(V.parseIntent("what's blocked"), { sessions: [] }), 'No sessions are running, so nothing is blocked.');
  assert.match(V.answer(V.parseIntent("what's Tonde's Claude doing"), { sessions: [] }), /team board/);
});

// ── Free-form: the user's own claude, isolated ──────────────────────────────
test('free-form asks haiku with no settings, tools, MCP servers or saved session, and a spend cap', () => {
  const args = V.claudeArgs('is it raining', { sessions: [] });
  const flag = (f) => args[args.indexOf(f) + 1];
  assert.equal(args[0], '-p');
  assert.equal(flag('--model'), 'haiku');
  assert.equal(flag('--setting-sources'), '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(flag('--tools'), '');
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(flag('--max-budget-usd'), V.CLAUDE_MAX_BUDGET_USD);
  assert.ok(!args.some((a) => /api[-_]?key|openai|gemini/i.test(a)), 'never another provider or key');
});

test('the free-form snapshot carries states and names only', () => {
  const snap = V.snapshot({ sessions: [S('bondly', 'tool-use', { tool: 'Bash', transcriptPath: '/secret.jsonl', lastPrompt: 'my secret' })], turns: [], transitions: [] });
  assert.deepEqual(snap.sessions, [{ project: 'bondly', state: 'is working, using Bash', agents: 0 }]);
  assert.ok(!JSON.stringify(snap).includes('secret'));
});

// ── The speech helper, mocked: no mic, no permission prompt ────────────────
function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args) => {
    const c = new EventEmitter();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.stdin = new PassThrough();
    c.written = '';
    c.stdin.on('data', (d) => { c.written += d; });
    c.kill = () => { c.killed = true; c.stdout.end(); c.emit('close', null); };
    c.say = (obj) => c.stdout.write(`${JSON.stringify(obj)}\n`);
    c.end = () => { c.stdout.end(); setImmediate(() => c.emit('close', 0)); };
    calls.push({ cmd, args, child: c });
    return c;
  };
  return { spawn, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 10));
function listener(over = {}) {
  const f = fakeSpawn();
  const states = [];
  const finals = [];
  const l = createListener({ spawn: f.spawn, helperPath: '/app/voice/buddy-listen', exists: () => true, platform: 'darwin', onState: (s) => states.push(s), onFinal: (t) => finals.push(t), ...over });
  return { l, f, states, finals };
}

test('listening: badge on, partials shown, the final transcript handed on, stop via stdin', async () => {
  const { l, f, states, finals } = listener();
  assert.deepEqual(l.start({ holdKey: 49 }), { ok: true });
  const { cmd, args, child } = f.calls[0];
  assert.equal(cmd, '/app/voice/buddy-listen');
  assert.deepEqual(args, ['listen', '--max-ms', '15000', '--hold-key', '49']);
  assert.ok(!args.some((a) => /\.(wav|aiff|caf|m4a)$/.test(a)), 'no audio file anywhere');
  assert.deepEqual(states[0], { state: 'listening' });
  assert.equal(l.listening, true);
  assert.deepEqual(l.start(), { ok: false, reason: 'already listening' });
  child.say({ event: 'ready' });
  child.say({ event: 'partial', text: "what's" });
  await tick();
  assert.deepEqual(states.at(-1), { state: 'listening', partial: "what's" });
  assert.equal(l.stop(), true);
  assert.equal(child.written, 'stop\n');
  child.say({ event: 'final', text: "what's blocked", ms: 320 });
  child.end();
  await tick();
  assert.deepEqual(finals, ["what's blocked"]);
  assert.equal(states.filter((s) => s.state === 'idle').length, 0, 'main moves on to thinking/talking itself');
  assert.equal(l.listening, false);
});

test('a key the helper cannot read falls back to press-again-to-stop', async () => {
  const { l, f } = listener();
  l.start({ holdKey: 105 });
  assert.equal(l.holdSupported, true);
  f.calls[0].child.say({ event: 'hold-unsupported' });
  await tick();
  assert.equal(l.holdSupported, false);
  l.start();
  assert.equal(f.calls.length, 1);
});

test('a long-press has no hold key: the widget says when to stop', () => {
  const { l, f } = listener();
  l.start();
  assert.deepEqual(f.calls[0].args, ['listen', '--max-ms', '15000']);
  assert.equal(l.holdSupported, false);
});

test('permission refusals come back as plain instructions, and exit without a final goes idle', async () => {
  const { l, f, states, finals } = listener();
  l.start();
  f.calls[0].child.say({ event: 'error', error: 'mic-denied' });
  f.calls[0].child.end();
  await tick();
  assert.match(states.at(-1).error, /System Settings, Privacy and Security, Microphone/);
  assert.equal(states.filter((s) => s.state === 'idle').length, 0);
  l.start();
  f.calls[1].child.end();
  await tick();
  assert.deepEqual(states.at(-1), { state: 'idle' });
  assert.deepEqual(finals, []);
});

test('no helper, or not a Mac: nothing is spawned and the reason is said', () => {
  const missing = listener({ exists: () => false });
  assert.match(missing.l.start().reason, /not built/);
  assert.equal(missing.f.calls.length, 0);
  const win = listener({ platform: 'win32' });
  assert.match(win.l.start().reason, /macOS only/);
  assert.equal(win.f.calls.length, 0);
});

test('a spawn that throws is reported, not thrown', () => {
  const { l } = listener({ spawn: () => { throw new Error('EACCES'); } });
  assert.deepEqual(l.start(), { ok: false, reason: 'EACCES' });
  assert.equal(l.listening, false);
});

// ── Wiring the tests can see without Electron ───────────────────────────────
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('the Swift helper is on-device only and never writes audio', () => {
  const src = read('native/voice/buddy-listen.swift');
  assert.equal((src.match(/requiresOnDeviceRecognition = true/g) || []).length, 2, 'both the mic and the file path');
  assert.ok(!/AVAudioFile|write\(to|FileHandle\(forWritingAtPath|\.write\(/.test(src), 'no audio written to disk');
  const plist = read('native/voice/Info.plist');
  assert.match(plist, /NSMicrophoneUsageDescription/);
  assert.match(plist, /NSSpeechRecognitionUsageDescription/);
});

test('the packaged app carries the usage strings and the helper', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.mac.extendInfo.NSMicrophoneUsageDescription);
  assert.ok(pkg.build.mac.extendInfo.NSSpeechRecognitionUsageDescription);
  assert.ok(pkg.build.extraResources.some((r) => r.from === 'native/voice/build' && r.to === 'voice'));
  assert.ok(pkg.scripts['predist:mac'] && pkg.scripts.predist);
});

test('the widget shows a mic badge while listening and moves the mouth while talking', () => {
  const html = read('index.html');
  assert.match(html, /id="mic"/);
  assert.match(html, /body\.listening #mic \{ display: grid/);
  assert.match(html, /rig\.talking\(st\.state === 'talking'\)/);
  assert.match(html, /prefers-reduced-motion: reduce\) \{ body\.listening #mic \{ animation: none/);
});
