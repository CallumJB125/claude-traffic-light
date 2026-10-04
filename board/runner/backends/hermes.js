// Hermes Agent adapter (`hermes chat --format stream-json --oneshot`). One
// turn per process, prompt on stdin, later messages by --resume, like Codex.
//
// Hermes has NO OS sandbox: its terminal and file tools run with the member's
// own account. The hub therefore dispatches Hermes only to the dispatcher's
// own machine (hub/api.js, AI_CAPABILITIES.ownMachineOnly) and the runner
// ignores any other offer (supervisor.js). Isolation is configuration only: a
// per-run HERMES_HOME whose generated config.yaml holds the per-run board MCP
// server, the model/provider and denied unattended approvals; user config,
// rules, memory, plugins and skills are never loaded. --safe-mode is not used
// because it also disables MCP.
//
// 'hermes' uses the member's own Hermes provider (API keys from their Hermes
// .env only); 'hermes-dgx' points the same CLI at the OpenAI-compatible
// endpoint in Plexiform's local-models.json, restricted to literal loopback,
// LAN or tailnet addresses (src/local-models.js addressAllowed), no key.
import fs from 'node:fs';
import net from 'node:net'; // privacy-flow: runner-hermes
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process'; // privacy-flow: runner-hermes
import { detectCli } from './detect.js';
import { CodexBackend, NotAvailableError } from './codex.js';
import { lstartOf } from '../procs.js';
import { writeFileAtomic } from '../util.js';
import { CODEX_MCP_SERVER, underElectron } from '../launch.js';
import { CODEX_BOARD_TOOLS } from '../../mcp/codex-run.js';

export const HERMES_SESSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const HERMES_TOOLSETS = Object.freeze(['terminal', 'file', 'board']);
const WRITE_TOOLS = new Set(['write_file', 'patch']);

const hermesHome = (env) => env.HERMES_HOME || (env.HOME ? path.join(env.HOME, '.hermes') : null);

/** Plexiform's local-models.json (Electron userData), per platform. */
export function localModelsFile(env = process.env, platform = process.platform) {
  if (env.PLEXIFORM_LOCAL_MODELS_FILE) return env.PLEXIFORM_LOCAL_MODELS_FILE;
  if (platform === 'darwin') return env.HOME ? path.join(env.HOME, 'Library', 'Application Support', 'Plexiform', 'local-models.json') : null;
  if (platform === 'win32') return env.APPDATA ? path.win32.join(env.APPDATA, 'Plexiform', 'local-models.json') : null;
  const base = env.XDG_CONFIG_HOME || (env.HOME && path.join(env.HOME, '.config'));
  return base ? path.join(base, 'Plexiform', 'local-models.json') : null;
}

/**
 * The first usable OpenAI-compatible endpoint, or null. Hermes resolves the
 * host itself, so only a literal IP passes (no DNS to re-check), and only
 * where local-models allows it without the public opt-in.
 */
export async function dgxEndpoint({ env = process.env, platform = process.platform, file = localModelsFile(env, platform) } = {}) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const { addressAllowed } = (await import('../../../src/local-models.js')).default; // privacy-flow: runner-hermes
  for (const e of Array.isArray(cfg?.endpoints) ? cfg.endpoints : []) {
    if (!e || e.kind !== 'openai' || typeof e.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(e.id) || typeof e.url !== 'string' || e.url.length > 300) continue;
    let u;
    try { u = new URL(e.url); } catch { continue; }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || !net.isIP(host) || !addressAllowed(host, false)) continue;
    const base = e.url.replace(/\/+$/, '');
    return { id: e.id, url: /\/v1$/.test(base) ? base : `${base}/v1`, kind: 'openai' };
  }
  return null;
}

/** Generated per-run config.yaml content (JSON is valid YAML). */
export function hermesConfig({ boardRunDir, systemPrompt = null, model = null, endpoint = null }) {
  return {
    ...(endpoint ? { model: { provider: 'custom', base_url: endpoint.url, ...(model ? { default: model } : {}) } } : model ? { model: { default: model } } : {}),
    mcp_servers: { board: {
      command: process.execPath, args: [CODEX_MCP_SERVER, boardRunDir],
      env: underElectron() ? { ELECTRON_RUN_AS_NODE: '1' } : {},
      tools: { include: [...CODEX_BOARD_TOOLS] }, connect_timeout: 10, timeout: 60,
    } },
    // No user is present to approve a dangerous command in a -q run.
    approvals: { single_query_mode: 'deny' },
    // A fresh per-run home has no update cache: every run would call GitHub.
    updates: { check: false },
    ...(systemPrompt ? { agent: { system_prompt: systemPrompt } } : {}),
  };
}

export class HermesBackend extends CodexBackend {
  static cli = 'hermes';
  static describe() {
    return { id: 'hermes', label: 'Hermes', startable: process.platform !== 'win32',
      capabilities: { budget: 'none', budgetUnit: null, resume: true, interrupt: false, structuredEvents: true,
        permissions: 'none', systemPrompt: true, model: true, maxTurns: true } };
  }
  static async detect(opts = {}) {
    const env = opts.env ?? process.env;
    const home = env.HOME ?? env.USERPROFILE;
    // `hermes --version` runs a synchronous GitHub update check whenever its
    // daily cache is stale (~20 s offline), which overran the 3 s probe and
    // marked Hermes unavailable. A throwaway home that opts out keeps it local.
    const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-hermes-probe-'));
    let d;
    try {
      fs.writeFileSync(path.join(probeHome, 'config.yaml'), 'updates:\n  check: false\n', { mode: 0o600 });
      d = await detectCli('hermes', { ...opts, knownDirs: (opts.knownDirs ?? [home && path.join(home, '.local', 'bin')]).filter(Boolean),
        authFiles: (e) => [hermesHome(e) && path.join(hermesHome(e), '.env')].filter(Boolean), versionEnv: { HERMES_HOME: probeHome } });
    } finally {
      fs.rmSync(probeHome, { recursive: true, force: true });
    }
    // stream-json, --query-file and --source were verified against v0.21.3.
    const v = /^(\d+)\.(\d+)\./.exec(d.version ?? '');
    const old = v && Number(v[1]) === 0 && Number(v[2]) < 21;
    return { ...d, id: this.describe().id, ...(d.installed && (!d.version || old) ? { startable: false, ...(old ? { reason: 'unsupported_version' } : {}) } : {}) };
  }
  argv() {
    return ['chat', '--query-file', '-', '--format', 'stream-json', '--oneshot', '--in', this.cwd, '--no-restore-cwd',
      '--ignore-rules', '--source', 'tool', '-t', HERMES_TOOLSETS.join(','),
      ...(this.maxTurns != null ? ['--max-turns', String(this.maxTurns)] : []),
      ...(this.resume ? ['--resume', this.sessionId] : [])];
  }
  // Credentials only: the member's Hermes .env (API keys). Never config,
  // memory, skills, plugins or auth.json (OAuth refresh rotation would be lost).
  linkCredentials(home) {
    const real = hermesHome(this.env);
    const target = real && path.join(real, '.env');
    if (target && fs.existsSync(target)) fs.symlinkSync(target, path.join(home, '.env'));
  }
  async resolveModel() { return { model: this.model ?? null, endpoint: null }; }
  start(prompt) {
    if (this.platform === 'win32') throw new NotAvailableError('Hermes runs are not available on Windows');
    if (this.budget?.amount != null || this.budgetUsd != null) throw new NotAvailableError('Hermes does not offer a native spend cap');
    if (this.permissionMode === 'default' || this.permissionMode === 'plan') throw new NotAvailableError('Hermes has no sandbox for plan-only or interactively approved runs');
    if (this.resume && !HERMES_SESSION.test(this.sessionId ?? '')) throw new NotAvailableError('Hermes resume requires the task session id');
    if (!this.boardRunDir) throw new NotAvailableError('Hermes requires the per-run board server');
    this.exited = false; this.sawResult = false; this.turnActive = true;
    return this.launch(prompt);
  }
  async launch(prompt) {
    try {
      const home = path.join(this.runDir, 'hermes-home');
      const { model, endpoint } = await this.resolveModel();
      if (!fs.existsSync(home)) {
        fs.mkdirSync(home, { recursive: true, mode: 0o700 });
        this.linkCredentials(home);
      }
      writeFileAtomic(path.join(home, 'config.yaml'), `${JSON.stringify(hermesConfig({ boardRunDir: this.boardRunDir, systemPrompt: this.systemPrompt, model, endpoint }), null, 2)}\n`);
      const env = { ...this.env, HERMES_HOME: home };
      delete env.HERMES_EPHEMERAL_SYSTEM_PROMPT;
      const child = spawn(this.bin, this.argv(), { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); // privacy-flow: runner-hermes
      this.child = child; this.pid = child.pid; this.pgid = child.pid; this.lstart = lstartOf(child.pid);
      this.attachChild(child);
      if (!child.pid) throw new NotAvailableError('Hermes could not start');
      child.stdin.end(String(prompt ?? ''));
      return this;
    } catch (e) {
      this.exited = true; this.turnActive = false;
      throw e instanceof NotAvailableError ? e : new NotAvailableError('Hermes could not start');
    }
  }
  flushText() {
    if (!this.pendingText) return;
    this.lastText = this.pendingText; this.pendingText = '';
    this.emit('assistant', { text: this.lastText });
  }
  toolOf(name, input) {
    if (name === 'terminal') return { name: 'Bash', input: { command: String(input?.command ?? '') } };
    if (WRITE_TOOLS.has(name)) return { name: 'Write', input: { file_path: input?.path } };
    return { name: String(name ?? 'unknown').slice(0, 100), input: input && typeof input === 'object' ? input : {} };
  }
  onEvent(e) {
    this.openTools ??= new Map(); this.toolSeq ??= 0;
    if (e.type === 'system' && e.subtype === 'init') {
      this.turnActive = true;
      if (HERMES_SESSION.test(e.session_id ?? '')) this.announce(e.session_id);
    } else if (e.type === 'text' && typeof e.text === 'string') {
      this.pendingText = (this.pendingText ?? '') + e.text;
    } else if (e.type === 'tool_use') {
      this.flushText();
      const t = this.toolOf(e.name, e.input);
      const id = typeof e.tool_call_id === 'string' && e.tool_call_id ? e.tool_call_id : `hermes:${++this.toolSeq}`;
      this.openTools.set(id, { raw: e.name, ...t });
      this.emit('tool_start', { id, name: t.name, input: t.input });
    } else if (e.type === 'tool_result') {
      let id = typeof e.tool_call_id === 'string' && this.openTools.has(e.tool_call_id) ? e.tool_call_id : null;
      if (!id) for (const [k, v] of this.openTools) if (v.raw === e.name) { id = k; break; }
      if (!id) return;
      const t = this.openTools.get(id); this.openTools.delete(id);
      // v0.21.3 wraps terminal results as {"output","exit_code","error"}.
      let output = String(e.output ?? ''), exitCode;
      if (t.raw === 'terminal') {
        try {
          const r = JSON.parse(output);
          if (typeof r?.output === 'string') { output = [r.output, r.error].filter(Boolean).join('\n'); if (Number.isInteger(r.exit_code)) exitCode = r.exit_code; }
        } catch { /* plain text */ }
      }
      this.emit('tool_end', { id, ok: e.is_error !== true, input: t.input, output: output.slice(-16000), ...(exitCode != null ? { exit_code: exitCode } : {}) });
    } else if (e.type === 'result') {
      this.flushText();
      this.turnActive = false; this.sawResult = true;
      if (HERMES_SESSION.test(e.session_id ?? '')) this.announce(e.session_id);
      this.emit('usage', { inputTokens: e.tokens?.input ?? 0, outputTokens: e.tokens?.output ?? 0, costUsd: null });
      const ok = e.exit_code === 0 && !e.error;
      this.emit('result', ok
        ? { subtype: 'success', is_error: false, result: typeof e.text === 'string' && e.text ? e.text : this.lastText, total_cost_usd: null, num_turns: 1, terminal_reason: null }
        : { subtype: 'error', is_error: true, result: String(e.error ?? e.text ?? 'Hermes turn failed').slice(0, 4000), total_cost_usd: null, num_turns: 1 });
    }
  }
  // The session id can arrive with init or (for a new session) only with the result.
  announce(id) {
    if (this.announced === id) return;
    this.announced = id; this.sessionId = id;
    this.emit('init', { session_id: id, tools: [], mcp_servers: [] });
  }
  exit(code, signal) {
    if (this.exited) return;
    this.exited = true; this.turnActive = false;
    this.emit('exit', { code, signal, error: this.error ? 'Hermes could not start' : null, sawResult: this.sawResult });
  }
}

export class HermesDgxBackend extends HermesBackend {
  static describe() {
    return { ...super.describe(), id: 'hermes-dgx', label: 'Hermes · DGX' };
  }
  static async detect(opts = {}) {
    const d = await super.detect(opts);
    if (!d.installed || d.reason) return d;
    const endpoint = await dgxEndpoint({ env: opts.env ?? process.env, platform: opts.platform ?? process.platform, ...(opts.localModelsFile ? { file: opts.localModelsFile } : {}) });
    return endpoint ? { ...d, signedIn: true } : { ...d, signedIn: 'unknown', startable: false, reason: 'no_local_model' };
  }
  linkCredentials() {}
  async resolveModel() {
    const endpoint = await dgxEndpoint({ env: this.env, platform: this.platform, ...(this.localModelsFile ? { file: this.localModelsFile } : {}) });
    if (!endpoint) throw new NotAvailableError('No local model endpoint is configured on this machine');
    if (this.model) return { model: this.model, endpoint };
    const { probeEndpoint } = (await import('../../../src/local-models.js')).default; // privacy-flow: runner-hermes
    const probe = await (this.probeEndpoint ?? probeEndpoint)({ ...endpoint, apiKeyEnv: null, allowPublic: false }, { env: {} });
    if (!probe.reachable || !probe.models.length) throw new NotAvailableError('The local model endpoint is not reachable or lists no models');
    return { model: probe.models[0], endpoint };
  }
}
