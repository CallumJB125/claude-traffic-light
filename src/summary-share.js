'use strict';
// "Share summary with team": one durable post that bundles a session's scrubbed
// replay summary, its saved data-only result cards and provenance (which
// session, which task, who ran it). It travels the same opt-in route as the
// Burst handover salvage (src/burst-handover.js): only for a repository the
// person switched "Share handover with team" on for, through the signed-in
// hub's append call, written as a system section the card keeps. Nothing is
// sent for a repo that is not opted in; without a hub nothing is sent.
const crypto = require('node:crypto');
const { scrub } = require('./scrub.js');
const BurstHandover = require('./burst-handover.js');
const ResultCards = require('./result-cards.js');

const MAX_CHARS = 8000;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// replay: Replay.exportReplay(...).summary + .model; cards: saved result cards (validated again here).
function buildBundle({ replay, cards = [], session, home = null, user = null, now = Date.now() } = {}) {
  if (!replay || typeof replay !== 'object' || !session || typeof session !== 'object') return null;
  const model = replay.model && typeof replay.model === 'object' ? replay.model : {};
  let safeCards = [];
  try { safeCards = ResultCards.cleanResultCards(Array.isArray(cards) ? cards : [], (v, max) => scrub(v, { home, user }).slice(0, max)); } catch { safeCards = []; }
  const provenance = {
    adapter: str(session.adapter, 40), session: crypto.createHash('sha256').update(str(session.sessionId, 300)).digest('hex').slice(0, 16),
    task: str(session.task, 400), author: str(session.author, 200) || 'Unknown', project: str(model.project, 100), exportedAt: new Date(now).toISOString(),
  };
  const lines = [
    `# Session summary · ${provenance.project || 'project'} · ${provenance.exportedAt.slice(0, 10)}`,
    `By ${provenance.author} using ${provenance.adapter || 'an AI tool'}${provenance.task ? ` on "${provenance.task}"` : ''}. Session ref ${provenance.session}.`,
    '', scrub(str(typeof replay.summary === 'string' ? replay.summary : JSON.stringify(replay.summary ?? ''), MAX_CHARS), { home, user }),
  ];
  if (safeCards.length) {
    lines.push('', '## Saved result cards');
    for (const c of safeCards) {
      if (c.kind === 'checklist') lines.push(`- ${c.title}: ${c.items.filter(i => i.done).length}/${c.items.length} done`);
      else if (c.kind === 'metric') lines.push(`- ${c.title}: ${c.value}${c.unit ? ` ${c.unit}` : ''}${c.note ? ` (${c.note})` : ''}`);
      else lines.push(`- ${c.title}: table, ${c.rows.length} row${c.rows.length === 1 ? '' : 's'}`);
    }
  }
  return { text: lines.join('\n').slice(0, MAX_CHARS), cards: safeCards, provenance };
}

// Payload the hub stores beside the card. Same gate as the handover salvage.
function hubPayload(root, bundle, { shared = {} } = {}) {
  if (!root || !bundle || shared[BurstHandover.repoKey(root)] !== true) return null;
  return { section: 'summary', written_by: 'system', repo: BurstHandover.repoKey(root), date: bundle.provenance.exportedAt.slice(0, 10), text: bundle.text, cards: bundle.cards, provenance: bundle.provenance };
}

async function share({ root, bundle, shared, send }) {
  const payload = hubPayload(root, bundle, { shared });
  if (!payload) return { ok: false, reason: 'not-shared', error: 'Turn on "Share handover with team" for this repository first. Nothing was sent.' };
  if (typeof send !== 'function') return { ok: false, reason: 'no-hub', error: 'No team hub is connected. Nothing was sent.' };
  let r;
  try { r = await send(payload); } // privacy-flow: summary-share
  catch { return { ok: false, reason: 'unconfirmed', error: 'No receipt from the team hub. Check the card before sharing again.' }; }
  return r && r.ok === false ? { ok: false, reason: 'refused', error: str(r.error, 300) || 'The team hub refused this post.' } : { ok: true, section: payload.section, date: payload.date };
}

module.exports = { buildBundle, hubPayload, share, MAX_CHARS };
