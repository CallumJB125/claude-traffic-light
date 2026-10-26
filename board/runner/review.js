// The review run kind (CONTRACT "AI review before Review (066)"): one
// review.offer → one review.result. It needs no claim, lease, fence or
// worktree and never edits anything: it reads the finished run's commits
// from the member's own clone with the checkpoint git (src/checkpoint-git.js:
// no hooks, filters, textconv or external diff), removes secrets
// (src/scrub.js), bounds the diff, and runs the reviewer once with no tools
// in an empty temporary folder, the same isolation as src/diff-review.js.
// The same function runs on a hosted runner; only localPath and the CLI bins differ.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createRequire } from 'node:module';
import { buildReviewPrompt, boundDiff, diffPaths, injectionSignals, REVIEW_OUTPUT_MAX, REVIEW_PROVIDERS } from '../shared/review.js';
import { git as runnerGit } from './git.js';

const require = createRequire(import.meta.url);
const CheckpointGit = require('../../src/checkpoint-git.js');
const DiffReview = require('../../src/diff-review.js');
const Scrub = require('../../src/scrub.js');

export const REVIEW_RUN_TIMEOUT_MS = 120_000;
const MAX_RAW_DIFF = 8 << 20;
const ENV_KEYS = ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'TMPDIR', 'TZ', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'];
const SHELL_KEYS = ['HOME', 'PATH', 'LANG', 'TMPDIR'];
// The reviewer reads only the diff on stdin, so it gets no command tool at all (the same names the owned chat
// disables, src/codex-app-server.js): with no shell, nothing can read the CLI's env through /proc or ps.
export const REVIEW_NO_SHELL = Object.freeze(['shell_tool', 'unified_exec', 'unified_exec_tty', 'shell_snapshot', 'code_mode_host']);
const HEAD = /^(?:[0-9a-f]{40}|[A-Za-z0-9][A-Za-z0-9._/-]{0,199})$/;
const KEY = /^[A-Za-z][A-Za-z0-9]{0,15}-[0-9]{1,9}$/;
const okRef = (r) => typeof r === 'string' && HEAD.test(r) && !r.includes('..') && !r.endsWith('.lock');

/** Secrets out, the home folder as "~". File paths stay: findings must name them. */
export function scrubDiff(diff, { home = null } = {}) {
  let d = Scrub.redactSecretsPass(String(diff ?? ''));
  if (typeof home === 'string' && home.length > 1) d = d.split(home).join('~');
  return d;
}

/**
 * argv for a one-shot, tool-less review. Claude: src/diff-review.js's isolation
 * flags with JSON output (for the cost). Codex: read-only sandbox, no user
 * config, rules, MCP servers, hooks or web search.
 * UNVERIFIED against a real Codex CLI: the exec flags follow backends/codex.js;
 * --sandbox read-only is documented but not exercised here.
 * provider: the user's Codex provider (board/shared/codex-carry.cjs) → its -c values and model. Its key values
 * travel in the CLI env only, and the shell gets none of that env (inherit="none"): only HOME, PATH, LANG and
 * TMPDIR from env, so read-only git and rg still work.
 */
export function reviewArgs(ai, { model = null, budgetUsd = null, cwd, provider = null, env = {} } = {}) {
  if (ai === 'claude') return DiffReview.buildArgs({ model, maxBudgetUsd: budgetUsd }).map((a) => (a === 'text' ? 'json' : a));
  if (ai === 'codex') {
    return ['exec', '--json', '--ignore-user-config', '--ignore-rules', '--strict-config', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', cwd,
      ...['approval_policy="never"', 'web_search="disabled"', 'mcp_servers={}', 'project_doc_max_bytes=0', 'hooks={}', 'notify=[]',
        'features.apps=false', 'features.multi_agent=false', 'features.hooks=false', 'shell_environment_policy.inherit="none"',
        `shell_environment_policy.set={${SHELL_KEYS.filter((k) => env[k]).map((k) => `${k}=${JSON.stringify(env[k])}`).join(',')}}`,
        'include_apply_patch_tool=false',
        ...(provider?.overrides ?? []), ...(provider?.model ? [`model=${JSON.stringify(provider.model)}`] : [])].flatMap((c) => ['-c', c]),
      ...REVIEW_NO_SHELL.flatMap((f) => ['--disable', f]), '-'];
  }
  throw Object.assign(new Error(`${ai} cannot run reviews`), { code: 'NOT_AVAILABLE' });
}

/** The CLI's stdout → {text, cost_usd}. */
export function readReply(ai, stdout) {
  const out = String(stdout ?? '');
  if (ai === 'claude') {
    try {
      const j = JSON.parse(out);
      return { text: typeof j.result === 'string' ? j.result : '', cost_usd: Number.isFinite(j.total_cost_usd) ? j.total_cost_usd : null, error: j.is_error ? String(j.subtype ?? 'error') : null };
    } catch { return { text: out, cost_usd: null, error: null }; }
  }
  let last = '';
  for (const line of out.split('\n')) {
    try {
      const ev = JSON.parse(line);
      const item = ev?.item ?? ev?.msg;
      if ((ev?.type === 'item.completed' && item?.type === 'agent_message') || item?.type === 'agent_message') last = String(item.text ?? item.message ?? last);
    } catch { /* not an event */ }
  }
  return { text: last, cost_usd: null, error: null };
}

/** Starts the reviewer CLI with the prompt on stdin. Never throws. */
export async function invokeReviewer({ ai, prompt, model, budgetUsd, bin, env = process.env, provider = null, spawn = childProcess.spawn, timeoutMs = REVIEW_RUN_TIMEOUT_MS }) {
  if (!bin) return { ok: false, error: `${ai} is not installed on this machine` };
  const childEnv = { ...Object.fromEntries(ENV_KEYS.filter((k) => env[k]).map((k) => [k, env[k]])), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...(ai === 'codex' ? provider?.env : null) };
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-board-review-')); } catch { return { ok: false, error: 'could not make a temporary folder' }; }
  try {
    const args = reviewArgs(ai, { model, budgetUsd, cwd: dir, provider: ai === 'codex' ? provider : null, env: childEnv });
    return await new Promise((resolve) => {
      let out = '', done = false, timer = null, child;
      const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
      try {
        child = spawn(bin, args, { cwd: dir, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); // privacy-flow: board-ai-review
      } catch { return finish({ ok: false, error: `${ai} could not start` }); }
      timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ ok: false, error: 'the reviewer took too long' }); }, timeoutMs);
      child.on('error', () => finish({ ok: false, error: `${ai} could not start` }));
      child.stdout.on('data', (d) => { if (out.length < REVIEW_OUTPUT_MAX * 4) out += d; });
      child.on('close', (code) => {
        const r = readReply(ai, out);
        if (code !== 0 && !r.text) return finish({ ok: false, error: r.error ? `the reviewer stopped: ${r.error}` : `the reviewer exited with code ${code}`, cost_usd: r.cost_usd });
        finish(r.text.trim() ? { ok: true, text: r.text.slice(0, REVIEW_OUTPUT_MAX), cost_usd: r.cost_usd } : { ok: false, error: 'the reviewer gave no reply', cost_usd: r.cost_usd });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function resolveHead(git, top, heads) {
  for (const h of heads) {
    if (!okRef(h)) continue;
    try { return (await git.run(top, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${h}^{commit}`], { timeoutMs: 10_000 })).trim(); } catch { /* next */ }
  }
  return null;
}

async function mergeBase(git, top, base, head) {
  for (const b of [`origin/${base}`, base]) {
    if (!okRef(b)) continue;
    try { return (await git.run(top, ['merge-base', '--end-of-options', b, head], { timeoutMs: 10_000 })).trim(); } catch { /* next */ }
  }
  return null;
}

// The run's snapshot refs, as createWorktree fetches them for a resumed run.
const fetchBoardRefs = (localPath, key) => runnerGit(localPath, ['fetch', '--quiet', 'origin', `+refs/board/${key}/*:refs/board/${key}/*`], { timeoutMs: 60_000 });

/**
 * offer: a review.offer frame. → the review.result body
 * {ok, output?, cost_usd?, files?, signals?, truncated?, model?, error?}. Never throws.
 */
export async function runReview(offer, { localPath, home = null, bin, env = process.env, provider = null, git = CheckpointGit.createGit(), fetchRefs = fetchBoardRefs, invoke = invokeReviewer, nonce = crypto.randomBytes(16).toString('hex') } = {}) {
  const fail = (error) => ({ ok: false, error: String(error).slice(0, 300) });
  try {
    if (!REVIEW_PROVIDERS.includes(offer.ai)) return fail(`${offer.ai} cannot run reviews`);
    const repo = await git.repoOf(localPath);
    if (repo.skip) return fail(repo.skip === 'filters' ? 'this repository defines git filters, so it is not read for reviews' : 'the repository is not available on this machine');
    let head = await resolveHead(git, repo.top, offer.heads ?? []);
    if (!head && KEY.test(offer.key ?? '')) {
      try { await fetchRefs(localPath, offer.key); } catch { /* offline: fall through */ }
      head = await resolveHead(git, repo.top, offer.heads ?? []);
    }
    if (!head) return fail('the finished run\'s commits are not on this machine');
    const base = await mergeBase(git, repo.top, offer.base_ref, head);
    if (!base) return fail(`no common history with ${offer.base_ref}`);
    const raw = await git.diffText(repo.top, base, head, null, MAX_RAW_DIFF);
    if (!raw.trim()) return { ok: true, output: JSON.stringify({ verdict: 'needs_human', summary: 'The run changed no files, so there was nothing to review.', findings: [] }), cost_usd: null, files: [], signals: [], truncated: false, model: null };
    const scrubbed = scrubDiff(raw, { home });
    const files = diffPaths(scrubbed);
    const signals = injectionSignals(scrubbed).map(({ file, line }) => ({ file, line }));
    const { text, truncated } = boundDiff(scrubbed);
    const prompt = buildReviewPrompt({ diff: text, goal: offer.goal, acceptance: offer.acceptance, tests: offer.tests, files, truncated, nonce });
    const r = await invoke({ ai: offer.ai, prompt, model: offer.model ?? null, budgetUsd: offer.budget_usd ?? null, bin, env, provider });
    if (!r.ok) return { ...fail(r.error ?? 'the review did not finish'), ...(Number.isFinite(r.cost_usd) ? { cost_usd: r.cost_usd } : {}) };
    return { ok: true, output: String(r.text).slice(0, REVIEW_OUTPUT_MAX), cost_usd: Number.isFinite(r.cost_usd) ? r.cost_usd : null, files, signals, truncated, model: offer.model ?? null };
  } catch (e) {
    return fail(e?.code === 'ETIMEDOUT' ? 'git did not finish' : `the review could not run: ${String(e?.message ?? e).split('\n')[0]}`);
  }
}
