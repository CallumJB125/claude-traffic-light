'use strict';
// Explicit native acceptance on a fresh private socket and clean HOME. The
// ad-hoc test identity works only with KEEPER_DEV. The test driver is not shipped.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { Duplex } = require('node:stream');
const { KeeperClient } = require('../apps/terminal/keeper-client');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync('/private/tmp/pf-keeper-test-'); fs.chmodSync(dir, 0o700);
const keeper = path.join(root, 'native/keeper-build/Plexiform Session Keeper.app/Contents/MacOS/PlexiformKeeper');
let keeperProcess, proxy, client;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const driver = path.join(dir, 'driver');
function connect(file = driver) {
  proxy = spawn(file, [path.join(dir, 'k.sock')], { stdio: ['pipe', 'pipe', 'pipe'] });
  proxy.stderr.on('data', d => process.stderr.write(d));
  client = new KeeperClient(Duplex.from({ readable: proxy.stdout, writable: proxy.stdin })); client.on('notice', () => {}); return client;
}
async function waitFor(predicate, label, attempts = 50) { for (let i = 0; i < attempts; i++) { if (predicate()) return; await delay(100); } throw Error(label); }
(async () => {
  const info = JSON.parse(execFileSync(keeper, ['--build-info'], { encoding: 'utf8' })); assert.equal(info.dev, true, 'Native smoke requires a development keeper.');
  execFileSync('xcrun', ['clang', '-O2', '-I', path.join(root, 'native/keeper/Support/include'), path.join(root, 'test/fixtures/terminal/keeper-test-driver.c'), path.join(root, 'native/keeper/Support/keeper.c'), '-framework', 'Security', '-framework', 'ApplicationServices', '-o', driver]);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'dev.plexiform.terminal', driver]);
  keeperProcess = spawn(keeper, ['--socket', path.join(dir, 'k.sock'), '--test-home', dir], { stdio: ['ignore', 'ignore', 'pipe'], env: { HOME: dir, PATH: '/usr/bin:/bin', NODE_OPTIONS: 'must-not-pass', BOARD_RUN_TOKEN: 'must-not-pass' } });
  let keeperErrors = ''; keeperProcess.stderr.on('data', d => { keeperErrors = (keeperErrors + d).slice(-2000); });
  await waitFor(() => fs.existsSync(path.join(dir, 'k.sock')), 'Keeper did not listen: ' + keeperErrors);
  // Generic unsigned/unrelated Node processes cannot become a driver.
  await new Promise((resolve, reject) => { const socket = net.createConnection(path.join(dir, 'k.sock')); const t = setTimeout(() => { socket.destroy(); reject(Error('Unrelated peer was not closed.')); }, 2000); socket.on('error', () => {}); socket.on('close', () => { clearTimeout(t); resolve(); }); });
  connect(); let output = ''; client.on('data', event => { output = (output + event.data.toString()).slice(-2 * 1024 * 1024); });
  assert.equal((await client.call('hello', { minor: 0, app: 'terminal', version: '0.1.0' })).welcome.role, 'driver');
  const created = await client.call('spawn', { kind: 'shell', argv: ['/bin/sh', '-l'], cwd: dir, env: {}, origin: { by: 'terminal', taskId: null }, cols: 80, rows: 24, reveal: true });
  let attached = await client.call('attach', { sessionId: created.sessionId, cols: 80, rows: 24 }); await delay(100); output = '';
  client.write(attached.channel, `printf '\\nPF_RECEIPT:%s:%s:%s\\n' "$HOME" "\${NODE_OPTIONS-unset}" "\${BOARD_RUN_TOKEN-unset}"\r`);
  await waitFor(() => output.includes(`PF_RECEIPT:${dir}:unset:unset`), 'Exact receipt/environment canary was missing.');
  // One keeper-owned terminal response; renderer replies stay disabled.
  output = '';
  client.write(attached.channel, "stty -echo -icanon min 0 time 1; printf '\\033[H\\033[6n'; dd bs=1 count=64 2>/dev/null | od -An -tx1; stty sane; printf '\\nPF_QUERY_DONE\\n'\r");
  await waitFor(() => output.includes('\r\nPF_QUERY_DONE\r\n'), 'Terminal query did not finish.');
  assert.match(output, /1b\s+5b\s+31\s+3b\s+31\s+52/, 'CPR response was missing.');
  assert.equal((output.match(/1b\s+5b\s+31\s+3b\s+31\s+52/g) || []).length, 1, 'Query reply was duplicated.');
  client.write(attached.channel, `/usr/bin/vi -u NONE -i NONE -n '${dir}/editor-proof.txt'\r`);
  await delay(300); client.write(attached.channel, 'iPF_VIM_RECEIPT\x1b'); await delay(150);
  const before = (await client.call('list')).sessions.find(s => s.sessionId === created.sessionId);
  await client.call('detach', { channel: attached.channel }); client.close(); proxy.kill(); await delay(150);
  connect(); output = ''; client.on('data', event => { output = (output + event.data.toString()).slice(-2 * 1024 * 1024); });
  await client.call('hello', { minor: 0, app: 'terminal', version: '0.1.0' });
  const after = (await client.call('list')).sessions.find(s => s.sessionId === created.sessionId); assert.equal(after.pid, before.pid);
  attached = await client.call('attach', { sessionId: created.sessionId, cols: 90, rows: 28 });
  await waitFor(() => output.includes('PF_VIM_RECEIPT'), 'Full-screen editor did not restore after reconnect.');
  client.write(attached.channel, ':wq\r'); await waitFor(() => fs.existsSync(path.join(dir, 'editor-proof.txt')), 'Editor did not save.');
  assert.equal(fs.readFileSync(path.join(dir, 'editor-proof.txt'), 'utf8'), 'PF_VIM_RECEIPT\n');
  output = ''; client.write(attached.channel, "printf '\\nPF_REATTACHED\\n'\r");
  await waitFor(() => output.includes('\r\nPF_REATTACHED\r\n'), 'Input after reattach failed.');
  await assert.rejects(client.call('spawn', { kind: 'shell', argv: ['/bin/sh', '-c', 'true'], cwd: dir, env: {}, cols: 80, rows: 24 }), /Invalid terminal/);
  await assert.rejects(client.call('rows.publish', { rows: [] }), /Only Plexiform/);
  // A real control-identity fixture is denied PTY access, input and native spawn.
  const control = path.join(dir, 'control'); fs.copyFileSync(driver, control); execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'dev.plexiform.app', control]);
  const driverClient = client, driverProxy = proxy;
  connect(control); await client.call('hello', { minor: 0, app: 'plexiform', version: '0.1.0' }); assert.deepEqual((await client.call('list')).sessions, []);
  await assert.rejects(client.call('attach', { sessionId: created.sessionId, cols: 80, rows: 24 }), /Control peers cannot attach/);
  await assert.rejects(client.call('spawn', { kind: 'shell', argv: ['/bin/sh', '-l'], cwd: dir, env: {}, cols: 80, rows: 24 }), /Takeover control is not enabled/);
  client.close(); proxy.kill(); client = driverClient; proxy = driverProxy;
  await client.call('signal', { sessionId: created.sessionId, signal: 'HUP' });
  console.log(JSON.stringify({ development: true, nativePeerAuthentication: true, unrelatedPeerRefused: true, realPTY: true, exactReceipt: true, cleanEnvironment: true, singleQueryReply: true, fullScreenEditorPersists: true, pidPersists: true, screenRestores: true, reattachInput: true, arbitrarySpawnRefused: true, controlCannotAttachOrSpawn: true, liveUserSessionsTouched: false }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  client?.close(); proxy?.kill(); keeperProcess?.kill('SIGTERM'); await delay(150); fs.rmSync(dir, { recursive: true, force: true });
});
