// Signed-out (local mode) Team and Integrations: always in the sidebar, each an
// explainer with a way in, and honest about which tools exist. No Electron:
// pure functions and source patterns, like buddy-window.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PAGES, pageById } = require('../buddy-window/pages');
const { LAUNCH_CONNECTORS, CONNECTORS, STATUS_TEXT, connectorStatus, connectorRows } = require('../buddy-window/connectors');
const { PAGE_SCREENS, ACCT_ARGS } = require('../buddy-window/account-flow');

const dir = path.join(__dirname, '..', 'buddy-window');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('only the connectors enabled on the team hub today are "Available"; the rest are "Coming soon"', () => {
  assert.deepEqual([...LAUNCH_CONNECTORS], ['github']);
  assert.deepEqual(CONNECTORS.map((c) => c.id), ['github', 'slack', 'sentry']);
  for (const c of CONNECTORS) assert.equal(connectorStatus(c.id), c.id === 'github' ? 'available' : 'soon', c.id);
  const rows = connectorRows();
  assert.deepEqual(rows.filter((r) => r.status === 'available').map((r) => r.id), ['github']);
  assert.equal(rows.find((r) => r.id === 'github').statusText, 'Available after you join a team');
  for (const r of rows.filter((x) => x.id !== 'github')) assert.equal(r.statusText, 'Coming soon', r.id);
  assert.equal(connectorStatus('nope'), 'soon', 'an unknown tool is never "available"');
  assert.deepEqual(STATUS_TEXT, { available: 'Available after you join a team', soon: 'Coming soon' });
  for (const c of CONNECTORS) assert.ok(c.value.length > 0 && c.value.length < 90, c.id);
});

test('the app and the board web agree on the connector list and which are available', async () => {
  const web = await import(pathToFileURL(path.join(__dirname, '..', 'board', 'web', 'js', 'connectors.js')).href);
  assert.deepEqual([...web.LAUNCH_CONNECTORS], [...LAUNCH_CONNECTORS]);
  assert.deepEqual(web.CONNECTORS.map((c) => ({ ...c })), CONNECTORS.map((c) => ({ ...c })));
  assert.deepEqual({ ...web.STATUS_TEXT }, { ...STATUS_TEXT });
  for (const c of CONNECTORS) assert.equal(web.connectorStatus(c.id), connectorStatus(c.id), c.id);
});

test('the sidebar lists Team and Integrations whatever the account or hub state', () => {
  // The registry is static and the sidebar renders every page; nothing filters by sign-in.
  assert.equal(pageById('team').kind, 'local');
  assert.equal(pageById('team').screen, 'team');
  assert.equal(pageById('integrations').localScreen, 'integrations');
  assert.ok(PAGES.filter((p) => p.group === 'team').map((p) => p.id).includes('integrations'));
  const sidebar = read(dir, 'sidebar.js');
  assert.match(sidebar, /for \(const s of sections\)/);
  assert.ok(!/signedIn|hub\.mode|workspaces/.test(sidebar.split('function build()')[1].split('function paint()')[0]), 'build() does not look at account state');
});

test('local Integrations opens the account page explainer; the hub page is used only on a team hub', () => {
  const idx = read(dir, 'index.js');
  assert.match(idx, /if \(page\.localScreen && !getTeamHub\(\)\) \{ flow\.show\(page\.localScreen\); return; \}/);
  assert.match(idx, /PAGES\.find\(\(p\) => p\.screen === screen \|\| p\.localScreen === screen\)/);
  assert.match(idx, /p\?\.kind === 'hub' && !\(p\.localScreen && !getTeamHub\(\)\)/, 'a hub restart does not swap the explainer for the hub page');
  assert.ok(PAGE_SCREENS.has('integrations') && PAGE_SCREENS.has('team') && PAGE_SCREENS.has('join'));
});

test('the sign-in buttons use the account page bridge: one new composed action, typed like oauth', () => {
  assert.deepEqual(ACCT_ARGS.signInWith, ['string']);
  assert.match(read(dir, 'account-preload.js'), /signInWith: \(provider\) => call\('signInWith', str\(provider\)\),/);
  const flow = read(dir, 'account-flow.js');
  const body = flow.split('async signInWith(provider) {')[1].split('async cancelOAuth()')[0];
  assert.match(body, /PROVIDERS\.includes\(provider\)/);
  assert.match(body, /ACCT\.hub\(BRAND\.DEFAULT_HUB\)/);
  assert.match(body, /beginOAuth\(acct\.hub, provider\)/);
  const acct = read(dir, 'account.js');
  assert.match(acct, /api\.signInWith\(p\)/);
  assert.match(acct, /Continue with Google/);
  assert.match(acct, /Continue with GitHub/);
  assert.match(acct, /Join with an invite link', \(\) => api\.go\('join'\)|onclick: \(\) => api\.go\('join'\) \}, 'Join with an invite link'/);
});

test('signed-out Team and Integrations copy: plain, names the hub from the brand, status is words', () => {
  const acct = read(dir, 'account.js');
  assert.match(acct, /Sign in to create a team or join one: invite teammates, see their agents live\./);
  assert.match(acct, /Teams and integrations live on the team hub \(\$\{s\.brand\.defaultHost\}\)/);
  assert.ok(!/app\.plexiform\.dev/.test(acct), 'the host comes from the brand, not the page');
  assert.match(acct, /el\('p', \{ class: 'acct-connector-status' \}, c\.statusText\)/);
  assert.match(acct, /el\('ul', \{ class: 'acct-connectors', 'aria-label'/);
  assert.ok(!/\.innerHTML\s*=|style=/.test(acct));
});

test('open(id) starts the account flows the way the sidebar switcher does: tray, Settings and the widget can open the sign-in screen', () => {
  const idx = read(dir, 'index.js');
  assert.match(idx, /const FLOW_IDS = \['signin', 'join', 'create-team'\];/);
  assert.match(idx, /const goTo = \(id\) => \(FLOW_IDS\.includes\(id\) \? flow\.startFlow\(id\) : select\(id\)\);/);
  assert.match(idx, /if \(pageId\) goTo\(pageId\);/, 'an open window routes the id');
  assert.match(idx, /else goTo\(pageId \?\? selected\);/, 'a fresh window routes the id too');
  assert.doesNotMatch(idx, /if \(pageId\) select\(pageId\);/, 'the old route that ignored the flow ids is gone');
  assert.match(idx, /if \(FLOW_IDS\.includes\(id\)\) flow\.startFlow\(id\); else switchWorkspace\(id\);/, 'the sidebar switcher keeps its behaviour');
});
