'use strict';
// Bounded "Ask" templates for a shared session. Each builds plain message text
// that goes through the existing team send path (overview teamMessage →
// team-session-controls). No new channel, no permission change: a session that
// refuses (watch-only, Plan-restricted Claude, ended) refuses here too, and the
// page never retries on an unconfirmed receipt. Receipt state is read back from
// the deliveries the directory already reports.
(function (root) {
  const EXPIRY_MS = 30 * 60_000;
  const TEMPLATES = Object.freeze([
    { id: 'status', label: 'Status update', text: 'Please reply with a short status update: what you are doing now, what is done, and anything blocking you. Do not change files for this message.' },
    { id: 'review', label: 'Review my change', text: 'When you reach a safe point, please review my latest change in this project and reply with concerns, risks and anything I should fix. Do not edit files for this review.' },
    { id: 'plan', label: 'Explain current plan', text: 'Please explain your current plan in a few sentences: the goal, the next steps and what you will not touch. Reply only; do not change files.' },
    { id: 'pause', label: 'Pause at next safe point', text: 'Please finish the current step, leave the working tree in a consistent state, write a short handover of where you are, then stop and wait for further instructions.' },
  ]);
  const byId = id => TEMPLATES.find(t => t.id === id) || null;
  const str = (v, max) => typeof v === 'string' && v.length <= max ? v : '';
  // Returns the exact text to send plus the request record the page keeps beside
  // the receipt. Sender/target/task/contextVersion come from the directory entry
  // and the signed-in viewer, never from free text.
  function buildRequest(templateId, { sender, target, task = null, contextVersion = null, now = Date.now(), note = '' } = {}) {
    const t = byId(templateId);
    if (!t) return { ok: false, error: 'Choose one of the listed requests.' };
    if (!str(sender, 200) || !str(target, 200)) return { ok: false, error: 'This request needs a signed-in sender and an exact shared session.' };
    const extra = str(note, 500).trim();
    const text = `${t.text}${extra ? `\n\nContext from ${sender}: ${extra}` : ''}`;
    return { ok: true, text, request: { template: t.id, label: t.label, sender, target, task: str(task, 400) || null, contextVersion: Number.isSafeInteger(contextVersion) ? contextVersion : null, sentAt: now, expiresAt: now + EXPIRY_MS } };
  }
  // deliveries: the entry's reported deliveries ({text, state, response}). The
  // request's own text identifies it; expiry applies only while unanswered.
  function receiptState(request, deliveries = [], now = Date.now()) {
    const d = (Array.isArray(deliveries) ? deliveries : []).find(x => x && x.text === request?.text);
    if (d && str(d.response, 16000)) return 'answered';
    if (d && /ack|deliver|accepted|receiv/i.test(String(d.state))) return 'acknowledged';
    if (request && now >= request.expiresAt) return 'expired';
    return d ? 'sent' : 'sending';
  }
  const STATE_LABEL = Object.freeze({ sending: 'Sending', sent: 'Sent', acknowledged: 'Acknowledged', answered: 'Answered', expired: 'Expired, no reply' });
  const api = { TEMPLATES, byId, buildRequest, receiptState, STATE_LABEL, EXPIRY_MS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformRequests = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
