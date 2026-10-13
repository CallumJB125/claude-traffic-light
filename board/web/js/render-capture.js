import { h } from './h.js';
import { formatAge } from '../../shared/liveness.js';
import { captureAgeMs } from '../../shared/capture-lane.js';

const PROVIDERS = { codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini', hermes: 'Hermes', claude: 'Claude Code' };
const STATUS = { working: 'AI working', waiting: 'waiting for input', review: 'awaiting human review', idle: 'idle', ended: 'session ended' };
const DAY = 86_400_000;
// Relative time, never a raw ISO string: "2m ago", "5h ago", "3 days ago".
export function agoText(ms) {
  if (ms == null || !Number.isFinite(ms)) return 'time unavailable';
  if (ms < DAY) return `${formatAge(ms)} ago`;
  const d = Math.floor(ms / DAY);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
export function capturePresentation(view, elapsed = 0, connectionLost = false, now = Date.now()) {
  const c = view?.capture;
  if (!c || c.source !== 'local_observation' || !PROVIDERS[c.provider]) return null;
  const provider = `Reported ${PROVIDERS[c.provider]}`;
  const validAge = Number.isFinite(c.age_ms) && c.age_ms >= 0 && Number.isFinite(elapsed) && elapsed >= 0;
  const age = validAge ? c.age_ms + elapsed : null;
  const fresh = !connectionLost && c.tracking === 'active' && c.fresh === true && age !== null && age < 60000 && !!STATUS[c.status];
  const status = c.tracking !== 'active' ? 'tracking stopped' : connectionLost ? 'connection lost' : fresh ? STATUS[c.status] : 'no recent report';
  const last = STATUS[c.reported_status] ?? STATUS[c.status];
  const reportAge = age ?? captureAgeMs(c, elapsed, now);
  const at = Date.parse(c.received_at);
  const exact = Number.isFinite(at) ? new Date(at).toLocaleString() : null;
  return { label: `${provider} · ${status}`, fresh, status: fresh ? c.status : 'unknown', lastReport: `Last report${!fresh && last ? `: ${last}` : ''} · ${agoText(reportAge)}`, exact };
}
export function captureLabel(view, elapsed = 0, connectionLost = false) {
  return capturePresentation(view, elapsed, connectionLost)?.label ?? null;
}
export function captureBadge(view, elapsed = 0, connectionLost = false) {
  const p = capturePresentation(view, elapsed, connectionLost);
  return p ? h('div', { class: 'capture-activity', 'data-fresh': p.fresh ? 'true' : 'false' },
    h('span', { class: 'label capture-report', 'data-status': p.status, title: 'Reported local activity; not a verified board runner or permission to start another session.' }, p.label),
    h('span', { class: 'capture-last-report', title: p.exact ? `Reported ${p.exact}` : null }, p.lastReport)) : null;
}

// A captured card's body as written by src/work-record.js cardBody():
// "Goal: …", the summary, "Files: a, b (+N more)". Any other text is summary.
export function recordParts(text) {
  const out = { goal: null, summary: null, files: [], more: 0 };
  if (typeof text !== 'string' || !text.trim()) return out;
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (blocks[0]?.startsWith('Goal: ')) out.goal = blocks.shift().slice(6).trim() || null;
  const last = blocks.at(-1);
  if (last?.startsWith('Files: ') && !last.includes('\n')) {
    blocks.pop();
    const m = /^(.*?)(?: \(\+(\d+) more\))?$/.exec(last.slice(7));
    out.files = m[1].split(', ').map((f) => f.trim()).filter(Boolean);
    out.more = Number(m[2] ?? 0);
  }
  out.summary = blocks.join('\n\n') || null;
  return out;
}

const SUMMARY_CHARS = 240;
// The WorkRecord on the card face: what the session set out to do, where it got to, the files it changed.
export function captureRecord(view) {
  if (view?.capture?.source !== 'local_observation') return null;
  const r = recordParts(view.capture.summary);
  if (!r.goal && !r.summary && !r.files.length) return null;
  const summary = r.summary && r.summary.length > SUMMARY_CHARS ? `${r.summary.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : r.summary;
  const shown = r.files.slice(0, 3), hidden = r.files.length - shown.length + r.more;
  return h('div', { class: 'capture-record' },
    r.goal ? h('p', { class: 'capture-goal', title: r.goal }, h('span', { class: 'capture-record-label' }, 'Goal '), r.goal) : null,
    summary ? h('p', { class: 'capture-summary', title: r.summary }, summary) : null,
    shown.length ? h('ul', { class: 'capture-files', 'aria-label': 'Files changed' },
      shown.map((f) => h('li', { key: f, class: 'capture-file num', title: f }, f)),
      hidden > 0 ? h('li', { key: 'more', class: 'capture-file-more' }, `+${hidden} more`) : null) : null);
}
