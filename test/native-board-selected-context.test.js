const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createAccountClient } = require('../buddy-window/accounts');
const { callTool } = require('../native-board/tools');

for (const name of ['plexiform_get_card', 'plexiform_list_cards', 'plexiform_update_card']) test(`${name} selected-board grant cannot export cross-board overlap peers`, async (t) => {
  const { communicationRig } = await import('../board/hub/test/communication-helpers.js');
  const x = await communicationRig(t), { A, sender: a, h } = x;
  const created = await x.as(x.users.ua, 'POST', '/api/boards', { request_id: crypto.randomUUID(), name: 'Hidden overlap board' });
  assert.equal(created.status, 200, created.text);
  const hiddenBoard = created.body.board.id;
  h.db.run('INSERT INTO board_repos(board_id,repo_id) VALUES(?,?)', hiddenBoard, A.repo);
  const hidden = await x.participant(x.users.s, A, { board: hiddenBoard });
  for (const p of [a, hidden]) {
    const declared = await p.client.rpc(p.run, 'board_declare_plan', { paths: ['src/shared-route.js'], summary: 'Shared route' });
    assert.equal(declared.ok, true, JSON.stringify(declared.error));
  }
  const broad = await x.as(a.user, 'GET', `/api/cards/${a.run.card_id}`);
  assert.equal(broad.status, 200); assert.ok(JSON.stringify(broad.body).includes(hidden.run.card_id), 'real cross-board overlap exists');
  const client = createAccountClient({ origin: h.base, store: { load: () => ({ hub: h.base, token: a.user.token, user: { id: a.user.id } }) } });
  const args = name === 'plexiform_list_cards' ? { board_id: A.board } : { card_id: a.run.card_id,
    ...(name === 'plexiform_update_card' ? { version: h.hub.card(a.run.card_id).version, title: 'Selected edit' } : {}) };
  const response = await callTool({ grant: { mode: name === 'plexiform_update_card' ? 'collaborate' : 'read', boardIds: [A.board] }, workspace: { teamId: A.team }, client }, name, args);
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.ok(!JSON.stringify(response).includes(hidden.run.card_id), 'unselected peer card ID must not leave the native bridge');
  assert.ok(!JSON.stringify(response).includes(hidden.run.key), 'unselected peer key must not leave the native bridge');
});
