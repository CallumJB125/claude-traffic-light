import { h } from './h.js';

const PROVIDERS = { codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini', hermes: 'Hermes', claude: 'Claude Code' };
const STATUS = { working: 'working', waiting: 'waiting for input', review: 'ready for review', idle: 'idle', ended: 'session ended' };
export function captureLabel(view, elapsed = 0) {
  const c = view?.capture;
  if (!c || c.source !== 'local_observation' || !PROVIDERS[c.provider]) return null;
  const provider = `Reported ${PROVIDERS[c.provider]}`;
  if (c.tracking !== 'active') return `${provider} · tracking stopped`;
  const fresh = c.fresh === true && Number.isFinite(c.age_ms) && c.age_ms >= 0 && c.age_ms + Math.max(0, elapsed) < 60000;
  return `${provider} · ${fresh && STATUS[c.status] ? STATUS[c.status] : 'no recent report'}`;
}
export function captureBadge(view, elapsed = 0) {
  const label = captureLabel(view, elapsed);
  return label ? h('span', { class: 'label capture-report', title: 'Local session report. Completion still needs review.' }, label) : null;
}
