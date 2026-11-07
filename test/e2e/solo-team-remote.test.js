'use strict';
// REMOTE CONTROL end to end: a Claude Code session the `claude remote-control` server started (the phone or claude.ai)
// is the person's session: its real hook records it interactive, its MCP child binds, it hands off through the real
// Tasks engine and gets the result back as a notice in its hook output. Clients that are not a signed Claude Code or
// Codex child (Gemini CLI, Cursor, VS Code, the Claude desktop app, Hermes) are unverified: read-only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startMac, until } = require('./helpers/mac.js');

const SET_STATUS = path.join(__dirname, '..', '..', 'hooks', 'set-status.js');
const BRIDGE = { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', CLAUDE_CODE_ENVIRONMENT_KIND: 'bridge' };
let n = 0;
const rid = (p) => `${p}-${process.pid}-${++n}-${Date.now().toString(36)}`;

// A real process chain whose parent's command line reads `<dir>/claude remote-control` (node with argv0 set, never a
// real claude), the way test/awareness-notes-e2e.test.js builds it; the hook runs last in the chain.
const RELAY = `const { spawn } = require('node:child_process');
const plan = JSON.parse(process.env.RC_PLAN);
const [file, args, cwd, argv0] = plan.shift();
const k = spawn(file, args, { cwd, stdio: 'inherit', ...(argv0 ? { argv0 } : {}), env: { ...process.env, RC_PLAN: JSON.stringify(plan) } });
k.on('exit', (code) => process.exit(code ?? 1));
`;
function launchKit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const relay = path.join(dir, 'relay.js');
  fs.writeFileSync(relay, RELAY);
  fs.writeFileSync(path.join(dir, 'remote-control'), RELAY);
  return { server: [process.execPath, ['remote-control'], dir, path.join(dir, 'claude')], session: [process.execPath, [relay], dir] };
}
function hook(w, { sessionId, cwd, signal, entry = BRIDGE, under = null }) {
  const payload = signal === 'tool-done'
    ? { session_id: sessionId, cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'PRIVATE OUTPUT' } }
    : signal === 'session-start' ? { session_id: sessionId, cwd, hook_event_name: 'SessionStart', source: 'startup' }
      : { session_id: sessionId, cwd, hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE PROMPT' };
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, HOME: w.home, CLAUDE_TRAFFIC_LIGHT_HOME: w.root, ...entry, CLAUDE_TRAFFIC_LIGHT_LOOKUP_MS: '500' };
    const h = [process.execPath, [SET_STATUS, signal], w.root];
    const [first, ...rest] = under ? [...under, h] : [h];
    const kid = spawn(first[0], first[1], { cwd: first[2], ...(first[3] ? { argv0: first[3] } : {}), env: { ...env, RC_PLAN: JSON.stringify(rest) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => { kid.kill('SIGKILL'); reject(new Error(`hook timed out: ${err}`)); }, 15_000);
    kid.stdout.on('data', (d) => { out += d; });
    kid.stderr.on('data', (d) => { err += d; });
    kid.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`hook exited ${code}: ${err}`));
      const text = out.trim();
      resolve(text ? (JSON.parse(text).hookSpecificOutput || {}).additionalContext || null : null);
    });
    kid.stdin.end(JSON.stringify(payload));
  });
}

test('REMOTE CONTROL: a session under `claude remote-control` is the person; unverified clients are read-only', async (t) => {
  const mac = await startMac(t, { remotes: { repoA: 'https://github.com/rc-person/app.git' } });
  const { w } = mac;
  // Claude 100 started by a signed `claude remote-control` server (90), its MCP child marked as the bridge marks it.
  const kid = w.procs.get(101);
  kid.env = kid.env.replace('CLAUDE_CODE_ENTRYPOINT=cli', 'CLAUDE_CODE_ENTRYPOINT=sdk-cli CLAUDE_CODE_ENVIRONMENT_KIND=bridge');
  w.proc(90, { exe: w.CLAUDE, cwd: w.home, signed: 'claude', args: 'claude remote-control' });
  w.procs.get(100).ppid = 90;
  await mac.aw.build();
  await mac.aw.refresh();

  await t.test('R1 the real hook, run under the remote-control server, records the bridge session as a person\'s session', async () => {
    const kit = launchKit(path.join(w.dir, 'rc'));
    await hook(w, { sessionId: 'RC1', cwd: w.repoA, signal: 'session-start', under: [kit.server, kit.session] });
    const file = fs.readdirSync(path.join(w.root, 'sessions')).find((f) => f.endsWith('-RC1.json'));
    assert.ok(file, 'session file written');
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.root, 'sessions', file), 'utf8')).interactive, true);
    // The same hook with the bridge variable but no remote-control parent (a `claude -p` its Bash started) is not a person.
    await hook(w, { sessionId: 'RCP', cwd: w.repoA, signal: 'session-start' });
    const p = fs.readdirSync(path.join(w.root, 'sessions')).find((f) => f.endsWith('-RCP.json'));
    assert.notEqual(p && JSON.parse(fs.readFileSync(path.join(w.root, 'sessions', p), 'utf8')).interactive, true, 'claude -p under a bridge session is headless');
  });

  await t.test('R2 its MCP child binds: bus_hello local_attested with its board; bus_peers bound', async () => {
    const hello = await mac.call('X', 'hello', { provider: 'claude' });
    assert.equal(hello.tier, 'local_attested', JSON.stringify(hello));
    assert.equal(hello.board?.kind, 'personal');
    const peers = await mac.call('X', 'peers');
    assert.equal(peers.bound, true, JSON.stringify(peers));
  });

  await t.test('R3 it hands off as itself through the real engine, and the result reaches its hook output as a notice and bus_notes', async () => {
    mac.bin.setCodex({ delayMs: 200, text: 'Done from the phone hand-off.' });
    const off = await mac.call('X', 'handoff', { request_id: rid('r3'), to: { provider: 'codex' }, title: 'From the phone', brief: 'x' });
    assert.equal(off.state, 'offered', JSON.stringify(off));
    const run = await mac.runOf(off.handoff_id, () => true, 'run');
    assert.ok(run.sourceMeta.originBoard, 'the bound asker\'s board rides on the run');
    await until(async () => mac.engine.agentBus?.log?.result?.(off.handoff_id) ?? (await mac.call('X', 'status', { handoff_id: off.handoff_id })).chain?.some((c) => /^result\./.test(c.kind)), { ms: 30000, label: 'result' });
    await until(async () => { await mac.aw.syncNotes(); await mac.aw.refresh(); return JSON.parse(fs.readFileSync(path.join(w.root, 'awareness', 'roster.json'), 'utf8')).self['claude|X'].notices.length; }, { label: 'notice' });
    const ctx = await hook(w, { sessionId: 'X', cwd: w.repoA, signal: 'tool-done' });
    assert.match(ctx || '', /1 hand-off result waiting/, `hook output: ${ctx}`);
    const got = await mac.call('X', 'notes');
    assert.match(JSON.stringify(got.notes), /Done from the phone hand-off|is done, by Codex/);
  });

  // Unverified clients: our MCP server under a parent that is not a signed Claude Code or Codex process.
  const CLIENTS = [
    ['gemini', { exe: '/opt/homebrew/bin/node', args: 'node /opt/homebrew/bin/gemini' }],
    ['cursor', { exe: '/Applications/Cursor.app/Contents/MacOS/Cursor', args: '/Applications/Cursor.app/Contents/MacOS/Cursor' }],
    ['vscode', { exe: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', args: 'Code Helper (Plugin)' }],
    ['claude-desktop', { exe: '/Applications/Claude.app/Contents/MacOS/Claude', args: '/Applications/Claude.app/Contents/MacOS/Claude' }],
    ['hermes', { exe: '/usr/bin/python3', args: 'python3 -m hermes' }],
  ];
  let pid = 600;
  for (const [name, parent] of CLIENTS) {
    await t.test(`R4 ${name}: unverified_client, can peers and a personal card only; its hand-off and note are refused and nothing starts`, async () => {
      const ppid = pid++; const mcp = pid++;
      const par = w.proc(ppid, { ...parent, cwd: w.repoA });
      const child = w.mcpChild(mcp, ppid, w.repoA, w.procs.get(101));
      child.env = `ELECTRON_RUN_AS_NODE=1 PLEXIFORM_MCP=bus-v1:packaged PLEXIFORM_CLIENT=${name}`;
      w.stdio(child, par, 'unix');
      const as = () => { w.call(mcp); return mac.conn; };
      const M = require('../../mcp-server.js');
      const hello = await M.busCall('hello', { provider: 'claude' }, as());
      assert.equal(hello.tier, 'unverified_client', JSON.stringify(hello));
      assert.deepEqual(hello.can, ['peers', 'card_personal']);
      const peers = await M.busCall('peers', {}, as());
      assert.equal(peers.bound, false, JSON.stringify(peers));
      assert.ok(Array.isArray(peers.peers), 'it can read peers');
      const tasks = mac.engine.tasks.size;
      const off = await M.busCall('handoff', { request_id: rid(`r4${name}`), to: { provider: 'codex' }, title: 'From an unverified client' }, as());
      assert.equal(off.reason, 'POLICY_DENIED', JSON.stringify(off));
      assert.equal(mac.engine.tasks.size, tasks, 'no run started');
      const note = await M.busCall('note', { to: (await mac.handles()).Z, text: 'hi', request_id: rid(`r4n${name}`) }, as());
      assert.equal(note.reason, 'NOT_BOUND', JSON.stringify(note));
      const card = await M.busCall('card_add', { title: 'From an unverified client', request_id: rid(`r4c${name}`) }, as());
      assert.ok(card.reason || card.board?.kind === 'personal', `never a team card: ${JSON.stringify(card)}`);
    });
  }
});
