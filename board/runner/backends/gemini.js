// Gemini CLI adapter (headless `gemini --output-format stream-json`). One turn
// per process, prompt on stdin, later messages by --resume, like Codex/Hermes.
//
// Gemini CLI has no OS sandbox we can configure, and unattended tool calls
// need its auto-approve mode, so it follows Hermes: the hub dispatches it only
// to the dispatcher's own machine (AI_CAPABILITIES.ownMachineOnly) and the
// runner ignores any other offer. Isolation is configuration only: a per-run
// GEMINI_CLI_HOME whose generated settings.json holds the per-run board MCP
// server; the member's own settings, GEMINI.md, extensions and history are
// never loaded. Plexiform stores no key: auth is the member's own OAuth login
// (oauth_creds.json, linked not copied so a token refresh reaches their file).
//
// UNVERIFIED against a real Gemini CLI (none was installed when written): the
// flags below, the GEMINI_CLI_HOME variable, the settings.json keys and the
// stream-json event shapes come from the CLI's documented headless mode. Every
// CLI-specific literal is in the constants here so a mismatch is a one-line fix.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process'; // privacy-flow: runner-gemini
import { detectCli } from './detect.js';
import { CodexBackend, NotAvailableError } from './codex.js';
import { lstartOf } from '../procs.js';
import { writeFileAtomic } from '../util.js';
import { CODEX_MCP_SERVER, underElectron } from '../launch.js';
import { CODEX_BOARD_TOOLS } from '../../mcp/codex-run.js';

const GEMINI_OUTPUT_ARGS = Object.freeze(['--output-format', 'stream-json']);
const GEMINI_APPROVAL_ARGS = Object.freeze(['--approval-mode', 'yolo']);
const GEMINI_RESUME_FLAG = '--resume';
const GEMINI_HOME_ENV = 'GEMINI_CLI_HOME';
const GEMINI_MIN_VERSION = Object.freeze([0, 11]);   // first release with stream-json output
const GEMINI_CREDENTIAL_FILES = Object.freeze(['oauth_creds.json', 'google_accounts.json']);
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WRITE_TOOLS = new Set(['write_file', 'replace']);

const realGeminiDir = (env) => env[GEMINI_HOME_ENV] ? path.join(env[GEMINI_HOME_ENV], '.gemini') : env.HOME ? path.join(env.HOME, '.gemini') : null;

/** Generated per-run settings.json. */
export function geminiSettings({ boardRunDir = null }) {
  return {
    security: { auth: { selectedType: 'oauth-personal' } },
    privacy: { usageStatisticsEnabled: false },
    ...(boardRunDir ? { mcpServers: { board: {
      command: process.execPath, args: [CODEX_MCP_SERVER, boardRunDir],
      env: underElectron() ? { ELECTRON_RUN_AS_NODE: '1' } : {},
      includeTools: [...CODEX_BOARD_TOOLS], trust: true, timeout: 60000,
    } } } : {}),
  };
}

export class GeminiBackend extends CodexBackend {
  static cli = 'gemini';
  static describe() {
    return { id: 'gemini', label: 'Gemini', startable: process.platform !== 'win32',
      capabilities: { budget: 'none', budgetUnit: null, resume: true, interrupt: false, structuredEvents: true,
        permissions: 'none', systemPrompt: true, model: true, maxTurns: false } };
  }
  static async detect(opts = {}) {
    const d = await detectCli('gemini', { ...opts, authFiles: (e) => [realGeminiDir(e) && path.join(realGeminiDir(e), 'oauth_creds.json')].filter(Boolean) });
    const v = /^(\d+)\.(\d+)\./.exec(d.version ?? '');
    const old = v && (Number(v[1]) < GEMINI_MIN_VERSION[0] || (Number(v[1]) === GEMINI_MIN_VERSION[0] && Number(v[2]) < GEMINI_MIN_VERSION[1]));
    return { ...d, id: this.describe().id, ...(d.installed && (!d.version || old) ? { startable: false, ...(old ? { reason: 'unsupported_version' } : {}) } : {}) };
  }
  argv() {
    return [...GEMINI_OUTPUT_ARGS, ...GEMINI_APPROVAL_ARGS, ...(this.model ? ['--model', this.model] : []),
      ...(this.resume ? [GEMINI_RESUME_FLAG, this.sessionId] : [])];
  }
  start(prompt) {
    if (this.platform === 'win32') throw new NotAvailableError('Gemini runs are not available on Windows');
    if (this.budget?.amount != null || this.budgetUsd != null) throw new NotAvailableError('Gemini does not offer a native spend cap');
    if (this.maxTurns != null) throw new NotAvailableError('Gemini does not offer a native max-turn cap');
    if (this.permissionMode === 'default' || this.permissionMode === 'plan') throw new NotAvailableError('Gemini has no sandbox for plan-only or interactively approved runs');
    if (this.resume && !SESSION.test(this.sessionId ?? '')) throw new NotAvailableError('Gemini resume requires the task session id');
    this.exited = false; this.sawResult = false; this.turnActive = true;
    return this.launch(prompt);
  }
  launch(prompt) {
    try {
      const home = path.join(this.runDir, 'gemini-home');
      const dir = path.join(home, '.gemini');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const real = realGeminiDir(this.env);
      for (const f of GEMINI_CREDENTIAL_FILES) {
        const src = real && path.join(real, f); const dst = path.join(dir, f);
        if (src && fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst);
      }
      writeFileAtomic(path.join(dir, 'settings.json'), `${JSON.stringify(geminiSettings({ boardRunDir: this.boardRunDir }), null, 2)}\n`);
      const env = { ...this.env, [GEMINI_HOME_ENV]: home };
      delete env.GEMINI_SYSTEM_MD;
      const child = spawn(this.bin, this.argv(), { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); // privacy-flow: runner-gemini
      this.child = child; this.pid = child.pid; this.pgid = child.pid; this.lstart = lstartOf(child.pid);
      this.attachChild(child);
      if (!child.pid) throw new NotAvailableError('Gemini could not start');
      // No system-prompt flag exists that keeps the CLI's own tool instructions, so the brief leads the prompt.
      child.stdin.end([this.systemPrompt, String(prompt ?? '')].filter(Boolean).join('\n\n'));
      return this;
    } catch (e) {
      this.exited = true; this.turnActive = false;
      throw e instanceof NotAvailableError ? e : new NotAvailableError('Gemini could not start');
    }
  }
  flushText() {
    if (!this.pendingText) return;
    this.lastText = this.pendingText; this.pendingText = '';
    this.emit('assistant', { text: this.lastText });
  }
  toolOf(name, input) {
    if (name === 'run_shell_command') return { name: 'Bash', input: { command: String(input?.command ?? '') } };
    if (WRITE_TOOLS.has(name)) return { name: 'Write', input: { file_path: input?.file_path } };
    return { name: String(name ?? 'unknown').slice(0, 100), input: input && typeof input === 'object' ? input : {} };
  }
  onEvent(e) {
    this.openTools ??= new Map(); this.toolSeq ??= 0;
    if (e.type === 'init') {
      this.turnActive = true;
      if (SESSION.test(e.session_id ?? '') && this.sessionId !== e.session_id) { this.sessionId = e.session_id; this.emit('init', { session_id: e.session_id, tools: [], mcp_servers: [] }); }
    } else if (e.type === 'message' && e.role === 'assistant' && typeof e.content === 'string') {
      this.pendingText = (this.pendingText ?? '') + e.content;
    } else if (e.type === 'tool_use') {
      this.flushText();
      const t = this.toolOf(e.tool_name, e.parameters);
      const id = typeof e.tool_id === 'string' && e.tool_id ? e.tool_id : `gemini:${++this.toolSeq}`;
      this.openTools.set(id, t);
      this.emit('tool_start', { id, name: t.name, input: t.input });
    } else if (e.type === 'tool_result') {
      const t = this.openTools.get(e.tool_id);
      if (!t) return;
      this.openTools.delete(e.tool_id);
      this.emit('tool_end', { id: e.tool_id, ok: e.status === 'success', input: t.input, output: String(e.output ?? e.error?.message ?? '').slice(-16000) });
    } else if (e.type === 'error' && e.severity === 'error') {
      this.lastError = String(e.message ?? '').slice(0, 4000);
    } else if (e.type === 'result') {
      this.flushText();
      this.turnActive = false; this.sawResult = true;
      this.emit('usage', { inputTokens: e.stats?.input_tokens ?? 0, outputTokens: e.stats?.output_tokens ?? 0, costUsd: null });
      this.emit('result', e.status === 'success'
        ? { subtype: 'success', is_error: false, result: this.lastText, total_cost_usd: null, num_turns: 1, terminal_reason: null }
        : { subtype: 'error', is_error: true, result: String(e.error?.message ?? this.lastError ?? 'Gemini turn failed').slice(0, 4000), total_cost_usd: null, num_turns: 1 });
    }
  }
  exit(code, signal) {
    if (this.exited) return;
    this.exited = true; this.turnActive = false;
    this.emit('exit', { code, signal, error: this.error ? 'Gemini could not start' : null, sawResult: this.sawResult });
  }
}
