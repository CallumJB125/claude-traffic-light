// Pure render helpers over cardFace (CONTRACT §13 "web/test/render.test.js").
// Render functions return plain vnode trees, so no DOM framework is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { textOf, byClass, byAttr, findAll, walk } from '../js/h.js';
import { displayFace, groupColumns, alertsForViewer, stripGlyph, boardLamps, columnFor } from '../js/view.js';
import { card, pill, alertsStrip, connectionBanner, boardScreen, cardActions } from '../js/render-board.js';
import { drawer, handoverBody } from '../js/render-drawer.js';
import { giveDialog, confirmDialog } from '../js/render-dialogs.js';
import { signinScreen } from '../js/render-signin.js';
import { TTL_MS, T_QUIET_MS } from '../../shared/liveness.js';
import { view, live, model, ALICE } from './fixtures.js';

const entry = (v, opts = {}) => ({ view: v, elapsed_ms: opts.elapsed_ms ?? 0, face: displayFace(v, opts) });

// ── D13: green only when the hub and the aged client recomputation agree ──

test('green when hub and client agree', () => {
  const f = displayFace(view());
  assert.equal(f.green, true);
  assert.equal(f.tone, 'green');
  assert.equal(f.label, 'Running');
});

test('hub says not green, client says green → not green (quiet tone, still Running)', () => {
  const f = displayFace(view({ live: live({ green: false }) }));
  assert.equal(f.client_green, true);
  assert.equal(f.green, false);
  assert.equal(f.tone, 'quiet');
  assert.equal(f.disagree, true);
});

test('hub says green, but ages advanced past the predicate → client wins, not green', () => {
  const f = displayFace(view({ live: live({ green: true, tool_in_flight: null, activity_age_ms: T_QUIET_MS - 10_000 }) }), { elapsed_ms: 20_000 });
  assert.equal(f.green, false);
  assert.equal(f.label, 'Quiet');
  const g = displayFace(view(), { elapsed_ms: TTL_MS });
  assert.equal(g.green, false);
  assert.equal(g.label, 'No signal');
});

test('connection lost: never green, never marked unresponsive by the browser', () => {
  const f = displayFace(view(), { elapsed_ms: TTL_MS * 10, connection_lost: true });
  assert.equal(f.green, false);
  assert.equal(f.tone, 'unknown');
  assert.equal(f.label, 'Running');
});

// ── card face ─────────────────────────────────────────────────────────────

test('card renders key, repo@branch, pill label + reason, sponsor, activity, budget', () => {
  const v = view({ overlaps: [{ other_card_id: 'c-2', other_key: 'BDL-2', other_owner: 'Bob', level: 'high', kind: 'overlapping', reasons: [], paths: ['src/api/deals.ts'], age_ms: 0 }] });
  const n = card(entry(v), model([]));
  const t = textOf(n);
  assert.match(t, /BDL-1/);
  assert.match(t, /bondly@board\/BDL-1-r2/);
  assert.match(textOf(byClass(n, 'pill')[0]), /^Running.*Alice's Claude · editing deals\.ts$/);
  assert.match(t, /Runs on Alice's MacBook Pro · Alice's claude account/);
  assert.match(t, /Alice's Claude · 5s ago/);
  assert.match(t, /\$1\.20\/\$5/);
  const chip = byClass(n, 'chip-overlap')[0];
  assert.equal(textOf(chip), 'overlaps BDL-2 · deals.ts', 'the ⚠ glyph is drawn as an icon, not text');
});

test('only a card green by both clocks gets the breathing lamp', () => {
  const on = pill(displayFace(view()));
  const off = pill(displayFace(view({ live: live({ green: false }) })));
  assert.equal(on.props['data-green'], '');
  assert.equal(off.props['data-green'], null);
});

test('pill keys by label so a state change re-creates it (the fade), a tick only patches text', () => {
  assert.equal(pill(displayFace(view())).key, undefined);
  assert.equal(pill(displayFace(view())).props.key, 'pill-running');
  assert.equal(pill(displayFace(view({ run_state: 'failed', fail_kind: 'limit', live: null }))).props.key, 'pill-failed_limit');
});

test('agent-driven cards are never draggable; human-owned cards are', () => {
  const agent = card(entry(view()), model([]));
  const human = card(entry(view({ run_state: 'todo', run: null, live: null, column: 'in_progress' })), model([]));
  assert.equal(agent.props['data-draggable'], null);
  assert.equal(human.props['data-draggable'], 'true');
});

test('column: human cards keep their column, run-state cards derive it', () => {
  const human = view({ run_state: 'todo', run: null, live: null, column: 'in_review' });
  const agent = view({ column: 'todo' });
  assert.equal(columnFor(human, displayFace(human)), 'in_review');
  assert.equal(columnFor(agent, displayFace(agent)), 'in_progress');
  const cols = groupColumns([entry(human), entry(agent), entry(view({ id: 'c-3', run_state: 'done', live: null }))]);
  assert.deepEqual([cols.todo.length, cols.in_progress.length, cols.in_review.length, cols.done.length], [0, 1, 1, 1]);
});

test('blocked first inside a column', () => {
  const cols = groupColumns([entry(view({ id: 'a' })), entry(view({ id: 'b', run_state: 'blocked', blocked_kind: 'question', ask: { kind: 'question', summary: 'x', count: 1 } }))]);
  assert.deepEqual(cols.in_progress.map((e) => e.view.id), ['b', 'a']);
});

test('stop and cancel are never the filled primary button', () => {
  const n = cardActions(displayFace(view({ run_state: 'queued', run: null, live: null, target: { member_id: 'm-alice', name: 'Alice', is_viewer: true, awaiting_confirm: false } })), view(), new Set());
  const btn = findAll(n, (x) => x.props['data-action'] === 'cancel')[0];
  assert.doesNotMatch(btn.props.class, /btn-primary/);
  assert.match(btn.props.class, /btn-quiet-danger/);
});

test('permission-blocked card without approval rights shows no answer buttons', () => {
  const v = view({ run_state: 'blocked', blocked_kind: 'permission', ask: { kind: 'permission', summary: 'npm run migrate', count: 2 }, viewer_can_approve: false });
  const n = card(entry(v), model([]));
  assert.equal(byClass(n, 'card-actions').length, 0);
  assert.match(textOf(n), /2 req/);
});

test('agent- and human-written text is only ever text (D25)', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(1)</script>';
  const n = card(entry(view({ title: evil, labels: [evil] })), model([]));
  assert.ok(textOf(n).includes(evil));
  walk(n, (x) => {
    assert.ok(!('innerHTML' in x.props) && !('outerHTML' in x.props), 'no html props');
    assert.notEqual(x.tag, 'script');
    assert.notEqual(x.tag, 'img', 'the title never becomes an element');
  });
});

// ── alerts strip, banner, lamps ───────────────────────────────────────────

test('alerts: viewer-scoped, glyph stripped, newest first, max 5 + more', () => {
  const blocked = (i) => view({ id: `b${i}`, key: `BDL-${i}`, run_state: 'blocked', blocked_kind: 'permission', ask: { kind: 'permission', count: 1 }, approvers: ['m-alice'], state_age_ms: i * 1000 });
  const entries = [1, 2, 3, 4, 5, 6, 7].map((i) => entry(blocked(i)));
  const a = alertsForViewer('m-alice', entries);
  assert.equal(a.items.length, 5);
  assert.equal(a.more, 2);
  assert.equal(a.items[0].text, 'BDL-1 needs you · approval waiting');
  const strip = alertsStrip(a, model([]));
  assert.equal(findAll(strip, (x) => x.tag === 'li').length, 6);
  assert.match(textOf(strip), /\+2 more/);
  assert.equal(alertsForViewer('m-bob', entries).items.length, 0, 'not involved → no alert');
});

test('orphaned alert appears only after ≥ 10 min (N-rules)', () => {
  const o = (age) => entry(view({ run_state: 'orphaned', live: null, state_age_ms: age }));
  assert.equal(alertsForViewer('m-alice', [o(9 * 60_000)]).items.length, 0);
  assert.equal(alertsForViewer('m-alice', [o(11 * 60_000)]).items.length, 1);
  assert.equal(alertsForViewer('m-alice', [{ ...o(9 * 60_000), elapsed_ms: 2 * 60_000 }]).items.length, 1, 'uses the aged state age');
});

test('stripGlyph removes the leading cardface glyph only', () => {
  assert.equal(stripGlyph('✋ BDL-1 needs you'), 'BDL-1 needs you');
  assert.equal(stripGlyph('⚠ overlaps BDL-2'), 'overlaps BDL-2');
  assert.equal(stripGlyph('✖ BDL-3 orphaned · take over'), 'BDL-3 orphaned · take over');
  assert.equal(stripGlyph('BDL-4 ✓ done'), 'BDL-4 ✓ done');
});

test('connection lost: one banner with the frozen time, alerts hidden, lamps dark', () => {
  const lostAt = new Date(2026, 8, 30, 14, 32, 5);
  const b = connectionBanner({ status: 'lost', lostAt, retryInMs: 3200 });
  assert.match(textOf(b), /^Board connection lost: states as of 14:32:05\.Reconnecting in 4s/);
  const m = model([entry(view(), { connection_lost: true })], { conn: { status: 'lost', lostAt, retryInMs: null } });
  const screen = boardScreen(m);
  assert.equal(byClass(screen, 'banner-lost').length, 1);
  assert.equal(byClass(screen, 'alerts').length, 0);
  assert.doesNotMatch(textOf(screen), /No signal/);
  assert.equal(findAll(screen, (x) => /\blit\b/.test(x.props.class ?? '')).length, 0);
  assert.equal(connectionBanner({ status: 'open' }), null);
});

test('header lamps mirror the widget: green only for verified-green work', () => {
  assert.deepEqual(boardLamps('m-alice', [entry(view())], false), { red: false, amber: false, green: true });
  assert.deepEqual(boardLamps('m-alice', [entry(view({ live: live({ green: false }) }))], false).green, false);
});

// ── drawer ─────────────────────────────────────────────────────────────────

function drawerModel(v, data, extra = {}) {
  const e = entry(v);
  return model([e], { detail: { cardId: v.id, data: { card: v, feed: [], comments: [], asks: [], permission_requests: [], ...data }, elapsed_ms: 0, tab: 'activity' }, ...extra });
}

test('drawer: approver gets Allow once / Allow for this run / Deny; others see who can answer', () => {
  const v = view({ run_state: 'blocked', blocked_kind: 'permission', ask: { kind: 'permission', summary: 'npm run migrate', count: 1 }, approvers: ['m-alice', 'm-bob'], viewer_can_approve: true });
  const pr = { id: 'pr-1', tool: 'Bash', input_summary: 'npm run migrate', state: 'open', approvers: ['m-alice', 'm-bob'] };
  const mine = drawer(drawerModel(v, { permission_requests: [pr] }));
  const buttons = byAttr(mine, 'data-action', 'permission').map(textOf);
  assert.deepEqual(buttons, ['Allow once', 'Allow for this run', 'Deny']);
  assert.match(textOf(mine), /First answer wins\./);
  const theirs = drawer(drawerModel(v, { permission_requests: [{ ...pr, approvers: ['m-bob'] }] }));
  assert.equal(byAttr(theirs, 'data-action', 'permission').length, 0);
  assert.match(textOf(theirs), /Waiting for Bob/);
  const done = drawer(drawerModel(v, { permission_requests: [{ ...pr, state: 'allowed', answered_by_name: 'Sam' }] }));
  assert.match(textOf(done), /Allowed by Sam/);
});

test('drawer: the actions that only open the drawer are not repeated inside it', () => {
  const v = view({ run_state: 'blocked', blocked_kind: 'question', ask: { kind: 'question', count: 1 } });
  const n = drawer(drawerModel(v, {}));
  assert.equal(byAttr(n, 'data-action', 'answer').length, 0);
  assert.equal(byAttr(n, 'data-action', 'hand_over').length, 1, 'Hand over is offered from blocked');
});

test('drawer: Hand over, Switch AI and Request changes sit behind a closed Advanced disclosure', () => {
  const v = view({ run_state: 'blocked', blocked_kind: 'question', ask: { kind: 'question', count: 1 } });
  const n = drawer(drawerModel(v, {}));
  const adv = byClass(n, 'drawer-advanced');
  assert.equal(adv.length, 1);
  assert.equal(adv[0].tag, 'details');
  assert.equal(adv[0].props.open, undefined);
  assert.equal(byAttr(adv[0], 'data-action', 'hand_over').length, 1);
  assert.equal(byAttr(adv[0], 'data-action', 'planning-edit').length, 1);
  const review = view({ run_state: 'in_review', live: null, run: { ...view().run, child_alive: false } });
  const r = drawer(drawerModel(review, {}));
  for (const a of displayFace(review).actions.filter((x) => ['switch_ai', 'request_changes'].includes(x))) {
    assert.equal(byAttr(r, 'data-action', a).length, 1);
    assert.equal(byAttr(byClass(r, 'drawer-advanced')[0], 'data-action', a).length, 1, `${a} only in Advanced`);
  }
});

test('drawer: Mark done stays hidden while the run ended on the hub but its AI process is still alive', () => {
  const base = view().run;
  const finishing = view({ run_state: 'in_review', live: null, run: { ...base, child_alive: true } });
  const f = drawer(drawerModel(finishing, {}));
  assert.equal(byAttr(f, 'data-action', 'approve_done').length, 0);
  assert.match(textOf(f), /The AI is still finishing/);
  const exited = view({ run_state: 'in_review', live: null, run: { ...base, child_alive: false } });
  assert.equal(byAttr(drawer(drawerModel(exited, {})), 'data-action', 'approve_done').length, 1);
});

test('drawer: an observed card with a fresh working capture has no Column picker; once stale it does', () => {
  const capture = { source: 'local_observation', fresh: true, status: 'working', provider: 'claude' };
  const live = view({ run_state: 'todo', run: null, live: null, column: 'done', capture });
  assert.equal(byAttr(drawer(drawerModel(live, {})), 'data-change', 'move').length, 0);
  assert.equal(columnFor(live, displayFace(live)), 'in_progress', 'renders in In progress, not Done');
  const stale = view({ run_state: 'todo', run: null, live: null, column: 'in_progress', capture: { ...capture, fresh: false, status: 'unknown' } });
  assert.equal(byAttr(drawer(drawerModel(stale, {})), 'data-change', 'move').length, 1);
});

test('drawer: pinned hypothesis and per-layer last synced ages advance client-side', () => {
  const v = view();
  const handover = { doc: { sections: { hypothesis: 'Draft keyed by anon id.' }, layers: { facts: {}, narrative: { version: 4 }, snapshot: { sha: '7f3a2c1d', status: 'pushed' } }, unsynced_paths: ['a.ts'] }, ages: { facts_ms: 10_000, narrative_ms: 60_000, snapshot_ms: 120_000 }, markdown: '# Handover · BDL-1\nState: running\nLast synced: stale\n\n## Goal\nFix it' };
  const m = drawerModel(v, { handover });
  m.detail.tab = 'handover';
  m.detail.elapsed_ms = 5000;
  const t = textOf(drawer(m));
  assert.match(t, /Current hypothesisDraft keyed by anon id\./);
  assert.match(t, /Facts15s ago/);
  assert.match(t, /Narrativev4 · 1m ago/);
  assert.match(t, /Code7f3a2c1 · 2m ago · pushed/);
  assert.match(t, /1 file changed after the last snapshot/);
  assert.doesNotMatch(t, /Last synced: stale/);
});

test('handoverBody drops the hub title and send-time "Last synced" line only', () => {
  assert.equal(handoverBody('# Handover · K t\nState: x\nLast synced: y\n\n## Goal\nLast synced: keep me'), 'State: x\n\n## Goal\nLast synced: keep me');
});

// ── dialogs ────────────────────────────────────────────────────────────────

test('Tackle with AI: own Codex account by default, sponsor and overlaps shown before dispatch', () => {
  const v = view({ run_state: 'todo', run: null, live: null, column: 'todo' });
  const m = model([entry(v)]);
  const dlg = { kind: 'give', cardId: v.id, target: 'm-alice', repos: [{ id: 'r1', short_name: 'bondly' }], repo_id: 'r1', base_ref: 'dev', budget_usd: 5,
    preview: { overlaps: [{ other_card_id: 'c-9', other_key: 'BDL-9', other_owner: 'Bob', kind: 'overlapping', paths: ['backend/routes/applications.js'] }], sponsor: 'Runs on your MacBook Pro · your claude account' } };
  const n = giveDialog(dlg, m);
  const t = textOf(n);
  assert.match(t, /Give BDL-1 to AI/);
  // Machine, branch, budget and plan approval wait behind one closed Advanced disclosure.
  const adv = findAll(n, (x) => x.tag === 'details');
  assert.equal(adv.length, 1);
  assert.equal(adv[0].props.open, undefined);
  for (const name of ['target', 'base_ref', 'plan_approval']) assert.ok(findAll(adv[0], (x) => x.props.name === name).length, `${name} is in Advanced`);
  assert.match(textOf(adv[0]), /Dollar and turn caps are unavailable for Codex/, 'budget is in Advanced');
  assert.equal(findAll(n, (x) => x.props.name === 'ai').length, 1, 'one AI picker');
  assert.match(textOf(findAll(n, (x) => x.props.type === 'submit')[0]), /^Start$/);
  assert.match(t, /Overlaps 1 live card/);
  assert.match(t, /BDL-9 \(Bob's agent\) is editing backend\/routes\/applications\.js, which this card mentions/);
  assert.match(t, /Runs on your machine · your Codex account/);
  const radios = findAll(n, (x) => x.tag === 'input' && x.props.type === 'radio');
  assert.equal(radios.find((r) => r.props.checked).props.value, 'm-alice');
  const teammate = textOf(giveDialog({ ...dlg, target: 'm-bob', preview: { overlaps: [] } }, m));
  assert.match(teammate, /Bob must confirm before it starts/);
  assert.match(teammate, /Ask Bob/);
});

test('take over from suspended explains fencing and needs an explicit confirm', () => {
  const v = view({ run_state: 'suspended', device_kind: 'laptop', live: null });
  const n = confirmDialog({ kind: 'confirm', action: 'take_over_confirm', cardId: v.id }, model([entry(v)]));
  assert.match(textOf(n), /asleep, not gone/);
  assert.equal(n.tag, 'dialog');
  assert.match(byAttr(n, 'type', 'submit')[0].props.class, /btn-danger/);
});

test('sign-in: dev login only when enabled; forbidden explains membership', () => {
  assert.equal(byClass(signinScreen({ status: 'signed_out', devLogin: false }), 'devlogin').length, 0);
  assert.equal(byClass(signinScreen({ status: 'signed_out', devLogin: true }), 'devlogin').length, 1);
  assert.equal(byAttr(signinScreen({ status: 'signed_out', devLogin: true }), 'name', 'dev_secret').length, 1, 'asks for the dev secret');
  assert.equal(byAttr(signinScreen({ status: 'signed_out', devLogin: true, devSecretKnown: true }), 'name', 'dev_secret').length, 0);
  assert.match(textOf(signinScreen({ status: 'forbidden', email: 'x@y.z' })), /isn't a member of this board/);
});

test('avatar renders initials when no image', () => {
  const n = card(entry(view()), model([]));
  assert.equal(textOf(byClass(n, 'avatar-initials')[0]), 'A');
  assert.ok(ALICE);
});

test('card face: an approver answers a permission request in one click; non-approvers get no buttons', () => {
  const ask = { kind: 'permission', summary: 'npm run migrate', count: 1, permission_request_id: 'pr-9' };
  const mine = card(entry(view({ run_state: 'blocked', blocked_kind: 'permission', ask, viewer_can_approve: true, live: live({ green: false }) })), model([]));
  const clicks = byAttr(mine, 'data-action', 'permission');
  assert.deepEqual(clicks.map(textOf), ['Allow', 'Deny']);
  assert.deepEqual(clicks.map((b) => [b.props['data-pr'], b.props['data-decision']]), [['pr-9', 'allow'], ['pr-9', 'deny']]);
  const theirs = card(entry(view({ run_state: 'blocked', blocked_kind: 'permission', ask, viewer_can_approve: false, live: live({ green: false }) })), model([]));
  assert.equal(byAttr(theirs, 'data-action', 'permission').length, 0);
  const legacy = card(entry(view({ run_state: 'blocked', blocked_kind: 'permission', ask: { ...ask, permission_request_id: undefined }, viewer_can_approve: true, live: live({ green: false }) })), model([]));
  assert.deepEqual(byAttr(legacy, 'data-action', 'allow').map(textOf), ['Review request'], 'no request id → open the drawer');
});

test('every FeedEvent kind the hub sends has a feed label (CONTRACT §5.3)', async () => {
  const { FEED_KINDS } = await import('../../shared/protocol.js');
  const { FEED_LABEL } = await import('../js/render-drawer.js');
  assert.deepEqual(FEED_KINDS.filter((k) => !FEED_LABEL[k]), []);
});
