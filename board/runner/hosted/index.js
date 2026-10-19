// Hosted mode: the board runner as an always-on service on a server (the
// team's Pi), so a card keeps working while its owner's laptop is closed
// (docs/CLOUD-RUNNER-RUNBOOK.md, board/deploy/pi/buddy-runner.service).
//
// The supervisor and run code are the desktop runner's; this adds what a
// headless shared host needs:
//  - repos are cloned on demand from GitHub with short-lived installation
//    tokens (repo-token.js), never the operator's own git credentials;
//  - every agent CLI starts inside its own cgroup (cgroup.js) with CPU and task
//    limits, a memory cap (or watchdog), a wall-clock cap and a token cap, and
//    a stop or cancel kills the whole cgroup;
//  - provider credentials come from the hub per run (runner_provider_config)
//    and reach only the CLI that needs them, never a log or the agent's shell.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRemoteUrl } from '../../shared/scope.js';
import { readPolicy, writePolicy } from '../config.js';
import { git, setGitAuth } from '../git.js';
import { ensurePrivateDir, writeJsonAtomic } from '../util.js';
import { RepoTokens, installAskpass, tokenEnv, isNetworkGit, subcommandOf, isAuthFailure } from './repo-token.js';
import { detectCgroup, RunCgroup } from './cgroup.js';

// AIs with no OS sandbox of their own (their tools run as this service user,
// which also holds the runner's credentials) stay off unless the operator opts in.
export const UNSANDBOXED_AIS = Object.freeze(['hermes', 'hermes-dgx', 'gemini']);
export const HOSTED_AIS = Object.freeze(['claude', 'codex', 'hermes-dgx']);
const MEMORY_POLL_MS = 2000;

const err = (code, message) => Object.assign(new Error(message), { code });
const num = (v, d, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (v == null || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`hosted config: ${v} is out of range`);
  return n;
};
const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function canonOf(entry) {
  return normalizeRemoteUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? entry : `https://${entry}`);
}

/** /etc/buddy-runner/runner.env (board/deploy/pi/runner.env.example) → config. Never echoes the token. */
export function hostedConfig(env = process.env, { readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const tokenFile = env.BUDDY_RUNNER_TOKEN_FILE || (env.CREDENTIALS_DIRECTORY ? path.join(env.CREDENTIALS_DIRECTORY, 'runner-token') : null);
  if (!tokenFile) throw new Error('hosted config: no runner token (LoadCredential=runner-token:… or BUDDY_RUNNER_TOKEN_FILE)');
  let runnerToken;
  try { runnerToken = readFile(tokenFile).trim(); } catch { throw new Error('hosted config: the runner token file is unreadable'); }
  if (!/^brt_[A-Za-z0-9_-]{20,200}$/.test(runnerToken)) throw new Error('hosted config: the runner token file does not hold a runner token (brt_…)');
  const hub = env.BUDDY_RUNNER_HUB;
  let u;
  try { u = new URL(hub); } catch { throw new Error('hosted config: BUDDY_RUNNER_HUB is not a URL'); }
  if (!['https:', 'wss:'].includes(u.protocol) && !(['http:', 'ws:'].includes(u.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) {
    throw new Error('hosted config: BUDDY_RUNNER_HUB must be https: (or http://127.0.0.1 for a hub on this host)');
  }
  const team = env.BUDDY_RUNNER_TEAM;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(team ?? '')) throw new Error('hosted config: BUDDY_RUNNER_TEAM must be the team id');
  const home = env.BUDDY_RUNNER_HOME;
  if (!home || !path.isAbsolute(home)) throw new Error('hosted config: BUDDY_RUNNER_HOME must be an absolute path');
  const repos = list(env.BUDDY_RUNNER_REPOS).map((r) => {
    const c = canonOf(r);
    if (!c || !c.startsWith('github.com/')) throw new Error(`hosted config: ${r} is not a github.com repository`);
    return c;
  });
  const allowUnsandboxed = env.BUDDY_RUNNER_ALLOW_UNSANDBOXED === '1';
  const ais = list(env.BUDDY_RUNNER_AIS || 'claude,codex').filter((a) => HOSTED_AIS.includes(a) && (allowUnsandboxed || !UNSANDBOXED_AIS.includes(a)));
  const sandbox = env.BUDDY_RUNNER_SANDBOX || 'cgroup';
  if (!['cgroup', 'off'].includes(sandbox)) throw new Error('hosted config: BUDDY_RUNNER_SANDBOX must be cgroup or off');
  return {
    hub, team, runnerToken, tokenFile, home, repos, ais, allowUnsandboxed, sandbox,
    credentialsDir: env.CREDENTIALS_DIRECTORY || null,
    maxConcurrent: num(env.BUDDY_RUNNER_MAX_CONCURRENT, 2, { min: 1, max: 8 }),
    hermesEndpoint: env.BUDDY_RUNNER_HERMES_ENDPOINT || null,
    gitName: env.BUDDY_RUNNER_GIT_NAME || 'Plexiform cloud runner',
    gitEmail: env.BUDDY_RUNNER_GIT_EMAIL || 'cloud-runner@users.noreply.github.com',
    caps: {
      wallMs: num(env.BUDDY_RUNNER_MAX_WALL_MINUTES, 90, { min: 1, max: 24 * 60 }) * 60_000,
      maxTokens: num(env.BUDDY_RUNNER_MAX_TOKENS, 3_000_000, { min: 1000 }),
      maxUsd: num(env.BUDDY_RUNNER_MAX_USD, 5, { min: 0.5, max: 1000 }),
      cpuPercent: num(env.BUDDY_RUNNER_RUN_CPU_PERCENT, 200, { min: 10, max: 400 }),
      tasksMax: num(env.BUDDY_RUNNER_RUN_TASKS_MAX, 512, { min: 16, max: 8192 }),
      memoryBytes: num(env.BUDDY_RUNNER_RUN_MEMORY_MB, 4096, { min: 256, max: 14336 }) * 1024 * 1024,
    },
  };
}

export class HostedMode {
  /**
   * opts: config (hostedConfig), log, fetchImpl, cgroup (a detectCgroup result;
   * detected when omitted), now, memoryPollMs.
   */
  constructor({ config, log, fetchImpl, cgroup, now = Date.now, memoryPollMs = MEMORY_POLL_MS }) {
    this.config = config;
    this.log = log;
    this.now = now;
    this.memoryPollMs = memoryPollMs;
    this.boardHome = path.join(config.home, 'board');
    this.reposDir = path.join(config.home, 'repos');
    for (const d of [config.home, this.boardHome, this.reposDir, path.join(config.home, 'bin')]) ensurePrivateDir(d);
    this.askpass = installAskpass(path.join(config.home, 'bin'));
    this.tokens = new RepoTokens({ hub: config.hub, team: config.team, runnerToken: config.runnerToken, fetchImpl });
    this.cgroup = config.sandbox === 'off' ? { ok: false, reason: 'BUDDY_RUNNER_SANDBOX=off' } : (cgroup ?? detectCgroup());
    if (config.sandbox === 'cgroup' && !this.cgroup.ok) throw new Error(`hosted runner refuses to start without its run sandbox: ${this.cgroup.reason}`);
    this.repoIds = new Map();     // repo_id → canonical url (allowlisted and configured)
    this.commonDirs = new Map();  // realpath of a checkout's .git → repo_id
    this.cloning = new Map();
    this.watches = new Map();     // run_id → {timers, cg}
    this.localModelsFile = path.join(config.home, 'local-models.json');
    if (config.hermesEndpoint) writeJsonAtomic(this.localModelsFile, { endpoints: [{ id: 'hosted', kind: 'openai', url: config.hermesEndpoint }] });
    setGitAuth({
      applies: (args) => isNetworkGit(args) && subcommandOf(args) !== 'clone',
      env: (cwd, { fresh }) => this.#tokenEnvFor(cwd, fresh),
      isAuthFailure,
    });
  }

  /** The supervisor's device: the runner token stays in memory, used for the WS connect only. */
  get device() {
    return { hub: this.config.hub, runner_token: this.config.runnerToken, team_id: this.config.team };
  }

  /** Parent env for the CLIs (the supervisor's allowlist applies on top). */
  childEnv(env) {
    return { ...env, ...(this.config.hermesEndpoint ? { PLEXIFORM_LOCAL_MODELS_FILE: this.localModelsFile } : {}) };
  }

  close() {
    setGitAuth(null);
    for (const id of [...this.watches.keys()]) this.#unwatch(id);
  }

  repoPath(repoId) { return path.join(this.reposDir, String(repoId).replace(/[^A-Za-z0-9._-]/g, '_')); }

  // ── repos ─────────────────────────────────────────────────────────────────
  /** Welcome: opt in exactly the configured repos the hub allowlists; → the new policy. */
  onAllowlist(l, allowlist) {
    const p = readPolicy(l);
    this.repoIds.clear();
    for (const a of allowlist ?? []) {
      const canon = normalizeRemoteUrl(a.canonical_url) ?? a.canonical_url;
      if (!this.config.repos.includes(canon)) continue;
      this.repoIds.set(a.repo_id, canon);
      p.repos[a.repo_id] = { ...(p.repos[a.repo_id] ?? {}), opt_in: true, local_path: this.repoPath(a.repo_id), max_concurrent: this.config.maxConcurrent, budget_per_run: this.config.caps.maxUsd };
    }
    for (const id of Object.keys(p.repos)) if (!this.repoIds.has(id)) p.repos[id] = { ...p.repos[id], opt_in: false };
    p.accept_from = {};
    writePolicy(l, p);
    return p;
  }

  /** Clone on first use (with a fresh installation token); later fetches go through git()'s auth. */
  async ensureCheckout(repoId) {
    const canon = this.repoIds.get(repoId);
    if (!canon) throw err('POLICY_DENIED', 'this repository is not configured on the hosted runner');
    const dir = this.repoPath(repoId);
    if (!fs.existsSync(path.join(dir, '.git'))) {
      if (!this.cloning.has(repoId)) this.cloning.set(repoId, this.#clone(repoId, canon, dir).finally(() => this.cloning.delete(repoId)));
      await this.cloning.get(repoId);
    }
    this.commonDirs.set(fs.realpathSync(path.join(dir, '.git')), repoId);
    return dir;
  }

  async #clone(repoId, canon, dir) {
    const tmp = `${dir}.clone-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    const token = await this.tokens.get(repoId);
    await git(this.reposDir, ['clone', '--quiet', '--no-tags', `https://${canon}.git`, tmp], { env: tokenEnv(this.askpass, token), timeoutMs: 600_000 });
    await git(tmp, ['config', 'user.name', this.config.gitName]);
    await git(tmp, ['config', 'user.email', this.config.gitEmail]);
    await git(tmp, ['config', 'commit.gpgsign', 'false']);
    fs.renameSync(tmp, dir);
    this.log.info('hosted checkout cloned', { repo_id: repoId });
  }

  async #tokenEnvFor(cwd, fresh) {
    const common = (await git(cwd, ['rev-parse', '--git-common-dir'])).trim();
    const repoId = this.commonDirs.get(fs.realpathSync(path.resolve(cwd, common)));
    if (!repoId) throw err('FORBIDDEN', 'not a hosted checkout');
    if (fresh) this.tokens.invalidate(repoId);
    return tokenEnv(this.askpass, await this.tokens.get(repoId, { fresh }));
  }

  // ── runs ──────────────────────────────────────────────────────────────────
  /**
   * Before each CLI spawn: this run's provider credential from the hub, its
   * cgroup and wrapper. → {bin, env, anthropicKey, model, denyRead, briefNote}
   */
  async prepare(sup, run, ai, realBin) {
    let cfg = { configured: false };
    try {
      cfg = await sup.rpc(run, 'runner_provider_config', {});
    } catch (e) {
      if (e.code !== 'NOT_AVAILABLE') throw e;
    }
    const out = { bin: realBin, env: {}, anthropicKey: null, model: cfg.model ?? null, denyRead: [this.config.credentialsDir, this.config.tokenFile].filter(Boolean), briefNote: HOSTED_BRIEF };
    if (ai === 'claude' && cfg.api_key) out.anthropicKey = cfg.api_key;
    if (ai === 'codex' && cfg.api_key) out.env.CODEX_API_KEY = cfg.api_key;
    if (ai === 'hermes-dgx') {
      const url = cfg.base_url ?? this.config.hermesEndpoint;
      if (!url) throw err('NOT_AVAILABLE', 'no model endpoint is configured for Hermes on the cloud runner');
      const file = path.join(run.runDir, 'local-models.json');
      writeJsonAtomic(file, { endpoints: [{ id: 'hosted', kind: 'openai', url }] });
      out.env.PLEXIFORM_LOCAL_MODELS_FILE = file;
    }
    if (this.cgroup.ok) {
      const cg = this.watches.get(run.run_id)?.cg ?? new RunCgroup({ base: this.cgroup.base, runId: run.run_id, memory: this.cgroup.memory, limits: this.config.caps }).create();
      this.#watch(run).cg = cg;
      out.bin = cg.wrap(realBin, run.runDir);
    }
    return out;
  }

  #watch(run) {
    let w = this.watches.get(run.run_id);
    if (!w) { w = { timers: [], cg: null, deadline: this.now() + this.config.caps.wallMs, tokens: 0 }; this.watches.set(run.run_id, w); }
    return w;
  }

  #unwatch(runId) {
    const w = this.watches.get(runId);
    if (!w) return null;
    for (const t of w.timers) { clearTimeout(t); clearInterval(t); }
    this.watches.delete(runId);
    return w;
  }

  /** After the backend is attached: caps, and a stop that also empties the run's cgroup. */
  attach(run, backend) {
    const w = this.#watch(run);
    for (const t of w.timers) { clearTimeout(t); clearInterval(t); }
    w.timers = [];
    const caps = this.config.caps;
    const failRun = (kind, reason, extra) => { if (!run.ending && !run.ended) run.fail(kind, reason, extra).catch((e) => this.log.warn('cap stop failed', { run_id: run.run_id, err: e.message })); };
    backend.on('usage', (u) => {
      w.tokens += (Number.isSafeInteger(u?.inputTokens) ? u.inputTokens : 0) + (Number.isSafeInteger(u?.outputTokens) ? u.outputTokens : 0);
      if (w.tokens > caps.maxTokens) failRun('budget', `cloud runner token cap reached (${caps.maxTokens} tokens)`, { budget_scope: 'device' });
    });
    const left = Math.max(0, w.deadline - this.now());
    const wall = setTimeout(() => failRun('error', `cloud runner time limit reached (${Math.round(caps.wallMs / 60_000)} min)`), left);
    wall.unref?.();
    w.timers.push(wall);
    const cg = w.cg;
    if (cg && !cg.memoryLimited) {
      const poll = setInterval(() => {
        if (cg.rssBytes() <= caps.memoryBytes) return;
        clearInterval(poll);
        // Report first (the run is then ending, so the kill is not read as a crash), then kill at once.
        failRun('error', `cloud runner memory limit reached (${Math.round(caps.memoryBytes / 1048576)} MB)`);
        cg.kill().catch(() => {});
      }, this.memoryPollMs);
      poll.unref?.();
      w.timers.push(poll);
    }
    if (cg && !backend.hostedStop) {
      const stop = backend.stop.bind(backend);
      backend.hostedStop = true;
      backend.stop = async () => {
        const stopped = await stop();
        return (await cg.kill()) && stopped === true;
      };
    }
  }

  /**
   * Before the run's worktree goes: push the run branch with a fresh token
   * (the agent has no git credentials), then empty and remove its cgroup.
   */
  async finishRun(run) {
    const w = this.#unwatch(run.run_id);
    try {
      if (run.worktree && fs.existsSync(run.worktree) && run.branch) {
        const ahead = Number((await git(run.worktree, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin'])).trim());
        if (ahead > 0) await git(run.worktree, ['-c', 'core.hooksPath=/dev/null', 'push', '--quiet', 'origin', `HEAD:refs/heads/${run.branch}`], { timeoutMs: 120_000 });
      }
    } catch (e) {
      this.log.warn('hosted branch push failed; the snapshot ref still holds the work', { run_id: run.run_id, err: String(e.stderr || e.message).split('\n')[0].slice(0, 200) });
    }
    if (w?.cg) {
      if (!(await w.cg.kill())) this.log.warn('run cgroup still has processes after kill', { run_id: run.run_id });
      w.cg.remove();
    }
  }
}

export const HOSTED_BRIEF = 'This run is on the team\'s cloud runner. You have no git credentials: commit on your branch and do not push; the runner pushes your branch and snapshots when the run ends.';
