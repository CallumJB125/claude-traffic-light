import test from 'node:test';
import assert from 'node:assert/strict';
import { textOf, byAttr } from '../js/h.js';
import { ownershipPanel, ownershipStatus } from '../js/render-ownership.js';
const entry = { run_id: 'run-current', card_key: 'PF-1', card_title: '<script>task</script>', paths: ['src/shared/**'],
  author: { name: '<img onerror=private>', provider_label: 'Codex' }, state: 'editing', expires_in_ms: 10000 };
const detail = { data: { card: {} }, ownershipLoaded: true, ownership: { ownership: entry, ownership_intents: [entry], ownership_overlaps: [] } };

test('lease freshness ages from the observed response and disappears at expiry or lost connection', () => {
  assert.match(ownershipStatus(entry, 9999), /fresh host signal/);
  assert.equal(ownershipStatus(entry, 10000), 'Heartbeat expired');
  assert.equal(ownershipStatus(entry, 0, false), 'Signal unavailable');
  assert.equal(ownershipStatus({ ...entry, expires_in_ms: null }), 'Heartbeat expired');
  assert.equal(ownershipStatus({ state: 'awaiting_review' }), 'Awaiting review');
});

test('coordination displays untrusted path/name/title text and grants no edit or file-lock action', () => {
  const rendered = ownershipPanel(detail, { conn: { status: 'open' } }, 5000), text = textOf(rendered);
  assert.match(text, /do not lock files or grant permission/); assert.match(text, /src\/shared\/\*\*/);
  assert.match(text, /<img onerror=private>/); assert.match(text, /<script>task<\/script>/);
  assert.deepEqual(byAttr(rendered, 'data-action').map(n => n.props['data-action']), ['ownership-reload']);
  assert.equal(textOf(ownershipPanel(detail, { conn: { status: 'lost' } })).includes('fresh host signal'), false);
});

test('failed and archived projections hide all previously loaded declared paths', () => {
  assert.equal(textOf(ownershipPanel({ ...detail, ownershipError: 'Sign in again' }, {})).includes('src/shared'), false);
  assert.equal(textOf(ownershipPanel({ ...detail, data: { card: { archived: true } } }, {})).includes('src/shared'), false);
});
