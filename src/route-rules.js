'use strict';
// The task router (plan-orchestrator §3, O1): which AI runs a task, and one
// line saying why. A pure function of what it is given: no files, no clock
// unless the caller leaves `now` out, no model call. The Tasks engine
// (board/tasks-engine/engine.js) gathers the inputs and records the reason on
// task.ai.reason.
//
// Order, first match wins, after the hard filters drop what can't run it:
//   1. the person's explicit choice (the Who chip, `--with`)
//   2. the repo's preferred AI
//   3. the person's rules ("Codex for *.py refactors")
//   4. the configured default AI, unless every window is known and its own is nearly used
//   5. the most usage-window headroom, only when every window is known
//   6. usage data incomplete → the usual pick (the first usable AI), never a guess
// Every window known and nothing decides → `ask`: the caller shows the top two and waits.
//
// Task text is data. Only rule keywords and globs are matched against it; it
// never picks a permission level, and nothing it says can name an AI.

const PROFILES = require('./tool-profiles.json');

const AIS = Object.freeze(['claude', 'codex', 'gemini']);
const MAX_REASON = 90;
const NEAR_FULL = 0.8;          // a window this used is "nearly used": the default steps aside
const HEADROOM_MARGIN = 0.1;    // headroom decides only when one AI has clearly more left
const MAX_RULES = 50;
const MAX_TERMS = 20;
const MAX_TERM = 80;
const MAX_TOKENS = 4000;
const MAX_TEXT = 20000;

// Every reason contains its rule's mark, so the line always names what fired.
const RULE_MARK = Object.freeze({
  override: 'you ',
  repo: 'for this repo',
  'user-rule': 'your rule',
  only: 'only',
  default: 'your default',
  headroom: 'usage',
  usual: 'usual pick',
  tie: 'no rule decides',
});
const CONFIDENCE = Object.freeze({ override: 'rule', repo: 'rule', 'user-rule': 'rule', only: 'rule', default: 'default', headroom: 'default', usual: 'default', tie: 'tie' });
const CODE_RANK = ['CAPABILITY_MISSING', 'BUDGET_EXCEEDED', 'AI_UNAVAILABLE'];

const clip = (s, n = MAX_REASON) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const pct = (u) => `${Math.round(u * 100)}%`;
const USAGE_STATUSES = Object.freeze(['allowed', 'allowed_warning', 'rejected']);

/**
 * A usage-window reading's utilization, or null when it is not known (plan-orchestrator "O1 fallback"): only a JSON
 * number in 0..1, with a known status and a reset (ms) still ahead. Anything else (null, a string, true, [], NaN,
 * a 0-100 percent, an unknown status, no reset or a past one) is unknown, and unknown never moves a task.
 */
function known(r, now) {
  if (!r || typeof r !== 'object') return null;
  const u = r.utilization;
  if (typeof u !== 'number' || !Number.isFinite(u) || u < 0 || u > 1) return null;
  if (!USAGE_STATUSES.includes(r.status)) return null;
  if (typeof r.resetsAt !== 'number' || !Number.isFinite(r.resetsAt) || !(r.resetsAt > now)) return null;
  return u;
}
const pad = (n) => String(n).padStart(2, '0');

function clock(atMs, now) {
  const d = new Date(atMs);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
}

// ── user rules ──────────────────────────────────────────────────────────────
const words = (s) => ` ${String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i += 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

const terms = (v) => (Array.isArray(v) ? v : [])
  .filter((t) => typeof t === 'string' && t.trim() && t.length <= MAX_TERM).slice(0, MAX_TERMS).map((t) => t.trim());

/** Rules as stored (policy.json route_rules) → the valid ones, in order. Anything else is dropped. */
function normaliseRules(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw.slice(0, MAX_RULES)) {
    if (!r || typeof r !== 'object' || !AIS.includes(r.ai)) continue;
    const keywords = terms(r.keywords).map(words).filter((k) => k.trim());
    const globs = terms(r.globs);
    if (!keywords.length && !globs.length) continue;
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : [...globs, ...terms(r.keywords)].join(' ');
    out.push({ ai: r.ai, name: clip(name.replace(/[\u0000-\u001f\u007f"]/g, ' '), 32), keywords, globs: globs.map(globRe) });
  }
  return out;
}

function textFacts(text) {
  const t = typeof text === 'string' ? text.slice(0, MAX_TEXT) : '';
  const paths = t.split(/[\s"'`()<>[\]{},;]+/).slice(0, MAX_TOKENS).map((x) => x.replace(/[.:!?]+$/, '')).filter((x) => /[./]/.test(x));
  return { words: words(t), paths };
}

/** A rule matches when any of its keywords is in the text (whole words) and any of its globs matches a path in it. */
function ruleMatches(rule, facts) {
  if (rule.keywords.length && !rule.keywords.some((k) => facts.words.includes(k))) return false;
  if (rule.globs.length && !rule.globs.some((g) => facts.paths.some((p) => g.test(p) || g.test(p.split('/').pop())))) return false;
  return true;
}

// ── the router ──────────────────────────────────────────────────────────────
/**
 * input:
 *   want        'auto' | an AI id: the person's explicit choice
 *   level       permission level ('ask' needs permission routing)
 *   needsBudget the task has a spend cap (needs a native cap)
 *   waitForReset the task is scheduled for after the usage reset: a limit doesn't drop the AI
 *   ais         [{id, installed, loggedIn, startable?, capabilities}] from detectAIs
 *   repoPreferred AI id or null
 *   rules       the person's rules as stored (policy.json route_rules); normalised here
 *   text        the task text (data; only rule keywords and globs read it)
 *   defaultAi   AI id or null
 *   spend       {[ai]: true | reason} AIs held by the spend gate
 *   usage       {[ai]: {limitedUntil: ms|null, utilization, status, resetsAt: ms}} raw readings; see known()
 *   now         ms
 *   profiles    tool-profiles.json shape (default: the shipped one)
 * → {decision: 'run'|'ask'|'refuse', ai, rule, confidence, reason, alternatives: [{ai, reason, usable}], code?, capability?}
 *   usable: that alternative could run this task if the person picks it.
 *   A refusal's rule is 'filter' and its code is the Tasks API error to raise.
 */
function route(input = {}) {
  const profiles = input.profiles ?? PROFILES;
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const label = (id) => profiles.tools?.[id]?.label ?? id;
  const ais = new Map((Array.isArray(input.ais) ? input.ais : []).filter((a) => a && AIS.includes(a.id)).map((a) => [a.id, a]));
  const usage = (id) => input.usage?.[id] ?? {};
  const util = (id) => known(usage(id), now);

  function drop(id) {
    const a = ais.get(id);
    const L = label(id);
    const caps = a?.capabilities ?? {};
    if (!a || !a.installed) return { code: 'AI_UNAVAILABLE', text: `${L} is not installed` };
    if (a.loggedIn === false) return { code: 'AI_UNAVAILABLE', text: `${L} is signed out` };
    if (a.startable === false || caps.background === false) return { code: 'AI_UNAVAILABLE', text: `${L} is not available in Plexiform yet` };
    if (input.level === 'ask' && !caps.permissionRouting) return { code: 'CAPABILITY_MISSING', capability: 'permissionRouting', text: `${L} can't ask you for approvals in the background` };
    if (input.needsBudget && !caps.budget) return { code: 'CAPABILITY_MISSING', capability: 'budget', text: `${L} has no native spend cap` };
    if (input.spend?.[id]) return { code: 'BUDGET_EXCEEDED', text: `${L} is paused by your spend cap` };
    const until = usage(id).limitedUntil;
    if (!input.waitForReset && Number.isFinite(until) && until > now) return { code: 'AI_UNAVAILABLE', text: `${L} is at its usage limit until ${clock(until, now)}` };
    return null;
  }

  const out = (decision, ai, rule, reason, alternatives, extra = {}) => ({
    decision, ai, rule, confidence: CONFIDENCE[rule] ?? null, reason: clip(reason),
    alternatives: alternatives.map((x) => ({ ai: x.ai, reason: clip(x.reason), usable: x.usable === true })), ...extra,
  });

  const want = input.want ?? 'auto';
  if (want !== 'auto') {
    if (!AIS.includes(want)) return out('refuse', null, 'filter', `${String(want).slice(0, 20)} is not an AI Plexiform knows`, [], { code: 'VALIDATION' });
    const d = drop(want);
    if (d) return out('refuse', want, 'filter', d.text, [], { code: d.code, ...(d.capability ? { capability: d.capability } : {}) });
    return out('run', want, 'override', `${label(want)}: you chose it`, []);
  }

  const candidates = [];
  const dropped = [];
  const skipped = [];
  for (const id of AIS) {
    if (!ais.has(id)) continue;
    const d = drop(id);
    if (d) dropped.push({ ai: id, reason: d.text, code: d.code, capability: d.capability, usable: false });
    else if (profiles.tools?.[id]?.autoRoute === false) skipped.push({ ai: id, reason: `${label(id)} runs only when you pick it`, usable: true });
    else candidates.push(id);
  }
  const summary = (id) => ({ ai: id, reason: `${label(id)}: ${profiles.tools?.[id]?.summary ?? 'can run it'}`, usable: true });
  const others = (picked) => [...candidates.filter((c) => c !== picked).map(summary), ...skipped, ...dropped];

  if (!candidates.length) {
    if (!dropped.length) return out('refuse', null, 'filter', skipped.length ? 'No AI runs this automatically; pick one' : 'No AI that can run tasks is installed', others(null), { code: 'AI_UNAVAILABLE' });
    const code = CODE_RANK.find((c) => dropped.some((d) => d.code === c));
    const first = dropped.find((d) => d.code === code);
    return out('refuse', null, 'filter', `No AI can run this: ${first.reason}`, others(null), { code, ...(first.capability ? { capability: first.capability } : {}) });
  }
  const run = (id, rule, reason) => out('run', id, rule, reason, others(id));

  if (candidates.length === 1) {
    const [id] = candidates;
    return run(id, 'only', dropped.length ? `${label(id)}: the only one that can run it; ${dropped[0].reason}` : `${label(id)}: the only AI that can run tasks here`);
  }

  const pref = input.repoPreferred;
  if (AIS.includes(pref) && candidates.includes(pref)) return run(pref, 'repo', `${label(pref)}: you set ${label(pref)} for this repo`);

  const rules = normaliseRules(input.rules);
  if (rules.length) {
    const facts = textFacts(input.text);
    const hit = rules.find((r) => candidates.includes(r.ai) && ruleMatches(r, facts));
    if (hit) return run(hit.ai, 'user-rule', `${label(hit.ai)}: your rule "${hit.name}" matched`);
  }

  // Usage moves a task only when every candidate's window is known: an unknown window could be just as full, so
  // incomplete data keeps the default, or the usual pick when there is none (plan-orchestrator "O1 fallback").
  const near = (id) => util(id) != null && util(id) >= NEAR_FULL;
  const room = candidates.map((id) => ({ id, h: util(id) == null ? null : 1 - util(id) }));
  const allKnown = room.every((r) => r.h != null);
  const [best, second] = allKnown ? [...room].sort((a, b) => b.h - a.h || AIS.indexOf(a.id) - AIS.indexOf(b.id)) : [];
  // 1e-9: 0.2 - 0.1 is 0.0999… in floating point, and a margin of exactly 0.1 counts.
  const clear = allKnown && best.h - second.h >= HEADROOM_MARGIN - 1e-9;
  const def = input.defaultAi;
  if (AIS.includes(def) && candidates.includes(def) && !(clear && near(def) && best.id !== def)) return run(def, 'default', `${label(def)}: it's your default AI`);
  if (clear) {
    return run(best.id, 'headroom', near(second.id)
      ? `${label(best.id)}: ${label(second.id)} is ${pct(1 - second.h)} through its usage window`
      : `${label(best.id)}: most usage left in its window (${pct(best.h)} vs ${pct(second.h)})`);
  }
  if (!allKnown) return run(candidates[0], 'usual', `${label(candidates[0])}: the usual pick; no usage data to compare`);

  const ranked = [...room].sort((a, b) => b.h - a.h || AIS.indexOf(a.id) - AIS.indexOf(b.id)).map((r) => r.id);
  const [a, b] = ranked;
  return out('ask', null, 'tie', `${label(a)} or ${label(b)}: no rule decides, so pick one`,
    [...ranked.map(summary), ...skipped, ...dropped]);
}

/** The person picked one of a tie's choices. → a run result, or null when that AI wasn't offered. */
function pickFromTie(result, ai, profiles = PROFILES) {
  if (result?.decision !== 'ask' || !result.alternatives.slice(0, 2).some((x) => x.ai === ai)) return null;
  const L = profiles.tools?.[ai]?.label ?? ai;
  return { decision: 'run', ai, rule: 'override', confidence: 'rule', reason: clip(`${L}: you picked it; no rule decides`), alternatives: result.alternatives.filter((x) => x.ai !== ai) };
}

module.exports = { route, known, USAGE_STATUSES, pickFromTie, normaliseRules, ruleMatches, textFacts, AIS, RULE_MARK, MAX_REASON, NEAR_FULL, HEADROOM_MARGIN, PROFILES };
