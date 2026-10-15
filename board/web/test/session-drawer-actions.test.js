import test from 'node:test';
import assert from 'node:assert/strict';
import { drawer } from '../js/render-drawer.js';
import { reportedContextDraft, withLocalHandover } from '../js/local-session-context.js';
import { textOf, byAttr } from '../js/h.js';
import { view, model } from './fixtures.js';
import { displayFace } from '../js/view.js';
const report = { source: 'local_observation', provider: 'codex', status: 'working', reported_status: 'working', tracking: 'active', fresh: true, age_ms: 1000,
  summary: 'Goal: Make the session tabs useful\n\nConnected the recorded context.\n\nFiles: board/web/js/app.js, /private/file, ../escape, <path>' };
function detail(tab, extra = {}) {
  const card = view({ run: null, run_state: null, capture: report, ...extra.card });
  return { cardId: card.id, tab, elapsed_ms: 0, data: { card, feed: [], comments: [], asks: [], permission_requests: [], ...extra.data }, packetLoaded: true, ...extra.detail };
}
const render = d => drawer(model([{ view: d.data.card, face: displayFace(d.data.card), elapsed_ms: 0 }], { detail: d }));
test('captured Activity shows recorded work even without board events', () => {
  const n = render(detail('activity'));
  assert.match(textOf(n), /Make the session tabs useful/); assert.match(textOf(n), /Connected the recorded context/); assert.match(textOf(n), /board\/web\/js\/app.js/);
  assert.doesNotMatch(textOf(n), /^No activity yet\.$/);
});
test('reported context draft excludes absolute/placeholder paths and never invents decisions or checks', () => {
  const d = detail('packet'), draft = reportedContextDraft(d);
  assert.equal(draft.brief, 'Make the session tabs useful'); assert.equal(draft.paths, 'board/web/js/app.js');
  assert.equal(draft.decisions, ''); assert.equal(draft.reportedChecks, ''); assert.deepEqual(draft.evidence, []);
  assert.equal(reportedContextDraft({ ...d, packet: { version: 1 } }), null); assert.equal(reportedContextDraft({ ...d, packetDraft: { brief: 'mine' } }), null);
});
test('a missing local handover clears previously displayed local data', () => {
  const d = detail('handover', { data: { local_handover: { markdown: 'revoked' } }, detail: { localHandover: { markdown: 'revoked' } } });
  const cleared = withLocalHandover(d, null, true);
  assert.equal(cleared.localHandover, null); assert.equal(cleared.data.local_handover, null);
  assert.doesNotMatch(textOf(render(cleared)), /revoked/);
});
test('Comments on a reported Codex session do not offer delivery to a nonexistent Claude run', () => {
  const n = render(detail('comments'));
  assert.equal(byAttr(n, 'name', 'for_agent').length, 0); assert.doesNotMatch(textOf(n), /Send to Claude/); assert.match(textOf(n), /Saved on this card/);
});
test('Details renders the actual handoff body instead of a generic object string', () => {
  const n = render(detail('details', { data: { memories: [{ id: 'h1', body: 'Next: inspect the actual diff.' }] } }));
  assert.match(textOf(n), /Next: inspect the actual diff/); assert.doesNotMatch(textOf(n), /\[object Object\]/);
});
test('local handover exposes actions only with the desktop capability', () => {
  const before = globalThis.plexiformDesktop;
  try {
    const d = detail('handover', { data: { local_handover: { markdown: '# Resume', timeline: true } } });
    delete globalThis.plexiformDesktop; assert.equal(byAttr(render(d), 'data-action', 'local-handover-copy').length, 0);
    globalThis.plexiformDesktop = { handoverAction() {}, continueIn() {} };
    const n = render(d); assert.match(textOf(n), /Refresh handover/); assert.match(textOf(n), /Copy as prompt/); assert.match(textOf(n), /Save Markdown/);
  } finally { if (before === undefined) delete globalThis.plexiformDesktop; else globalThis.plexiformDesktop = before; }
});
