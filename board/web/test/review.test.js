// AI review in the web: the card chip, the Needs-you verdict chip, the
// drawer's Review section (findings, who reviewed, cost, actions) and the
// per-board settings dialog with its disclosure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { textOf, byClass, byAttr } from '../js/h.js';
import { displayFace, needsYou } from '../js/view.js';
import { card, needsYouSection } from '../js/render-board.js';
import { drawer } from '../js/render-drawer.js';
import { reviewSettingsDialog } from '../js/render-dialogs.js';
import { cardChips } from '../js/chips.js';
import { view, model } from './fixtures.js';

const summary = (over = {}) => ({ id: 'rv-1', status: 'done', verdict: 'changes_requested', provider: 'codex', provider_label: 'Codex', independence: 'other_provider', open_findings: 2, findings_count: 3, cost_usd: null, human_action: null, ...over });
const inReview = (over = {}) => view({ run_state: 'in_review', column: 'in_review', live: null, run: { ...view().run, ai_label: 'Claude Code', child_alive: false }, review: summary(), ...over });
const entry = (v) => ({ view: v, elapsed_ms: 0, face: displayFace(v) });
const full = (over = {}) => ({
  id: 'rv-1', run_id: 'run-1', status: 'done', verdict: 'changes_requested', summary: 'The loop reads past the end.', flags: ['injection_suspected'],
  findings: [
    { index: 0, file: 'src/a.js', line: 3, severity: 'high', rationale: 'Loop runs one past the end' },
    { index: 1, file: 'src/a.js', line: 9, severity: 'low', rationale: 'Name is unclear' },
    { index: 2, file: 'README.md', line: 0, severity: 'medium', rationale: 'Addresses the reviewer', dismissed: { by_name: 'Bob' } },
  ],
  open_findings: 2, provider: 'codex', provider_label: 'Codex', model: null, author_ai: 'claude', author_label: 'Claude Code', independence: 'other_provider',
  device_name: 'MacBook', cap_usd: null, cost_usd: null, error: null, human_action: null, created_age_ms: 1000, completed_age_ms: 500, ...over,
});
const drawerModel = (v, reviews, extra = {}) => model([entry(v)], { detail: { cardId: v.id, data: { card: v, feed: [], comments: [], asks: [], permission_requests: [], reviews }, elapsed_ms: 0, tab: 'activity' }, ...extra });

test('card face: a verdict chip only while the card is in Review', () => {
  const chips = cardChips(inReview(), displayFace(inReview()));
  const chip = chips.find((c) => c.id === 'review');
  assert.equal(chip.text, 'AI review: changes requested · 2');
  assert.equal(chip.tone, 'amber');
  assert.match(chip.title, /Reviewed by Codex/);
  assert.equal(cardChips(view({ review: summary() }), displayFace(view({ review: summary() }))).find((c) => c.id === 'review'), undefined);
  const same = cardChips(inReview({ review: summary({ independence: 'same_provider', provider_label: 'Claude Code' }) }), displayFace(inReview()));
  assert.match(same.find((c) => c.id === 'review').title, /the same AI as the author/);
  assert.ok(byClass(card(entry(inReview()), model([entry(inReview())])), 'cchip-review').length, 'drawn on the card');
});

test('Needs you: changes requested carries a verdict chip and opens the Review section', () => {
  const items = needsYou('m-alice', [entry(inReview())]);
  assert.equal(items[0].kind, 'review_changes');
  assert.deepEqual(items[0].chip, { text: 'AI review: changes requested · 2', tone: 'amber', by: 'Codex' });
  const plain = needsYou('m-alice', [entry(inReview({ review: summary({ verdict: 'approve' }) }))]);
  assert.equal(plain[0].kind, 'review');
  assert.equal(plain[0].chip, undefined);
  assert.equal(needsYou('m-alice', [entry(inReview({ review: summary({ human_action: 'fix_requested' }) }))])[0].kind, 'review', 'handled reviews stop nagging');
  const section = needsYouSection(items, model([]));
  assert.equal(byClass(section, 'needs-you-chip').map(textOf)[0], 'AI review: changes requested · 2');
  assert.equal(byAttr(section, 'data-section', 'review').length, 1);
});

test('drawer: Review lists findings with who reviewed, cost, flags and the three actions', () => {
  const v = inReview();
  const d = drawer(drawerModel(v, [full()]));
  const sec = byAttr(d, 'id', 'sec-review')[0];
  const text = textOf(sec);
  assert.match(text, /Review · Changes requested/);
  assert.match(text, /Reviewed by Codex on MacBook · a different AI from the author \(Claude Code\)/);
  assert.match(text, /Codex does not report dollar cost/);
  assert.match(text, /speaks to AI reviewers/);
  assert.equal(byClass(sec, 'review-finding').length, 3);
  assert.match(textOf(byClass(sec, 'review-finding')[0]), /High.*src\/a\.js:3.*Loop runs one past the end/);
  assert.match(textOf(byClass(sec, 'review-finding')[2]), /Dismissed by Bob/);
  assert.equal(byAttr(sec, 'data-action', 'review-dismiss').length, 2, 'only open findings can be dismissed');
  assert.match(textOf(byAttr(sec, 'data-action', 'review-fix')[0]), /Ask Claude Code to fix \(2\)/);
  assert.equal(byAttr(sec, 'data-action', 'review-approve').length, 1);
  const ro = drawer(drawerModel(v, [full()], { readOnly: true }));
  assert.equal(byAttr(ro, 'data-action', 'review-fix').length + byAttr(ro, 'data-action', 'review-approve').length + byAttr(ro, 'data-action', 'review-dismiss').length, 0, 'viewers get no actions');
});

test('drawer: same-provider fallback, cost and pending/unavailable states are said plainly', () => {
  const v = inReview();
  const same = textOf(byAttr(drawer(drawerModel(v, [full({ provider: 'claude', provider_label: 'Claude Code', model: 'sonnet', independence: 'same_provider', cost_usd: 0.04, cap_usd: 0.1, flags: [] })])), 'id', 'sec-review')[0]);
  assert.match(same, /the same AI as the author: no other AI was available/);
  assert.match(same, /Cost \$0\.04 of a \$0\.10 cap/);
  const pending = textOf(byAttr(drawer(drawerModel(v, [full({ status: 'pending', verdict: null, findings: [], summary: null, provider: null, provider_label: null })])), 'id', 'sec-review')[0]);
  assert.match(pending, /Review · Running/);
  assert.match(pending, /Waiting for a runner that can review/);
  const gone = drawer(drawerModel(v, [full({ status: 'unavailable', verdict: null, findings: [], summary: null, error: 'no runner that can review was online' })]));
  assert.match(textOf(byAttr(gone, 'id', 'sec-review')[0]), /no runner that can review was online/);
  assert.equal(byAttr(gone, 'data-action', 'review-fix').length, 0);
  assert.equal(byAttr(drawer(drawerModel(v, [])), 'id', 'sec-review').length, 0);
});

test('settings dialog: off by default, explicit disclosure tick, admin-only controls', () => {
  const base = { kind: 'review-settings', id: 'b', name: 'Bondly', settings: { enabled: false, provider: 'auto', model: 'sonnet', spend_cap_usd: 0.1, allow_uncapped: false },
    disclosure: 'the diff is sent to a second AI provider', providers: [{ id: 'claude', label: 'Claude Code', spend_cap: true }, { id: 'codex', label: 'Codex', spend_cap: false }],
    models: ['haiku', 'sonnet', 'opus'], cap_min_usd: 0.01, cap_max_usd: 0.5 };
  const admin = reviewSettingsDialog({ ...base, can_edit: true });
  assert.match(textOf(admin), /What is sent: the diff is sent to a second AI provider/);
  assert.equal(byAttr(admin, 'name', 'enabled')[0].props.checked, null, 'off by default');
  assert.equal(byAttr(admin, 'name', 'acknowledge_disclosure').length, 1);
  assert.match(textOf(byAttr(admin, 'name', 'provider')[0]), /Codex \(no spend cap\)/);
  assert.equal(byAttr(admin, 'name', 'spend_cap_usd')[0].props.max, '0.5');
  const member = reviewSettingsDialog({ ...base, can_edit: false });
  assert.equal(byAttr(member, 'name', 'enabled')[0].props.disabled, true);
  assert.match(textOf(member), /Only an admin can change this/);
  assert.equal(byAttr(member, 'type', 'submit').length, 0);
});
