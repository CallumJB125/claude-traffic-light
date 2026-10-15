import { isObservedWork } from '../../shared/capture-lane.js';
import { recordParts } from './render-capture.js';

// Reuse the recorded card report; this is participant context, never a task
// packet, an ownership declaration or a provider delivery acknowledgement.
export function reportedSessionContext(detail) {
  const card = detail.data?.card;
  if (!card || !isObservedWork(card)) return null;
  const report = typeof card.capture.summary === 'string' ? card.capture.summary
    : card.capture.managed?.body !== false ? detail.data.body : null;
  const parts = recordParts(report);
  return parts.goal || parts.summary || parts.files.length ? parts : null;
}

export function reportedContextDraft(detail) {
  if (!detail.packetLoaded || detail.packet || detail.packetDraft) return null;
  const r = reportedSessionContext(detail);
  if (!r) return null;
  // Reported paths can be absolute or scrubbed placeholders. A shared packet
  // accepts only actual repository-relative paths; keep other paths in view.
  const paths = r.files.filter(p => p.length <= 1000 && !/^(?:[A-Za-z]:|[\\/~])|[<>\0\r\n]/.test(p) && !p.split(/[\\/]/).includes('..'));
  return { brief: (r.goal ?? '').slice(0, 4000), progress: (r.summary ?? '').slice(0, 4000), decisions: '', nextAction: '',
    paths: paths.slice(0, 20).join('\n'), reportedChecks: '', evidence: [], expected_version: 0, expected_fence: detail.data.card.fence };
}

export function withLocalHandover(detail, result, timeline = false) {
  const markdown = typeof result?.markdown === 'string' && result.markdown.trim() ? result.markdown : null;
  const localHandover = markdown ? { markdown, timeline } : null;
  return { ...detail, localHandover, data: { ...detail.data, local_handover: localHandover } };
}
