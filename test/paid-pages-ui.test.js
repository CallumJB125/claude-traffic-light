// First-run (empty profile) rendering of the paid-tier pages: placeholders in
// empty selects, one blocker at a time, real Sign in / See plans buttons, and
// the shared page frame.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const tick = () => new Promise((r) => setTimeout(r, 0));

function page(t, html, js, globals) {
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, html), 'utf8'), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  Object.assign(dom.window, globals);
  dom.window.eval(fs.readFileSync(path.join(ROOT, js), 'utf8'));
  return dom.window.document;
}

test('What changed: an empty session list shows a disabled "No sessions yet" placeholder and a hint', async (t) => {
  const state = { enabled: false, limits: { turns: 3, days: 7 }, sessions: [], models: ['haiku'], review: { enabled: false, model: 'haiku', maxBudgetUsd: 0.05 }, reviewAllowed: false };
  const doc = page(t, 'checkpoints.html', 'checkpoints.js', { checkpointsApi: { state: async () => state, turns: async () => null, changed: () => {}, set: async () => state } });
  await tick(); await tick();
  const select = doc.getElementById('session');
  assert.equal(select.options.length, 1);
  assert.equal(select.options[0].textContent, 'No sessions yet');
  assert.ok(select.options[0].disabled);
  assert.ok(select.disabled);
  assert.match(doc.getElementById('status').textContent, /No sessions yet\. Switch on checkpoints/);
});

test('Client billing: empty folder and client selects have placeholders and Map folder waits for both', async (t) => {
  const snap = { store: { clients: [], mappings: [] }, plan: 'free', pdf: false, rateCards: false, months: 1, mode: 'subscription' };
  const doc = page(t, 'clients-local.html', 'clients-local.js', { clientsApi: { state: async () => snap, folders: async () => ['/work/acme'], preview: async () => null, save: async () => snap } });
  await tick(); await tick();
  const folder = doc.getElementById('map-folder'), client = doc.getElementById('map-client');
  assert.equal(folder.options[0].textContent, 'Choose a folder');
  assert.equal(client.options[0].textContent, 'Add a client first');
  assert.equal(folder.value, '');
  assert.ok(doc.getElementById('map-submit').disabled);
  folder.value = '/work/acme';
  folder.dispatchEvent(new doc.defaultView.Event('change'));
  assert.ok(doc.getElementById('map-submit').disabled, 'still no client');
});

test('Sync: a free, signed-out install shows only the plan blocker, with See plans', async (t) => {
  const opened = [];
  const doc = page(t, 'sync.html', 'sync.js', { sync: { state: async () => ({ entitled: false, plan: 'free', signedIn: false, enabled: false, local: {}, hub: null }), open: (p) => opened.push(p) } });
  await tick();
  assert.equal(doc.getElementById('upsell').hidden, false);
  assert.equal(doc.getElementById('status').hidden, true, 'the sign-in card waits until the plan allows sync');
  doc.getElementById('see-plans').click();
  assert.deepEqual(opened, ['upgrade']);
  assert.doesNotMatch(doc.body.textContent, /team hub \(Account\)/);
});

test('Sync: an entitled, signed-out install shows Sign in, which opens Account', async (t) => {
  const opened = [];
  const doc = page(t, 'sync.html', 'sync.js', { sync: { state: async () => ({ entitled: true, plan: 'plus', signedIn: false, enabled: false, local: {}, hub: null }), open: (p) => opened.push(p) } });
  await tick();
  assert.equal(doc.getElementById('upsell').hidden, true);
  assert.equal(doc.getElementById('sign-in').hidden, false);
  assert.match(doc.getElementById('detail').textContent, /Plexiform account/);
  doc.getElementById('sign-in').click();
  assert.deepEqual(opened, ['account']);
});

test('Plan & billing: signed out shows a Sign in button and plain wording', async (t) => {
  let signIn = 0;
  const doc = page(t, 'upgrade.html', 'upgrade.js', { plan: { state: async () => ({ plan: 'free', planName: 'Free', signedIn: false, limits: {} }), signIn: () => { signIn++; } } });
  await tick();
  assert.equal(doc.getElementById('sign-in').hidden, false);
  assert.equal(doc.getElementById('upgrade-month').hidden, true);
  assert.equal(doc.getElementById('detail').textContent, 'Sign in to your Plexiform account to upgrade.');
  doc.getElementById('sign-in').click();
  assert.equal(signIn, 1);
});

test('the new pages share one page frame and the Plus badge', () => {
  for (const html of ['home.html', 'memory.html', 'checkpoints.html', 'clients-local.html', 'phone-pairing.html', 'sync.html', 'upgrade.html', 'setups.html']) {
    const src = fs.readFileSync(path.join(ROOT, html), 'utf8');
    assert.match(src, /href="page\.css"/, html);
    assert.match(src, /<main class="page">/, html);
    assert.match(src, /<header class="page-head">/, html);
    assert.doesNotMatch(src, /class="pill"/, html);
  }
  const css = fs.readFileSync(path.join(ROOT, 'page.css'), 'utf8');
  assert.match(css, /max-width: 960px/);
  assert.match(css, /\.badge-plus \{[^}]*color: var\(--accent\)/);
  assert.ok(require('../package.json').build.files.includes('page.css'));
});
