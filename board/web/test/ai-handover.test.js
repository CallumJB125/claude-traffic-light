import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handoverPin, sameHandover } from '../js/ai-handover.js';
import { cardFace } from '../../shared/cardface.js';
import { switchAiDialog } from '../js/render-dialogs.js';
import { textOf as text } from '../js/h.js';
const view = { id: 'card', key: 'ME-5', title: 'Fix parser', fence: 3, run_state: 'running', run: { id: 'run-3', ai: 'codex', ai_label: 'Codex' }, repo: { id: 'repo' } };
test('handover pin rejects changed run, fence or absent identity', () => {
  const pin = handoverPin(view);
  assert.equal(sameHandover(view, pin), true);
  assert.equal(sameHandover({ ...view, fence: 4 }, pin), false);
  assert.equal(sameHandover({ ...view, run: { id: 'other' } }, pin), false);
  assert.equal(sameHandover(view, {}), false);
});
test('managed switch and held state distinguish stop preparation, blocked and ready handover', () => {
  assert.ok(cardFace(view).actions.includes('switch_ai'));
  const held = { ...view, run_state: 'handed_over', handover_hold: true, handover_provenance: 'checkpoint_incomplete' };
  assert.deepEqual(cardFace(held).actions, ['view_handover']);
  assert.match(cardFace(held).reason, /not confirmed/);
  assert.deepEqual(cardFace({ ...held, handover_provenance: 'checkpoint_complete' }).actions, ['view_handover', 'take_over_with_claude']);
  const model = { entries: [{ view }], members: new Map(), me: { member: { id: 'me' } } };
  assert.match(text(switchAiDialog({ cardId: view.id }, model)), /No replacement starts automatically/);
  assert.match(text(switchAiDialog({ cardId: view.id }, model)), /This session runs in your own terminal; stop it there/);
});
