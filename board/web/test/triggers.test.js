import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { render } from '../js/h.js';
import { integrationsScreen } from '../js/render-integrations.js';
import { triggerBody } from '../js/render-triggers.js';
import { triggerActions } from '../js/triggers-actions.js';
import { TRIGGER_EVENTS, TRIGGER_ACTIONS, validateRule } from '../../shared/triggers.js';
import { model } from './fixtures.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-08T12:00:00Z');
const rule = (over = {}) => ({
  id: 't1', event: 'github.pr.opened', action: 'request_ai_review', filters: { repo: 'acme/api' }, params: {}, mode: 'off', max_per_hour: 10,
  sentence: 'When a pull request is opened in acme/api, ask the AI to review it and comment', dry_run_since: null, can_enable_at: null, ...over,
});
const data = (triggers, can_edit = true) => ({ triggers, events: TRIGGER_EVENTS, actions: TRIGGER_ACTIONS, dry_run_days: 7, max_per_hour_max: 60, can_edit });

function rig({ role = 'owner', triggers = {}, local = false } = {}) {
  const dom = new JSDOM('<main id="root"></main>');
  const previous = globalThis.document; globalThis.document = dom.window.document;
  const m = model([], { view: 'integrations' });
  render(document.getElementById('root'), integrationsScreen({ ...m, boards: [{ id: 'b1', name: 'Team board' }], me: { member: { ...m.me.member, role } },
    integrations: { status: 'ok', data: { connections: [], available: [], vault: true }, nowMs: NOW, local, triggers: { status: 'ok', data: data([rule()]), ...triggers } } }));
  const doc = dom.window.document;
  return { doc, text: doc.body.textContent, close: () => { globalThis.document = previous; dom.window.close(); } };
}

test('the panel shows each rule as a plain sentence with its switch; a new rule starts with "Start dry run"', () => {
  const r = rig();
  try {
    assert.match(r.text, /When a pull request is opened in acme\/api, ask the AI to review it and comment/);
    assert.match(r.text, /never starts an AI that edits code/);
    assert.ok(r.doc.querySelector('[data-action="trigger-dry-run"][data-trigger="t1"]'));
    assert.equal(r.doc.querySelector('[data-action="trigger-on-ask"]'), null, 'no enable before a dry run');
    assert.ok(r.doc.querySelector('form[data-form="trigger-new"]'));
  } finally { r.close(); }
});

test('dry run: enable for real waits for the week, then asks for confirmation', () => {
  const since = new Date(NOW - 2 * DAY).toISOString();
  const waiting = rig({ triggers: { data: data([rule({ mode: 'dry_run', dry_run_since: since, can_enable_at: new Date(NOW + 5 * DAY).toISOString() })]) } });
  try {
    assert.match(waiting.text, /Dry run: logging what it would do/);
    assert.match(waiting.text, /Enable for real from/);
    assert.equal(waiting.doc.querySelector('[data-action="trigger-on-ask"]'), null);
  } finally { waiting.close(); }
  const ready = rig({ triggers: { data: data([rule({ mode: 'dry_run', dry_run_since: since, can_enable_at: new Date(NOW - 1000).toISOString() })]) } });
  try { assert.ok(ready.doc.querySelector('[data-action="trigger-on-ask"]')); } finally { ready.close(); }
  const confirming = rig({ triggers: { confirmOn: 't1', data: data([rule({ mode: 'dry_run', dry_run_since: since, can_enable_at: new Date(NOW - 1000).toISOString() })]) } });
  try {
    assert.match(confirming.text, /acts for real/);
    assert.ok(confirming.doc.querySelector('[data-action="trigger-on"]'));
  } finally { confirming.close(); }
});

test('members see the rules but no controls or form; the local hub shows no panel', () => {
  const r = rig({ role: 'member', triggers: { data: data([rule({ mode: 'on' })], false) } });
  try {
    assert.match(r.text, /When a pull request is opened/);
    assert.equal(r.doc.querySelector('[data-action^="trigger-"][data-trigger]'), null);
    assert.equal(r.doc.querySelector('form[data-form="trigger-new"]'), null);
    assert.match(r.text, /A team admin can add triggers/);
  } finally { r.close(); }
  const local = rig({ local: true });
  try { assert.doesNotMatch(local.text, /Triggers/); } finally { local.close(); }
});

test('activity: event, action and result per firing, with dry runs as "would have"', () => {
  const firings = [
    { id: 2, trigger_id: 't1', event: 'github.pr.opened', action: 'request_ai_review', mode: 'on', result: 'skipped', detail: 'ai_review_off', subject: 'acme/api#7', card_id: 'c1', at: new Date(NOW).toISOString() },
    { id: 1, trigger_id: 'gone', event: 'card.moved_to_review', action: 'label_card', mode: 'dry_run', result: 'would', detail: 'label_card', subject: 'BDL-4', card_id: null, at: new Date(NOW).toISOString() },
  ];
  const r = rig({ triggers: { showActivity: true, activity: firings } });
  try {
    const items = [...r.doc.querySelectorAll('.trigger-activity li')].map((li) => li.textContent);
    assert.match(items[0], /acme\/api#7.*Ask the AI to review.*Skipped: AI review is off on that board/);
    assert.match(items[1], /A card moves to Review.*BDL-4.*Label its card.*Would have done it \(dry run\).*deleted trigger/);
  } finally { r.close(); }
});

test('the form sends only the chosen action’s parameter, and the hub model accepts it', () => {
  const r = rig();
  try {
    const form = r.doc.querySelector('form[data-form="trigger-new"]');
    form.elements.event.value = 'github.pr.opened';
    form.elements.filter_repo.value = ' acme/api ';
    form.elements.action.value = 'create_card';
    form.elements.board_id.value = 'b1';
    form.elements.text.value = 'ignored';
    const body = triggerBody(form);
    assert.deepEqual(body, { event: 'github.pr.opened', action: 'create_card', filters: { repo: 'acme/api' }, params: { board_id: 'b1' }, max_per_hour: 10 });
    assert.deepEqual(validateRule(body), { event: 'github.pr.opened', filters: { repo: 'acme/api' }, action: 'create_card', params: { board_id: 'b1' }, max_per_hour: 10 });
  } finally { r.close(); }
});

test('actions: mode changes go to the hub with confirm only for "on", and the reply replaces the rule', async () => {
  const calls = [];
  const state = { integ: { triggers: { status: 'ok', data: data([rule({ mode: 'dry_run' })]) } } };
  const api = {
    setTriggerMode: async (id, mode, confirm) => { calls.push([id, mode, confirm]); return { trigger: rule({ mode }) }; },
    deleteTrigger: async (id) => { calls.push(['delete', id]); return { ok: true }; },
  };
  const t = triggerActions({ api, state, update: () => {}, withBusy: (_k, fn) => fn(), errorText: (e) => e.message, toast: () => {} });
  await t.mode('t1', 'on');
  assert.deepEqual(calls[0], ['t1', 'on', true]);
  assert.equal(state.integ.triggers.data.triggers[0].mode, 'on');
  await t.mode('t1', 'off');
  assert.deepEqual(calls[1], ['t1', 'off', false]);
  await t.remove('t1');
  assert.deepEqual(state.integ.triggers.data.triggers, []);
});

test('app.js routes every trigger control to the actions module', () => {
  const src = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  for (const a of ['trigger-dry-run', 'trigger-off', 'trigger-on-ask', 'trigger-on', 'trigger-on-cancel', 'trigger-delete', 'trigger-activity']) assert.match(src, new RegExp(`case '${a}':`));
  assert.match(src, /kind === 'trigger-new'\) return triggers\.submit\(form\)/);
});
