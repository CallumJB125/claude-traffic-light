// The permission answer protocol (hooks/answer-file.js) and the hook that
// uses it: unique request ids, hash-bound answers, first answer wins, the
// hook's last word at its deadline, and the .taken acknowledgement.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const A = require('../hooks/answer-file.js');

const SET_STATUS = path.join(__dirname, '..', 'hooks', 'set-status.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-answer-'));
const listening = () => new Promise((res) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => res(s)); });

function writeReq(dir, id, input = { command: 'ls' }) {
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, tool: 'Bash', toolInput: input, toolInputHash: A.hashToolInput(input), createdAt: new Date().toISOString() }));
  return A.hashToolInput(input);
}

test('canonical hash ignores key order, not content', () => {
  assert.equal(A.hashToolInput({ a: 1, b: [2, { d: 1, c: 2 }] }), A.hashToolInput({ b: [2, { c: 2, d: 1 }], a: 1 }));
  assert.notEqual(A.hashToolInput({ command: 'ls' }), A.hashToolInput({ command: 'ls ' }));
});

test('first answer wins; later answers are told so', () => {
  const dir = tmp();
  writeReq(dir, 'r1');
  const results = ['allow', 'deny', 'allow', 'deny'].map((d) => A.writeAnswer(dir, 'r1', d));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results[1].error, 'already answered');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'r1.answer'), 'utf8')).decision, 'allow');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['r1.answer', 'r1.json'], 'no temp files left behind');
});

test('first answer wins across processes racing at once', () => {
  const dir = tmp();
  writeReq(dir, 'r2');
  const script = `const A=require(${JSON.stringify(path.join(__dirname, '..', 'hooks', 'answer-file.js'))});const t=Number(process.argv[1]);while(Date.now()<t);process.stdout.write(String(A.writeAnswer(${JSON.stringify(dir)},'r2',process.argv[2]).ok))`;
  const start = Date.now() + 400;
  const kids = Array.from({ length: 8 }, (_, i) => spawn(process.execPath, ['-e', script, String(start), i % 2 ? 'allow' : 'deny']));
  return Promise.all(kids.map((k) => new Promise((res) => { let o = ''; k.stdout.on('data', (d) => { o += d; }); k.on('exit', () => res(o)); }))).then((outs) => {
    assert.equal(outs.filter((o) => o === 'true').length, 1, outs.join(','));
  });
});

test('answers need a hashed request; bad ids and decisions are refused', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ id: 'old', tool: 'Bash' }));
  assert.match(A.writeAnswer(dir, 'old', 'allow').error, /no input hash/);
  assert.equal(A.writeAnswer(dir, 'missing', 'allow').ok, false);
  for (const id of ['../x', '.hidden', '', 'a/b']) assert.equal(A.writeAnswer(dir, id, 'allow').ok, false, id);
  writeReq(dir, 'r3');
  assert.equal(A.writeAnswer(dir, 'r3', 'maybe').ok, false);
});

test('deadline race: the hook claims first → a late answer loses', () => {
  const dir = tmp();
  writeReq(dir, 'r4');
  assert.equal(A.claimTimeout(dir, 'r4'), true);
  assert.equal(A.writeAnswer(dir, 'r4', 'allow').error, 'already answered');
});

test('deadline race: an answer landed first → the hook honours it', () => {
  const dir = tmp();
  const h = writeReq(dir, 'r5');
  assert.equal(A.writeAnswer(dir, 'r5', 'deny').ok, true);
  assert.equal(A.claimTimeout(dir, 'r5'), false);
  assert.equal(A.consumeAnswer(dir, 'r5', h), 'deny');
});

test('an answer bound to a different input is refused by the hook', () => {
  const dir = tmp();
  writeReq(dir, 'r6', { command: 'rm -rf ~' });
  assert.equal(A.writeAnswer(dir, 'r6', 'allow', { ack: true }).ok, true);
  // The hook is holding a different input than the one the answer was for.
  assert.equal(A.consumeAnswer(dir, 'r6', A.hashToolInput({ command: 'ls' })), null);
  assert.ok(fs.existsSync(path.join(dir, 'r6.refused')));
});

test('ack: applied only once the hook has taken our answer; lost / refused / unknown otherwise', async () => {
  const dir = tmp();
  const h = writeReq(dir, 'r7');
  const mine = A.writeAnswer(dir, 'r7', 'allow', { ack: true });
  assert.equal(await A.awaitTaken(dir, 'r7', mine.nonce, { timeoutMs: 100 }), 'unknown', 'hook has not read it yet');
  assert.equal(A.consumeAnswer(dir, 'r7', h), 'allow');
  assert.equal(await A.awaitTaken(dir, 'r7', 'someone-else', { timeoutMs: 100 }), 'lost');
  assert.equal(await A.awaitTaken(dir, 'r7', mine.nonce), 'applied');
  assert.equal(fs.existsSync(path.join(dir, 'r7.taken')), false, 'the answerer cleans up its ack');

  writeReq(dir, 'r8', { command: 'x' });
  const bad = A.writeAnswer(dir, 'r8', 'allow', { ack: true });
  A.consumeAnswer(dir, 'r8', 'f'.repeat(64));
  assert.equal(await A.awaitTaken(dir, 'r8', bad.nonce), 'refused');
});

test('sweep removes stale leftovers only', () => {
  const dir = tmp();
  writeReq(dir, 'r9');
  for (const f of ['a.answer', 'b.taken', 'c.refused', 'd.answer.tmp.00ff']) fs.writeFileSync(path.join(dir, f), '{}');
  fs.writeFileSync(path.join(dir, 'fresh.taken'), '{}');
  const old = new Date(Date.now() - 20 * 60 * 1000);
  for (const f of ['a.answer', 'b.taken', 'c.refused', 'd.answer.tmp.00ff', 'r9.json']) fs.utimesSync(path.join(dir, f), old, old);
  A.sweep(dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['fresh.taken', 'r9.json']);
});

// ── the real hook ───────────────────────────────────────────────────────────
function startHook(home, port, input, { session = 's', askMs = 5000 } = {}) {
  const child = spawn(process.execPath, [SET_STATUS, 'permission-request'], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, CLAUDE_TRAFFIC_LIGHT_ASK_MS: String(askMs), CLAUDE_TRAFFIC_LIGHT_PORT: String(port) } });
  child.stdin.end(JSON.stringify({ session_id: session, cwd: '/x', tool_name: 'Bash', tool_input: input }));
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.done = new Promise((res) => child.on('exit', () => res(out)));
  return child;
}
async function waitForRequests(dir, n) {
  const deadline = Date.now() + 4000;
  for (;;) {
    const reqs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
    if (reqs.length >= n || Date.now() > deadline) return reqs;
    await new Promise((r) => setTimeout(r, 30));
  }
}

test('hook: parallel tool calls in one session get distinct ids; one answer releases only its own call', async () => {
  const home = tmp();
  const srv = await listening();
  try {
    const dir = path.join(home, 'requests');
    const a = startHook(home, srv.address().port, { command: 'echo a' }, { askMs: 1500 });
    const b = startHook(home, srv.address().port, { command: 'rm -rf build' }, { askMs: 1500 });
    const reqs = await waitForRequests(dir, 2);
    assert.equal(reqs.length, 2);
    assert.notEqual(reqs[0].id, reqs[1].id);
    for (const r of reqs) assert.match(r.id, /-[0-9a-f]{8}-[0-9a-f]{4}-/);
    const ra = reqs.find((r) => r.toolInput.command === 'echo a');
    assert.equal(A.writeAnswer(dir, ra.id, 'allow').ok, true);
    assert.deepEqual(JSON.parse(await a.done).hookSpecificOutput.decision, { behavior: 'allow' });
    assert.equal(await b.done, '', 'the other call was not released');
  } finally { srv.close(); }
});

test('hook: an answer carrying another input\'s hash is ignored', async () => {
  const home = tmp();
  const srv = await listening();
  try {
    const dir = path.join(home, 'requests');
    const h = startHook(home, srv.address().port, { command: 'rm -rf ~' }, { askMs: 1500 });
    const [req] = await waitForRequests(dir, 1);
    A.createExclusive(path.join(dir, `${req.id}.answer`), JSON.stringify({ v: 1, decision: 'allow', toolInputHash: A.hashToolInput({ command: 'ls' }), ack: false }));
    assert.equal(await h.done, '');
  } finally { srv.close(); }
});

test('hook: an ack-wanting answer is confirmed via .taken; after the deadline nothing can be answered', async () => {
  const home = tmp();
  const srv = await listening();
  try {
    const dir = path.join(home, 'requests');
    const h = startHook(home, srv.address().port, { command: 'npm test' });
    const [req] = await waitForRequests(dir, 1);
    const w = A.writeAnswer(dir, req.id, 'allow', { by: 'remote', ack: true });
    assert.equal(await A.awaitTaken(dir, req.id, w.nonce, { timeoutMs: 3000 }), 'applied');
    assert.deepEqual(JSON.parse(await h.done).hookSpecificOutput.decision, { behavior: 'allow' });

    const late = startHook(home, srv.address().port, { command: 'npm test' }, { askMs: 200 });
    const [req2] = await waitForRequests(dir, 1);
    assert.equal(await late.done, '');
    assert.equal(A.writeAnswer(dir, req2.id, 'allow').ok, false, 'request is gone once the hook gave up');
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing left behind');
  } finally { srv.close(); }
});

test('hook: request files are 0600 in a 0700 directory', async () => {
  const home = tmp();
  const srv = await listening();
  try {
    const dir = path.join(home, 'requests');
    const h = startHook(home, srv.address().port, { command: 'ls' }, { askMs: 600 });
    const deadline = Date.now() + 3000;
    let f = null;
    while (!f && Date.now() < deadline) { f = fs.existsSync(dir) && fs.readdirSync(dir).find((x) => x.endsWith('.json')); if (!f) await new Promise((r) => setTimeout(r, 20)); }
    assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    await h.done;
  } finally { srv.close(); }
});

test('the answer is spawnSync-safe: a CLI answerer on a missing request fails cleanly', () => {
  const r = spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(path.join(__dirname, '..', 'hooks', 'answer-file.js'))}).writeAnswer(${JSON.stringify(tmp())}, 'nope', 'allow')))`]);
  assert.equal(JSON.parse(r.stdout).ok, false);
});
