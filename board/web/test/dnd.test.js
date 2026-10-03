// Drag and drop as pure logic: move planning, where a card lands, selection,
// the keyboard state machine, and what the board renders for each.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byClass, textOf, findAll } from '../js/h.js';
import { displayFace, columnFor } from '../js/view.js';
import { column, boardScreen, card } from '../js/render-board.js';
import {
  planMoves, moveSummary, dropSlot, dragModel, toggleSelection, pruneSelection, idsToDrag, selectionBar,
  kbdStart, kbdKey, announcement,
} from '../js/dnd.js';
import { view, model } from './fixtures.js';

const human = (id, extra = {}) => view({ id, key: id.toUpperCase(), run_state: 'todo', run: null, live: null, column: 'todo', state_age_ms: 1000, ...extra });
const agent = (id, extra = {}) => view({ id, key: id.toUpperCase(), ...extra });
const entry = (v) => ({ view: v, elapsed_ms: 0, face: displayFace(v) });
const lookup = (...vs) => { const m = new Map(vs.map((v) => [v.id, v])); return (id) => m.get(id); };

test('planMoves: human cards move, same-column ones are unchanged, run-driven ones are skipped with a reason', () => {
  const a = human('a');
  const b = human('b', { column: 'in_review' });
  const c = agent('c');
  const plan = planMoves(['a', 'b', 'c', 'gone'], lookup(a, b, c), 'in_review');
  assert.deepEqual(plan.moves.map((m) => [m.id, m.from]), [['a', 'todo']]);
  assert.deepEqual(plan.unchanged, ['b']);
  assert.deepEqual(plan.skipped, [{ id: 'c', key: 'C', reason: 'run' }]);
});

test('planMoves: an observed card whose AI is still reporting work can move between open columns but never to Done', () => {
  const capture = { source: 'local_observation', fresh: true, status: 'working' };
  const w = human('w', { column: 'in_progress', capture });
  const plan = planMoves(['w'], lookup(w), 'done');
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.skipped, [{ id: 'w', key: 'W', reason: 'working' }]);
  assert.match(moveSummary(plan, 'done'), /Skipped W: an AI is still working/);
  assert.equal(dragModel({ ids: ['w'], over: 'done' }, [entry(w)]).ok, false);
  assert.equal(planMoves(['w'], lookup(w), 'in_review').moves.length, 1);
  const stale = human('s', { column: 'in_progress', capture: { ...capture, fresh: false, status: 'unknown' } });
  assert.equal(planMoves(['s'], lookup(stale), 'done').moves.length, 1, 'a stale report no longer holds the card');
  // A person's earlier Done does not hide live work: it renders in In progress.
  const done = human('d', { column: 'done', capture });
  assert.equal(columnFor(done, displayFace(done)), 'in_progress');
  assert.equal(columnFor({ ...done, capture: { ...capture, status: 'review' } }, displayFace(done)), 'done');
});

test('moveSummary: one sentence for a move, a partial move and a no-op', () => {
  const plan = planMoves(['a', 'c'], lookup(human('a'), agent('c')), 'done');
  assert.match(moveSummary(plan, 'done'), /^Moved A to Done\. Skipped C: Claude drives its column/);
  const many = planMoves(['a', 'b', 'c'], lookup(human('a'), human('b'), human('c')), 'in_review');
  assert.equal(moveSummary(many, 'in_review'), 'Moved 3 cards to Review.');
  const none = planMoves(['a'], lookup(human('a')), 'todo');
  assert.equal(moveSummary(none, 'todo'), 'Already in To do.');
});

test('dropSlot: the moved card lands where the derived order puts it (recency within rank)', () => {
  const old = human('old', { column: 'in_review', state_age_ms: 9000 });
  const mid = human('mid', { column: 'in_review', state_age_ms: 5000 });
  const fresh = human('fresh', { column: 'in_review', state_age_ms: 100 });
  const mover = human('mover', { column: 'todo', state_age_ms: 6000 });
  const entries = [old, mid, fresh, mover].map(entry);
  assert.deepEqual(dropSlot(entries, ['mover'], 'in_review'), { before: 'old' }, 'older than mid, newer than old: sits above the older one');
  const last = human('last', { column: 'todo', state_age_ms: 99_000 });
  assert.deepEqual(dropSlot([...entries, entry(last)], ['last'], 'in_review'), { before: null }, 'oldest goes to the end');
  assert.deepEqual(dropSlot([entry(mover)], ['mover'], 'done'), { before: null }, 'empty column');
});

test('dragModel: nothing held over a column yet, droppable, and run-driven only', () => {
  const a = human('a');
  const r = agent('r', { column: 'in_progress' });
  const entries = [a, r].map(entry);
  assert.equal(dragModel({ ids: ['a'], over: null }, entries).ok, false);
  const over = dragModel({ ids: ['a'], over: 'done', mode: 'pointer' }, entries);
  assert.equal(over.ok, true);
  assert.equal(over.before, null);
  const runOnly = dragModel({ ids: ['r'], over: 'done' }, entries);
  assert.equal(runOnly.ok, false);
  assert.equal(runOnly.plan.skipped.length, 1);
  assert.equal(dragModel({ ids: ['a'], over: 'todo' }, entries).ok, false, 'same column is not a drop');
});

test('selection: toggle is immutable, prune drops vanished ids, dragging a selected card carries them all', () => {
  const s0 = new Set();
  const s1 = toggleSelection(s0, 'a');
  assert.equal(s0.size, 0);
  assert.deepEqual([...toggleSelection(s1, 'b')], ['a', 'b']);
  assert.equal(toggleSelection(s1, 'a').size, 0);
  const s2 = new Set(['a', 'b']);
  assert.equal(pruneSelection(s2, ['a', 'b', 'c']), s2, 'unchanged selection keeps identity');
  assert.deepEqual([...pruneSelection(s2, ['b'])], ['b']);
  assert.deepEqual(idsToDrag(s2, 'a'), ['a', 'b']);
  assert.deepEqual(idsToDrag(s2, 'z'), ['z'], 'a card outside the selection drags alone');
  const bar = selectionBar(new Set(['a', 'r']), lookup(human('a'), agent('r')));
  assert.deepEqual({ n: bar.count, m: bar.movable, s: bar.skipped, t: bar.text }, { n: 2, m: 1, s: 1, t: '2 selected' });
});

test('keyboard: arrows walk the columns without wrapping, Space drops, Esc cancels', () => {
  let st = kbdStart(['a'], 'todo');
  let r = kbdKey(st, 'ArrowLeft');
  assert.equal(r.state.over, 'todo');
  assert.equal(r.effect.edge, true, 'already leftmost');
  r = kbdKey(r.state, 'ArrowRight');
  r = kbdKey(r.state, 'ArrowRight');
  assert.equal(r.state.over, 'in_review');
  assert.deepEqual(r.effect, { type: 'over', column: 'in_review', edge: false });
  const drop = kbdKey(r.state, ' ');
  assert.equal(drop.state, null);
  assert.deepEqual(drop.effect, { type: 'drop', column: 'in_review' });
  assert.deepEqual(kbdKey(r.state, 'Enter').effect, { type: 'drop', column: 'in_review' });
  const cancel = kbdKey(r.state, 'Escape');
  assert.equal(cancel.state, null);
  assert.equal(cancel.effect.type, 'cancel');
  const other = kbdKey(r.state, 'q');
  assert.equal(other.effect, null);
  assert.equal(other.state, r.state, 'unrelated keys leave the lift alone');
  assert.equal(kbdKey(kbdStart(['a'], 'done'), 'ArrowRight').effect.edge, true);
});

test('keyboard: dropping where it started is a cancel, not a move', () => {
  const r = kbdKey(kbdStart(['a'], 'in_progress'), ' ');
  assert.deepEqual(r.effect, { type: 'cancel', dropped: true });
});

test('announcements name the card and the column', () => {
  assert.match(announcement({ type: 'pickup' }, { key: 'BDL-12' }), /^Picked up BDL-12\./);
  assert.equal(announcement({ type: 'over', column: 'in_review', edge: false }, { key: 'BDL-12', over: 'in_review' }), 'BDL-12 over Review.');
  assert.match(announcement({ type: 'over', edge: true }, { key: 'BDL-12', over: 'todo' }), /^To do\. No column further/);
  assert.equal(announcement({ type: 'drop' }, { key: 'BDL-12', over: 'in_review' }), 'Moved BDL-12 to Review.');
  assert.equal(announcement({ type: 'drop' }, { key: 'BDL-12', over: 'in_review', count: 3 }), 'Moved 3 cards to Review.');
  assert.equal(announcement({ type: 'cancel' }, { key: 'BDL-12', from: 'todo' }), 'Cancelled. BDL-12 stays in To do.');
});

// ── what the board renders ──────────────────────────────────────────────────

test('cards: only human-owned ones carry data-draggable', () => {
  const m = model([]);
  assert.equal(card(entry(agent('r')), m).props['data-draggable'], null);
  assert.equal(card(entry(human('a')), m).props['data-draggable'], 'true');
  assert.equal(card(entry(human('a')), model([], { readOnly: true })).props['data-draggable'], null, 'viewers cannot move cards');
});

test('column: a droppable hover lights the column and draws one line at the derived slot', () => {
  const a = human('a', { column: 'todo', state_age_ms: 6000 });
  const x = human('x', { column: 'in_review', state_age_ms: 9000 });
  const y = human('y', { column: 'in_review', state_age_ms: 4000 });
  const entries = [a, x, y].map(entry);
  const drag = dragModel({ ids: ['a'], over: 'in_review', mode: 'pointer' }, entries);
  const m = model(entries, { drag, selection: new Set() });
  const col = column('in_review', [y, x].map(entry), m);
  assert.match(col.props.class, /is-drop/);
  const body = byClass(col, 'column-body')[0];
  const order = body.children.map((c) => c.props.key);
  assert.deepEqual(order, ['y', 'drop-line', 'x'], 'a is older than y and newer than x');
  assert.equal(byClass(column('todo', [entry(a)], m), 'drop-line').length, 0, 'the source column shows no line');
  assert.equal(byClass(column('done', [], m), 'drop-line').length, 0);
});

test('column: dropping on a run-driven-only hold shows the not-allowed state', () => {
  const r = agent('r', { column: 'in_progress' });
  const entries = [entry(r)];
  const m = model(entries, { drag: dragModel({ ids: ['r'], over: 'done' }, entries) });
  assert.match(column('done', [], m).props.class, /is-drop-none/);
});

test('no multi-select bulk bar: a selection set never renders bulk actions', () => {
  const entries = [human('a'), human('b')].map(entry);
  const screen = boardScreen(model(entries, { selection: new Set(['a', 'b']) }));
  assert.equal(byClass(screen, 'selbar').length, 0);
  assert.equal(findAll(screen, (n) => n.props['data-change'] === 'bulk-move').length, 0);
});

test('the board has a live region for announcements and a hint for assistive tech', () => {
  const screen = boardScreen(model([], { announce: 'Moved BDL-12 to Review.' }));
  const live = findAll(screen, (n) => n.props['aria-live'] === 'assertive');
  assert.equal(live.length, 1);
  assert.equal(textOf(live[0]), 'Moved BDL-12 to Review.');
  assert.equal(findAll(screen, (n) => n.props.id === 'dnd-help').length, 1);
});
