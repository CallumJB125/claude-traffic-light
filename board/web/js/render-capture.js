import { h } from './h.js';
import { formatAge } from '../../shared/liveness.js';

const PROVIDERS = { codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini', hermes: 'Hermes', claude: 'Claude Code' };
const STATUS = { working: 'AI working', waiting: 'waiting for input', review: 'awaiting human review', idle: 'idle', ended: 'session ended' };
export function capturePresentation(view, elapsed = 0, connectionLost = false) {
  const c = view?.capture;
  if (!c || c.source !== 'local_observation' || !PROVIDERS[c.provider]) return null;
  const provider = `Reported ${PROVIDERS[c.provider]}`;
  const validAge = Number.isFinite(c.age_ms) && c.age_ms >= 0 && Number.isFinite(elapsed) && elapsed >= 0;
  const age = validAge ? c.age_ms + elapsed : null;
  const fresh = !connectionLost && c.tracking === 'active' && c.fresh === true && age !== null && age < 60000 && !!STATUS[c.status];
  const status = c.tracking !== 'active' ? 'tracking stopped' : connectionLost ? 'connection lost' : fresh ? STATUS[c.status] : 'no recent report';
  const last = STATUS[c.reported_status] ?? STATUS[c.status];
  const received = typeof c.received_at === 'string' && Number.isFinite(Date.parse(c.received_at)) ? new Date(c.received_at).toISOString() : null;
  const when = age !== null ? `${formatAge(age)} ago` : received ?? 'time unavailable';
  return { label: `${provider} · ${status}`, fresh, status: fresh ? c.status : 'unknown', lastReport: `Last report${!fresh && last ? `: ${last}` : ''} · ${when}` };
}
export function captureLabel(view, elapsed = 0, connectionLost = false) {
  return capturePresentation(view, elapsed, connectionLost)?.label ?? null;
}
export function captureBadge(view, elapsed = 0, connectionLost = false) {
  const p = capturePresentation(view, elapsed, connectionLost);
  return p ? h('div', { class: 'capture-activity', 'data-fresh': p.fresh ? 'true' : 'false' },
    h('span', { class: 'label capture-report', 'data-status': p.status, title: 'Reported local activity; not a verified board runner or permission to start another session.' }, p.label),
    h('span', { class: 'capture-last-report' }, p.lastReport)) : null;
}
