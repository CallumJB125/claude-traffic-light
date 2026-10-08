import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topBar, boardScreen } from '../js/render-board.js';
import { dialog } from '../js/render-dialogs.js';
import { integrationsScreen } from '../js/render-integrations.js';
import { byAttr, textOf } from '../js/h.js';
import { model } from './fixtures.js';

const boards = [{ id: 'a', name: 'Delivery', key_prefix: 'DEL', archived_at: null }, { id: 'b', name: 'History', key_prefix: 'HIS', archived_at: '2026-10-01' }];
const m = (over = {}) => model([], { me: { member: { id: 'm-alice', role: 'owner' } }, boards, board: boards[0], ...over });

test('switcher hides archived boards; admin controls and archive notice follow the current board', () => {
  const v = topBar(m(), {});
  assert.equal(byAttr(v, 'data-change', 'board').length, 1);
  assert.deepEqual(byAttr(v, 'value', 'b'), []);
  assert.equal(byAttr(v, 'data-action', 'manage-boards').length, 1);
  const readonly = m({ board: boards[1], readOnly: true });
  assert.match(textOf(boardScreen(readonly)), /archived and read-only/);
  assert.equal(byAttr(topBar(readonly, {}), 'data-action', 'new-card').length, 0);
});

test('manager preserves last active board and offers restore; board dialogs use ordinary form controls', () => {
  const v = dialog(m({ dialog: { kind: 'boards' } }));
  assert.equal(byAttr(v, 'data-action', 'new-board').length, 1);
  assert.equal(byAttr(v, 'data-action', 'restore-board')[0].props['data-board'], 'b');
  assert.equal(byAttr(v, 'data-action', 'archive-board')[0].props.disabled, true);
  const create = dialog(m({ dialog: { kind: 'new-board' } }));
  assert.equal(byAttr(create, 'id', 'board-name').length, 1);
  assert.equal(byAttr(create, 'id', 'board-prefix').length, 1);
  const rename = dialog(m({ dialog: { kind: 'rename-board', id: 'a', name: 'Delivery' } }));
  assert.equal(byAttr(rename, 'value', 'Delivery').length, 1);
  assert.equal(byAttr(rename, 'id', 'board-prefix').length, 0, 'rename never changes card keys');
});

test('integration target includes its archived selection with intake paused; members cannot edit it', () => {
  assert.match(textOf(integrationsScreen(m({ integrations: { status: 'idle', data: null } }))), /Loading integrations/);
  const data = { available: [{ id: 'fake', name: 'Fake' }], connections: [{ id: 'c', provider: 'fake', target_board_id: 'b', settings: {}, status: 'active' }], vault: true };
  const owner = m({ integrations: { status: 'ok', data } });
  const v = integrationsScreen(owner);
  assert.match(textOf(v), /History \(Archived — intake paused\)/);
  assert.equal(byAttr(v, 'data-change', 'integ-board').length, 1);
  const member = { ...owner, me: { member: { role: 'member' } } };
  assert.equal(byAttr(integrationsScreen(member), 'data-change', 'integ-board').length, 0);
});
