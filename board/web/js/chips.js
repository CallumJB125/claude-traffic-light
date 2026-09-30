// What is unique to Plexiform, as small chips on the card face. Pure:
// (CardView, cardFace) → [{id, text, tone, …}], using only fields CardView
// already carries (CONTRACT §5.3).
//
// Already on the face, so not repeated here: the live step (the pill's reason
// is "Alice's Claude · editing deals.ts" while running), the overlap chip, and
// the agent-suggested badge. CardView has no self-driven field.
import { fmtUsd, formatAge } from './view.js';

// A live run whose handover has not synced for this long would lose that
// narrative if the machine died: worth a nudge, not an alarm.
export const HANDOVER_STALE_MS = 10 * 60_000;

// States whose pill reason already says how old the handover is.
const HANDOVER_IN_REASON = new Set(['orphaned', 'handed_over']);
const HANDOVER_SHOWN = new Set(['claimed', 'running', 'quiet', 'blocked', 'parked', 'suspended', 'reconnecting', 'unresponsive', 'handing_over']);
const HANDOVER_WARN = new Set(['running', 'quiet', 'blocked']);

function proofChip(view, face) {
  if (face.state !== 'in_review' && face.state !== 'done') return null;
  const ev = view.evidence;
  const parts = [];
  if (ev?.tests === 'pass') parts.push('tests ✓');
  else if (ev?.tests === 'fail') parts.push('tests ✗');
  else if (ev?.tests === 'none') parts.push('no tests');
  if (view.pr?.number) parts.push(`PR #${view.pr.number}`);
  if (!parts.length) return null;
  const verified = ev?.verification === 'hub_verified';
  // In review the verification status is the point; once done it is history.
  if (face.state === 'in_review' && ev) parts.push(verified ? 'hub-verified' : 'self-reported');
  const tone = ev?.tests === 'fail' ? 'red' : ev?.tests === 'pass' && verified ? 'green' : ev?.tests === 'pass' || view.pr?.state === 'merged' ? 'quiet' : 'amber';
  const icon = ev?.tests === 'fail' ? 'cross' : ev?.tests === 'pass' || view.pr?.state === 'merged' ? 'check' : 'warn';
  return {
    id: 'proof', text: parts.join(' · '), tone, icon,
    title: [ev?.tests ? `Tests: ${ev.tests}` : null, ev ? (verified ? 'Verified by the hub against GitHub' : 'Self-reported by the agent, not verified') : null,
      view.pr?.number ? `PR #${view.pr.number} ${view.pr.state ?? ''}`.trim() : null].filter(Boolean).join(' · '),
    href: view.pr?.url ?? null,
  };
}

function handoverChip(view, face, elapsed_ms) {
  if (!view.handover || !view.run || HANDOVER_IN_REASON.has(face.state) || !HANDOVER_SHOWN.has(face.state)) return null;
  if (view.handover.synced_age_ms == null) return null;
  const age = view.handover.synced_age_ms + elapsed_ms;
  const stale = age > HANDOVER_STALE_MS && HANDOVER_WARN.has(face.state);
  return {
    id: 'handover', text: `handover ${formatAge(age)}`, tone: stale ? 'amber' : 'quiet', icon: 'swap',
    title: stale ? `The handover last synced ${formatAge(age)} ago. If this run dies, anything newer is lost.` : `Handover last synced ${formatAge(age)} ago. Another Claude can pick this up from it.`,
  };
}

function costChip(view, face) {
  // An unspent budget on a card nobody is running is noise; the drawer shows it.
  if (!face.budget || !(view.run || view.budget?.spent_usd > 0)) return null;
  const { spent_usd = 0, cap_usd } = view.budget;
  return {
    id: 'cost', text: `${fmtUsd(spent_usd)}/${fmtUsd(cap_usd)}`, ratio: face.budget.ratio,
    tone: face.budget.ratio >= 1 ? 'red' : face.budget.ratio >= 0.8 ? 'amber' : 'quiet',
    title: `Budget ${face.budget.text} (${Math.round(face.budget.ratio * 100)}%)`,
  };
}

export function cardChips(view, face, { elapsed_ms = 0 } = {}) {
  return [proofChip(view, face), handoverChip(view, face, elapsed_ms), costChip(view, face)].filter(Boolean);
}
