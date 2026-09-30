// Exit (l), runner half: a permission answer is re-checked against LOCAL policy
// (T1): an answerer not in approvals_from → deny (fail-closed) + message fact.
// A direct `approval` call by the model can only create an ask. A CLI-side
// cancel withdraws the wait and drops the late answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { startFakeHub, startRunner, makeRepo, tmpDir, rm, offerFor, claimRun, waitFor, readFakeLog, OWNER, REPO_ID } from './helpers.js';
import { answererAllowed, runAllowKey } from '../policy.js';

function approvals(runDir) {
  return readFakeLog(runDir).filter((e) => e.ev === 'approval').map((e) => e.result);
}

async function setup(steps, repoPolicy = {}) {
  const root = tmpDir();
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  let n = 0;
  hub.rpcReply = (f) => {
    if (f.method === 'approval') return { ok: true, result: { permission_request_id: `pr-${++n}` } };
    if (f.method === 'board_ask_human') return { ok: true, result: { ask_id: 'ask-1' } };
    return { ok: true, result: {} };
  };
  const sup = await startRunner({ hub, home: path.join(root, 'home'), repo, repoPolicy, scenario: { steps } });
  return { root, hub, sup };
}

const answer = (hub, run, prid, by, extra = {}) => hub.send({ type: 'answer', run_id: run.run_id, card_id: run.card_id, fence: run.fence, permission_request_id: prid, decision: 'allow', answered_by: { member_id: by, name: by }, ...extra });

test('answer from someone outside local approvals_from is denied; owner allow passes; allow-for-run sticks', async () => {
  const { root, hub, sup } = await setup([
    { tool: 'Bash', input: { command: 'curl https://evil.example' }, approval: true },
    { tool: 'Bash', input: { command: 'make deploy' }, approval: true },
    { tool: 'Bash', input: { command: 'make other' }, approval: true },
    { tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 },
  ], { approvals_from: ['m-lead'] });
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-90' }));
    await waitFor(() => hub.of('rpc').some((f) => f.method === 'approval'), { what: 'approval rpc' });
    const rpc = hub.of('rpc').find((f) => f.method === 'approval');
    assert.equal(rpc.params.tool_name, 'Bash');
    assert.match(rpc.params.input_summary, /curl/);
    answer(hub, run, 'pr-1', 'm-intruder');
    await waitFor(() => approvals(run.runDir).length === 1, { what: 'first decision' });
    assert.equal(approvals(run.runDir)[0].result.behavior, 'deny');
    await waitFor(() => { run.flushFacts(); return hub.facts('message').some((m) => /ignored/.test(m.text)); }, { what: 'message fact' });

    await waitFor(() => hub.of('rpc').filter((f) => f.method === 'approval').length === 2, { what: 'second approval' });
    answer(hub, run, 'pr-2', 'm-lead', { scope: 'run' });
    await waitFor(() => approvals(run.runDir).length === 2, { what: 'second decision' });
    assert.equal(approvals(run.runDir)[1].result.behavior, 'allow');
    // "Allow for this run": same tool + same first word → allowed without asking.
    await waitFor(() => approvals(run.runDir).length === 3, { what: 'third decision' });
    assert.equal(approvals(run.runDir)[2].result.behavior, 'allow');
    assert.equal(hub.of('rpc').filter((f) => f.method === 'approval').length, 2, 'no third rpc');
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});

test('a direct approval call by the model only creates an ask and is denied', async () => {
  const { root, hub, sup } = await setup([
    { mcp: 'approval', args: { tool_name: 'Bash', input: { command: 'rm -rf /' }, tool_use_id: 'toolu_made_up' } },
    { tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 },
  ]);
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-91' }));
    const mcp = await waitFor(() => readFakeLog(run.runDir).find((e) => e.ev === 'mcp' && e.name === 'approval'), { what: 'mcp result' });
    assert.equal(mcp.result.result.behavior, 'deny');
    assert.ok(hub.of('rpc').some((f) => f.method === 'board_ask_human'));
    assert.ok(!hub.of('rpc').some((f) => f.method === 'approval'), 'no permission request was created');
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});

test('cancel {re} from board-mcp denies the held approval and drops the late answer', async () => {
  const { root, hub, sup } = await setup([{ tool: 'Bash', input: { command: 'sleep 600' }, ms: 600000 }]);
  try {
    const run = await claimRun(sup, hub, offerFor({ key: 'APP-92' }));
    run.streamTools.set('toolu_x', { name: 'Bash', mono: 0 });
    const sock = net.createConnection(run.socketPath);
    const lines = [];
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    await new Promise((r) => sock.on('connect', r));
    sock.write(`${JSON.stringify({ type: 'tool', id: 'a1', token: run.run_token, name: 'approval', args: { tool_name: 'Bash', input: { command: 'make x' }, tool_use_id: 'toolu_x' } })}\n`);
    await waitFor(() => hub.of('rpc').some((f) => f.method === 'approval'), { what: 'approval rpc' });
    sock.write(`${JSON.stringify({ type: 'cancel', id: 'c1', token: run.run_token, re: 'a1' })}\n`);
    const a1 = await waitFor(() => lines.find((l) => l.id === 'a1'), { what: 'a1 answered' });
    assert.equal(a1.result.behavior, 'deny');
    assert.match(a1.result.message, /cancelled/);
    const withdraw = await waitFor(() => hub.of('rpc').find((f) => f.method === 'approval_cancel'), { what: 'approval_cancel rpc' });
    assert.deepEqual(withdraw.params, { permission_request_id: 'pr-1' }, 'the hub is told to withdraw the request');
    answer(hub, run, 'pr-1', OWNER);   // late: dropped, nothing crashes
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(run.approvals.size, 0);
    sock.end();
  } finally {
    await sup.shutdown();
    await hub.close();
    rm(root);
  }
});

test('policy helpers', () => {
  const policy = { repos: { [REPO_ID]: { approvals_from: ['m-lead'] } } };
  assert.equal(answererAllowed(policy, REPO_ID, OWNER, { member_id: OWNER }), true);
  assert.equal(answererAllowed(policy, REPO_ID, OWNER, { member_id: 'm-lead' }), true);
  assert.equal(answererAllowed(policy, REPO_ID, OWNER, { member_id: 'm-x' }), false);
  assert.equal(answererAllowed(policy, REPO_ID, OWNER, null), false);
  assert.equal(runAllowKey('Bash', { command: 'npm run build' }), 'Bash:npm');
  assert.equal(runAllowKey('Edit', {}), 'Edit');
});
