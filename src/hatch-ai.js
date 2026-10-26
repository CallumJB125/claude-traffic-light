// Hatch's "Describe it": the user's own Claude Code CLI (`claude -p`, their
// login and quota) is asked for a character, after a one-time consent. Each try
// runs hidden in an empty temporary folder with no tools, settings, MCP servers,
// slash commands or session file, a minimal environment and --max-budget-usd.
// The reply is only parsed and validated by characters/hatch.js; a character
// that fails the checks is never shown or kept.
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Hatch = require('../characters/hatch.js');
const { NONE, prepareNoTool, carryFor } = require('./claude-carry');

const TOOL = Object.freeze({ id: 'claude', label: 'Claude Code' });
const MODEL = 'sonnet';
const ATTEMPT_BUDGET_USD = 0.25;
const TOTAL_BUDGET_USD = 0.5;
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 120_000;
const MAX_OUT = Hatch.LIMITS.aiBytes * 2;
const ENV_KEYS = ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'TMPDIR', 'TZ', 'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'];

function availability({ bin, tools = [] } = {}) {
  if (bin) return { ai: true, tool: TOOL.id, label: TOOL.label };
  const row = (tools || []).find((t) => t && t.id === TOOL.id);
  const reason = row && row.installed
    ? 'Describing a character runs Claude Code, but its claude program was not found in ~/.local/bin, /opt/homebrew/bin or /usr/local/bin. Reinstall Claude Code, or pick a look below.'
    : 'Describing a character needs an AI: install Claude Code (the claude command) to use it, or pick a look below.';
  return { ai: false, reason };
}

function consentDialog() {
  return {
    type: 'question', buttons: ['Cancel', `Send to ${TOOL.label}`], defaultId: 0, cancelId: 0, noLink: true,
    message: `Send your description to ${TOOL.label}?`,
    detail: [
      `Plexiform will run ${TOOL.label} (the claude program on this computer) in the background to draw your character.`,
      'Your description, the name and the look you picked are sent to it, and Claude Code sends them to Anthropic under your Claude account and quota.',
      `It runs with no tools, in an empty temporary folder, for at most ${MAX_ATTEMPTS} tries capped at ${Math.round(TOTAL_BUDGET_USD * 100)} US cents in total.`,
      'Only a character that passes Plexiform\'s checks is shown, and nothing is saved until you press Save.',
      'You are asked this once.',
    ].join('\n\n'),
  };
}

function buildArgs(system, model = MODEL) {
  return ['-p', '--output-format', 'json', '--no-session-persistence',
    '--setting-sources', '', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands',
    '--tools', '', '--permission-mode', 'dontAsk',
    '--model', model, '--max-budget-usd', String(ATTEMPT_BUDGET_USD), '--system-prompt', system];
}

function userMessage(request, errors) {
  if (!errors || !errors.length) return request.user;
  const list = errors.slice(0, 8).map((e) => `- ${e.path || 'character'}: ${e.message}`).join('\n');
  return `${request.user}\n\nYour last reply was rejected for these reasons. Reply with a corrected JSON object only:\n${list}`;
}

const fatal = (message) => Object.assign(new Error(message), { fatal: true });

// generate() for Hatch.runHatch: → { text, costUsd }. Any failure to get an answer stops the run.
function makeGenerate({ bin, env = process.env, spawn = childProcess.spawn, timeoutMs = TIMEOUT_MS, carry = carryFor(env) }) {
  return async function generate({ request, errors, signal }) {
    // The user's own provider and auth (a no-tool child may hold a key in its env).
    const c = carry ? await prepareNoTool(carry) : NONE;
    if (c.failure) throw fatal(`${TOOL.label} is not set up: ${c.failure.reason}`);
    const childEnv = { ...Object.fromEntries(ENV_KEYS.filter((k) => env[k]).map((k) => [k, env[k]])), ...c.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    let dir;
    try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-hatch-')); } catch { throw fatal('could not make a temporary folder'); }
    try {
      return await new Promise((resolve, reject) => {
        let out = '';
        let done = false;
        let timer = null;
        let child;
        const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); fn(v); };
        const kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
        const onAbort = () => { kill(); finish(reject, fatal('stopped')); };
        try {
          child = spawn(bin, buildArgs(request.system), { cwd: dir, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); // privacy-flow: hatch-describe
        } catch (e) { finish(reject, fatal(`could not start ${TOOL.label} (${e.message})`)); return; }
        timer = setTimeout(() => { kill(); finish(reject, fatal(`${TOOL.label} took longer than ${Math.round(timeoutMs / 1000)} seconds`)); }, timeoutMs);
        signal?.addEventListener?.('abort', onAbort, { once: true });
        child.on('error', (e) => finish(reject, fatal(`could not start ${TOOL.label} (${e.message})`)));
        child.stdout.on('data', (d) => { if (out.length < MAX_OUT) out += d; });
        child.on('close', (code) => {
          let reply = null;
          try { reply = JSON.parse(out); } catch { /* not an envelope */ }
          if (!reply || typeof reply !== 'object') return finish(reject, fatal(code === 0 ? `${TOOL.label} gave no answer` : `${TOOL.label} stopped (exit ${code})`));
          if (reply.is_error) return finish(reject, fatal(String(reply.result || reply.subtype || `${TOOL.label} reported an error`).slice(0, 160)));
          finish(resolve, { text: String(reply.result == null ? '' : reply.result), costUsd: Number(reply.total_cost_usd) || 0 });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(userMessage(request, errors));
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

// → { ok: true, character, params } | { ok: false, error }. Never throws.
async function describe({ params, bin, consented, askConsent, env, spawn, timeoutMs, signal, carry }) {
  if (!bin) return { ok: false, error: availability({ bin }).reason };
  const p = Hatch.normalizeParams(params);
  if (!p.description) return { ok: false, error: 'Write a short description first.' };
  if (!consented()) {
    let yes = false;
    try { yes = await askConsent(consentDialog()); } catch { yes = false; }
    if (!yes) return { ok: false, error: 'Not sent. Nothing left this computer.' };
  }
  let r;
  try {
    r = await Hatch.runHatch({ params: p, generate: makeGenerate({ bin, env, spawn, timeoutMs, ...(carry !== undefined ? { carry } : {}) }), maxAttempts: MAX_ATTEMPTS, maxCostUsd: TOTAL_BUDGET_USD, signal });
  } catch (e) { return { ok: false, error: `Could not hatch it: ${e.message}` }; }
  if (r.ok && r.source === 'ai') return { ok: true, character: r.character, params: r.params };
  if (r.source === 'cancelled') return { ok: false, error: 'Stopped.' };
  const last = (r.lastErrors || [])[0];
  const why = last ? ` Last problem: ${last.replace(/^character: /, '').replace(/\.$/, '')}.` : '';
  const head = r.reason === 'budget'
    ? `${TOOL.label} reached the ${Math.round(TOTAL_BUDGET_USD * 100)}-cent cap without a character that passed the checks, so nothing was kept.`
    : `${TOOL.label} did not make a character that passed the checks, so nothing was kept.`;
  return { ok: false, error: head + why };
}

module.exports = { availability, consentDialog, buildArgs, userMessage, makeGenerate, describe, TOOL, MODEL, ATTEMPT_BUDGET_USD, TOTAL_BUDGET_USD, MAX_ATTEMPTS };
