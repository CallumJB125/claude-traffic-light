// Phase 1 exit criteria end to end, as separate processes (CONTRACT §13 e2e):
// hub + runners + board-mcp + fake-claude, compressed timers
// (BOARD_TEST_TIME_SCALE, default 0.05 → TTL 2.25 s, T_orphan 15 s, G 12 s).
// Every test ends by replaying the hub journal against the live cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TTL_MS, T_ORPHAN_MS, GATE_G_MS, HB_MS } from '../../shared/liveness.js';
import { stack, watch, until, sleep, checkJournal, SCALE } from './harness.js';

assert.ok(SCALE < 1 && TTL_MS === 45_000 * SCALE, 'run with BOARD_TEST_TIME_SCALE (npm run test:e2e)');

// Busy agent: a file, a handover, then steady tool work.
const WORK = (n = 200, ms = 250) => ({
  steps: [
    { mcp: 'board_get_card' },
    { tool: 'Write', input: { file_path: 'src/feature.js', content: 'export const feature = 1;\n' } },
    { mcp: 'board_write_handover', args: { patch: { hypothesis: 'feature flag belongs in src/feature.js', next: 'add the test' } } },
    ...Array.from({ length: n }, (_, i) => ({ tool: 'Bash', input: { command: `echo step ${i}` }, ms })),
  ],
});

async function dispatch(s, member, card, body = {}) {
  const res = await member.call('POST', `/api/cards/${card.id}/actions/dispatch`, body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.card;
}

const greenNow = async (s, m, id) => (await s.view(m, id)).card.live?.green === true;
const stateOf = async (s, m, id) => (await s.view(m, id)).card.run_state;

function finish(s, timelines) {
  const db = s.db();
  try {
    const j = checkJournal(db, timelines);
    assert.deepEqual(j.mismatches, [], 'journal replay reproduces the live cards');
    assert.ok(j.transitions > 0);
  } finally { db.close(); }
}

test('Give to Claude → green; kill -9 the CLI → failed within ~1 s, never green again', async () => {
  const s = await stack();
  try {
    const A = await s.runner('rA', s.alice, WORK());
    const card = await s.card(s.alice);
    await dispatch(s, s.alice, card);
    await until(() => greenNow(s, s.alice, card.id), { what: 'green', timeout: 15000 });
    const w = watch(s.alice, card.id);
    const runId = (await s.view(s.alice, card.id)).card.run.id;
    const t0 = Date.now();
    process.kill(A.cliPid(runId), 'SIGKILL');
    await until(async () => (await stateOf(s, s.alice, card.id)) === 'failed', { what: 'failed' });
    const dt = Date.now() - t0;
    await sleep(TTL_MS);
    const tl = w.stop();
    assert.ok(dt < 1500, `failed ${dt} ms after kill -9`);
    assert.ok(tl.filter((x) => x.t > t0 + 200).every((x) => !x.green), 'never green after the kill');
    const v = (await s.view(s.alice, card.id)).card;
    assert.deepEqual([v.run_state, v.fail_kind], ['failed', 'error']);
    finish(s, { [card.id]: tl });
  } finally {
    await s.close();
  }
});

test('kill -9 the runner and its CLI (the machine dies) → never green; unresponsive at ~TTL, orphaned at ~T_orphan of silence; handover from facts + notes + snapshot', async () => {
  const s = await stack();
  try {
    const A = await s.runner('rA', s.alice, WORK());
    const card = await s.card(s.alice);
    await dispatch(s, s.alice, card);
    await until(() => greenNow(s, s.alice, card.id), { what: 'green', timeout: 15000 });
    // The handover narrative and a pushed snapshot are on the hub before the crash.
    await until(async () => {
      const h = (await s.alice.call('GET', `/api/cards/${card.id}/handover?format=json`)).body;
      return h?.doc?.layers?.narrative?.version >= 1 && h?.doc?.layers?.snapshot?.status === 'pushed';
    }, { what: 'narrative + snapshot synced' });
    const w = watch(s.alice, card.id);
    const lastHb = Date.now();
    A.signal('SIGKILL');
    const tUnresp = await until(async () => (await stateOf(s, s.alice, card.id)) === 'unresponsive' && Date.now(), { what: 'unresponsive' });
    const tOrphan = await until(async () => (await stateOf(s, s.alice, card.id)) === 'orphaned' && Date.now(), { what: 'orphaned', timeout: T_ORPHAN_MS + 10000 });
    const tl = w.stop();
    // The hub only learns of a dead machine from HB silence: green may last until
    // the last HB is TTL old (isGreen's hb_age ≤ TTL), never beyond it.
    const lateGreen = tl.filter((x) => x.green && x.t > lastHb + TTL_MS + 300);
    assert.deepEqual(lateGreen, [], 'never green once the last heartbeat is TTL old');
    const slack = HB_MS + 1500;
    assert.ok(tUnresp - lastHb >= TTL_MS - HB_MS && tUnresp - lastHb <= TTL_MS + slack, `unresponsive after ${tUnresp - lastHb} ms (TTL ${TTL_MS})`);
    // T_orphan counts HB silence (liveness.timerEvent), not time since unresponsive.
    assert.ok(tOrphan - lastHb >= T_ORPHAN_MS - HB_MS && tOrphan - lastHb <= T_ORPHAN_MS + slack, `orphaned after ${tOrphan - lastHb} ms of silence (T_orphan ${T_ORPHAN_MS})`);

    const h = (await s.alice.call('GET', `/api/cards/${card.id}/handover?format=json`)).body;
    assert.ok(h.doc.layers.facts, 'facts layer');
    assert.ok(JSON.stringify(h.doc).includes('src/feature.js'), 'facts: the touched file');
    assert.match(h.markdown, /feature flag belongs in src\/feature\.js/, 'notes: the narrative');
    assert.match(h.doc.layers.snapshot.ref, /^refs\/board\/DEV-1\/r1/, 'snapshot ref');
    assert.equal(h.doc.layers.snapshot.status, 'pushed');
    const git = s.repo.gitIn(s.repo.bare, 'show', `${h.doc.layers.snapshot.sha}:src/feature.js`);
    assert.match(git, /feature = 1/, 'the snapshot is in the remote');
    finish(s, { [card.id]: tl });
  } finally {
    await s.close();
  }
});

test('SIGSTOP the runner and its CLI (lid closed) → suspended, never green; SIGCONT → recovers grey, green only after fresh activity', async () => {
  const s = await stack();
  try {
    const A = await s.runner('rA', s.alice, WORK(400, 150));
    const card = await s.card(s.alice);
    await dispatch(s, s.alice, card);
    await until(() => greenNow(s, s.alice, card.id), { what: 'green', timeout: 15000 });
    const w = watch(s.alice, card.id, 25);
    await A.control({ type: 'host_suspending' });   // Buddy's powerMonitor relay
    await until(async () => (await stateOf(s, s.alice, card.id)) === 'suspended', { what: 'suspended' });
    const tStop = Date.now();
    A.signal('SIGSTOP');
    await sleep(2 * TTL_MS + 1000);
    assert.equal(await stateOf(s, s.alice, card.id), 'suspended', 'a sleeping laptop stays suspended, not unresponsive');
    const tCont = Date.now();
    A.signal('SIGCONT');
    await until(async () => !['suspended'].includes(await stateOf(s, s.alice, card.id)), { what: 'recovered' });
    await until(() => greenNow(s, s.alice, card.id), { what: 'green after fresh activity', timeout: 15000 });
    await sleep(300);
    const tl = w.stop();
    assert.ok(tl.filter((x) => x.t >= tStop && x.t <= tCont).every((x) => x.run_state === 'suspended' && !x.green), 'suspended and never green while asleep');
    const after = tl.filter((x) => x.t > tCont && x.run_state !== 'suspended');
    assert.equal(after[0].green, false, 'the first recovered view is grey');
    const firstGreen = after.find((x) => x.green);
    assert.ok(firstGreen && firstGreen.post_wake_activity === true, `green only with post-wake activity ${JSON.stringify(after.slice(0, 12).map((x) => [x.t - tCont, x.run_state, x.green, x.post_wake_activity]))}`);
    const log = A.logs();
    assert.ok(log.some((l) => l.msg === 'host woke' && l.source === 'tick_gap'), 'the runner detected the sleep by the tick gap');
    finish(s, { [card.id]: tl });
  } finally {
    await s.close();
  }
});

test('restart the hub → reconnecting → recovers on the first heartbeat; no false orphan', async () => {
  const s = await stack();
  try {
    await s.runner('rA', s.alice, WORK(400, 150));
    const card = await s.card(s.alice);
    await dispatch(s, s.alice, card);
    await until(() => greenNow(s, s.alice, card.id), { what: 'green', timeout: 15000 });
    const w = watch(s.alice, card.id, 20);
    await s.restartHub();
    await until(() => greenNow(s, s.alice, card.id), { what: 'green again', timeout: 15000 });
    await sleep(T_ORPHAN_MS + 2000);   // past boot grace: still no orphan
    const tl = w.stop();
    assert.ok(tl.every((x) => x.run_state !== 'orphaned'), 'never orphaned');
    assert.equal(await stateOf(s, s.alice, card.id), 'running');
    const db = s.db();
    try {
      const t = db.prepare("SELECT payload FROM journal WHERE card_id = ? AND kind = 'card.transition' ORDER BY seq").all(card.id).map((x) => JSON.parse(x.payload));
      const boot = t.findIndex((x) => x.rule === '19');
      assert.ok(boot > 0, 'hub_boot → reconnecting was journalled');
      assert.equal(t[boot + 1].rule, '20', 'next: the first HB of the new epoch recovers it');
      assert.ok(!t.some((x) => x.to === 'orphaned' || x.to === 'unresponsive'), 'no false orphan or unresponsive');
    } finally { db.close(); }
    finish(s, { [card.id]: tl });
  } finally {
    await s.close();
  }
});

test('partition: gate G pauses the runner before the card orphans; takeover by a teammate; the zombie is fenced, never double-works, and its work lands in salvage', async () => {
  const s = await stack();
  try {
    const A = await s.runner('rA', s.alice, WORK(600, 100));
    await s.runner('rB', s.bob, WORK(600, 100), { accept_from: { [s.repoId]: [s.alice.id] } });
    const card = await s.card(s.alice);
    await dispatch(s, s.alice, card);
    await until(() => greenNow(s, s.alice, card.id), { what: 'A green', timeout: 15000 });
    const vA = (await s.view(s.alice, card.id)).card;
    const runA = { ...vA.run, fence: vA.fence };
    const w = watch(s.alice, card.id);
    A.proxy.blackhole();
    const lastAck = Math.max(...A.proxy.frames('down').filter((f) => f.type === 'hb.ack').map((f) => f.at));
    const tOrphan = await until(async () => (await stateOf(s, s.alice, card.id)) === 'orphaned' && Date.now(), { what: 'orphaned', timeout: T_ORPHAN_MS + 15000 });
    const gate = A.logs().find((l) => l.msg === 'gate closed');
    assert.ok(gate, 'the partitioned runner closed gate G');
    const tGate = Date.parse(gate.t);
    assert.ok(tGate - lastAck >= GATE_G_MS - 1000 && tGate - lastAck <= GATE_G_MS + 2500, `gate closed ${tGate - lastAck} ms after the last current ack (G ${GATE_G_MS})`);
    assert.ok(tGate < tOrphan, 'tools paused before the card orphaned');
    const preAfterGate = A.fakeLog(runA.id).filter((e) => e.ev === 'hook' && e.event === 'PreToolUse' && e.t > tGate + 50);
    assert.ok(preAfterGate.every((e) => e.out?.hookSpecificOutput?.permissionDecision === 'deny'), 'every tool after G is denied');

    // Take over, then give it to Bob's Claude.
    const to = await s.alice.call('POST', `/api/cards/${card.id}/actions/take_over`, {});
    assert.equal(to.status, 200, JSON.stringify(to.body));
    const re = await s.alice.call('POST', `/api/cards/${card.id}/actions/take_over_with_claude`, { target_member_id: s.bob.id });
    assert.equal(re.status, 200, JSON.stringify(re.body));
    await until(async () => { const v = (await s.view(s.alice, card.id)).card; return v.run?.id !== runA.id && v.live?.green; }, { what: 'B green', timeout: 15000 });
    const runB = (await s.view(s.alice, card.id)).card.run;
    assert.equal(runB.device_name, 'rB');

    // Heal: the zombie reconnects, is fenced, stops, and salvages.
    const tHeal = Date.now();
    A.proxy.heal();
    await until(() => Object.keys(A.ledger()).length === 0, { what: 'A stopped its CLI', timeout: 20000 });
    await until(async () => (await s.view(s.alice, card.id)).feed.some((e) => e.kind === 'salvage' && e.run_n === runA.fence && /fenced/.test(e.data?.text ?? '')), { what: 'salvage note', timeout: 15000 });
    const detail = await s.view(s.alice, card.id);
    const salv = detail.feed.filter((e) => e.kind === 'salvage' && e.run_n === runA.fence);
    assert.ok(salv.length >= 1);
    assert.ok(salv.every((e) => e.data.promoted !== true), 'a zombie salvage is never promoted over the newer run');
    assert.ok(salv.some((e) => e.data.kind === 'snapshot' && /-salvage$/.test(e.data.ref ?? '')), 'its code is in the salvage ref');
    const post = A.fakeLog(runA.id).filter((e) => e.ev === 'hook' && e.event === 'PostToolUse' && e.t > tGate + 50);
    assert.deepEqual(post, [], 'no tool completed on the zombie after gate G');
    assert.equal(detail.card.run.id, runB.id);
    const tl = w.stop();
    assert.ok(tl.filter((x) => x.t > tHeal).every((x) => x.run_state === 'running' || x.run_state === 'quiet'), 'Bob\'s run is undisturbed by the zombie');
    const db = s.db();
    try {
      const late = db.prepare("SELECT kind FROM events WHERE run_id = ? AND id > (SELECT MAX(id) FROM events WHERE card_id = ? AND kind = 'taken_over')").all(runA.id, card.id).map((x) => x.kind);
      // Its stale outbox entries are acked and dropped: one visible salvage line, the rest internal.
      assert.ok(late.every((k) => k === 'salvage' || k === 'outbox_dropped'), `after the takeover the zombie only salvages (${late.join(',')})`);
    } finally { db.close(); }
    finish(s, { [card.id]: tl });
  } finally {
    await s.close();
  }
});

test('two runners of one member claim the same offer → exactly one wins and spawns; zero foreign bytes from a non-board repo on the same device', async () => {
  const s = await stack();
  try {
    // A foreign repo, opted in locally but on no board, with a secret-looking name.
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const foreign = path.join(s.root, 'secretproj');
    fs.mkdirSync(foreign);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: foreign });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:other/secretproj.git'], { cwd: foreign });
    const extra = { extraRepos: { 'repo-foreign': { opt_in: true, local_path: foreign } } };
    const A1 = await s.runner('rA1', s.alice, WORK(300, 100), extra);
    const A2 = await s.runner('rA2', s.alice, WORK(300, 100), extra);
    const card = await s.card(s.alice);
    await dispatch(s, s.alice, card);
    await until(() => greenNow(s, s.alice, card.id), { what: 'green', timeout: 15000 });
    await sleep(500);
    const claims = [A1, A2].map((r) => r.proxy.frames('up').filter((f) => f.type === 'claim').length);
    const wins = [A1, A2].map((r) => r.proxy.frames('down').filter((f) => f.type === 'claim.result' && f.ok).length);
    assert.ok(claims[0] + claims[1] >= 1);
    assert.equal(wins[0] + wins[1], 1, `exactly one claim won (claims ${claims})`);
    assert.equal(A1.runDirs().length + A2.runDirs().length, 1, 'exactly one CLI was spawned');
    const winner = wins[0] ? A1 : A2;
    const loser = wins[0] ? A2 : A1;
    if (claims[wins[0] ? 1 : 0]) assert.ok(loser.proxy.frames('down').some((f) => f.type === 'claim.result' && !f.ok && f.error.code === 'CLAIM_LOST'), 'the loser got CLAIM_LOST');

    // A session in the foreign repo on the same machine: the hook shim with the
    // run's IPC env, but the tool touches the foreign checkout (a `cd ..` path).
    const runId = (await s.view(s.alice, card.id)).card.run.id;
    const runDir = winner.runDirs()[0];
    const token = fs.readFileSync(path.join(runDir, 'hook.token'), 'utf8');
    const ledger = winner.ledger()[runId];
    const env = { PATH: process.env.PATH, BOARD_RUN_SOCKET: path.join(runDir, 'ipc.sock'), BOARD_SUPERVISOR_PID: String(winner.proc.pid), BOARD_SUPERVISOR_LSTART: execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(winner.proc.pid)], { encoding: 'utf8' }).trim() };
    for (const ev of ['post', 'postfail']) {
      const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(foreign, 'secret.env'), content: 'x' }, tool_response: { ok: true }, cwd: foreign, error: `${foreign}/secret.env: API_KEY=sk-ant-0123456789abcdefghij` });
      execFileSync(process.execPath, [new URL('../../runner/hook-shim.js', import.meta.url).pathname, ev], { input: payload, env, cwd: foreign });
    }
    assert.ok(token && ledger);
    await sleep(3000);   // past the fact flush
    for (const r of [A1, A2]) {
      const up = r.proxy.up.map((f) => f.text).join('\n');
      assert.ok(r.proxy.up.length > 0);
      for (const bad of ['secretproj', foreign, 'repo-foreign', 'sk-ant-0123']) assert.ok(!up.includes(bad), `${r.name}: "${bad}" never reaches the hub`);
      const adv = r.proxy.frames('up').filter((f) => f.type === 'advertise');
      assert.ok(adv.every((a) => a.repos.every((x) => x.repo_id === s.repoId)), 'only the board repo is advertised');
    }
    finish(s, {});
  } finally {
    await s.close();
  }
});
