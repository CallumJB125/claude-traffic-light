import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MCP_TOOLS, MCP_TOOL_SCOPES, TOOL_SCOPES, ERRORS } from '../../shared/protocol.js';
import { AGENT_WRITABLE } from '../../shared/handover.js';
import { TOOLS, callTool, approvalReply, errorResult, okResult } from '../tools.js';
import { IpcClient } from '../ipc.js';
import { createBoardServer } from '../server.js';
import { startFakeRunner, TOKEN } from './fake-runner.js';

const parse = (res) => JSON.parse(res.content[0].text);

// ── unit: schemas ──────────────────────────────────────────────────────────

describe('tool schemas', () => {
  test('exactly the contract tools exist', () => {
    assert.deepEqual(Object.keys(TOOLS).sort(), [...MCP_TOOLS].sort());
  });

  test('every tool has a title and a substantive description', () => {
    for (const [name, def] of Object.entries(TOOLS)) {
      assert.ok(def.title, name);
      assert.ok(def.description.length >= 80, `${name} description too thin`);
    }
  });

  test('read-only tools carry readOnlyHint, writers do not', () => {
    const ro = Object.entries(TOOLS).filter(([, d]) => d.annotations?.readOnlyHint).map(([n]) => n).sort();
    assert.deepEqual(ro, ['board_check_overlap', 'board_get_card', 'board_list_cards', 'board_read_packet', 'board_recall']);
  });

  const packet = { brief:'brief', decisions:[], progress:'progress', nextAction:'review', artifacts:[], reportedChecks:[] };
  const accept = {
    board_list_messages: [{}],
    board_send_message: [{request_id:'00000000-0000-4000-8000-000000000001',kind:'coordination',body:'Please review',recipient_run_ids:['00000000-0000-4000-8000-000000000002']}],
    board_ack_message: [{receipt_id:'00000000-0000-4000-8000-000000000001',receipt_token:'fixture-receipt'}],
    board_read_packet: [{}, {version:1}],
    board_write_packet: [{request_id:'00000000-0000-4000-8000-000000000001', expected_version:0, data:packet}],
    board_get_card: [{}, { key: 'DEV-12' }],
    board_list_cards: [{}, { column: 'in_review', mine: true }],
    board_update_status: [{ summary: 'Tracing the submit payload' }],
    board_append_progress: [{ text: 'Root cause found' }],
    board_write_handover: [{ patch: { next: 'Run the API tests' } }, { patch: { done: ['a', 'b'], plan: [{ text: 'x', status: 'doing' }], hypothesis: null } }],
    board_ask_human: [{ kind: 'decision', text: 'A or B?', options: ['A', 'B'] }, { kind: 'question', text: 'Which env?' }],
    board_comment: [{ text: 'hi', reply_to: 'c1' }],
    board_attach_evidence: [{ kind: 'test_run', ref: 'npm test', summary: '42 passed', result: 'pass' }, { kind: 'no_tests_reason', ref: 'docs', summary: 'docs only' }],
    board_complete: [{ summary: 'done', evidence_ids: ['e1'] }],
    board_release: [{ reason: 'stuck', requeue: false }],
    board_declare_plan: [{ summary: 's', paths: ['src/**', 'a/b.js'], areas: ['auth'] }],
    board_check_overlap: [{}],
    board_recall: [{}, { paths: ['src/x.js'], query: 'q', kinds: ['handoff'] }],
    board_create_card: [{ title: 'Handle cents in the bank client' }, { title: 't', body: 'why', acceptance: 'tests pass' }],
    board_add_lesson: [{ text: 'Run db:reset before the API tests.' }, { text: 'Use tabs in this repo.', evidence: 'CLAUDE.md' }],
    approval: [{ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' }, { tool_name: 'Bash', input: {} }],
  };
  const reject = {
    board_list_messages: [{run_id:'other'}],
    board_send_message: [{}, {request_id:'00000000-0000-4000-8000-000000000001',kind:'coordination',body:'Please review',recipient_run_ids:[]}, {request_id:'00000000-0000-4000-8000-000000000001',kind:'coordination',body:'Please review',recipient_run_ids:['00000000-0000-4000-8000-000000000002'],provider:'codex'}],
    board_ack_message: [{}, {receipt_id:'00000000-0000-4000-8000-000000000001',receipt_token:'fixture-receipt',connection_generation:'claimed'}],
    board_read_packet: [{version:0}, {run_id:'other'}],
    board_write_packet: [{}, {request_id:'not-uuid', expected_version:0, data:packet}, {request_id:'00000000-0000-4000-8000-000000000001', expected_version:0, data:{...packet, approval:'allow'}}],
    board_get_card: [{ key: '' }, { key: 5 }, { other: 1 }],
    board_list_cards: [{ column: 'doing' }, { mine: 'yes' }],
    board_update_status: [{}, { summary: '' }, { summary: 'x'.repeat(141) }],
    board_append_progress: [{ text: 'x'.repeat(501) }, {}],
    board_write_handover: [{}, { patch: {} }, { patch: { goal: 'mine now' } }, { patch: { done_means: 'x' } }, { patch: { salvage: 'x' } }, { patch: { plan: [{ text: 'x', status: 'nope' }] } }],
    board_ask_human: [{ kind: 'permission', text: 'may I?' }, { kind: 'question' }, { kind: 'decision', text: 'x', options: ['only one'] }],
    board_comment: [{}, { text: '' }],
    board_attach_evidence: [{ kind: 'vibes', ref: 'x', summary: 'x' }, { kind: 'pr', ref: 'x' }, { kind: 'test_run', ref: 'x', summary: 'y', result: 'ok' }],
    board_complete: [{ summary: 'done', evidence_ids: [] }, { summary: 'done' }],
    board_release: [{ reason: 'x' }, { reason: 'x', requeue: 'no' }],
    board_declare_plan: [{ summary: 's', paths: [] }, { summary: 's', paths: ['/etc/passwd'] }, { summary: 's', paths: ['../other/x'] }, { summary: 's', paths: ['~/.ssh/id'] }],
    board_check_overlap: [{ x: 1 }],
    board_recall: [{ kinds: ['secret'] }, { paths: ['/abs'] }],
    board_create_card: [{}, { title: '' }, { title: 'x'.repeat(201) }, { title: 't', repo_id: 'other' }, { title: 't', labels: ['x'] }, { title: 't', assignees: ['m'] }, { title: 't', budget_usd: 5 }, { title: 't', column: 'in_progress' }, { title: 't', board_id: 'b2' }],
    board_add_lesson: [{}, { text: 'too short' }, { text: 'x'.repeat(501) }, { text: 'long enough lesson', repo_id: 'other' }, { text: 'long enough lesson', evidence: 'x'.repeat(1001) }],
    approval: [{ input: {} }, { tool_name: 'Bash', input: 'ls' }],
  };

  for (const name of MCP_TOOLS) {
    test(`${name} accepts valid input`, () => {
      for (const a of accept[name]) assert.ok(TOOLS[name].input.safeParse(a).success, JSON.stringify(a));
    });
    test(`${name} rejects bad input`, () => {
      for (const a of reject[name]) assert.equal(TOOLS[name].input.safeParse(a).success, false, JSON.stringify(a));
    });
  }

  test('every tool has a declared least-privilege scope', () => {
    assert.deepEqual(Object.keys(MCP_TOOL_SCOPES).sort(), [...MCP_TOOLS].sort());
    for (const [name, scope] of Object.entries(MCP_TOOL_SCOPES)) assert.ok(TOOL_SCOPES[scope], `${name}: ${scope}`);
    for (const name of Object.keys(TOOLS).filter((n) => TOOLS[n].annotations?.readOnlyHint)) assert.match(MCP_TOOL_SCOPES[name], /:read$/, name);
    assert.equal(MCP_TOOL_SCOPES.board_create_card, 'card:create_child');
  });

  test('handover patch keys are exactly AGENT_WRITABLE', () => {
    for (const k of AGENT_WRITABLE) assert.ok(TOOLS.board_write_handover.input.safeParse({ patch: { [k]: k === 'done' ? 'x' : 'x' } }).success, k);
  });
});

// ── unit: result / error mapping ───────────────────────────────────────────

describe('result mapping', () => {
  test('ok → one JSON text block', () => {
    assert.deepEqual(okResult({ version: 3 }), { content: [{ type: 'text', text: '{"version":3}' }] });
  });

  test('error → isError with "<code>: <message>"', () => {
    assert.deepEqual(errorResult('FENCED', 'stale'), { isError: true, content: [{ type: 'text', text: 'FENCED: stale' }] });
  });

  test('approval allow always echoes the CLI input, never the runner\'s copy', () => {
    const input = { command: 'npm publish --token abc' };
    assert.deepEqual(parse(approvalReply(input, { behavior: 'allow', updatedInput: { command: '[REDACTED]' } })), { behavior: 'allow', updatedInput: input });
  });

  test('approval fails closed on anything that is not an explicit allow', () => {
    for (const d of [null, undefined, {}, { behavior: 'ALLOW' }, { decision: 'allow' }, { behavior: 'deny' }]) {
      const body = parse(approvalReply({ a: 1 }, d));
      assert.equal(body.behavior, 'deny', JSON.stringify(d));
      assert.equal(typeof body.message, 'string');
    }
  });

  const fakeIpc = (impl) => ({ calls: [], request(type, body, opts) { this.calls.push({ type, body, opts }); return impl(type, body, opts); } });

  test('IPC errors map to the contract error text', async () => {
    for (const code of ['FENCED', 'RUN_ENDED', 'GATE_CLOSED', 'HUB_UNREACHABLE', 'OUT_OF_SCOPE', 'ONE_OPEN_ASK', 'EVIDENCE_MISSING']) {
      assert.ok(code in ERRORS);
      const ipc = fakeIpc(async () => { throw Object.assign(new Error('because'), { code }); });
      const res = await callTool(ipc, 'board_complete', { summary: 's', evidence_ids: ['e'] });
      assert.equal(res.isError, true);
      assert.equal(res.content[0].text, `${code}: because`);
    }
  });

  test('validation errors never reach the runner', async () => {
    const ipc = fakeIpc(async () => { throw new Error('should not be called'); });
    const res = await callTool(ipc, 'board_update_status', { summary: 'x'.repeat(200) });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^VALIDATION: summary: /);
    assert.equal(ipc.calls.length, 0);
  });

  test('unknown tool → VALIDATION', async () => {
    const res = await callTool(fakeIpc(async () => ({})), 'board_move_card', {});
    assert.equal(res.content[0].text, 'VALIDATION: unknown tool board_move_card');
  });

  test('approval: IPC error or bad input → a well-formed deny, not isError', async () => {
    const failing = fakeIpc(async () => { throw Object.assign(new Error('offline'), { code: 'HUB_UNREACHABLE' }); });
    const res = await callTool(failing, 'approval', { tool_name: 'Bash', input: { command: 'ls' } });
    assert.equal(res.isError, undefined);
    assert.deepEqual(parse(res), { behavior: 'deny', message: 'HUB_UNREACHABLE: offline' });
    const bad = await callTool(failing, 'approval', { tool_name: 'Bash' });
    assert.equal(parse(bad).behavior, 'deny');
    assert.match(parse(bad).message, /^VALIDATION/);
  });

  test('approval has no local timeout; other tools do', async () => {
    const ipc = fakeIpc(async () => ({ behavior: 'allow' }));
    await callTool(ipc, 'approval', { tool_name: 'Bash', input: {} });
    await callTool(ipc, 'board_check_overlap', {});
    assert.equal(ipc.calls[0].opts.timeoutMs, 0);
    assert.ok(ipc.calls[1].opts.timeoutMs > 0);
  });
});

// ── integration: MCP client ⇄ server ⇄ fake runner ─────────────────────────

describe('integration with a fake runner', () => {
  let runner;
  let client;
  let ipc;
  const pendingApprovals = new Map();

  before(async () => {
    runner = await startFakeRunner({
      onTool(msg, reply) {
        switch (msg.name) {
          case 'approval':
            pendingApprovals.set(msg.args.tool_use_id, { reply, msg });
            return;
          case 'board_write_handover':
            return reply(true, { version: 7 });
          case 'board_complete':
            return reply(false, { code: 'EVIDENCE_MISSING', message: 'need a hub_verified pr or pushed commit' });
          case 'board_update_status':
            return reply(true, { ok: true, queued: true });
          default:
            return reply(true, { tool: msg.name, args: msg.args });
        }
      },
    });
    ipc = new IpcClient({ socketPath: runner.socketPath, token: TOKEN });
    const server = createBoardServer({ ipc });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  after(async () => {
    await client.close();
    ipc.close();
    await runner.close();
  });

  test('lists every contract tool with JSON schemas and server instructions', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...MCP_TOOLS].sort());
    for (const t of tools) assert.equal(t.inputSchema.type, 'object', t.name);
    const get = tools.find((t) => t.name === 'board_get_card');
    assert.equal(get.annotations.readOnlyHint, true);
    const ho = tools.find((t) => t.name === 'board_write_handover');
    assert.deepEqual(Object.keys(ho.inputSchema.properties.patch.properties).sort(), [...AGENT_WRITABLE].sort());
    assert.match(client.getInstructions(), /board_write_handover/);
  });

  test('tool call forwards {type:"tool", id, token, name, args} and returns JSON text', async () => {
    const res = await client.callTool({ name: 'board_write_handover', arguments: { patch: { next: 'run tests', done: 'reproduced' } } });
    assert.deepEqual(parse(res), { version: 7 });
    const sent = runner.tools().at(-1);
    assert.equal(sent.token, TOKEN);
    assert.equal(typeof sent.id, 'string');
    assert.equal(sent.name, 'board_write_handover');
    assert.deepEqual(sent.args, { patch: { next: 'run tests', done: 'reproduced' } });
    assert.deepEqual(runner.invalid, []);
  });

  test('outbox tool reports queued', async () => {
    const res = await client.callTool({ name: 'board_update_status', arguments: { summary: 'Testing' } });
    assert.deepEqual(parse(res), { ok: true, queued: true });
  });

  test('runner error → isError "<code>: <message>"', async () => {
    const res = await client.callTool({ name: 'board_complete', arguments: { summary: 's', evidence_ids: ['e1'] } });
    assert.equal(res.isError, true);
    assert.equal(res.content[0].text, 'EVIDENCE_MISSING: need a hub_verified pr or pushed commit');
  });

  test('invalid arguments are rejected locally with VALIDATION', async () => {
    const before = runner.tools().length;
    const res = await client.callTool({ name: 'board_write_handover', arguments: { patch: { goal: 'x' } } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^VALIDATION: /);
    assert.equal(runner.tools().length, before);
  });

  test('approval is held open until the runner answers, then allows with the original input', async () => {
    const input = { command: 'git push origin board/DEV-1-r3' };
    const call = client.callTool({ name: 'approval', arguments: { tool_name: 'Bash', input, tool_use_id: 't-allow' } }, undefined, { timeout: 60_000 });
    let settled = false;
    call.then(() => { settled = true; });
    while (!pendingApprovals.has('t-allow')) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(settled, false, 'approval must wait for the human');
    pendingApprovals.get('t-allow').reply(true, { behavior: 'allow', updatedInput: { command: 'REDACTED' } });
    const res = await call;
    assert.equal(res.content.length, 1);
    assert.equal(res.content[0].type, 'text');
    assert.deepEqual(parse(res), { behavior: 'allow', updatedInput: input });
  });

  test('approval deny carries the runner message', async () => {
    const call = client.callTool({ name: 'approval', arguments: { tool_name: 'Bash', input: { command: 'rm -rf x' }, tool_use_id: 't-deny' } });
    while (!pendingApprovals.has('t-deny')) await new Promise((r) => setTimeout(r, 5));
    pendingApprovals.get('t-deny').reply(true, { behavior: 'deny', message: 'Denied by alice' });
    assert.deepEqual(parse(await call), { behavior: 'deny', message: 'Denied by alice' });
  });

  test('approval honours cancellation from the client and drops the late answer', async () => {
    const ac = new AbortController();
    const call = client.callTool({ name: 'approval', arguments: { tool_name: 'Bash', input: {}, tool_use_id: 't-cancel' } }, undefined, { signal: ac.signal });
    while (!pendingApprovals.has('t-cancel')) await new Promise((r) => setTimeout(r, 5));
    assert.equal(ipc.pending.size, 1);
    ac.abort('user interrupt');
    await assert.rejects(call);
    for (let i = 0; i < 100 && ipc.pending.size; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(ipc.pending.size, 0, 'the server stopped waiting on the runner');
    const held = pendingApprovals.get('t-cancel').msg;
    for (let i = 0; i < 100 && !runner.received.some((m) => m.type === 'cancel'); i++) await new Promise((r) => setTimeout(r, 5));
    const cancel = runner.received.find((m) => m.type === 'cancel');
    assert.ok(cancel, 'the runner is told the held call was cancelled');
    assert.equal(cancel.re, held.id);
    assert.equal(cancel.token, TOKEN);
    assert.deepEqual(runner.invalid, []);
    pendingApprovals.get('t-cancel').reply(true, { behavior: 'allow' });
    const res = await client.callTool({ name: 'board_check_overlap', arguments: {} });
    assert.deepEqual(parse(res), { tool: 'board_check_overlap', args: {} });
  });
});

describe('IPC client', () => {
  test('bad token → BAD_RUN_TOKEN and the runner closes; later calls reconnect', async () => {
    const runner = await startFakeRunner();
    const ipc = new IpcClient({ socketPath: runner.socketPath, token: 'wrong' });
    const res = await callTool(ipc, 'board_get_card', {});
    assert.equal(res.content[0].text, 'BAD_RUN_TOKEN: bad run token');
    ipc.token = TOKEN;
    for (let i = 0; i < 100 && ipc.socket; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(parse(await callTool(ipc, 'board_get_card', {})), { tool: 'board_get_card', args: {} });
    ipc.close();
    await runner.close();
  });

  test('hello returns the run identity', async () => {
    const runner = await startFakeRunner();
    const ipc = new IpcClient({ socketPath: runner.socketPath, token: TOKEN });
    const r = await ipc.request('hello');
    assert.equal(r.key, 'DEV-1');
    assert.deepEqual(runner.received[0], { type: 'hello', id: '1', token: TOKEN });
    ipc.close();
    await runner.close();
  });

  test('runner unreachable → tools error, approval denies', async () => {
    const ipc = new IpcClient({ socketPath: '/nonexistent/board/ipc.sock', token: TOKEN, connectTimeoutMs: 500 });
    const res = await callTool(ipc, 'board_get_card', {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^INTERNAL: board runner unavailable/);
    const ap = parse(await callTool(ipc, 'approval', { tool_name: 'Bash', input: {} }));
    assert.equal(ap.behavior, 'deny');
  });

  test('runner dying mid-call fails pending calls (approval → deny)', async () => {
    const runner = await startFakeRunner({ onTool: (msg, reply, sock) => sock.destroy() });
    const ipc = new IpcClient({ socketPath: runner.socketPath, token: TOKEN });
    const ap = parse(await callTool(ipc, 'approval', { tool_name: 'Bash', input: {} }));
    assert.deepEqual(ap, { behavior: 'deny', message: 'INTERNAL: board runner closed the connection' });
    ipc.close();
    await runner.close();
  });

  test('missing env is refused up front', () => {
    assert.throws(() => new IpcClient({ socketPath: '', token: TOKEN }), /BOARD_RUN_SOCKET/);
    assert.throws(() => new IpcClient({ socketPath: '/x', token: '' }), /BOARD_RUN_TOKEN/);
  });
});
