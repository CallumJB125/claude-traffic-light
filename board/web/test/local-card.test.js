// The first-run card on the local board: shown in local mode only, on the
// Board view, dismissible, text only. Pure render, like render.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { textOf, byClass, byAttr } from '../js/h.js';
import { boardScreen, localCard } from '../js/render-board.js';
import { model } from './fixtures.js';

const card = (extra) => byClass(boardScreen(model([], { view: 'board', ...extra })), 'localcard');

test('local mode: the card says you are on the local board, to create a team, and where', () => {
  const [c] = card({ localCard: true });
  assert.ok(c);
  assert.equal(c.tag, 'section');
  assert.equal(c.props['aria-labelledby'], 'localcard-title');
  const t = textOf(c);
  assert.match(t, /You’re on your local board/);
  assert.match(t, /Create a team to collaborate/);
  assert.match(t, /Open Team in the sidebar/);
  assert.match(t, /team hub/);
  assert.equal(byAttr(c, 'data-action', 'local-card-dismiss').length, 1, 'dismissible');
});

test('on a team hub (or before the mode is known) there is no card, and none off the Board view', () => {
  assert.equal(card({}).length, 0);
  assert.equal(card({ localCard: false }).length, 0);
  assert.equal(localCard(model([], { view: 'table', localCard: true })), null);
  assert.equal(localCard(model([], { view: 'integrations', localCard: true })), null);
});

test('text only: no links, forms or inline styles in the card', () => {
  const [c] = card({ localCard: true });
  const all = JSON.stringify(c);
  assert.ok(!/"tag":"(a|form|input)"/.test(all) && !all.includes('"style"'));
});

test('the app shows it for auth=local only, remembers a dismissal in localStorage inside try/catch, never requires it', () => {
  const src = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(src, /localCard: state\.authMode === 'local' && !state\.localCardDismissed,/);
  assert.match(src, /case 'local-card-dismiss':\n\s+state\.localCardDismissed = true;\n\s+try \{ localStorage\.setItem\('board-local-card', 'dismissed'\); \} catch/);
  assert.match(src, /try \{ state\.localCardDismissed = localStorage\.getItem\('board-local-card'\) === 'dismissed'; \} catch \{ state\.localCardDismissed = false; \}/);
  assert.match(src, /\nloadLocalCard\(\);\n/);
});
