// Accounts P4 two-machine e2e (CONTRACT D79–D81): the real hub process in
// BOARD_AUTH=accounts (loopback try-out, console mailer), two people who sign
// in with email codes, one team, each enrols their install and runs the real
// app-mode runner (runner/app-entry.js under a stand-in parentPort) with
// {hub_url, runner_token, team_id, data_dir}. One card each goes green on its
// owner's runner; neither runner ever sees a frame about the other's card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BOARD, Proxy, freePort, startHub, until, sleep, tmpDir, rm, SCALE } from './harness.js';
import { makeRepo, fakeClaudeBin, REMOTE_URL } from '../../runner/test/helpers.js';

assert.ok(SCALE < 1, 'run with BOARD_TEST_TIME_SCALE (npm run test:e2e)');

const PRELOAD = path.join(BOARD, 'runner', 'test', 'fixtures', 'fake-parent-port.js');
const WORK = { steps: [{ mcp: 'board_get_card' }, { tool: 'Write', input: { file_path: 'src/feature.js', content: 'export const f = 1;\n' } }, ...Array.from({ length: 200 }, (_, i) => ({ tool: 'Bash', input: { command: `echo ${i}` }, ms: 250 }))] };

function api(url, token) {
  return async (method, p, body, headers = {}) => {
    const r = await fetch(`${url}${p}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body: json, text };
  };
}

// The console mailer prints each mail to the hub's stderr (its log file here).
function codeFrom(logFile, email) {
  const text = fs.readFileSync(logFile, 'utf8');
  const all = [...text.matchAll(/To: (\S+)\nSubject: [^\n]*\n\n[\s\S]*?code: (\d{6})/g)].filter((m) => m[1] === email);
  return all.length ? all[all.length - 1][2] : null;
}

async function signIn(hub, email) {
  const call = api(hub.url);
  const s = await call('POST', '/api/auth/email/start', { email, client: 'buddy_desktop', device_name: `${email} laptop`, platform: 'darwin-arm64' });
  assert.equal(s.status, 200, s.text);
  const code = await until(() => codeFrom(hub.logFile, email), { what: `code for ${email}` });
  const v = await call('POST', '/api/auth/email/verify', { flow_id: s.body.flow_id, code });
  assert.equal(v.status, 200, v.text);
  return { token: v.body.device_token, user: v.body.user, teams: v.body.teams, call: api(hub.url, v.body.device_token) };
}

async function appRunner({ root, name, hubPort, teamId, runnerToken, repo, repoId }) {
  const data = path.join(root, name);
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const bin = fakeClaudeBin(root, { mcp_stdio: true, ...WORK });
  fs.writeFileSync(path.join(data, 'policy.json'), JSON.stringify({
    repos: { [repoId]: { opt_in: true, local_path: repo.checkout, allow_write_extra: [repo.bare] } }, accept_from: {}, backends: { claude: bin }, never_auto_labels: [], form_factor: 'laptop',
  }), { mode: 0o600 });
  const proxy = await new Proxy(hubPort).listen();
  const userHome = path.join(root, `${name}-home`);
  fs.mkdirSync(userHome, { recursive: true });
  const logFile = path.join(root, `${name}.log`);
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, ['--import', PRELOAD, path.join(BOARD, 'runner', 'app-entry.js')], {
    env: { PATH: process.env.PATH, HOME: userHome, TMPDIR: '/tmp', LANG: 'en_US.UTF-8', BOARD_TEST_TIME_SCALE: String(SCALE), CLAUDE_TRAFFIC_LIGHT_HOME: path.join(userHome, '.ctl') },
    stdio: ['ignore', out, out, 'ipc'],
  });
  const messages = [];
  child.on('message', (m) => messages.push(m));
  child.send({ type: 'runner.config', hub_url: `http://127.0.0.1:${proxy.port}`, runner_token: runnerToken, team_id: teamId, data_dir: data });
  await until(() => messages.some((m) => m.type === 'runner.status' && m.state === 'connected'), { what: `${name} connected` });
  return {
    name, data, proxy, child, logFile, messages,
    text: () => [...proxy.up, ...proxy.down].map((f) => f.text).join('\n'),
    async stop() {
      try {
        const ledger = JSON.parse(fs.readFileSync(path.join(data, 'ledger.json'), 'utf8')).runs ?? {};
        for (const e of Object.values(ledger)) { try { process.kill(-e.pid, 'SIGKILL'); } catch { try { process.kill(e.pid, 'SIGKILL'); } catch { /* gone */ } } }
      } catch { /* no ledger */ }
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      await proxy.close();
    },
  };
}

test('two enrolled runners in one team, one card each: each goes green on its own runner, zero cross frames, no token on disk or in logs', async () => {
  const root = tmpDir('bA-');
  const dataDir = path.join(root, 'hub');
  fs.mkdirSync(dataDir);
  const port = await freePort();
  const hub = await startHub({
    dataDir, port,
    env: { BOARD_AUTH: 'accounts', BOARD_DEV_SEED: '', BOARD_DEV_LOGIN_SECRET: '', BOARD_ACCOUNTS_DEV: '1', BOARD_CONSOLE_MAILER: '1', BOARD_BOOTSTRAP: 'owner@e2e.test' },
  });
  const runners = [];
  try {
    const repo = makeRepo(root);
    const owner = await signIn(hub, 'owner@e2e.test');
    const team = owner.teams[0];
    assert.ok(team, 'the bootstrap team is the owner\'s');
    const board = team.boards[0].id;
    const T = { 'x-board-team': team.id };
    const r1 = await owner.call('POST', '/api/repos', { url: REMOTE_URL }, T);
    assert.equal(r1.status, 200, r1.text);
    const repoId = r1.body.repo?.id ?? r1.body.id;
    assert.equal((await owner.call('POST', `/api/boards/${board}/repos`, { repo_id: repoId })).status, 200);
    // A teammate joins by invite (the code the inviter shares).
    const inv = await owner.call('POST', `/api/teams/${team.id}/invites`, { email: 'mate@e2e.test', role: 'member' });
    assert.equal(inv.status, 200, inv.text);
    const mate = await signIn(hub, 'mate@e2e.test');
    assert.equal((await mate.call('POST', '/api/invites/accept', { code: inv.body.code })).status, 200);

    const enrolled = [];
    for (const [who, name] of [[owner, 'rOwner'], [mate, 'rMate']]) {
      const e = await who.call('POST', `/api/teams/${team.id}/enrol`, { device_name: name });
      assert.equal(e.status, 200, e.text);
      enrolled.push(e.body);
      runners.push(await appRunner({ root, name, hubPort: port, teamId: team.id, runnerToken: e.body.runner_token, repo, repoId }));
    }
    await until(async () => (await owner.call('GET', `/api/teams/${team.id}/enrolments`)).body.enrolments.filter((x) => x.online).length === 2, { what: 'both runners online' });

    const cards = [];
    for (const who of [owner, mate]) {
      const c = await who.call('POST', `/api/boards/${board}/cards`, { title: `${who.user.email} card`, repo_id: repoId });
      assert.equal(c.status, 200, c.text);
      const d = await who.call('POST', `/api/cards/${c.body.card.id}/actions/dispatch`, { request_id: crypto.randomUUID() });
      assert.equal(d.status, 200, d.text);
      cards.push(c.body.card);
    }
    for (const [i, who] of [owner, mate].entries()) {
      await until(async () => (await who.call('GET', `/api/cards/${cards[i].id}`)).body?.card?.live?.green === true, { what: `card ${i} green`, timeout: 30000 });
    }
    await sleep(500);
    const views = await Promise.all(cards.map((c) => owner.call('GET', `/api/cards/${c.id}`)));
    const runsOf = views.map((v) => v.body.card.run.id);
    for (const [i, r] of runners.entries()) {
      const mine = cards[i];
      const other = cards[1 - i];
      const down = r.proxy.frames('down');
      assert.deepEqual([...new Set(down.filter((f) => f.type === 'offer').map((f) => f.card_id))], [mine.id], `${r.name}: offers only for its own card`);
      assert.equal(down.filter((f) => f.type === 'claim.result' && f.ok).length, 1, `${r.name}: claimed one`);
      const text = r.text();
      for (const bad of [other.id, other.key, runsOf[1 - i]]) assert.ok(!text.includes(bad), `${r.name}: a frame names the other card (${bad})`);
      assert.ok(!text.includes(enrolled[i].runner_token), 'the token never rides a frame');
      const logs = fs.readFileSync(r.logFile, 'utf8');
      for (const e of enrolled) assert.ok(!logs.includes(e.runner_token) && !logs.includes(e.runner_token.slice(4, 24)), `${r.name}: token in the runner log`);
      const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? files(path.join(dir, x.name)) : x.isFile() ? [path.join(dir, x.name)] : []));
      for (const f of files(r.data)) {
        const buf = fs.readFileSync(f);
        assert.ok(!buf.includes(enrolled[i].runner_token), `${f} holds the runner token`);
      }
    }
    const hubLog = fs.readFileSync(hub.logFile, 'utf8');
    for (const e of enrolled) assert.ok(!hubLog.includes(e.runner_token), 'token in the hub log');
    // Unenrolling the owner's install stops its runner and leaves the app signed in.
    assert.equal((await owner.call('DELETE', `/api/teams/${team.id}/enrol`, {})).status, 200);
    await until(() => runners[0].messages.some((m) => m.type === 'runner.status' && m.state === 'revoked'), { what: 'owner runner revoked' });
    assert.equal((await owner.call('GET', '/api/account')).status, 200);
    assert.ok(!runners[1].messages.some((m) => m.type === 'runner.status' && m.state === 'revoked'), 'the teammate\'s runner stays');
  } finally {
    for (const r of runners) await r.stop();
    hub.proc.kill('SIGKILL');
    await new Promise((r) => (hub.proc.exitCode != null ? r() : hub.proc.once('exit', r)));
    if (!process.env.BOARD_E2E_KEEP) rm(root);
  }
});
