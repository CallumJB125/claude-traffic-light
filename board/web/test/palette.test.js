// ⌘K palette: fuzzy scoring, ranking, items, and the dialog's accessibility wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byClass, byAttr, textOf, findAll } from '../js/h.js';
import { displayFace } from '../js/view.js';
import { fuzzyMatch, fuzzyScore, rankItems, commandItems, cardItems, giveItems, paletteResults } from '../js/palette.js';
import { paletteDialog } from '../js/render-palette.js';
import { dialog } from '../js/render-dialogs.js';
import { emptyFilters } from '../js/filters.js';
import { view, model } from './fixtures.js';

const entry = (v) => ({ view: v, elapsed_ms: 0, face: displayFace(v) });
const running = entry(view({ id: 'a', key: 'BDL-12', title: 'Fix the login redirect' }));
const blocked = entry(view({ id: 'b', key: 'BDL-7', title: 'Approve the migration', run_state: 'blocked', blocked_kind: 'permission', ask: { kind: 'permission', summary: 'npm run migrate', count: 1 } }));
const todo = entry(view({ id: 'c', key: 'BDL-30', title: 'Write the docs', run_state: 'todo', column: 'todo', run: null, live: null, repo: null, branch: null }));
const entries = [running, blocked, todo];
const env = (over = {}) => ({ entries, view: 'board', readOnly: false, filters: emptyFilters(), ...over });

test('fuzzyScore: subsequence only, null when a letter is missing', () => {
  assert.equal(fuzzyScore('xyz', 'abc'), null);
  assert.equal(fuzzyScore('abcd', 'abc'), null, 'query longer than the text');
  assert.equal(fuzzyScore('', 'anything'), 0);
  assert.notEqual(fuzzyScore('bdl12', 'BDL-12 Fix login'), null);
  assert.notEqual(fuzzyScore('FIX', 'fix'), null, 'case-insensitive');
  assert.equal(fuzzyScore('ba', 'ab'), null, 'order matters');
});

test('fuzzyScore: prefix > inside a word, consecutive > scattered, exact > prefix, shorter wins', () => {
  const s = fuzzyScore;
  assert.ok(s('log', 'login page') > s('log', 'catalog page'), 'prefix beats inside a word');
  assert.ok(s('login', 'login page') > s('login', 'l-o-g-i-n page'), 'consecutive beats scattered');
  assert.ok(s('board', 'board') > s('board', 'board views'), 'exact beats prefix');
  assert.ok(s('tab', 'Table') > s('tab', 'Dashboard table'), 'earlier and shorter wins');
  assert.ok(s('gt', 'Go to Table') > s('gt', 'Agent suggestions'), 'word starts beat mid-word letters');
});

test('fuzzyMatch returns the matched positions in order (for highlighting)', () => {
  assert.deepEqual(fuzzyMatch('bdl12', 'BDL-12 Fix login').indices, [0, 1, 2, 4, 5]);
  assert.deepEqual(fuzzyMatch('fl', 'Fix login').indices, [0, 4], 'picks the word starts');
  assert.deepEqual(fuzzyMatch('', 'x').indices, []);
});

test('rankItems: a key outranks the same letters in a title; commands and cards mix', () => {
  const items = [...commandItems({ view: 'board', readOnly: false, filters: emptyFilters(), hasGive: true }), ...cardItems(entries)];
  assert.equal(rankItems(items, 'bdl-12')[0].item.id, 'card:a');
  assert.equal(rankItems(items, 'blocked')[0].item.run.chip, 'blocked', 'the "Show only: Blocked" command leads');
  assert.deepEqual(rankItems(items, 'zzzzqq'), []);
  assert.ok(rankItems(items, 'the').length >= 3, 'all three card titles contain "the"');
  assert.ok(rankItems(items, 'dark').some((x) => x.item.id === 'cmd:theme'), 'keywords find commands');
});

test('commands: views, theme, new card, give, filters; read-only viewers get no write commands', () => {
  const ids = commandItems({ view: 'board', readOnly: false, filters: emptyFilters(), hasGive: true }).map((c) => c.id);
  for (const id of ['cmd:view-board', 'cmd:view-table', 'cmd:view-dashboard', 'cmd:theme', 'cmd:new', 'cmd:give', 'cmd:filter-blocked', 'cmd:filter-mine']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('cmd:filter-clear'), 'nothing to clear yet');
  const ro = commandItems({ view: 'board', readOnly: true, filters: { ...emptyFilters(), q: 'x' }, hasGive: true }).map((c) => c.id);
  assert.ok(!ro.includes('cmd:new') && !ro.includes('cmd:give'));
  assert.ok(ro.includes('cmd:filter-clear'));
  const cur = commandItems({ view: 'table', readOnly: false, filters: emptyFilters(), hasGive: false }).find((c) => c.id === 'cmd:view-table');
  assert.equal(cur.hint, 'current');
});

test('cards: jump target, status hint, and a give action only where Claude can take it', () => {
  const items = cardItems(entries);
  assert.deepEqual(items.map((i) => i.run), [{ type: 'open-card', id: 'a' }, { type: 'open-card', id: 'b' }, { type: 'open-card', id: 'c' }]);
  assert.equal(items[0].give, null, 'a running card cannot be given');
  assert.deepEqual(items[2].give, { id: 'c', mode: 'dispatch' });
  assert.deepEqual(giveItems(entries).map((i) => i.run), [{ type: 'give', id: 'c', mode: 'dispatch' }]);
});

test('paletteResults: empty query lists commands then cards that need you first; give scope lists only giveable cards', () => {
  const r = paletteResults({ query: '', index: 0, scope: null }, env());
  assert.equal(r[0].item.kind, 'command');
  assert.equal(r.find((x) => x.item.kind === 'card').item.id, 'card:b', 'the blocked card comes first');
  assert.deepEqual(paletteResults({ query: '', index: 0, scope: 'give' }, env()).map((x) => x.item.id), ['give:c']);
  assert.equal(paletteResults({ query: 'docs', index: 0, scope: 'give' }, env()).length, 1);
  assert.equal(paletteResults({ query: 'redirect', index: 0, scope: 'give' }, env()).length, 0);
});

const dlg = (over = {}) => ({ kind: 'palette', query: '', index: 0, scope: null, ...over });
const modelFor = (over = {}) => model(entries, { view: 'board', filters: emptyFilters(), ...over });

test('dialog: role=dialog, a combobox input owning a listbox, aria-activedescendant on the selected option', () => {
  const v = paletteDialog(dlg({ index: 1 }), modelFor());
  assert.equal(v.tag, 'dialog');
  assert.equal(v.props.role, 'dialog');
  assert.equal(v.props['aria-modal'], 'true');
  assert.ok(v.props['aria-label']);
  const input = byAttr(v, 'data-input', 'palette-q')[0];
  assert.equal(input.props.role, 'combobox');
  assert.equal(input.props['aria-controls'], 'pal-list');
  assert.equal(input.props.autofocus, true, 'app.js focuses it when the dialog opens');
  assert.equal(findAll(v, (n) => n.props.role === 'listbox')[0].props.id, 'pal-list');
  const opts = findAll(v, (n) => n.props.role === 'option');
  const selected = opts.filter((o) => o.props['aria-selected'] === 'true');
  assert.equal(selected.length, 1);
  assert.equal(input.props['aria-activedescendant'], selected[0].props.id);
  assert.equal(selected[0].props.id, 'pal-opt-1');
  assert.equal(new Set(opts.map((o) => o.props.id)).size, opts.length, 'unique option ids');
});

test('dialog: typing narrows the list, highlights the match, and an overlong index is clamped', () => {
  const v = paletteDialog(dlg({ query: 'mig', index: 99 }), modelFor());
  const opts = findAll(v, (n) => n.props.role === 'option');
  assert.ok(opts.length >= 1);
  assert.match(textOf(opts[0]), /BDL-7 Approve the migration/);
  assert.ok(byClass(opts[0], 'pal-hit').length >= 1);
  assert.equal(byAttr(v, 'data-input', 'palette-q')[0].props['aria-activedescendant'], `pal-opt-${opts.length - 1}`);
  const none = paletteDialog(dlg({ query: 'zzzqq' }), modelFor());
  assert.equal(byAttr(none, 'data-input', 'palette-q')[0].props['aria-activedescendant'], null);
  assert.match(textOf(none), /Nothing matches/);
});

test('dialog: rows are click targets, the footer teaches ⌘↵, and the give step says what it is', () => {
  const v = paletteDialog(dlg(), modelFor());
  const rows = byAttr(v, 'data-action', 'palette-run');
  assert.ok(rows.length > 3);
  assert.equal(rows[0].props['data-index'], '0');
  assert.match(textOf(byClass(v, 'pal-foot')[0]), /tackle card with AI/);
  const g = paletteDialog(dlg({ scope: 'give' }), modelFor());
  assert.match(g.props['aria-label'], /Tackle a card with AI/);
  assert.doesNotMatch(textOf(byClass(g, 'pal-foot')[0]), /give card/);
  assert.match(textOf(paletteDialog(dlg({ scope: 'give', query: 'zzz' }), modelFor())), /No card can be assigned to an AI right now/);
});

test('render-dialogs routes the palette kind', () => {
  assert.equal(dialog(modelFor({ dialog: dlg() })).props['data-dialog'], 'palette');
});
