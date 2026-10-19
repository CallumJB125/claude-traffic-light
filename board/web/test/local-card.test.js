// The first-run card on the local board: shown in local mode only, on the
// Board view, dismissible, no links or forms. Pure render, like render.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { textOf, byClass, byAttr } from '../js/h.js';
import { boardScreen, localCard } from '../js/render-board.js';
import { model } from './fixtures.js';

const card = (extra) => byClass(boardScreen(model([], { view: 'board', ...extra })), 'localcard');

test('local mode in the app: the card says what signing in gives you and has a Sign in or create a team button', () => {
  const [c] = card({ localCard: true, openTeam: true });
  assert.ok(c);
  assert.equal(c.tag, 'section');
  assert.equal(c.props['aria-labelledby'], 'localcard-title');
  const t = textOf(c);
  assert.match(t, /You’re on your local board/);
  assert.match(t, /Sign in to share this board with teammates/);
  assert.doesNotMatch(t, /sidebar/);
  const [b] = byAttr(c, 'data-action', 'open-team');
  assert.equal(b.tag, 'button');
  assert.match(b.props.class, /btn-primary/);
  assert.equal(textOf(b), 'Sign in or create a team');
  assert.equal(byAttr(c, 'data-action', 'local-card-dismiss').length, 1, 'dismissible');
});

test('local mode outside the app (no bridge): no button, and the text says where Team is', () => {
  const [c] = card({ localCard: true });
  assert.equal(byAttr(c, 'data-action', 'open-team').length, 0);
  assert.match(textOf(c), /open Team in the app’s sidebar/);
});

test('the app shows the button only with the desktop bridge and the click asks it for the Team page', () => {
  const src = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(src, /const canOpenTeam = \(\) => typeof globalThis\.plexiformDesktop\?\.openTeam === 'function';/);
  assert.match(src, /openTeam: canOpenTeam\(\),/);
  assert.match(src, /case 'open-team': if \(canOpenTeam\(\)\) globalThis\.plexiformDesktop\.openTeam\(\); return;/);
});

test('on a team hub (or before the mode is known) there is no card, and none off the Board view', () => {
  assert.equal(card({}).length, 0);
  assert.equal(card({ localCard: false }).length, 0);
  assert.equal(localCard(model([], { view: 'table', localCard: true })), null);
  assert.equal(localCard(model([], { view: 'integrations', localCard: true })), null);
});

test('no links, forms or inline styles in the card', () => {
  const [c] = card({ localCard: true, openTeam: true });
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
