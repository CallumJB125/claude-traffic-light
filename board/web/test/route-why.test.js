// Why a card is on this board (main's answer from src/board-why-view.js, via the app's bridge):
// the chip and its fix on a card, a muted pointer card, the "waiting for the team hub" banner,
// and the local card for a solo person versus someone who already has a team.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { textOf, byClass, byAttr } from '../js/h.js';
import { card, boardScreen, routeChip, routePendingBanner, localCard } from '../js/render-board.js';
import { displayFace } from '../js/view.js';
import { model, view } from './fixtures.js';

const rendered = (v, routes) => card({ view: v, face: displayFace(v), elapsed_ms: 0 }, model([], { routes }));

test('a card with a reason shows it, with its fix as a button that names the reason', () => {
  const v = view();
  const n = rendered(v, { cards: { 'c-1': { label: 'Repo not linked', tone: 'muted', title: 'Not linked to any team board.', fix: { id: 'link', label: 'Link to a team…' } } }, pending: 0 });
  const [chip] = byClass(n, 'route-why');
  assert.ok(chip);
  assert.equal(chip.props['data-tone'], 'muted');
  assert.match(textOf(chip), /On this board because: Repo not linked/);
  const [fix] = byAttr(chip, 'data-action', 'route-fix');
  assert.equal(fix.tag, 'button');
  assert.equal(fix.props['data-fix'], 'link');
  assert.equal(fix.props['data-card'], 'c-1');
  assert.equal(fix.props['aria-label'], 'Link to a team: Repo not linked');
});

test('no bridge, no answer or another card: nothing extra on the card', () => {
  const v = view();
  assert.equal(byClass(rendered(v, null), 'route-why').length, 0);
  assert.equal(byClass(rendered(v, { cards: { other: { label: 'x', tone: 'team' } } }), 'route-why').length, 0);
  assert.equal(routeChip({ label: '' }, v), null);
});

test('an unknown tone or fix from main is not trusted', () => {
  const n = routeChip({ label: 'Hi', tone: 'evil', fix: { id: 'rm -rf', label: 'Do it' } }, view());
  assert.equal(n.props['data-tone'], 'muted');
  assert.equal(byAttr(n, 'data-action', 'route-fix').length, 0);
});

test('a pointer card is muted and has no way in: no open button, no actions, no repo', () => {
  const v = view({ title: 'Codex · hand-off running in another team’s repo' });
  const n = rendered(v, { cards: { 'c-1': { label: 'Hand-off in another team’s repo', tone: 'muted', pointer: true, fix: null, title: 'details stay' } } });
  assert.match(n.props.class, /\bis-pointer\b/);
  assert.equal(byAttr(n, 'data-action', 'open').length, 0);
  assert.equal(byClass(n, 'card-actions').length, 0);
  assert.equal(byClass(n, 'card-repo').length, 0);
  assert.match(textOf(n), /details stay with the asker/);
});

test('the banner counts cards waiting for the team hub, only on the Board view', () => {
  assert.equal(routePendingBanner(model([], { view: 'board', routes: { cards: {}, pending: 0 } })), null);
  const b = routePendingBanner(model([], { view: 'board', routes: { cards: {}, pending: 2 } }));
  assert.equal(b.props.role, 'status');
  assert.match(textOf(b), /2 cards waiting to reach the team board/);
  assert.match(textOf(routePendingBanner(model([], { view: 'board', routes: { pending: 1 } }))), /1 card waiting to reach the team board\. .*it belongs on, so it stays here/);
  assert.equal(routePendingBanner(model([], { view: 'table', routes: { pending: 3 } })), null);
  assert.equal(byClass(boardScreen(model([], { view: 'board', routes: { cards: {}, pending: 1 } })), 'banner-route').length, 1);
});

test('solo in the app: one gentle "Invite your team"; with a team already: no sign-in pitch on My board', () => {
  const solo = localCard(model([], { view: 'board', localCard: true, openTeam: true, solo: true }));
  assert.match(textOf(solo), /Just you for now/);
  const [b] = byAttr(solo, 'data-action', 'open-team');
  assert.equal(textOf(b), 'Invite your team');
  assert.doesNotMatch(textOf(solo), /hub|offline|sign in/i);
  assert.equal(localCard(model([], { view: 'board', localCard: true, openTeam: true, solo: false })), null);
});

test('the app asks main again when cards change or main says routing changed, and fixes go through the bridge', () => {
  const src = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(src, /if \(state\.cardsRev !== routesRev && state\.board\) routesSoon\(\);/);
  assert.match(src, /globalThis\.plexiformDesktop\?\.onCardRoutesChanged\?\.\(\(\) => routesSoon\(50\)\);/);
  assert.match(src, /case 'route-fix': if \(el\.dataset\.fix === 'session'\) \{ if \(cardId\) localSessionAction\(cardId, 'open'\); \} else globalThis\.plexiformDesktop\?\.routeFix\?\.\(el\.dataset\.fix\); return;/);
});
