// The signed-out path to a team, as a new user meets it: one clear "Sign in or create a team" wherever a
// team is needed, a Team page with one obvious way in, a waiting screen that says what to do, and every
// one of those opening the Team page. Account pages are rendered in jsdom with a stubbed bridge.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { ACCT_ARGS, firstTeamNotice } = require('../buddy-window/account-flow');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'buddy-window');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

async function page(state) {
  const calls = [];
  const dom = new JSDOM('<!doctype html><main id="acct"></main>', { url: `file:///account.html?screen=${state.screen}`, runScripts: 'outside-only' });
  const spy = (name) => async (...a) => { calls.push([name, ...a]); return { ok: true }; };
  dom.window.buddyAccount = new Proxy({ state: async () => ({ ok: true, brand: { name: 'Plexiform', copy: {}, defaultHost: 'app.plexiform.dev' }, signedInHubs: [], accounts: [], ...state }), onChanged() {} }, { get: (t, k) => t[k] ?? spy(k) });
  dom.window.eval(read(DIR, 'account.js'));
  await tick(); await tick();
  const doc = dom.window.document;
  const buttons = () => [...doc.querySelectorAll('button')];
  const button = (text) => buttons().find((b) => b.textContent === text);
  return { doc, calls, buttons, button, text: () => doc.getElementById('acct').textContent, close: () => dom.window.close() };
}

test('signed-out Team: one heading, why in two sentences, Google and GitHub first, invites apart, no hub address', async () => {
  const p = await page({ screen: 'team', team: null });
  assert.equal(p.doc.querySelector('h1').textContent, 'Work with a team');
  assert.match(p.text(), /Share one board with your teammates and see what their AI sessions are working on\. My board stays on this Mac; only team boards are shared\./);
  assert.match(p.text(), /Your browser opens so you can sign in, then you come back here\./);
  assert.deepEqual([...p.doc.querySelectorAll('.acct-providers button')].map((b) => b.textContent), ['Continue with Google', 'Continue with GitHub']);
  assert.equal(p.doc.querySelector('.acct-section h2').textContent, 'Were you sent an invite?');
  assert.doesNotMatch(p.text(), /app\.plexiform\.dev|team’s address/);
  p.button('Continue with GitHub').click(); await tick();
  p.button('Paste your invite link').click(); await tick();
  p.button('Other ways to sign in').click(); await tick();
  assert.deepEqual(p.calls, [['signInWith', 'github'], ['go', 'join'], ['signInOther']]);
  p.close();
});

test('signed-out Account, Integrations and Create a team show the same way in', async () => {
  for (const [screen, extra] of [['account', {}], ['integrations', { connectors: [] }], ['create-team', { host: null }]]) {
    const p = await page({ screen, ...extra });
    assert.ok(p.button('Continue with Google') && p.button('Continue with GitHub') && p.button('Paste your invite link'), screen);
    assert.doesNotMatch(p.text(), /team’s address|app\.plexiform\.dev/, screen);
    p.close();
  }
});

test('waiting for the browser: says it waits 5 minutes, what to do if nothing opened, with Try again and Cancel', async () => {
  const p = await page({ screen: 'browser', provider: 'google' });
  assert.equal(p.doc.querySelector('h1').textContent, 'Finish signing in in your browser');
  assert.match(p.text(), /We opened Google in your browser\./);
  assert.match(p.text(), /This stops after 5 minutes\./);
  assert.match(p.text(), /No browser window\? Choose Try again\./);
  p.button('Try again').click(); await tick();
  p.button('Cancel').click(); await tick();
  assert.deepEqual(p.calls, [['oauth', 'google'], ['cancelOAuth']]);
  p.close();
  const none = await page({ screen: 'browser', provider: null });
  assert.equal(none.button('Try again'), undefined, 'nothing to retry without a provider');
  none.close();
});

test('"Other ways to sign in" is a typed no-argument action: the default hub’s own sign-in screen', () => {
  assert.deepEqual(ACCT_ARGS.signInOther, []);
  assert.match(read(DIR, 'account-preload.js'), /signInOther: \(\) => call\('signInOther'\),/);
  assert.match(read(DIR, 'account-flow.js'), /signInOther\(\) \{ return ACCT\.hub\(BRAND\.DEFAULT_HUB\); \},/);
});

test('after the first sign-in the notice says what was made and what to do next', () => {
  assert.equal(firstTeamNotice('Ada’s team'), 'You’re signed in. We made a team for you, Ada’s team, with one board, and you’re its owner. Invite people below, or open Board in the sidebar to start.');
});

test('every other signed-out entry point opens the Team page with the same words', () => {
  for (const f of ['upgrade.html', 'sync.html']) assert.match(read(ROOT, f), /<button class="primary" id="sign-in" hidden>Sign in or create a team<\/button>/, f);
  assert.match(read(ROOT, 'sync.js'), /\$\('sign-in'\)\.addEventListener\('click', \(\) => api\.open\('team'\)\);/);
  assert.match(read(ROOT, 'src', 'entitlement-refresh.js'), /ipcMain\.handle\('entitlement:sign-in', \(e\) => \{ if \(fromUpgrade\(e\)\) ctx\.buddy\?\.\(\)\?\.open\?\.\('team'\); return null; \}\);/);
  assert.match(read(ROOT, 'main.js'), /\['overview', 'board', 'join', 'team', 'settings'\]\.includes\(destination\)/, 'Help may open Team');
  assert.match(read(ROOT, 'src', 'remote-pairing-view.js'), /Sign in on the Team page first/);
});
