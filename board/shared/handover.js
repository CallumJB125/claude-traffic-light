// Handover doc (design §7): three layers, none written at death.
//   card      goal, done_means                          (humans; never agent-writable)
//   facts     files touched, branch/commits, commands, TodoWrite plan (supervisor)
//   narrative plan, done, hypothesis, dead_ends, next, questions (board_write_handover)
//   snapshot  sha, ref, status pushed|push_failed|held    (supervisor, §7.2)
//   salvage   append-only (fenced runs / post-mortem)
// Every layer carries the HUB receive time of its last sync (`*_at_ms`, hub
// clock), so "last synced Ns ago" is computed on one clock.
//
// Browser-safe, dependency-free.

import { formatAge } from './liveness.js';
import { branchName, snapshotRef } from './fence.js';

export const SECTIONS = Object.freeze([
  ['goal', 'Goal'],
  ['done_means', 'Done means'],
  ['plan', 'Plan'],
  ['done', 'Done so far'],
  ['hypothesis', 'Current hypothesis'],
  ['dead_ends', 'Dead ends / ruled out'],
  ['files_touched', 'Files touched'],
  ['branch', 'Branch, commits, snapshot'],
  ['commands', 'Last commands & tests'],
  ['next', 'Next step'],
  ['questions', 'Open questions / blocked on'],
  ['salvage', 'Salvage'],
  ['how_to_take_over', 'How to take over'],
]);

// board_write_handover may patch only these.
export const AGENT_WRITABLE = Object.freeze(['plan', 'done', 'hypothesis', 'dead_ends', 'next', 'questions']);
export const HUMAN_WRITABLE = Object.freeze(['goal', 'done_means', ...AGENT_WRITABLE]);
export const WRITTEN_BY = Object.freeze(['claude', 'human', 'postmortem', 'system']);

export const LIMITS = Object.freeze({ section_chars: 4000, done_entries: 50, done_entry_chars: 500, plan_items: 50, files: 200, commands: 10, tail_lines: 20 });

export function emptyNarrative() {
  return { plan: null, done: [], hypothesis: null, dead_ends: null, next: null, questions: null, at_ms: null, version: 0, written_by: null };
}

function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// plan: string (markdown) or [{text, status: todo|doing|done|skipped}]
function normPlan(v) {
  if (v == null) return null;
  if (typeof v === 'string') return clip(v, LIMITS.section_chars);
  if (!Array.isArray(v)) throw new TypeError('plan must be a string or an array');
  return v.slice(0, LIMITS.plan_items).map((i) => ({ text: clip(i.text, 300), status: ['todo', 'doing', 'done', 'skipped'].includes(i.status) ? i.status : 'todo' }));
}

/**
 * Apply one board_write_handover patch. Semantics (decision D9):
 *  - `done` PREPENDS its entries (string or string[]) newest-first, capped;
 *  - every other section REPLACES; null clears.
 * Throws {code:'VALIDATION'} on a non-writable section.
 */
export function applyPatch(narrative, patch, { written_by = 'claude', at_ms, writable = AGENT_WRITABLE } = {}) {
  if (!patch || typeof patch !== 'object') throw Object.assign(new TypeError('patch must be an object'), { code: 'VALIDATION' });
  const bad = Object.keys(patch).filter((k) => !writable.includes(k));
  if (bad.length) throw Object.assign(new TypeError(`not writable: ${bad.join(', ')}`), { code: 'VALIDATION' });
  if (!WRITTEN_BY.includes(written_by)) throw Object.assign(new TypeError(`bad written_by ${written_by}`), { code: 'VALIDATION' });
  const n = { ...(narrative ?? emptyNarrative()) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'done') {
      const entries = (Array.isArray(v) ? v : [v]).filter((e) => e != null && String(e).trim()).map((e) => clip(e, LIMITS.done_entry_chars));
      n.done = [...entries, ...(n.done ?? [])].slice(0, LIMITS.done_entries);
    } else if (k === 'plan') n.plan = normPlan(v);
    else n[k] = v == null ? null : clip(v, LIMITS.section_chars);
  }
  n.version = (n.version ?? 0) + 1;
  n.written_by = written_by;
  n.at_ms = at_ms ?? n.at_ms;
  return n;
}

/**
 * Merge the layers into one doc model.
 * input:
 *   card      {key, title, goal, done_means, repo_id}
 *   run       {n (fence), run_state, agent_label, fence, base_ref, base_sha} | null
 *   facts     {at_ms, files_touched:[{path, op: 'edit'|'write'|'read'|'delete', at_ms}],
 *              branch, head_sha, commits_ahead, commands:[{cmd, exit, duration_ms, tail}],
 *              plan:[{text,status}], plan_at_ms} | null
 *   narrative from applyPatch | null
 *   snapshot  {sha, ref, status: 'pushed'|'push_failed'|'held', reason?, at_ms} | null
 *   salvage   [{at_ms, run_n, text, ref?}]
 */
export function mergeHandover({ card, run = null, facts = null, narrative = null, snapshot = null, salvage = [] }) {
  const nar = narrative ?? emptyNarrative();
  // The newer of the agent's own plan and the TodoWrite mirror wins.
  const factPlan = facts?.plan?.length ? facts.plan : null;
  const plan = nar.plan != null && (factPlan == null || (nar.at_ms ?? 0) >= (facts?.plan_at_ms ?? 0)) ? nar.plan : factPlan;
  const unsynced = snapshot?.at_ms != null
    ? (facts?.files_touched ?? []).filter((f) => f.op !== 'read' && f.at_ms != null && f.at_ms > snapshot.at_ms).map((f) => f.path)
    : [];
  return {
    card,
    run,
    layers: {
      facts: { at_ms: facts?.at_ms ?? null },
      narrative: { at_ms: nar.at_ms ?? null, version: nar.version ?? 0, written_by: nar.written_by ?? null },
      snapshot: snapshot ? { ...snapshot } : null,
    },
    unsynced_paths: [...new Set(unsynced)],
    sections: {
      goal: card?.goal ?? card?.title ?? null,
      done_means: card?.done_means ?? null,
      plan,
      done: nar.done ?? [],
      hypothesis: nar.hypothesis ?? null,
      dead_ends: nar.dead_ends ?? null,
      files_touched: (facts?.files_touched ?? []).slice(-LIMITS.files),
      branch: facts ? { branch: facts.branch ?? null, head_sha: facts.head_sha ?? null, commits_ahead: facts.commits_ahead ?? null } : null,
      commands: (facts?.commands ?? []).slice(-LIMITS.commands),
      next: nar.next ?? null,
      questions: nar.questions ?? null,
      salvage: [...salvage],
    },
  };
}

/** Per-layer "last synced" ages on the hub clock. */
export function syncAges(doc, now_ms) {
  const age = (t) => (t == null ? null : Math.max(0, now_ms - t));
  return {
    facts_ms: age(doc.layers.facts.at_ms),
    narrative_ms: age(doc.layers.narrative.at_ms),
    snapshot_ms: age(doc.layers.snapshot?.at_ms),
  };
}

function snapshotText(s, ageMs) {
  if (!s) return 'code none';
  const status = s.status === 'held' ? `held: ${s.reason ?? 'possible secret'}` : s.status;
  return `code ${s.sha ? String(s.sha).slice(0, 7) : '?'} ${formatAge(ageMs)} ago (${status})`;
}

const planMark = { done: 'x', doing: '~', skipped: '-', todo: ' ' };

/** Render to markdown (§7.4 template). `now_ms` on the hub clock. */
export function renderMarkdown(doc, { now_ms }) {
  const a = syncAges(doc, now_ms);
  const c = doc.card ?? {};
  const r = doc.run;
  const s = doc.sections;
  const ago = (ms) => (ms == null ? 'never' : `${formatAge(ms)} ago`);
  const out = [];
  out.push(`# Handover · ${c.key ?? '?'} ${c.title ?? ''}`.trimEnd());
  out.push(`State: ${r?.run_state ?? 'no run'}${r ? ` · run r${r.fence} (fence ${r.fence}) · ${r.agent_label ?? 'agent'}` : ''} · repo ${c.repo_id ?? '?'}`);
  out.push(`Last synced: facts ${ago(a.facts_ms)} · narrative ${ago(a.narrative_ms)} · ${snapshotText(doc.layers.snapshot, a.snapshot_ms)}${doc.unsynced_paths.length ? `; ${doc.unsynced_paths.length} file(s) modified after that are NOT synced` : ''}`);
  const sec = (title, body) => { out.push('', `## ${title}`); out.push(body == null || body === '' ? '(none)' : body); };
  sec('Goal', s.goal);
  sec('Done means', s.done_means);
  sec('Plan', Array.isArray(s.plan) ? s.plan.map((i) => `- [${planMark[i.status] ?? ' '}] ${i.text}`).join('\n') : s.plan);
  sec('Done so far', s.done.map((d) => `- ${d}`).join('\n'));
  sec('Current hypothesis', s.hypothesis);
  sec('Dead ends / ruled out', s.dead_ends);
  sec('Files touched', s.files_touched.map((f) => `- ${f.path} · ${f.op}${f.at_ms != null && doc.unsynced_paths.includes(f.path) ? ' (after last snapshot)' : ''}`).join('\n'));
  sec('Branch, commits, snapshot', s.branch || doc.layers.snapshot
    ? `branch ${s.branch?.branch ?? '?'}${r?.base_ref ? ` · base ${r.base_ref}${r.base_sha ? `@${String(r.base_sha).slice(0, 7)}` : ''}` : ''}${s.branch?.commits_ahead != null ? ` · ${s.branch.commits_ahead} commit(s) ahead` : ''}${doc.layers.snapshot?.sha ? ` · snapshot ${String(doc.layers.snapshot.sha).slice(0, 7)} (${doc.layers.snapshot.ref ?? '?'})` : ''}`
    : null);
  sec('Last commands & tests', s.commands.map((x) => `- \`${x.cmd}\` · exit ${x.exit ?? '?'}${x.duration_ms != null ? ` · ${(x.duration_ms / 1000).toFixed(1)} s` : ''}${x.tail ? `\n  ${String(x.tail).split('\n').slice(-LIMITS.tail_lines).join('\n  ')}` : ''}`).join('\n'));
  sec('Next step', s.next);
  sec('Open questions / blocked on', s.questions);
  sec('Salvage', s.salvage.map((x) => `- r${x.run_n ?? '?'}: ${x.text}${x.ref ? ` (${x.ref})` : ''}`).join('\n'));
  sec('How to take over', howToTakeOver(doc));
  return `${out.join('\n')}\n`;
}

/** Generated "How to take over" (Phase 1: fresh seeded session only, §7.6). */
export function howToTakeOver(doc) {
  const c = doc.card ?? {};
  const r = doc.run;
  if (!r) return 'Give to Claude to start a run.';
  const next = r.fence + 1;
  const snap = doc.layers.snapshot;
  const from = snap?.status === 'pushed' && snap.sha
    ? `from snapshot ${String(snap.sha).slice(0, 7)} at ${snapshotRef(c.key, r.fence)} (git fetch origin 'refs/board/${c.key}/*:refs/board/${c.key}/*')`
    : `from branch ${branchName(c.key, r.fence)} (no pushed snapshot)`;
  const lines = [`- Fresh: new run r${next} on ${branchName(c.key, next)} ${from}.`];
  if (doc.unsynced_paths.length) lines.push(`- Redo the ${doc.unsynced_paths.length} unsynced edit(s): ${doc.unsynced_paths.join(', ')}.`);
  if (doc.sections.next) lines.push('- Start from "Next step" above.');
  return lines.join('\n');
}

/** The `handoff` memory auto-written on every handoff (§3.12 #8), ≤ 1200 chars. */
export function handoffMemoryText({ from_n, to_n = null, taker = null, provenance = null, hypothesis = null, next = null }) {
  const head = `r${from_n} → ${to_n != null ? `r${to_n}` : 'next'}: ${taker ? `${taker} took over` : 'handed over'}${provenance ? ` (${provenance.replace(/_/g, ' ')})` : ''}`;
  const parts = [head];
  if (hypothesis) parts.push(`hypothesis ${hypothesis}`);
  if (next) parts.push(`next ${next}`);
  return clip(parts.join('; '), 1200);
}
