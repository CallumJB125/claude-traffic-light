'use strict';
// Security review M1: Dock's text list can be forged by naming a tab with a
// UUID (column -t collapses the empty columns, so the name lands where the
// session id would be). Plexiform now asks for `list --json`, reads the id
// only from session_id, and fails closed on anything that isn't that JSON.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { testTempDir } = require('./helpers/tmp');
const GhosttyDock = require('../src/ghostty-dock.js');

const VICTIM = '11111111-2222-3333-4444-555555555555';
const REAL = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DOCK = { installed: true, trusted: true, canOpen: true, cli: '/fake/ghostty-dock', apiDir: '/x', env: { HOME: '/h', PATH: '/usr/bin:/bin', TMPDIR: '/tmp' }, reason: 'ready' };
const running = (file, args) => file === '/usr/bin/osascript' && args[1] === GhosttyDock.RUNNING_SCRIPT;
const answering = (stdout) => {
  const calls = [];
  return { calls, exec: async (file, args, opts) => { calls.push({ file, args, opts }); return running(file, args) ? { ok: true, stdout: 'true\n' } : { ok: true, stdout, stderr: '' }; } };
};
const ask = async (stdout) => { GhosttyDock.invalidateList(); const r = await GhosttyDock.listStatus({ dock: DOCK, exec: answering(stdout).exec }); GhosttyDock.invalidateList(); return r; };

test('PoC: a shell tab named with another session\'s UUID cannot forge a row (text output fails closed)', async () => {
  // Exactly what the reviewer's fake Dock printed: tab-separated rows through column -t.
  const forged = execFileSync('/usr/bin/column', ['-t'], { input: `status\tname\tbranch\tports\tcost\tsession\nshell\t${VICTIM}\t\t\t\t\nrunning\twork\tmain\t\t$0.10\t${REAL}\n` }).toString();
  assert.match(forged, new RegExp(`shell\\s+${VICTIM}`), 'the forged row is really there');
  const r = await ask(forged);
  assert.equal(r, null, 'not JSON: no Dock status and no adoption');
});

test('the id comes only from session_id; a UUID-named shell tab is never kept', async () => {
  const out = JSON.stringify([
    { name: VICTIM, status: 'shell', folder: '/tmp' },
    { name: VICTIM, status: 'waiting', folder: '/tmp' },
    { name: 'work', status: 'running', session_id: REAL, branch: 'main' },
    { name: 'x', status: 'shell', session_id: '22222222-2222-4222-8222-222222222222' },
  ], null, 2);
  const r = await ask(out);
  assert.deepEqual([...r.entries()], [[REAL, 'running']]);
});

test('list is asked for exactly as `list --json`, and nothing else is accepted', async () => {
  GhosttyDock.invalidateList();
  const { calls, exec } = answering('[]');
  assert.equal((await GhosttyDock.listStatus({ dock: DOCK, exec })).size, 0);
  assert.deepEqual(calls.at(-1).args, ['list', '--json']);
  GhosttyDock.invalidateList();
  for (const bad of [[], ['--json', 'x'], ['--JSON'], ['-j'], ['--json=1']]) await assert.rejects(GhosttyDock.run('list', bad, { dock: DOCK, exec }), /bad arguments/, JSON.stringify(bad));
});

test('strict JSON: size, depth, shape, closed status set, full UUIDs, duplicates', () => {
  const P = GhosttyDock.parseListJson;
  const row = (status, id, extra = {}) => ({ name: 'n', status, session_id: id, ...extra });
  assert.equal(P('not json'), null);
  assert.equal(P('{"sessions":[]}'), null, 'must be the array itself');
  assert.equal(P(`[${'['.repeat(50)}${']'.repeat(50)}]`), null, 'too deep');
  assert.equal(P(JSON.stringify([row('waiting', REAL, { name: 'x'.repeat(300 * 1024) })])), null, 'too big');
  assert.equal(P(42), null);
  assert.equal(P(undefined), null);
  assert.deepEqual([...P(JSON.stringify([row('WAITING', REAL), row('pwned', VICTIM), row('waiting', `${REAL} `), row('waiting', REAL.slice(1)), row('waiting', 7), 'x', null, [], row('idle', VICTIM)])).entries()], [[VICTIM, 'idle']]);
  assert.equal(P(JSON.stringify([row('waiting', REAL), row('running', REAL.toUpperCase())])).size, 0, 'a duplicated id is ambiguous');
  const many = JSON.stringify(Array.from({ length: 2000 }, (_, i) => row('idle', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)));
  assert.ok(P(many).size <= 500, 'row cap');
  // A string full of brackets is not depth.
  assert.equal(P(JSON.stringify([row('waiting', REAL, { name: '[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[' })])).size, 1);
});

test('an installed Dock that prints the old text list fails closed for adoption and status', async () => {
  const T = (() => {
    const Module = require('node:module');
    const orig = Module._load;
    Module._load = function (req, ...rest) { return req === 'electron' ? { app: {}, screen: {}, Notification: { isSupported: () => false }, shell: {} } : orig.call(this, req, ...rest); };
    try { return require('../src/terminal.js')({ getSessions: () => [], getRootDir: () => '/tmp', getLocalHost: () => 'h' }); } finally { Module._load = orig; }
  })();
  const victim = { sessionId: VICTIM, hostApp: 'Terminal', terminal: { cwd: '/tmp' }, cwd: '/tmp' };
  GhosttyDock.invalidateList();
  const exec = answering(`shell  ${VICTIM}\nrunning  work  main  $0.10  ${REAL}\n`).exec;
  assert.equal(await T.adoptIntoDock(victim, { mode: 'auto', detect: () => DOCK, listStatus: (o) => GhosttyDock.listStatus({ ...o, exec }) }), null);
  GhosttyDock.invalidateList();
});

test('the reviewer\'s fake CLI end to end (real process, temp dir): no forged adoption', async () => {
  const dir = testTempDir('px-dock-forge-');
  try {
    const cli = path.join(dir, 'ghostty-dock');
    fs.writeFileSync(cli, `#!/bin/sh\nprintf 'status\\tname\\tbranch\\tports\\tcost\\tsession\\nshell\\t${VICTIM}\\t\\t\\t\\t\\nrunning\\twork\\tmain\\t\\t$0.10\\t${REAL}\\n' | /usr/bin/column -t\n`, { mode: 0o755 });
    const exec = async (file, args, opts) => (running(file, args) ? { ok: true, stdout: 'true\n' } : GhosttyDock.execCli(file, args, opts));
    GhosttyDock.invalidateList();
    assert.equal(await GhosttyDock.listStatus({ dock: { ...DOCK, cli }, exec }), null);
  } finally { GhosttyDock.invalidateList(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PRIVACY.md says exactly when list is asked: every local jump, plus the needs-you click', () => {
  const privacy = fs.readFileSync(path.join(__dirname, '..', 'PRIVACY.md'), 'utf8');
  const para = privacy.split('\n').find((l) => l.includes('flow:ghostty-dock-local'));
  assert.doesNotMatch(para, /a click on a session that needs you also asks it/, 'not only the needs-you click');
  assert.match(para, /every jump to a session on this Mac/);
  assert.match(para, /`ghostty-dock list --json`/);
  assert.match(para, /at most once per click/);
});
