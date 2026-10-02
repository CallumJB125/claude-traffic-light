import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { startHub } from './helpers.js';
import { createSentryConnector } from '../integrations/sentry/index.js';

async function rig(t) {
  const h = await startHub(); t.after(() => h.close());
  h.hub.setVaultKey(randomBytes(32));
  h.app.integrations.register(createSentryConnector({ now: () => h.clock.wall() }));
  const alice = await h.login('alice'), secret = randomBytes(24).toString('hex');
  const r = await h.api(alice, 'POST', '/api/integrations/sentry/token', { token: secret });
  assert.equal(r.status, 200, r.text);
  const conn = r.body.connection;
  assert.equal((await h.api(alice, 'PATCH', `/api/integrations/${conn.id}`, { config: { default_board_id: h.ids.board } })).status, 200);
  const rawBody = Buffer.from(JSON.stringify({ action: 'created', data: { issue: { id: '12345', level: 'error', project: { slug: 'app' }, firstSeen: new Date(h.clock.wall()).toISOString() } } }));
  const headers = { 'sentry-hook-resource': 'issue', 'sentry-hook-signature': createHmac('sha256', secret).update(rawBody).digest('hex') };
  return { h, conn, send: () => h.app.integrations.webhook(conn.id, { headers, rawBody }) };
}

for (const change of ['pause', 'autonomy', 'settings']) test(`queued integration intake rechecks ${change} before creating a card`, async t => {
  const { h, conn, send } = await rig(t);
  const before = h.db.get('SELECT count(*) n FROM cards').n;
  let release, started;
  const held = h.hub.withBoard(h.ids.board, () => new Promise(r => { release = r; }));
  await new Promise(r => setImmediate(r));
  const admitted = new Promise(r => { started = r; }), create = h.app.api.createCard;
  h.app.api.createCard = function (...args) { const result = create.apply(this, args); started(); return result; };
  let delivery;
  try {
    delivery = send(); await admitted;
    if (change === 'pause') h.db.run("UPDATE connections SET status = 'paused' WHERE id = ?", conn.id);
    else h.app.integrations.setSettings(conn.id, change === 'autonomy' ? { autonomy: { 'sentry.card': 'off' } } : { config: { include_message: true } });
    release(); await held; await delivery;
    assert.equal(h.db.get('SELECT count(*) n FROM cards').n, before, 'old admission cannot outlive current connection settings');
    assert.equal(h.db.get('SELECT count(*) n FROM integration_requests WHERE connection_id = ?', conn.id).n, 0);
    if (change === 'pause') h.db.run("UPDATE connections SET status = 'active' WHERE id = ?", conn.id);
    else h.app.integrations.setSettings(conn.id, change === 'autonomy' ? { autonomy: { 'sentry.card': null } } : { config: { include_message: null } });
    assert.equal((await send()).status, 200);
    assert.equal(h.db.get('SELECT count(*) n FROM cards').n, before + 1, 'the same delivery succeeds once after current authority is restored');
    assert.equal((await send()).status, 200);
    assert.equal(h.db.get('SELECT count(*) n FROM cards').n, before + 1);
  } finally { release?.(); await held; if (delivery) await delivery; h.app.api.createCard = create; }
});

test('current actor refresh preserves an integration owner downgrade', async t => {
  const { h, conn } = await rig(t), owner = h.hub.member(h.db.get('SELECT created_by FROM connections WHERE id = ?', conn.id).created_by);
  assert.ok(h.hub.isAdmin(owner));
  const current = h.hub.actVia({ connection_id: conn.id, member_id: owner.id, name: 'Sentry' }, () => h.app.api.currentWriter(owner));
  assert.equal(current.role, 'member');
});
