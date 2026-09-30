// Recorded claude-code hook payloads through normalize(), emit.js and /hook/:adapter.
require('./helpers.js').suite(require('../../adapters/claude-code.js'));

// The real signal server: the hook hands it the answer key; only it can answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tmp } = require('./helpers.js');

// No pooled sockets: the suite's own 401s leave half-read connections behind.
function post(home, urlPath, body, token) {
  const b = JSON.stringify(body);
  const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), 'x-buddy-token': token === undefined ? fs.readFileSync(path.join(home, 'token'), 'utf8') : token };
  return new Promise((resolve, reject) => {
    require('http').request({ host: '127.0.0.1', port: Number(fs.readFileSync(path.join(home, 'port'), 'utf8')), path: urlPath, method: 'POST', headers, agent: false }, (r) => { r.resume(); r.on('end', () => resolve({ status: r.statusCode })); }).on('error', reject).end(b);
  });
}
const A = require('../../hooks/answer-file.js');

test('signal server: POST /request-key takes a key once, token-protected; the desk answers with it', async () => {
  // Its own server: the suite's one is closed when its test ends.
  const home = tmp();
  process.env.CLAUDE_TRAFFIC_LIGHT_PORT = '0';
  require.cache[require.resolve('electron')] = { id: 'electron', filename: 'electron', loaded: true, exports: { app: { on() {} } } };
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const api = require('../../src/signal-server.js')({ rootDir: home, sessionsDir: path.join(home, 'sessions'), requestsDir: path.join(home, 'requests'), aggregateState: () => ({ look: {}, sessions: [] }), broadcastStatus: () => {} });
  const http = api.startSignalServer();
  test.after(() => { http.closeAllConnections(); http.close(); });
  while (!fs.existsSync(path.join(home, 'port'))) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await post(home, '/request-key', { id: 'mac-x', key: 'ab'.repeat(32) })).status, 200);
  assert.equal((await post(home, '/request-key', { id: 'mac-x', key: 'cd'.repeat(32) })).status, 409, 'first key wins');
  assert.equal((await post(home, '/request-key', { id: '../x', key: 'ab'.repeat(32) })).status, 409);
  assert.equal(api.keyFor('mac-x').toString('hex'), 'ab'.repeat(32));
  assert.equal((await post(home, '/request-key', { id: 'mac-y', key: 'ab'.repeat(32) }, 'wrong')).status, 401);
  assert.equal(api.keyFor('mac-y'), null);

  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'hooks', 'set-status.js'), 'permission-request'], { env: { ...process.env, CLAUDE_TRAFFIC_LIGHT_HOME: home, CLAUDE_TRAFFIC_LIGHT_ASK_MS: '5000' } });
  child.stdin.end(JSON.stringify({ session_id: 'srv', cwd: '/x', tool_name: 'Bash', tool_input: { command: 'ls' } }));
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const done = new Promise((res) => child.on('exit', () => res(out)));
  const dir = path.join(home, 'requests');
  let req = null;
  for (let i = 0; i < 200 && !req; i += 1) {
    const f = fs.existsSync(dir) && fs.readdirSync(dir).find((x) => x.endsWith('.json'));
    if (f) req = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    else await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(req && api.keyFor(req.id), 'the hook registered its key before the request appeared');
  assert.equal(A.writeAnswer(dir, req.id, 'allow').ok, false, 'no key: an outside writer cannot answer');
  assert.ok(api.readRequests().some((r) => r.id === req.id));
  assert.equal(api.answerRequest(req.id, 'allow'), true);
  assert.deepEqual(JSON.parse(await done).hookSpecificOutput.decision, { behavior: 'allow' });
});

const Claude = require('../../adapters/claude-code.js');
const Runtime = require('../../adapters/runtime.js');
const { spawnSync } = require('child_process');

test('installer: adds Edit(~/.claude-traffic-light/**) to permissions.deny, keeps foreign rules, backs up once, strips on uninstall (temp HOME)', () => {
  const home = tmp();
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = { permissions: { allow: ['Bash(npm test)'], deny: ['Read(./.env)'] }, model: 'x' };
  fs.writeFileSync(file, JSON.stringify(original));
  // The checkout installer, with HOME pointed at the temp dir.
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'hooks', 'install.js')], { env: { ...process.env, HOME: home } });
  assert.equal(r.status, 0, r.stderr.toString());
  let s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Claude.DENY_RULES, ['Edit(~/.claude-traffic-light/**)']);
  assert.deepEqual(s.permissions, { allow: ['Bash(npm test)'], deny: ['Read(./.env)', 'Edit(~/.claude-traffic-light/**)'] });
  assert.equal(s.model, 'x');
  assert.ok(s.hooks.PreToolUse);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.buddy-backup`, 'utf8')), original, 'backup is the file as it was');

  const runtime = Runtime.make({ execPath: null, hooksDir: path.join(__dirname, '..', '..', 'hooks'), dataDir: path.join(home, '.claude-traffic-light') });
  assert.equal(Claude.isInstalled({ home, runtime }), true);
  Claude.install({ home, runtime });
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.permissions.deny.filter((x) => x === Claude.DENY_RULES[0]).length, 1, 'idempotent');
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.buddy-backup`, 'utf8')), original, 'backup never replaced');

  // Someone removed the rule: no longer counted as installed, so the app puts it back.
  fs.writeFileSync(file, JSON.stringify({ ...s, permissions: { ...s.permissions, deny: ['Read(./.env)'] } }));
  assert.equal(Claude.isInstalled({ home, runtime }), false);
  Claude.install({ home, runtime });

  Claude.uninstall({ home });
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s, original, 'uninstall leaves exactly the foreign settings');

  // A settings file with nothing else: uninstall removes the permissions block it added.
  const home2 = tmp();
  Claude.install({ home: home2, runtime });
  assert.equal(fs.existsSync(path.join(home2, '.claude', 'settings.json.buddy-backup')), false, 'nothing to back up');
  Claude.uninstall({ home: home2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home2, '.claude', 'settings.json'), 'utf8')), {});
});
