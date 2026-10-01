// Security review group B: origin is not client-trusted (scoped relay tokens),
// remote work needs a repo opted in by policy.json, spin-offs inherit their
// parent's rules, per-task caches, memory caps, limits and retention.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startEngine, makeRepo, waitFor, fakeLog, rm, tmpDir, writePolicy } from './helpers.js';
import { addRelayToken } from '../relay-tokens.js';
import { connect } from '../../tasks-api/client.js';

const runDirOf = (m, id) => path.join(m.dataDir, 'run', id);

async function setup(scenario) {
  const dir = tmpDir();
  const repo = makeRepo(dir);
  const m = await startEngine({ dir, scenario });
  return { ...m, repo, spec: { text: 'Fix the README', cwd: repo.checkout }, async done() { await m.close().catch(() => {}); rm(dir); } };
}

test('relay tokens force their source and cannot approve, answer, take over or accept a start', async () => {
  const m = await setup();
  try {
    writePolicy(m.dataDir, { repos: { [m.repo.checkout]: { remote_tasks: true } } });
    const token = addRelayToken({ dataDir: m.dataDir, source: 'phone', label: 'phone bridge' });
    assert.match(token, /^btr_[A-Za-z0-9_-]{43}$/);
    const stored = fs.readFileSync(path.join(m.dataDir, 'relay-tokens.json'), 'utf8');
    assert.ok(!stored.includes(token), 'stored hashed');
    assert.equal(fs.statSync(path.join(m.dataDir, 'relay-tokens.json')).mode & 0o777, 0o600);
    const relay = await connect({ socketPath: m.eng.socketPath, token });
    try {
      const { id } = await relay.createTask({ ...m.spec, source: 'local', permissionLevel: 'auto' });
      const d = await m.client.getTask(id);
      assert.equal(d.source, 'phone', 'the token decides the source');
      assert.equal(d.awaitingConfirm, true);
      assert.equal(d.planFirst, true);
      assert.equal(d.permissionLevel, 'auto-edits');
      await assert.rejects(relay.act(id, 'approve', { approvalId: d.openApprovals[0].approvalId }), (e) => e.code === 'POLICY_DENIED');
      await m.client.act(id, 'approve', { approvalId: d.openApprovals[0].approvalId });
      const p = await waitFor(async () => { const x = await m.client.getTask(id); return x.blockedKind === 'plan' && x; }, { label: 'plan' });
      await assert.rejects(relay.act(id, 'answer', { askId: p.openAsk.askId, answer: 'Approve' }), (e) => e.code === 'POLICY_DENIED');
      await assert.rejects(relay.act(id, 'takeover', { mode: 'print' }), (e) => e.code === 'POLICY_DENIED');
      const s = await relay.act(id, 'stop', {});
      assert.equal(s.task.state, 'failed');
    } finally { relay.close(); }
    fs.chmodSync(path.join(m.dataDir, 'relay-tokens.json'), 0o644);
    await assert.rejects(connect({ socketPath: m.eng.socketPath, token }), (e) => e.code === 'UNAUTHENTICATED', 'a loosened token file is not trusted');
  } finally { await m.done(); }
});

test('remote tasks need policy.json repos[...].remote_tasks; accept_from comes from policy.json', async () => {
  const m = await setup();
  try {
    await assert.rejects(m.client.createTask({ ...m.spec, source: 'slack' }), (e) => e.code === 'POLICY_DENIED');
    writePolicy(m.dataDir, { repos: { 'github.com/acme/app': { remote_tasks: true } } });
    m.repo.git('remote', 'add', 'origin', 'git@github.com:acme/app.git');
    const a = await m.client.createTask({ ...m.spec, source: 'slack', sourceMeta: { userId: 'u-dana' } });
    assert.equal((await m.client.getTask(a.id)).awaitingConfirm, true, 'opted in by canonical remote');
    writePolicy(m.dataDir, { accept_from: ['u-dana'], repos: { [m.repo.checkout]: { remote_tasks: true } } });
    const b = await m.client.createTask({ ...m.spec, source: 'slack', sourceMeta: { userId: 'u-dana' } });
    assert.equal((await m.client.getTask(b.id)).awaitingConfirm, false, 'trusted sender from policy.json');
    fs.chmodSync(path.join(m.dataDir, 'policy.json'), 0o666);
    await assert.rejects(m.client.createTask({ ...m.spec, source: 'slack' }), (e) => e.code === 'POLICY_DENIED', 'a policy file others can write is ignored');
    for (const id of [a.id, b.id]) await m.client.act(id, 'stop', {});
  } finally { await m.done(); }
});

test('relay sender trust is bound by its private token record, never caller metadata', async () => {
  const m = await setup();
  const relays = [];
  try {
    writePolicy(m.dataDir, { accept_from: ['trusted-user'], repos: { [m.repo.checkout]: { remote_tasks: true } } });
    const relay = async (userId) => {
      const c = await connect({ socketPath: m.eng.socketPath, token: addRelayToken({ dataDir: m.dataDir, source: 'phone', userId }) });
      relays.push(c); return c;
    };
    const unbound = await relay(null);
    const bound = await relay('trusted-user');
    const requestId = 'same-request-across-principals';
    const a = await unbound.createTask({ ...m.spec, sourceMeta: { userId: 'trusted-user' } }, { requestId });
    const ad = await m.client.getTask(a.id);
    assert.equal(ad.awaitingConfirm, true, 'forged accept_from identity does not start');
    assert.equal(ad.spec.sourceMeta.userId, undefined);
    const b = await bound.createTask({ ...m.spec, sourceMeta: { userId: 'forged-other' } }, { requestId });
    const bd = await m.client.getTask(b.id);
    assert.notEqual(b.id, a.id, 'idempotency cache is principal scoped');
    assert.equal(bd.awaitingConfirm, false);
    assert.equal(bd.spec.sourceMeta.userId, 'trusted-user');
  } finally { for (const c of relays) c.close(); await m.done(); }
});

test('MCP relay cannot omit or replace its authenticated parent to widen repo or permission scope', async () => {
  const m = await setup({ steps: [{ result: 'success', text: 'plan' }] });
  const other = makeRepo(fs.mkdtempSync(path.join(m.dir, 'other-')));
  let relay;
  try {
    assert.throws(() => addRelayToken({ dataDir: m.dataDir, source: 'mcp' }), /parent session/);
    const { id } = await m.client.createTask({ ...m.spec, permissionLevel: 'plan' });
    const parent = await m.client.getTask(id);
    relay = await connect({ socketPath: m.eng.socketPath, token: addRelayToken({ dataDir: m.dataDir, source: 'mcp', parentSessionId: parent.sessionId }) });
    for (const sourceMeta of [{}, { parentSessionId: '00000000-0000-4000-8000-000000000000' }]) {
      await assert.rejects(relay.createTask({ text: 'escape', cwd: other.checkout, permissionLevel: 'auto-edits', sourceMeta }), (e) => e.code === 'POLICY_DENIED');
      const k = await relay.createTask({ ...m.spec, permissionLevel: 'auto-edits', sourceMeta });
      const kid = await m.client.getTask(k.id);
      assert.equal(kid.permissionLevel, 'plan');
      assert.equal(kid.spec.sourceMeta.parentSessionId, parent.sessionId);
    }
    const stale = await connect({ socketPath: m.eng.socketPath, token: addRelayToken({ dataDir: m.dataDir, source: 'mcp', parentSessionId: '00000000-0000-4000-8000-000000000000' }) });
    try { await assert.rejects(stale.createTask(m.spec), (e) => e.code === 'POLICY_DENIED'); } finally { stale.close(); }
  } finally { relay?.close(); await m.done(); }
});

test('spin-offs: limited to the parent task\'s repo, capped at its level, and a remote parent\'s rules carry over', async () => {
  const m = await setup({ steps: [{ tool: 'Bash', input: { command: 'sleep 1' }, ms: 60000 }] });
  const other = makeRepo(fs.mkdtempSync(path.join(m.dir, 'o-')));
  try {
    await m.client.setLimits({ maxParallel: 8 });
    const parent = await m.client.createTask({ ...m.spec, permissionLevel: 'ask' });
    const pd = await m.client.getTask(parent.id);
    const meta = { parentSessionId: pd.sessionId };
    await assert.rejects(m.client.createTask({ text: 'elsewhere', cwd: other.checkout, source: 'mcp', sourceMeta: meta }), (e) => e.code === 'POLICY_DENIED');
    const kid = await m.client.createTask({ text: 'sub', cwd: m.repo.checkout, source: 'mcp', permissionLevel: 'auto-edits', sourceMeta: meta });
    assert.equal((await m.client.getTask(kid.id)).permissionLevel, 'ask', "capped at the parent's level");

    writePolicy(m.dataDir, { repos: { [m.repo.checkout]: { remote_tasks: true } } });
    const rp = await m.client.createTask({ ...m.spec, source: 'slack' });
    const rd = await m.client.getTask(rp.id);
    const rkid = await m.client.createTask({ text: 'sub of remote', cwd: m.repo.checkout, source: 'mcp', sourceMeta: { parentSessionId: rd.sessionId } });
    const rk = await m.client.getTask(rkid.id);
    assert.equal(rk.awaitingConfirm, true, "a remote parent's spin-off waits for a local accept");
    assert.equal(rk.planFirst, true);
    for (const id of [parent.id, kid.id, rp.id, rkid.id]) await m.client.act(id, 'stop', {});
  } finally { await m.done(); }
});

test('caches go to a per-task dir; the global caches are not writable', async () => {
  const m = await setup({ steps: [{ result: 'success' }] });
  try {
    const { id } = await m.client.createTask(m.spec);
    await waitFor(async () => (await m.client.getTask(id)).state === 'in_review', { label: 'in_review' });
    const env = fakeLog(runDirOf(m, id)).find((l) => l.ev === 'start').env;
    for (const k of ['npm_config_cache', 'XDG_CACHE_HOME', 'PIP_CACHE_DIR', 'UV_CACHE_DIR']) assert.ok(env[k]?.includes(id), `${k} is per task`);
    const s = JSON.parse(fs.readFileSync(path.join(runDirOf(m, id), 'settings.json'), 'utf8'));
    assert.ok(!s.sandbox.filesystem.allowWrite.some((p) => /\.cache|Library\/Caches|\.npm/.test(p)));
    assert.ok(env.TMPDIR.includes(id), 'temp files are per task too');
    assert.ok(!s.sandbox.filesystem.allowWrite.includes('/tmp'), 'shared temp root is not writable');
    assert.ok(s.sandbox.filesystem.denyWrite.includes(fs.realpathSync(m.dataDir)), 'cannot alter engine config/tokens through Bash');
  } finally { await m.done(); }
});

test('in-place Bash sandbox protects instructions and config even within its writable folder', async () => {
  const m = await setup();
  try {
    const { id } = await m.client.createTask({ ...m.spec, workInPlace: true, permissionLevel: 'auto' });
    await waitFor(() => fs.existsSync(path.join(runDirOf(m, id), 'settings.json')));
    const s = JSON.parse(fs.readFileSync(path.join(runDirOf(m, id), 'settings.json'), 'utf8'));
    for (const p of ['.git/config', '.git/hooks', '.claude', '.mcp.json', 'CLAUDE.md', 'AGENTS.md']) {
      assert.ok(s.sandbox.filesystem.denyWrite.includes(path.join(m.repo.checkout, p)), p);
    }
  } finally { await m.done(); }
});

test('limits: maxParallel is capped at 8; at most 100 tasks waiting per source', async () => {
  const m = await setup({ steps: [{ result: 'success' }] });
  try {
    await assert.rejects(m.client.setLimits({ maxParallel: 9 }), (e) => e.code === 'VALIDATION');
    writePolicy(m.dataDir, { repos: { [m.repo.checkout]: { remote_tasks: true } } });
    for (let i = 0; i < 100; i++) await m.client.createTask({ ...m.spec, text: `r${i}`, source: 'slack' });
    await assert.rejects(m.client.createTask({ ...m.spec, text: 'one more', source: 'slack' }), (e) => e.code === 'RATE_LIMITED');
    const page = await m.client.call('listTasks', { limit: 30 });
    assert.equal(page.length, 30);
    const all = await m.client.listTasks();
    assert.equal(all.length, 100, 'the client pages through');
    assert.equal(new Set(all.map((t) => t.id)).size, 100);
  } finally { await m.done(); }
});

test('retention: finished tasks beyond the newest N are pruned with their files', async () => {
  const dir = tmpDir();
  const repo = makeRepo(dir);
  const m = await startEngine({ dir, scenario: { steps: [{ result: 'success' }] }, engineOpts: { retentionMax: 2 } });
  try {
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const { id } = await m.client.createTask({ text: `t${i}`, cwd: repo.checkout });
      await waitFor(async () => (await m.client.getTask(id)).state === 'in_review', { label: 'in_review' });
      await m.client.act(id, 'message', { body: 'note' });
      await waitFor(async () => (await m.client.getTask(id)).state === 'in_review', { label: 'in_review again' });
      await m.client.act(id, 'discard', { confirm: true });
      ids.push(id);
    }
    const left = (await m.client.listTasks()).map((t) => t.id);
    assert.deepEqual(left.sort(), ids.slice(-2).sort());
    assert.equal(fs.existsSync(path.join(m.dataDir, 'mesh', `${ids[0]}.ndjson`)), false);
    await assert.rejects(m.client.getTask(ids[0]), (e) => e.code === 'NOT_FOUND');
  } finally { await m.close().catch(() => {}); rm(dir); }
});

test('memory: a client that never reads is cut off; a long replay is paged with lagged, never one huge burst', async () => {
  const dir = tmpDir();
  const repo = makeRepo(dir);
  const m = await startEngine({ dir, scenario: { steps: [...Array.from({ length: 100 }, (_, i) => ({ assistant: `${i} ${'y'.repeat(60000)}` })), { result: 'success' }] } });
  try {
    const { id } = await m.client.createTask({ text: 'flood', cwd: repo.checkout });
    await waitFor(async () => (await m.client.getTask(id)).state === 'in_review', { label: 'in_review' });
    const c = await connect({ socketPath: m.eng.socketPath, tokenPath: m.eng.tokenPath });
    const got = [];
    let lagged = 0;
    c.on('lagged', () => { lagged += 1; });
    await c.subscribe('*', { fromSeq: 1 }, (e) => got.push(e.seq));
    const last = (await m.client.getTask(id)).lastSeq;
    await waitFor(() => got.at(-1) === last, { label: 'whole replay', timeoutMs: 20000 });
    assert.ok(lagged >= 1, 'replay was paged');
    assert.deepEqual(got, [...new Set(got)].sort((a, b) => a - b));
    c.close();

    const s = net.createConnection(m.eng.socketPath);
    s.on('error', () => {});   // EPIPE once the engine cuts us off
    await new Promise((r) => s.once('connect', r));
    s.pause();
    const tok = m.eng.token;
    s.write(`${JSON.stringify({ id: 'h', method: 'hello', params: { protocol: 1 }, token: tok })}\n`);
    const line = `${JSON.stringify({ id: 'g', method: 'getTask', params: { id }, token: tok })}\n`;
    for (let i = 0; i < 12000 && !s.destroyed; i++) s.write(line);
    const closed = await new Promise((r) => { s.once('close', () => r(true)); setTimeout(() => r(false), 15000); });
    assert.equal(closed, true, 'cut off past the write-buffer cap');
  } finally { await m.close().catch(() => {}); rm(dir); }
});
