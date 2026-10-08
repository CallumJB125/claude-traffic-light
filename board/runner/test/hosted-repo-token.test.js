// Hosted checkouts with short-lived GitHub App installation tokens
// (hosted/repo-token.js, git.js setGitAuth). The hub endpoint
// GET /api/runner/v1/repo-token is faked; git runs for real against local repos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RepoTokens, installAskpass, tokenEnv, isNetworkGit, subcommandOf, isAuthFailure, hubHttpBase } from '../hosted/repo-token.js';
import { git, setGitAuth } from '../git.js';
import { tmpDir, rm, makeRepo, filesHolding } from './helpers.js';

const TOKEN_A = 'ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = 'ghs_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function fakeHub(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, redirect: init.redirect });
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return { status: a.status ?? 200, ok: (a.status ?? 200) < 300, json: async () => a.body };
  };
  return { calls, fetchImpl };
}

test('hubHttpBase maps the runner hub URL to its https origin', () => {
  assert.equal(hubHttpBase('wss://hub.example.test/ws/runner'), 'https://hub.example.test');
  assert.equal(hubHttpBase('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
});

test('RepoTokens: asks with the runner token and team, caches, and refreshes before expiry (token expired mid-run)', async () => {
  let now = Date.parse('2026-10-08T10:00:00Z');
  const hub = fakeHub([
    { body: { token: TOKEN_A, expires_at: '2026-10-08T10:10:00Z' } },
    { body: { token: TOKEN_B, expires_at: '2026-10-08T11:10:00Z' } },
  ]);
  const t = new RepoTokens({ hub: 'https://hub.example.test', team: 'team-1', runnerToken: 'brt_runner', fetchImpl: hub.fetchImpl, now: () => now });
  assert.equal(await t.get('repo 1'), TOKEN_A);
  assert.equal(hub.calls[0].url, 'https://hub.example.test/api/runner/v1/repo-token?repo_id=repo%201');
  assert.equal(hub.calls[0].headers.authorization, 'Bearer brt_runner');
  assert.equal(hub.calls[0].headers['board-team'], 'team-1');
  assert.equal(hub.calls[0].redirect, 'error', 'a redirect could carry the runner token elsewhere');
  now += 4 * 60_000;
  assert.equal(await t.get('repo 1'), TOKEN_A, 'still 6 min left: cached');
  now += 2 * 60_000;
  assert.equal(await t.get('repo 1'), TOKEN_B, 'inside the 5 min skew: a new one');
  assert.equal(hub.calls.length, 2);
});

test('RepoTokens: hub offline, refused, no installation and malformed answers are distinct errors', async () => {
  const mk = (a) => new RepoTokens({ hub: 'https://h.test', team: 't', runnerToken: 'brt_x', fetchImpl: fakeHub([a]).fetchImpl });
  await assert.rejects(mk(new TypeError('fetch failed')).get('r'), { code: 'HUB_UNREACHABLE' });
  await assert.rejects(mk({ status: 401 }).get('r'), { code: 'UNAUTHENTICATED' });
  await assert.rejects(mk({ status: 404 }).get('r'), { code: 'NOT_AVAILABLE' });
  await assert.rejects(mk({ status: 502 }).get('r'), { code: 'HUB_UNREACHABLE' });
  await assert.rejects(mk({ body: { token: 'has spaces in it and is long', expires_at: '2099-01-01T00:00:00Z' } }).get('r'), { code: 'INTERNAL' });
  await assert.rejects(mk({ body: { token: TOKEN_A, expires_at: '2000-01-01T00:00:00Z' } }).get('r'), /expired/);
});

test('askpass prints the token from its env and a fixed username; the script holds no secret', { skip: process.platform === 'win32' }, () => {
  const dir = tmpDir('ask-');
  try {
    const file = installAskpass(dir);
    assert.equal(fs.statSync(file).mode & 0o777, 0o700);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('ghs_'));
    const env = { PATH: process.env.PATH, ...tokenEnv(file, TOKEN_A) };
    assert.equal(execFileSync(file, ["Username for 'https://github.com': "], { env, encoding: 'utf8' }).trim(), 'x-access-token');
    assert.equal(execFileSync(file, ["Password for 'https://x-access-token@github.com': "], { env, encoding: 'utf8' }).trim(), TOKEN_A);
    assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper');
    assert.equal(env.GIT_CONFIG_VALUE_0, '', 'stored helpers are reset for this one process');
  } finally { rm(dir); }
});

test('isNetworkGit / isAuthFailure', () => {
  assert.equal(subcommandOf(['-c', 'core.hooksPath=/dev/null', 'push', 'origin', 'x']), 'push');
  assert.equal(isNetworkGit(['fetch', '--quiet', 'origin']), true);
  assert.equal(isNetworkGit(['rev-parse', 'HEAD']), false);
  assert.equal(isNetworkGit(['-C', 'push', 'status']), false, '-C takes a value');
  assert.equal(isAuthFailure({ stderr: "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/a/b.git/'" }), true);
  assert.equal(isAuthFailure({ stderr: 'fatal: unable to access: The requested URL returned error: 403' }), true);
  assert.equal(isAuthFailure({ stderr: 'fatal: couldn\'t find remote ref main' }), false);
});

test('git(): a remote that refuses the first token gets one retry with a fresh one; the token never reaches disk', { skip: process.platform === 'win32' }, async () => {
  const root = tmpDir('rtk-');
  try {
    const repo = makeRepo(root);
    const fail = path.join(root, 'fail.sh');
    fs.writeFileSync(fail, "#!/bin/sh\necho 'fatal: Authentication failed for https://github.com/acme/app.git' >&2\nexit 128\n", { mode: 0o755 });
    // The provider decides the remote through env-only config: the stale token
    // reaches a remote that refuses it, the fresh one the real (local) remote.
    const seen = [];
    const via = (url) => ({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'protocol.ext.allow', GIT_CONFIG_VALUE_0: 'always', GIT_CONFIG_KEY_1: `url.${url}.insteadOf`, GIT_CONFIG_VALUE_1: 'https://github.com/acme/app.git' });
    setGitAuth({
      applies: (args) => isNetworkGit(args),
      env: async (cwd, { fresh }) => { seen.push(fresh); return { BOARD_GIT_TOKEN: fresh ? TOKEN_B : TOKEN_A, ...(fresh ? via(`file://${repo.bare}`) : via(`ext::${fail}`)) }; },
      isAuthFailure,
    });
    repo.git('config', '--unset-all', `url.file://${repo.bare}.insteadOf`);
    const out = await git(repo.checkout, ['ls-remote', 'origin', 'refs/heads/main']);
    assert.match(out, /refs\/heads\/main/);
    assert.deepEqual(seen, [false, true]);
    assert.deepEqual(filesHolding(root, 'ghs_'), [], 'no token in any file');
  } finally { setGitAuth(null); rm(root); }
});

test('git(): local commands never ask for a token', async () => {
  const root = tmpDir('rtk-');
  try {
    const repo = makeRepo(root);
    let asked = 0;
    setGitAuth({ applies: isNetworkGit, env: async () => { asked++; return {}; }, isAuthFailure });
    await git(repo.checkout, ['rev-parse', 'HEAD']);
    assert.equal(asked, 0);
  } finally { setGitAuth(null); rm(root); }
});
