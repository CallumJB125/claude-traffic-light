'use strict';
// Usage-limit reset times, read only from what Plexiform already holds: Burst's
// state (route SECONDARY until a time, per-model rejections), Tasks parked on a
// limit (the engine's limitResetsAtMs) and sessions whose signal is limit-hit.
// A time is shown only when one of those carries it; nothing is guessed.

const PROVIDERS = Object.freeze({ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' });
const SHOWN = Object.keys(PROVIDERS);
const MAX_ROWS = 20;

const providerOf = (source) => {
  const s = typeof source === 'string' ? source.toLowerCase() : '';
  if (!s || s === 'claude' || s === 'claude-code' || s === 'anthropic') return 'claude';
  if (s === 'codex' || s === 'openai') return 'codex';
  if (s === 'gemini' || s === 'google') return 'gemini';
  return s.replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'claude';
};
const labelOf = (p) => PROVIDERS[p] || p;
const msOf = (iso) => { const t = typeof iso === 'string' && iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
const text = (v, n = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '');
const pad = (n) => String(n).padStart(2, '0');

// 'HH:MM' local; another day gets its short weekday in front.
function clock(atMs, now) {
  const d = new Date(atMs), n = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === n.toDateString() ? hm : `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm}`;
}

// burst: BurstIpc.snapshot().d; tasks: tasks-service snapshot().tasks; sessions: live session rows.
// → [{ provider, label, source: 'burst'|'tasks'|'session', resetAtMs|null, model?, why?, session? }]
function collect({ burst = null, tasks = [], sessions = [], now = Date.now() } = {}) {
  const out = [];
  const st = burst && burst.kind === 'present' && burst.state && typeof burst.state === 'object' ? burst.state : null;
  if (st) {
    const until = msOf(st.until);
    if (st.route === 'SECONDARY' && until !== null && until > now) out.push({ provider: providerOf(st.primary && st.primary.provider), source: 'burst', resetAtMs: until, why: text(st.reason) });
    for (const r of Array.isArray(st.rejected) ? st.rejected.slice(0, MAX_ROWS) : []) {
      const at = msOf(r && r.until);
      if (at !== null && at > now && r.model) out.push({ provider: 'claude', source: 'burst', resetAtMs: at, model: text(r.model, 80), why: r.fallsBackTo ? `falls back to ${text(r.fallsBackTo, 80)}` : '' });
    }
  }
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || t.parkReason !== 'limit' || !t.ai || !t.ai.id) continue;
    const at = Number.isFinite(t.limitResetsAtMs) && t.limitResetsAtMs > now ? t.limitResetsAtMs : null;
    out.push({ provider: providerOf(t.ai.id), source: 'tasks', resetAtMs: at, why: text(t.title) });
  }
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || s.signal !== 'limit-hit' || typeof s.sessionId !== 'string') continue;
    out.push({ provider: providerOf(s.source), source: 'session', resetAtMs: null, session: s });
  }
  return out.map((e) => ({ ...e, label: labelOf(e.provider) }));
}

// The soonest whole-provider reset (a per-model rejection is not the provider's limit).
function resetFor(entries, provider) {
  const times = entries.filter((e) => e.provider === provider && !e.model && e.resetAtMs !== null).map((e) => e.resetAtMs);
  return times.length ? Math.min(...times) : null;
}

const SOURCE = { burst: 'from Burst', tasks: 'from a paused task' };

// The Usage page's Limits panel: one row per provider (the usual three always,
// others when something reported them), then Burst's per-model rejections.
function panel(entries, now) {
  const providers = [...new Set([...SHOWN, ...entries.map((e) => e.provider)])];
  const rows = providers.map((p) => {
    const mine = entries.filter((e) => e.provider === p && !e.model);
    const at = resetFor(entries, p);
    if (at !== null) {
      const src = mine.find((e) => e.resetAtMs === at).source;
      return { provider: p, label: labelOf(p), status: 'limited', resetAtMs: at, text: `Resets at ${clock(at, now)}`, source: SOURCE[src] || '' };
    }
    if (mine.length) return { provider: p, label: labelOf(p), status: 'limited', resetAtMs: null, text: 'Limit hit. Reset time not known', source: '' };
    return { provider: p, label: labelOf(p), status: 'clear', resetAtMs: null, text: 'No limit reported right now', source: '' };
  });
  const models = entries.filter((e) => e.model).sort((a, b) => a.resetAtMs - b.resetAtMs).slice(0, MAX_ROWS)
    .map((e) => ({ model: e.model, resetAtMs: e.resetAtMs, text: `${e.model}: available again at ${clock(e.resetAtMs, now)}${e.why ? ` (${e.why})` : ''}` }));
  return { rows, models, note: 'Plexiform knows a reset time only when Claude Burst or a task paused on a limit reports one. It never guesses.' };
}

module.exports = { collect, panel, resetFor, clock, providerOf, labelOf, PROVIDERS };
