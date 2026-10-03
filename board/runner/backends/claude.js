// Claude CLI backend: spawn with the isolation profile, parse stream-json,
// stdin injection, control_request interrupt and the stop recipe (§6.7).
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { INTERRUPT_WAIT_MS, STOP_GRACE_MS } from '../../shared/liveness.js';
import { lstartOf, killTree, processTable, treeGroups, killGroups, isAlive, waitForStopped, STOP_VERIFY_MS } from '../procs.js';
import { buildArgv, userMessage, interruptRequest } from '../launch.js';
import { lineReader } from '../util.js';
import { detectCli } from './detect.js';
import path from 'node:path';

/**
 * Normalised events (design §3.2.2):
 *  init {session_id, tools, mcp_servers}
 *  tool_start {id, name, input} · tool_end {id, ok}
 *  assistant {text} · result {subtype, is_error, total_cost_usd, num_turns, terminal_reason, permission_denials, result}
 *  usage {inputTokens, outputTokens, costUsd} (with each result that reports usage)
 *  rate_limit {info} · control_response {request_id, subtype} · compact {} · exit {code, signal, sawResult}
 * A spend cap hit (--max-budget-usd) is a result with terminal_reason 'budget'.
 */
export class ClaudeBackend extends EventEmitter {
  static describe(platform = process.platform) {
    return {
      id: 'claude',
      label: 'Claude Code',
      startable: platform !== 'win32',
      ...(platform === 'win32' ? { reason: 'Claude managed tasks require a provider sandbox, which Claude does not support on native Windows.' } : {}),
      capabilities: {
        budget: 'native', budgetUnit: 'usd',      // --max-budget-usd
        resume: true, interrupt: true, structuredEvents: true,
        permissions: 'hooks',                     // PreToolUse gate + --permission-prompt-tool
        systemPrompt: true, model: true, maxTurns: true,
      },
    };
  }

  /** Signed in: an API key in the env, or the CLI's documented credentials file exists (macOS keeps it in the keychain: 'unknown'). */
  static async detect(opts = {}) {
    if ((opts.platform ?? process.platform) === 'win32') return { id: 'claude', installed: false, startable: false, signedIn: 'unknown', reason: 'unsupported_windows_sandbox', detail: 'Claude managed tasks require a provider sandbox. Native Windows is unsupported; external sessions remain visible.' };
    const d = await detectCli('claude', { ...opts, authFiles: (env) => (env.HOME ? [path.join(env.HOME, '.claude', '.credentials.json')] : []) });
    return d.installed && !d.reason && (opts.env ?? process.env).ANTHROPIC_API_KEY ? { ...d, signedIn: true } : d;
  }

  // budget {amount, unit:'usd'} (adapter contract §4) or the older budgetUsd; permissionMode defaults to the board profile.
  constructor({ bin, cwd, env, runDir, sessionId, budgetUsd, budget = null, maxTurns, systemPrompt, model, resume = false, log, boardHome = null,
    platform = process.platform, permissionMode = 'acceptEdits', extraDisallowed = [], interruptWaitMs = INTERRUPT_WAIT_MS, stopGraceMs = STOP_GRACE_MS }) {
    super();
    if (budgetUsd == null && budget?.unit === 'usd' && Number.isFinite(budget.amount)) budgetUsd = budget.amount;
    Object.assign(this, { bin, cwd, env, runDir, sessionId, budgetUsd, maxTurns, systemPrompt, model, resume, log, boardHome, platform, permissionMode, extraDisallowed, interruptWaitMs, stopGraceMs });
    this.child = null;
    this.pid = null;
    this.lstart = null;
    this.pgid = null;
    this.exited = false;
    this.exitInfo = null;
    this.sawResult = false;
    this.turnActive = false;
    this.stopping = false;
  }

  argv() {
    return buildArgv({ runDir: this.runDir, sessionId: this.sessionId, resume: this.resume, budgetUsd: this.budgetUsd,
      maxTurns: this.maxTurns, systemPrompt: this.systemPrompt, model: this.model, boardHome: this.boardHome,
      permissionMode: this.permissionMode, extraDisallowed: this.extraDisallowed });
  }

  start(firstPromptText) {
    if (this.platform === 'win32') throw Object.assign(new Error('Claude managed tasks require a provider sandbox, unavailable on native Windows. External sessions remain visible.'), { code: 'NOT_AVAILABLE' });
    const child = spawn(this.bin, this.argv(), { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); // privacy-flow: runner-claude
    this.child = child;
    this.pid = child.pid;
    this.lstart = lstartOf(child.pid);
    this.pgid = child.pid;   // detached ⇒ own session and process group
    this.attachChild(child);
    if (firstPromptText) this.send(firstPromptText);
    return this;
  }

  attachChild(child) {
    child.stdin.on('error', () => { /* EPIPE after exit */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', lineReader((l) => this.#onLine(l)));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => this.log?.debug('claude stderr', { text: String(d).slice(0, 500) }));
    child.on('error', (err) => {
      this.log?.error('claude spawn error', { err: err.message });
      if (!this.exited) this.#exit(null, null, err.message);
    });
    child.on('exit', (code, signal) => this.#exit(code, signal));
  }

  #exit(code, signal, error) {
    if (this.exited) return;
    this.exited = true;
    this.turnActive = false;
    this.exitInfo = { code, signal, error: error ?? null, sawResult: this.sawResult };
    this.emit('exit', this.exitInfo);
  }

  #onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.sessionId = m.session_id ?? this.sessionId;
          this.emit('init', { session_id: m.session_id, tools: m.tools ?? [], mcp_servers: m.mcp_servers ?? [], model: m.model });
        } else if (m.subtype === 'compact_boundary') this.emit('compact', {});
        break;
      case 'assistant': {
        this.turnActive = true;
        for (const c of m.message?.content ?? []) {
          if (c.type === 'tool_use') this.emit('tool_start', { id: c.id, name: c.name, input: c.input ?? {} });
          else if (c.type === 'text' && c.text) this.emit('assistant', { text: c.text });
        }
        break;
      }
      case 'user':
        if (m.isReplay) break;
        for (const c of Array.isArray(m.message?.content) ? m.message.content : []) {
          if (c.type === 'tool_result') this.emit('tool_end', { id: c.tool_use_id, ok: !c.is_error });
        }
        break;
      case 'result':
        this.sawResult = true;
        this.turnActive = false;
        if (m.usage && typeof m.usage === 'object') {
          const n = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
          this.emit('usage', { inputTokens: n(m.usage.input_tokens), outputTokens: n(m.usage.output_tokens), ...(Number.isFinite(m.total_cost_usd) ? { costUsd: m.total_cost_usd } : {}) });
        }
        this.emit('result', {
          subtype: m.subtype, is_error: !!m.is_error, total_cost_usd: m.total_cost_usd, num_turns: m.num_turns,
          terminal_reason: m.subtype === 'error_max_budget_usd' ? 'budget' : (m.terminal_reason ?? null), permission_denials: m.permission_denials ?? [], result: m.result ?? null,
          errors: m.errors ?? null,
        });
        break;
      case 'rate_limit_event':
        this.emit('rate_limit', { info: m.rate_limit_info ?? {} });
        break;
      case 'control_response':
        this.emit('control_response', { request_id: m.response?.request_id, subtype: m.response?.subtype });
        break;
      default:
        break;
    }
  }

  alive() {
    return !!this.child && !this.exited;
  }

  #write(s) {
    if (!this.alive() || this.child.stdin.destroyed || this.child.stdin.writableEnded) return false;
    this.child.stdin.write(s);
    return true;
  }

  send(text) {
    const ok = this.#write(userMessage(text));
    if (ok) this.turnActive = true;
    return ok;
  }

  // stream-json interrupt; SIGINT if no control_response within 2 s (D16).
  interrupt() {
    if (!this.alive()) return Promise.resolve(false);
    const id = `int-${crypto.randomUUID()}`;
    return new Promise((resolve) => {
      let done = false;
      const onResp = (r) => {
        if (r.request_id !== id || done) return;
        done = true; clearTimeout(t); this.off('control_response', onResp); resolve(true);
      };
      const t = setTimeout(() => {
        if (done) return;
        done = true; this.off('control_response', onResp);
        if (this.alive()) { try { process.kill(this.pid, 'SIGINT'); } catch { /* gone */ } }
        resolve(false);
      }, 2000);
      this.on('control_response', onResp);
      if (!this.#write(interruptRequest(id))) { clearTimeout(t); done = true; this.off('control_response', onResp); resolve(false); }
    });
  }

  endInput() {
    if (this.child && !this.child.stdin.writableEnded) { try { this.child.stdin.end(); } catch { /* closed */ } }
  }

  #waitExit(ms) {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.off('exit', on); resolve(false); }, ms);
      const on = () => { clearTimeout(t); resolve(true); };
      this.once('exit', on);
    });
  }

  #waitTurnEnd(ms) {
    if (!this.turnActive || this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v) => { clearTimeout(t); this.off('result', onR); this.off('exit', onR); resolve(v); };
      const onR = () => done(true);
      const t = setTimeout(() => done(false), ms);
      this.once('result', onR);
      this.once('exit', onR);
    });
  }

  /**
   * Stop recipe: interrupt → wait ≤ 5 s → end stdin → SIGTERM → after 10 s,
   * if pid + lstart still match, SIGKILL + kill every descendant pgid. Any
   * descendant group seen before SIGTERM that is still alive afterwards is
   * killed too (tool trees reparent to 1 and outlive claude, spike 5b).
   */
  async stop() {
    if (this.stopping) { await this.#waitExit(this.interruptWaitMs + this.stopGraceMs + 5000); return this.#confirmStopped(); }
    this.stopping = true;
    if (!this.alive()) { this.#reapLeftovers(); return this.#confirmStopped(); }
    if (this.turnActive) {
      await this.interrupt();
      await this.#waitTurnEnd(this.interruptWaitMs);
    }
    const before = treeGroups(this.pid, processTable());
    this.#leftovers = [...new Set([...this.#leftovers, ...before.groups.filter((g) => g !== this.pgid)])];
    this.endInput();
    try { process.kill(this.pid, 'SIGTERM'); } catch { /* gone */ }
    const exited = await this.#waitExit(this.stopGraceMs);
    if (!exited || (isAlive(this.pid) && lstartOf(this.pid) === this.lstart)) {
      killTree(this.pid, this.lstart);
      await this.#waitExit(2000);
    }
    this.#reapLeftovers();
    return this.#confirmStopped();
  }

  async #confirmStopped() {
    const observed = await waitForStopped({ pid: this.pid, groups: [...new Set([this.pgid, ...this.#leftovers].filter((g) => g != null))] }, { timeoutMs: STOP_VERIFY_MS });
    return observed && !this.alive();
  }

  #leftovers = [];

  // Remember the tool tree's process groups while claude is alive: after an
  // unexpected SIGKILL they reparent to 1 and can no longer be found.
  refreshTree() {
    if (!this.alive()) return;
    const groups = treeGroups(this.pid, processTable()).groups.filter((g) => g !== this.pgid);
    this.#leftovers = [...new Set([...this.#leftovers, ...groups])];
  }

  // After an unexpected exit: kill the tool trees that outlived claude.
  reap() {
    this.#reapLeftovers();
  }

  #reapLeftovers() {
    const alive = this.#leftovers.filter((g) => { try { process.kill(-g, 0); return true; } catch { return false; } });
    killGroups(alive, 'SIGKILL');
  }

  // Immediate hard kill (gate close escalation, orphan).
  kill() {
    if (!this.pid) return;
    killTree(this.pid, this.lstart);
  }
}
