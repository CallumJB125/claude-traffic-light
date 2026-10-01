// Codex exec adapter: subscription auth stays in CODEX_HOME; tasks use a
// named filesystem profile, no network/Unix sockets, no user config/rules,
// and prompts only on stdin. A turn exits; later messages arrive by resume.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process'; // privacy-flow: runner-codex
import fs from 'node:fs';
import path from 'node:path';
import { detectCli } from './detect.js';
import { lstartOf, killTree, processTable, treeGroups, killGroups } from '../procs.js';
import { writeFileAtomic } from '../util.js';
import { CODEX_MCP_SERVER, underElectron } from '../launch.js';
import { CODEX_BOARD_TOOLS } from '../../mcp/codex-run.js';

export class NotAvailableError extends Error {
  constructor(message = 'this AI capability is not available') { super(message); this.code = 'NOT_AVAILABLE'; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const table = (entries) => `{${Object.entries(entries).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(',')}}`;
const ownedRef = (ref) => typeof ref === 'string' && ref.startsWith('refs/heads/')
  && !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) && !ref.includes('..') && !ref.includes('@{')
  && ref.split('/').every((p) => p && !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock'));

/** Same profile is used for new, resumed and user-owned terminal turns. */
export function codexConfig({ cwd, cacheDir, dataDir, gitDir, commonGitDir, gitRef, readOnly = false, env = {}, instructionsFile, denyPaths = [], boardRunDir = null }) {
  const filesystem = { ':minimal': 'read', ':workspace_roots': readOnly ? 'read' : 'write' };
  // OS minimal permissions omit common installed tool runtimes. Grant read
  // only (never their caches/configuration or arbitrary home directories).
  for (const d of ['/opt/homebrew/bin', '/opt/homebrew/Cellar', '/opt/homebrew/lib', '/opt/homebrew/share', '/usr/local/bin', '/usr/local/lib', '/usr/local/Cellar', '/usr/local/share', '/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer']) filesystem[d] = 'read';
  if (cacheDir) filesystem[cacheDir] = 'write';
  // Shared Git refs belong to other tasks and user checkouts. Commits need
  // object storage and only this task's authorized branch, never all refs.
  if (commonGitDir) {
    filesystem[commonGitDir] = 'read';
    if (!readOnly) {
      filesystem[path.join(commonGitDir, 'objects')] = 'write';
      if (ownedRef(gitRef)) {
        for (const rel of [gitRef, `${gitRef}.lock`, `logs/${gitRef}`, `logs/${gitRef}.lock`]) filesystem[path.join(commonGitDir, rel)] = 'write';
      }
      if (gitDir === commonGitDir) {
        const localFiles = ['HEAD', 'index', 'logs/HEAD', 'COMMIT_EDITMSG', 'AUTO_MERGE', 'MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'MERGE_RR', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'SQUASH_MSG', 'ORIG_HEAD'];
        for (const rel of localFiles.flatMap((n) => [n, `${n}.lock`])) filesystem[path.join(gitDir, rel)] = 'write';
      }
    }
  }
  if (gitDir && gitDir !== commonGitDir) filesystem[gitDir] = readOnly ? 'read' : 'write';
  // Read-only exceptions prevent a shell from modifying its own policy or
  // trusted instructions. Nested rules narrow the enclosing writable root.
  for (const d of new Set([cwd, commonGitDir].filter(Boolean))) {
    const names = d === commonGitDir ? ['config', 'hooks'] : ['.git', '.codex', '.claude', '.mcp.json', 'AGENTS.md', 'CLAUDE.md'];
    for (const n of names) filesystem[path.join(d, n)] = 'read';
  }
  if (gitDir) for (const n of ['config', 'config.worktree', 'hooks']) filesystem[path.join(gitDir, n)] = 'read';
  if (dataDir) filesystem[dataDir] = 'deny';
  for (const d of denyPaths) filesystem[d] = 'deny';
  for (const d of [env.CODEX_HOME || (env.HOME && path.join(env.HOME, '.codex')), ...['.ssh', '.aws', '.config/gh', '.claude', '.claude.json', '.claude-traffic-light', 'Library/Keychains'].map((n) => env.HOME && path.join(env.HOME, n))].filter(Boolean)) filesystem[d] = 'deny';
  const shellEnv = {};
  for (const k of ['HOME', 'PATH', 'LANG', 'TMPDIR', 'TZ', 'npm_config_cache', 'XDG_CACHE_HOME', 'PIP_CACHE_DIR', 'UV_CACHE_DIR']) if (env[k]) shellEnv[k] = env[k];
  return [
    'approval_policy="never"', 'default_permissions="plexiform"',
    `permissions.plexiform.filesystem=${table(filesystem)}`,
    'permissions.plexiform.network.enabled=false',
    'permissions.plexiform.network.dangerously_allow_all_unix_sockets=false',
    'shell_environment_policy.inherit="none"', `shell_environment_policy.set=${table(shellEnv)}`,
    'shell_environment_policy.experimental_use_profile=false',
    `projects.${JSON.stringify(cwd)}.trust_level="untrusted"`,
    'project_doc_max_bytes=0', 'web_search="disabled"', 'mcp_servers={}',
    ...(boardRunDir ? [
      `mcp_servers.board.command=${JSON.stringify(process.execPath)}`,
      `mcp_servers.board.args=${JSON.stringify([CODEX_MCP_SERVER, boardRunDir])}`,
      `mcp_servers.board.env=${table(underElectron() ? { ELECTRON_RUN_AS_NODE: '1' } : {})}`,
      'mcp_servers.board.env_vars=[]', 'mcp_servers.board.required=true',
      'mcp_servers.board.startup_timeout_sec=10', 'mcp_servers.board.tool_timeout_sec=60',
      `mcp_servers.board.enabled_tools=${JSON.stringify(CODEX_BOARD_TOOLS)}`,
      // The task dispatch authorizes these closed, per-run board tools.
      // Codex exec cannot present an MCP approval prompt; without an exact
      // tool policy it cancels writes before the fenced hub can validate them.
      // Shell sandbox and recorded human plan grants remain independent.
      'mcp_servers.board.default_tools_approval_mode="prompt"',
      ...CODEX_BOARD_TOOLS.map((tool) => `mcp_servers.board.tools.${tool}.approval_mode="approve"`),
    ] : []), 'hooks={}', 'notify=[]',
    'features.apps=false', 'features.multi_agent=false', 'features.hooks=false',
    ...(instructionsFile ? [`model_instructions_file=${JSON.stringify(instructionsFile)}`] : []),
  ];
}

export class CodexBackend extends EventEmitter {
  static describe() {
    return { id: 'codex', label: 'Codex', startable: true,
      capabilities: { budget: 'none', budgetUnit: null, resume: true, interrupt: false, structuredEvents: true,
        permissions: 'sandbox-flags', systemPrompt: true, model: true, maxTurns: false } };
  }
  static async detect(opts = {}) {
    const home = opts.env?.HOME ?? process.env.HOME;
    const knownDirs = opts.knownDirs ?? [home && path.join(home, '.local/bin'), home && path.join(home, '.npm-global/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS', '/Applications/Codex.app/Contents/Resources'];
    const d = await detectCli('codex', { ...opts, knownDirs: knownDirs.filter(Boolean), statusArgs: ['login', 'status'], authFiles: (env) => [env.CODEX_HOME ? path.join(env.CODEX_HOME, 'auth.json') : env.HOME && path.join(env.HOME, '.codex', 'auth.json')].filter(Boolean) });
    const v = /^(\d+)\.(\d+)\.(\d+)/.exec(d.version ?? '');
    return d.installed && d.version && (!v || (Number(v[1]) === 0 && Number(v[2]) < 159)) ? { ...d, reason: 'unsupported_version', startable: false } : d.installed && !d.version ? { ...d, startable: false } : d;
  }
  constructor(opts = {}) {
    super(); Object.assign(this, opts);
    this.child = null; this.pid = null; this.lstart = null; this.pgid = null; this.exited = true;
    this.turnActive = false; this.sawResult = false; this.lastText = ''; this.leftovers = []; this.error = null;
  }
  argv() {
    const instructionsFile = path.join(this.runDir, 'codex-instructions.md');
    const config = codexConfig({ ...this, readOnly: this.permissionMode === 'plan', instructionsFile });
    return ['exec', '--json', '--ignore-user-config', '--ignore-rules', '--strict-config', '-C', this.cwd,
      ...config.flatMap((c) => ['-c', c]), ...(this.model ? ['--model', this.model] : []),
      ...(this.resume ? ['resume', this.sessionId] : ['--skip-git-repo-check']), '-'];
  }
  start(prompt) {
    if (this.budget?.amount != null || this.budgetUsd != null) throw new NotAvailableError('Codex does not offer a native spend cap');
    if (this.maxTurns != null) throw new NotAvailableError('Codex does not offer a native max-turn cap');
    if (this.permissionMode === 'default') throw new NotAvailableError('Codex exec cannot route interactive approvals');
    if (this.resume && !UUID.test(this.sessionId ?? '')) throw new NotAvailableError('Codex resume requires the task session UUID');
    writeFileAtomic(path.join(this.runDir, 'codex-instructions.md'), this.systemPrompt ?? 'Work only on the user task in the supplied workspace.');
    this.exited = false; this.sawResult = false; this.turnActive = true;
    const child = spawn(this.bin, this.argv(), { cwd: this.cwd, env: { ...this.env, ...(this.env.CODEX_HOME ? {} : this.env.HOME ? { CODEX_HOME: path.join(this.env.HOME, '.codex') } : {}) }, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); // privacy-flow: runner-codex
    this.child = child; this.pid = child.pid; this.pgid = child.pid; this.lstart = lstartOf(child.pid);
    child.stdin.on('error', () => {});
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s) => {
      buf += s;
      if (Buffer.byteLength(buf) > 2 * 1024 * 1024) { this.kill(); return; }
      let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); try { this.onEvent(JSON.parse(line)); } catch { /* non-event output */ } }
    });
    // CLI stderr may contain auth/network details; it never reaches app logs.
    child.stderr.on('data', () => {});
    child.on('error', () => { this.error = 'Codex could not start'; this.exit(null, null); });
    child.on('exit', (code, signal) => this.exit(code, signal));
    if (!child.pid) {
      this.exited = true; this.turnActive = false;
      throw new NotAvailableError('Codex could not start');
    }
    child.stdin.end(String(prompt ?? ''));
    return this;
  }
  onEvent(e) {
    if (e.type === 'thread.started' && UUID.test(e.thread_id ?? '')) { this.sessionId = e.thread_id; this.emit('init', { session_id: e.thread_id, tools: [], mcp_servers: [] }); }
    else if (e.type === 'turn.started') this.turnActive = true;
    else if (e.type === 'item.started' && e.item?.type === 'command_execution') this.emit('tool_start', { id: e.item.id, name: 'Bash', input: { command: e.item.command } });
    else if (e.type === 'item.completed') {
      const i = e.item;
      if (i?.type === 'command_execution') this.emit('tool_end', { id: i.id, ok: i.exit_code === 0,
        input: { command: i.command }, output: String(i.aggregated_output ?? '').slice(-16000), exit_code: i.exit_code });
      else if (i?.type === 'agent_message' && typeof i.text === 'string') { this.lastText = i.text; this.emit('assistant', { text: i.text }); }
      else if (i?.type === 'file_change') for (const [n, c] of (i.changes ?? []).entries()) {
        const id = `${i.id}:${n}`; this.emit('tool_start', { id, name: 'Write', input: { file_path: c.path } }); this.emit('tool_end', { id, ok: i.status !== 'failed' });
      }
    } else if (e.type === 'turn.completed') {
      this.turnActive = false; this.sawResult = true;
      this.emit('usage', { inputTokens: e.usage?.input_tokens ?? 0, outputTokens: e.usage?.output_tokens ?? 0, costUsd: null });
      this.emit('result', { subtype: 'success', is_error: false, result: this.lastText, total_cost_usd: null, num_turns: 1, terminal_reason: null });
    } else if (e.type === 'turn.failed') {
      this.turnActive = false; this.sawResult = true;
      this.emit('result', { subtype: 'error', is_error: true, result: String(e.error?.message ?? 'Codex turn failed').slice(0, 4000), total_cost_usd: null, num_turns: 1 });
    }
  }
  exit(code, signal) { if (this.exited) return; this.exited = true; this.turnActive = false; this.emit('exit', { code, signal, error: this.error, sawResult: this.sawResult }); }
  send() { return false; }
  interrupt() { return Promise.resolve(false); }
  endInput() { this.child?.stdin?.end(); }
  alive() { return !!this.child && !this.exited; }
  refreshTree() { if (this.alive()) this.leftovers = [...new Set([...this.leftovers, ...treeGroups(this.pid, processTable()).groups.filter((g) => g !== this.pgid)])]; }
  reap() { killGroups(this.leftovers, 'SIGKILL'); }
  kill() { if (this.pid) killTree(this.pid, this.lstart); this.reap(); }
  async stop() {
    if (!this.alive()) { this.reap(); return true; }
    this.refreshTree();
    const ended = new Promise((r) => { const t = setTimeout(() => { this.off('exit', done); r(false); }, this.stopGraceMs ?? 3000); const done = () => { clearTimeout(t); r(true); }; this.once('exit', done); });
    try { process.kill(this.pid, 'SIGTERM'); } catch { /* gone */ }
    if (!(await ended)) {
      this.kill();
      if (!this.exited) await new Promise((r) => {
        const done = () => { clearTimeout(t); r(); };
        const t = setTimeout(() => { this.off('exit', done); r(); }, 1000);
        this.once('exit', done);
      });
    }
    this.reap(); return !this.alive();
  }
}
