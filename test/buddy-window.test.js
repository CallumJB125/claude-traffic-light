// Buddy main window: page registry, navigation lock, and the embedded hub
// supervisor (fake utilityProcess child, no Electron).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PAGES, SECTIONS, sectionOf, flat, pageById, hubPageUrl, navDecision, openDecision, connectDecision, manifestPost, parseConnectName, connectUrlOk, connectNavOk, bindCookie, appUserAgent, isConnectCallback, pageForHubUrl } = require('../buddy-window/pages');
const { createHubSupervisor, hubEnv, MAX_RESTARTS } = require('../buddy-window/hub-process');

// ── pages ──────────────────────────────────────────────────────────────────

test('every page has a unique id, a title and a known kind', () => {
  const all = flat();
  assert.equal(new Set(all.map((p) => p.id)).size, all.length);
  for (const p of all) {
    assert.ok(p.title, p.id);
    assert.ok(['hub', 'window', 'local'].includes(p.kind), `${p.id}: no placeholder pages`);
    assert.ok(!p.pending, `${p.id}: no soon pill`);
    if (p.kind === 'window') assert.ok(p.window, p.id);
  }
  for (const want of ['board', 'myday', 'tasks', 'integrations', 'team', 'usage', 'setups', 'settings', 'aitools']) assert.ok(pageById(want), want);
  assert.equal(PAGES[0].id, 'overview');
  assert.ok(PAGES.some(page => page.id === 'board'));
});

test('the sidebar has six sections that together reach every page exactly once', () => {
  assert.deepEqual(SECTIONS.map((s) => s.id), ['today', 'sessions', 'board', 'team', 'activity', 'more']);
  const listed = SECTIONS.flatMap((s) => s.pages);
  assert.equal(new Set(listed).size, listed.length, 'no page in two sections');
  assert.deepEqual([...listed].sort(), flat().filter((p) => !p.hidden).map((p) => p.id).sort(), 'no visible page is orphaned');
  for (const s of SECTIONS) assert.ok(s.pages.includes(s.default) && pageById(s.default), `${s.id} opens a page it holds`);
  assert.equal(sectionOf('board:calendar'), 'board');
  assert.equal(sectionOf('waiting'), 'today');
  assert.equal(sectionOf('integrations'), 'team');
  assert.equal(sectionOf('nope'), null);
  assert.equal(pageById('plugins'), null);
});

test('local pages name an app file and its preload, and both exist', () => {
  const local = flat().filter((p) => p.kind === 'local' && !p.screen); // screen pages are the account page's
  assert.ok(local.some((p) => p.id === 'waiting'), 'Waiting on you is a local page');
  for (const p of local) {
    for (const f of [p.file, p.preload]) {
      assert.ok(typeof f === 'string' && !f.includes('..') && !path.isAbsolute(f), `${p.id}: ${f}`);
      assert.ok(fs.existsSync(path.join(__dirname, '..', f)), `${p.id}: ${f} exists`);
    }
  }
});

test('hub page URLs carry ?view= for every view but the board itself', () => {
  assert.equal(hubPageUrl('http://127.0.0.1:5000', pageById('board')), 'http://127.0.0.1:5000/');
  assert.equal(hubPageUrl('http://127.0.0.1:5000/', pageById('board:table')), 'http://127.0.0.1:5000/?view=table');
  assert.equal(pageForHubUrl('http://127.0.0.1:5000/?view=table#card=x'), 'board:table');
  assert.equal(pageForHubUrl('http://127.0.0.1:5000/'), 'board');
  assert.equal(pageForHubUrl('http://127.0.0.1:5000/?view=nope'), 'board');
  assert.equal(hubPageUrl('https://buddy.example.com', pageById('board:table'), { org: 'team_1' }), 'https://buddy.example.com/?org=team_1&view=table');
  assert.equal(hubPageUrl('https://buddy.example.com/?org=old&view=x', pageById('board'), { org: 'team_2' }), 'https://buddy.example.com/?org=team_2');
  assert.equal(pageForHubUrl('https://buddy.example.com/?org=t&view=table'), 'board:table');
  for (const id of ['team', 'thismac', 'account']) assert.ok(pageById(id).screen, id);
});

test('the hub view only navigates within its origin (+ the team Access login)', () => {
  const o = { hubOrigin: 'http://127.0.0.1:5000', accessTeam: 'pistor' };
  assert.equal(navDecision('http://127.0.0.1:5000/?view=table', o), 'allow');
  assert.equal(navDecision('http://127.0.0.1:5001/', o), 'external');
  assert.equal(navDecision('https://pistor.cloudflareaccess.com/cdn-cgi/access/login', o), 'allow');
  assert.equal(navDecision('https://evil.cloudflareaccess.com/', o), 'external');
  assert.equal(navDecision('http://pistor.cloudflareaccess.com/', o), 'external');
  assert.equal(navDecision('https://github.com/o/r/pull/1', o), 'external');
  assert.equal(navDecision('file:///etc/passwd', o), 'deny');
  assert.equal(navDecision('javascript:alert(1)', o), 'deny');
  assert.equal(navDecision('not a url', o), 'deny');
  assert.equal(navDecision('https://pistor.cloudflareaccess.com/', { hubOrigin: o.hubOrigin }), 'external');
});

test('window.open from the hub view: plexiform-connect|<provider>|<bind> (https) may get the connect window; the old buddy-connect opens nothing', () => {
  const o = { hubOrigin: 'https://buddy.example.com' };
  assert.equal(openDecision({ url: 'https://github.com/login/oauth/authorize?x=1', frameName: 'plexiform-connect|github|b1nd_X-9' }, o), 'connect');
  assert.equal(openDecision({ url: 'https://slack.com/oauth/v2/authorize', frameName: 'plexiform-connect|slack|b' }, o), 'connect');
  assert.equal(openDecision({ url: 'http://github.com/login', frameName: 'plexiform-connect|github|b' }, o), 'deny');
  assert.equal(openDecision({ url: 'javascript:alert(1)', frameName: 'plexiform-connect|github|b' }, o), 'deny');
  for (const url of ['https://github.com/login/oauth/authorize', 'http://github.com/login']) assert.equal(openDecision({ url, frameName: 'buddy-connect' }, o), 'deny', 'buddy-connect no longer opens anything');
  assert.equal(openDecision({ url: 'https://github.com/', frameName: 'plexiform-connect|github' }, o), 'deny', 'a malformed connect name opens nothing, not even the browser');
  assert.equal(openDecision({ url: 'https://github.com/o/r', frameName: '' }, o), 'external');
  assert.equal(openDecision({ url: 'https://github.com/o/r', frameName: 'other' }, o), 'external');
  assert.equal(openDecision({ url: 'https://buddy.example.com/x', frameName: '' }, o), 'deny', 'no second hub window');
  assert.equal(openDecision({ url: 'file:///etc/passwd', frameName: '' }, o), 'deny');
  assert.equal(isConnectCallback('https://buddy.example.com/integrations/github/callback?code=x&state=y', o.hubOrigin), true);
  assert.equal(isConnectCallback('https://buddy.example.com/integrations/slack/callback/', o.hubOrigin), true);
  assert.equal(isConnectCallback('https://evil.example.com/integrations/github/callback', o.hubOrigin), false);
  assert.equal(isConnectCallback('https://buddy.example.com/integrations/github', o.hubOrigin), false);
  assert.equal(isConnectCallback('https://buddy.example.com/integrations/../callback', o.hubOrigin), false);
  assert.equal(hubPageUrl(o.hubOrigin, pageById('integrations'), { org: 't1' }), 'https://buddy.example.com/?org=t1&view=integrations');
});

test('connect names: exactly three |-parts, plexiform-connect, a provider and a bind of the allowed alphabets', () => {
  assert.deepEqual(parseConnectName('plexiform-connect|github|abc_DEF-123'), { provider: 'github', bind: 'abc_DEF-123' });
  assert.deepEqual(parseConnectName(`plexiform-connect|google-drive|${'b'.repeat(64)}`), { provider: 'google-drive', bind: 'b'.repeat(64) });
  for (const n of ['', 'buddy-connect', 'plexiform-connect', 'plexiform-connect|github', 'plexiform-connect|github|b|x', 'plexiform-connect||b', 'plexiform-connect|g|b', `plexiform-connect|${'a'.repeat(33)}|b`, 'plexiform-connect|GitHub|b', 'plexiform-connect|git_hub|b', 'plexiform-connect|github|', `plexiform-connect|github|${'b'.repeat(65)}`, 'plexiform-connect|github|b=1', 'plexiform-connect|github|b c', 'Plexiform-connect|github|b', 'x|github|b', null, undefined]) {
    assert.equal(parseConnectName(n), null, String(n));
  }
});

test('connect guard: only the signed-in hub’s own Integrations page, right after a gesture, to a public https URL', () => {
  const hub = 'https://app.plexiform.dev';
  const base = { url: 'https://github.com/login/oauth/authorize?client_id=x', frameName: 'plexiform-connect|github|bnd1', referrer: `${hub}/?org=t1&view=integrations`, pageUrl: `${hub}/?org=t1&view=integrations`, hubOrigin: hub, signedIn: true, gestureAt: 1000, now: 2000 };
  assert.deepEqual(connectDecision(base), { ok: true, provider: 'github', bind: 'bnd1' });
  assert.equal(connectDecision({ ...base, referrer: '' }).ok, true, 'a no-referrer page still counts by its own URL');
  const no = (over, reason) => assert.deepEqual(connectDecision({ ...base, ...over }), { ok: false, reason }, JSON.stringify(over));
  no({ gestureAt: 0 }, 'gesture');
  no({ now: 1000 + 5001 }, 'gesture');
  no({ gestureAt: 3000 }, 'gesture');
  no({ pageUrl: 'https://evil.example.com/?view=integrations' }, 'opener');
  no({ pageUrl: `${hub}/?org=t1` }, 'opener');
  no({ pageUrl: `${hub}/?view=table` }, 'opener');
  no({ referrer: 'https://evil.example.com/x' }, 'opener');
  for (const pageUrl of [`${hub}/integrations/github/callback?view=integrations`, `${hub}/docs/x?view=integrations`, `${hub}/api/x?view=integrations`, `${hub}:444/?view=integrations`, `http://app.plexiform.dev/?view=integrations`, 'about:blank', 'not a url', undefined, `${hub}/?view=integrations&view=table`]) no({ pageUrl }, 'opener');
  no({ referrer: 'http://app.plexiform.dev/' }, 'opener');
  no({ signedIn: false }, 'signed-out');
  no({ frameName: 'buddy-connect' }, 'name');
  for (const url of ['http://github.com/login', 'https://127.0.0.1/x', 'https://10.1.2.3/', 'https://192.168.0.5/', 'https://169.254.169.254/latest', 'https://[::1]/', 'https://localhost/', 'https://intranet/']) no({ url }, 'url');
  assert.equal(connectUrlOk('https://slack.com/oauth/v2/authorize'), true);
  // localhost. resolves to loopback; a trailing dot, an IP literal or a private-use suffix names nothing a provider uses.
  for (const url of ['https://localhost./', 'https://foo.localhost./x', 'https://github.com./login', 'https://8.8.8.8/', 'https://0x7f000001/', 'https://printer.local/', 'https://metadata.google.internal/', 'https://router.home.arpa/', 'https://user:pw@github.com/', 'data:text/html,x', 'file:///etc/passwd', 'javascript:alert(1)']) assert.equal(connectUrlOk(url), false, url);
});

test('connect window navigation: public https provider pages and the hub callback only; popups are refused', () => {
  const hub = 'https://app.plexiform.dev';
  for (const u of ['https://github.com/login', 'https://github.com/sessions/two-factor', 'https://slack.com/oauth/v2/authorize', `${hub}/integrations/github/callback?code=x&state=y`]) assert.equal(connectNavOk(u, hub), true, u);
  for (const u of ['http://github.com/login', 'https://192.168.1.1/', 'https://localhost./', 'https://127.0.0.1:8080/', 'file:///etc/passwd', 'data:text/html,x', 'javascript:alert(1)', 'mailto:a@b.co', 'x-github-desktop://open', 'not a url', 'http://app.plexiform.dev/integrations/github/callback']) assert.equal(connectNavOk(u, hub), false, u);
  const local = 'http://127.0.0.1:4100';
  assert.equal(connectNavOk(`${local}/integrations/github/callback?code=x`, local), true, 'the local hub’s own callback');
  assert.equal(connectNavOk(`${local}/`, local), false, 'nothing else on the local hub');
  assert.equal(connectNavOk('http://127.0.0.1:4101/integrations/github/callback', local), false, 'exact origin, port included');
  const src = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'index.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function openConnect'), src.indexOf('async function showHubPage'));
  assert.match(fn, /const guard = \(e, u\) => \{ if \(!connectNavOk\(u, w\.hubOrigin\)\) e\.preventDefault\(\); \};/);
  assert.match(fn, /wc\.on\('will-navigate', guard\);/);
  assert.match(fn, /wc\.on\('will-redirect', guard\);/);
  assert.match(fn, /wc\.setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\);/);
  assert.ok(!/openExternal/.test(fn), 'the provider page can’t open the system browser either');
});

test('connect window: one at a time; a second open while one is open (or still opening) is refused, never stacked or swapped', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'index.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function openConnect'), src.indexOf('async function showHubPage'));
  const refuse = fn.indexOf("if (connectWin && !connectWin.isDestroyed()) { connectWin.focus(); log('connect window refused', 'already open'); return; }");
  const pending = fn.indexOf('if (connectOpening) return;');
  assert.ok(refuse > 0 && pending > 0, 'both guards present');
  assert.ok(Math.max(refuse, pending) < fn.indexOf('bindCookie('), 'refused before any cookie is set');
  assert.ok(!/connectWin\.close\(\)/.test(fn), 'an open window is never closed to make room (its closed handler would remove the new bind cookie)');
  assert.match(fn, /connectOpening = true;\n\s+let ses, cookie, current;\n\s+try \{\n/);
  assert.match(fn, /current = await connectLife\.setBindCookie\(ses, integrationPartitionFor\(h\.origin\), cookie\);\n\s+\} finally \{ connectOpening = false; \}/);
});

test('bind cookie: __Host- on https hubs (Secure, Path=/, no Domain), plain on /integrations/ for http dev hubs; HttpOnly, Lax, 10 minutes', () => {
  const now = 1_700_000_000_000;
  const https = bindCookie('https://app.plexiform.dev', 'github', 'bnd', now);
  assert.deepEqual(https, { url: 'https://app.plexiform.dev/', name: '__Host-board_int_github', value: 'bnd', path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: now / 1000 + 600 });
  assert.equal('domain' in https, false);
  const dev = bindCookie('http://127.0.0.1:4100', 'slack', 'b2', now);
  assert.deepEqual(dev, { url: 'http://127.0.0.1:4100/integrations/', name: 'board_int_slack', value: 'b2', path: '/integrations/', secure: false, httpOnly: true, sameSite: 'lax', expirationDate: now / 1000 + 600 });
});

test('bind cookie fails closed: only an exact http(s) hub origin, a valid provider and bind', () => {
  for (const [origin, provider, bind] of [
    ['https://app.plexiform.dev/', 'github', 'b'], ['https://app.plexiform.dev/x', 'github', 'b'], ['https://u:p@app.plexiform.dev', 'github', 'b'],
    ['file:///tmp', 'github', 'b'], ['not a url', 'github', 'b'], [undefined, 'github', 'b'],
    ['https://app.plexiform.dev', 'git;hub', 'b'], ['https://app.plexiform.dev', 'GitHub', 'b'], ['https://app.plexiform.dev', 'github', 'b;Domain=evil.com'], ['https://app.plexiform.dev', 'github', ''], ['https://app.plexiform.dev', 'github', 'b'.repeat(65)], ['https://app.plexiform.dev', undefined, 'b'], ['https://app.plexiform.dev', 'github', undefined],
  ]) assert.throws(() => bindCookie(origin, provider, bind), /bind cookie/, JSON.stringify([origin, provider, bind]));
});

test('user agent: the hub view appends Plexiform/<version> once, never replacing the browser’s', () => {
  const ua = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Electron/44 Safari/537.36';
  assert.equal(appUserAgent(ua, '2.4.0'), `${ua} Plexiform/2.4.0`);
  assert.equal(appUserAgent(appUserAgent(ua, '2.4.0'), '2.4.0'), `${ua} Plexiform/2.4.0`);
});

test('connect window wiring: gesture-tracked, guarded, cookie set before the load and removed on close, no bearer, no preload', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'index.js'), 'utf8');
  assert.match(src, /hubSes\.setUserAgent\(appUserAgent\(hubSes\.getUserAgent\(\), app\.getVersion\(\)\)\)/);
  assert.match(src, /wc\.on\('input-event'/);
  assert.match(src, /connectDecision\(\{ url, frameName, referrer: referrer\?\.url/);
  const fn = src.slice(src.indexOf('async function openConnect'), src.indexOf('async function showHubPage'));
  assert.ok(fn.indexOf('await connectLife.setBindCookie(') < fn.indexOf('w.loadURL(url)'), 'the bind cookie is set before the provider page loads');
  assert.match(fn, /ses\.cookies\.remove\(cookie\.url, cookie\.name\)/);
  assert.match(fn, /integrationPartitionFor\(h\.origin\)/);
  assert.ok(!/preload|installBearer|bearerHeaders/.test(fn), 'no preload, no bearer on the connect partition');
  assert.match(fn, /first page must be the authorize host/);
  assert.match(fn, /sandbox: true/);
});

test('connect window guardrails pinned: hub-view opener only, neutral name, own partition with no bearer, callback close, host title, fail-closed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'index.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function openConnect'), src.indexOf('async function showHubPage'));
  const hubView = src.slice(src.indexOf('function makeHubView('), src.indexOf('async function openConnect'));
  // Only the hub view's window.open handler can start one, and only for the current, signed-in account hub.
  assert.equal(src.split('openConnect(').length - 1, 2, 'declared once, called once');
  assert.equal(src.split('connectDecision(').length - 1, 1);
  assert.ok(hubView.includes('openConnect(url, h, c)') && hubView.includes('connectDecision('));
  assert.match(hubView, /signedIn: !!h\.bearer && signedIn\(h\.origin\) && hubInfo\?\.origin === h\.origin/);
  assert.match(hubView, /pageUrl: wc\.getURL\(\)/, 'the opener is judged by the hub view’s own main-frame URL');
  assert.match(hubView, /wc\.on\('will-frame-navigate', \(e\) => \{ if \(!e\.isMainFrame && decide\(e\.url\) !== 'allow'\) e\.preventDefault\(\); \}\);/, 'frames stay on the hub origin');
  assert.match(hubView, /gestureAt = 0;\n\s+if \(c\.ok\)/, 'one gesture, one try');
  // The page's own window (named with the bind) is never created: the handler always denies, and ours has no name.
  const handler = hubView.slice(hubView.indexOf('wc.setWindowOpenHandler('), hubView.indexOf('const guard'));
  assert.ok(!/action: 'allow'|overrideBrowserWindowOptions/.test(handler));
  assert.match(handler, /return \{ action: 'deny' \};\n\s+\}\);/);
  const ctor = fn.slice(fn.indexOf('new BrowserWindow('), fn.indexOf('w.hubOrigin = h.origin'));
  assert.ok(ctor.length > 0 && !/frameName|bind|name:/.test(ctor), 'nothing names the connect window');
  assert.equal(fn.replace(/\/\/.*$/gm, '').match(/\bbind\b/g).length, 2, 'the bind reaches only bindCookie');
  assert.match(fn, /w\.loadURL\(url\)/);
  // Its own partition: never the hub's (which carries the bearer header), and cleared on sign-out.
  assert.match(fn, /session\.fromPartition\(integrationPartitionFor\(h\.origin\)\)/);
  assert.ok(!/h\.partition|teamPartition|webRequest/.test(fn));
  for (const o of ['https://app.plexiform.dev', 'https://buddy.example.com', 'http://127.0.0.1:4100']) {
    assert.notEqual(integrationPartitionFor(o), teamPartition(o));
    assert.ok(integrationPartitionFor(o).startsWith('persist:integration-auth-') && teamPartition(o).startsWith('persist:board-'));
  }
  assert.match(src, /function installBearer\(origin\) \{\n\s+const partition = teamPartition\(origin\);/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account-flow.js'), 'utf8'), /const parts = \[partitionFor\(origin\), integrationPartitionFor\(origin\)\];/);
  // The first page must be the authorize host; the callback page closes the window shortly after it loads.
  assert.match(fn, /if \(host !== authorizeHost\) \{ log\('connect window closed: first page not the authorize host'\); wc\.stop\(\); w\.close\(\); \}/);
  assert.match(fn, /wc\.on\('did-finish-load', \(\) => \{\n\s+if \(closing \|\| !isConnectCallback\(wc\.getURL\(\), w\.hubOrigin\)\) return;/);
  assert.match(fn, /setTimeout\(\(\) => \{\n\s+if \(!w\.isDestroyed\(\)\) w\.close\(\);[\s\S]*?\}, 1500\);/);
  // The title shows the host on screen; the page can't replace it.
  assert.match(fn, /w\.on\('page-title-updated', \(e\) => e\.preventDefault\(\)\);/);
  assert.match(fn, /w\.setTitle\(`\$\{BRAND\.CONNECT_TITLE\} · \$\{new URL\(u\)\.host\}`\)/);
  // Fail closed on anything malformed.
  const hub = 'https://app.plexiform.dev';
  const ok = { url: 'https://github.com/login/oauth/authorize', frameName: 'plexiform-connect|github|b', pageUrl: `${hub}/?view=integrations`, hubOrigin: hub, signedIn: true, gestureAt: 1, now: 2 };
  assert.equal(connectDecision(ok).ok, true);
  for (const over of [{ url: undefined }, { url: '::' }, { frameName: undefined }, { frameName: 42 }, { pageUrl: undefined }, { hubOrigin: undefined }, { referrer: '::' }, { gestureAt: NaN }, { now: NaN }, { gestureAt: 5 }]) {
    assert.equal(connectDecision({ ...ok, ...over }).ok, false, JSON.stringify(over));
  }
  assert.equal(connectNavOk(undefined, hub), false);
  assert.equal(isConnectCallback(`${hub}/integrations/github/callback`, undefined), false);
});

// ── GitHub App-manifest POST into the connect window ─────────────────────

const MF_HUB = 'https://app.plexiform.dev';
const MF_STATE = `${'P'.repeat(40)}.${'m_-'.repeat(14)}`;
const MF_HOOK = `${MF_HUB}/integrations/0b6f1c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e/webhook`;
async function githubForm(input = {}) {
  const gh = (await import('../board/hub/integrations/github/index.js')).default;
  return gh.connect.manifestForm({ state: MF_STATE, redirectUri: `${MF_HUB}/integrations/github/callback`, webhookUrl: MF_HOOK, provider: {}, config: {}, input });
}
const formBody = (fields, contentType = 'application/x-www-form-urlencoded') => ({ contentType, data: [{ type: 'rawData', bytes: Buffer.from(new URLSearchParams(Object.entries(fields)).toString()) }] });
const mfBase = (over = {}) => ({ url: `https://github.com/settings/apps/new?state=${MF_STATE}`, frameName: 'plexiform-connect|github|bnd1', referrer: `${MF_HUB}/?org=t1&view=integrations`, pageUrl: `${MF_HUB}/?org=t1&view=integrations`, hubOrigin: MF_HUB, signedIn: true, gestureAt: 1000, now: 2000, ...over });

test('manifest POST: the GitHub connector’s own form (user and org) is accepted, its body re-encoded from the checked manifest', async () => {
  for (const input of [{}, { org: 'acme-co' }]) {
    const f = await githubForm(input);
    assert.deepEqual(Object.keys(f.fields), ['manifest'], 'the form the hub serves has one field');
    const c = connectDecision(mfBase({ url: f.action, postBody: formBody(f.fields) }));
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.equal(c.provider, 'github');
    assert.equal(c.post.url, f.action);
    assert.equal(c.post.extraHeaders, 'Content-Type: application/x-www-form-urlencoded');
    assert.equal(c.post.postData.length, 1);
    assert.equal(c.post.postData[0].type, 'rawData');
    const sent = new URLSearchParams(c.post.postData[0].bytes.toString());
    assert.deepEqual([...sent.keys()], ['manifest']);
    assert.deepEqual(JSON.parse(sent.get('manifest')), JSON.parse(f.fields.manifest));
  }
  const org = await githubForm({ org: 'acme-co' });
  assert.match(org.action, /^https:\/\/github\.com\/organizations\/acme-co\/settings\/apps\/new\?state=/);
});

test('manifest POST: the form GitHub\'s manifestForm builds for an organization named at connect passes the unchanged desktop check; an odd org never reaches a form', async () => {
  const gh = (await import('../board/hub/integrations/github/index.js')).default;
  const build = (input) => gh.connect.manifestForm({ state: MF_STATE, redirectUri: `${MF_HUB}/integrations/github/callback`, webhookUrl: MF_HOOK, provider: {}, config: {}, input });
  for (const org of ['acme-co', 'Acme-Co', 'a', 'x'.repeat(39)]) {
    const f = build({ org });
    assert.equal(new URL(f.action).pathname, `/organizations/${org}/settings/apps/new`);
    const c = connectDecision(mfBase({ url: f.action, postBody: formBody(f.fields) }));
    assert.equal(c.ok, true, `${org} ${JSON.stringify(c)}`);
    assert.equal(c.post.url, f.action);
    assert.deepEqual(JSON.parse(new URLSearchParams(c.post.postData[0].bytes.toString()).get('manifest')), JSON.parse(f.fields.manifest));
  }
  // Path-like or odd names are refused by the connector before any form exists (the hub refuses them at /start too).
  for (const org of ['ac/me', '../acme', 'acme/../../settings', 'ac%2Fme', 'acme?x=1', 'acme#x', 'ac me', '-acme', 'acme-', 'ac--me', 'x'.repeat(40), 'ácme', '']) {
    assert.throws(() => build({ org }), /not a GitHub organization/, org);
  }
});

test('manifest POST: a GET to the same page still takes the GET path (no body, no post)', () => {
  const c = connectDecision(mfBase());
  assert.deepEqual(c, { ok: true, provider: 'github', bind: 'bnd1' });
  assert.deepEqual(connectDecision(mfBase({ postBody: undefined })), { ok: true, provider: 'github', bind: 'bnd1' });
});

test('manifest POST: only github.com’s two manifest pages over https with a sane state and nothing else; anything else is refused', async () => {
  const f = await githubForm();
  const body = formBody(f.fields);
  const no = (url, why) => assert.deepEqual(connectDecision(mfBase({ url, postBody: body })), { ok: false, reason: why === 'url' ? 'url' : 'post-url' }, url);
  const q = `?state=${MF_STATE}`;
  for (const url of [
    `https://github.com.evil/settings/apps/new${q}`, `https://api.github.com/settings/apps/new${q}`, `https://gist.github.com/settings/apps/new${q}`, `https://evilgithub.com/settings/apps/new${q}`,
    `https://github.com/settings/apps/new/${q}`, `https://github.com/settings/apps${q}`, `https://github.com/settings/apps/new/x${q}`, `https://github.com/x/settings/apps/new${q}`,
    `https://github.com/organizations/-acme/settings/apps/new${q}`, `https://github.com/organizations/${'a'.repeat(40)}/settings/apps/new${q}`, `https://github.com/organizations/ac%2Fme/settings/apps/new${q}`, `https://github.com/organizations//settings/apps/new${q}`,
    `https://github.com/login/oauth/authorize${q}`,
    'https://github.com/settings/apps/new', 'https://github.com/settings/apps/new?state=', 'https://github.com/settings/apps/new?state=short', `https://github.com/settings/apps/new?state=${'a'.repeat(1025)}`, 'https://github.com/settings/apps/new?state=has%20space%20in%20it%20ok',
    `https://github.com/settings/apps/new${q}&x=1`, `https://github.com/settings/apps/new${q}&state=${MF_STATE}`, `https://github.com/settings/apps/new?x=1&state=${MF_STATE}`, `https://github.com/settings/apps/new${q}#frag`,
    `https://github.com:8443/settings/apps/new${q}`,
  ]) no(url);
  for (const url of [`http://github.com/settings/apps/new${q}`, `https://u:p@github.com/settings/apps/new${q}`, `https://u@github.com/settings/apps/new${q}`, `https://localhost./settings/apps/new${q}`, `https://github.com./settings/apps/new${q}`, `https://127.0.0.1/settings/apps/new${q}`]) no(url, 'url');
  // Another provider’s window name never carries a manifest POST.
  assert.deepEqual(connectDecision(mfBase({ frameName: 'plexiform-connect|slack|b', url: f.action, postBody: body })), { ok: false, reason: 'post-provider' });
  // The opener rules still come first.
  for (const [over, reason] of [[{ signedIn: false }, 'signed-out'], [{ gestureAt: 0 }, 'gesture'], [{ pageUrl: `${MF_HUB}/?view=board` }, 'opener'], [{ frameName: 'buddy-connect' }, 'name']]) {
    assert.deepEqual(connectDecision(mfBase({ url: f.action, postBody: body, ...over })), { ok: false, reason });
  }
});

test('manifest POST: the body must be the hub’s form exactly: urlencoded, capped, one manifest field of JSON naming this hub', async () => {
  const f = await githubForm();
  const good = JSON.parse(f.fields.manifest);
  const try_ = (postBody) => connectDecision(mfBase({ url: f.action, postBody }));
  const bad = (postBody, reason, label) => assert.deepEqual(try_(postBody), { ok: false, reason }, label);
  const withManifest = (m) => formBody({ manifest: typeof m === 'string' ? m : JSON.stringify(m) });
  assert.equal(try_(withManifest(good)).ok, true);
  // shape of the body
  bad(formBody(f.fields, 'multipart/form-data; boundary=x'), 'post-body', 'multipart');
  bad(formBody(f.fields, 'text/plain'), 'post-body', 'text/plain');
  bad({ contentType: 'application/x-www-form-urlencoded', data: [{ type: 'file', filePath: '/etc/passwd' }] }, 'post-body', 'file part');
  bad({ contentType: 'application/x-www-form-urlencoded', data: [{ type: 'rawData', bytes: 'manifest=%7B%7D' }] }, 'post-body', 'bytes not a buffer');
  bad({ contentType: 'application/x-www-form-urlencoded' }, 'post-body', 'no data');
  bad({ contentType: 'application/x-www-form-urlencoded', data: [] }, 'post-body', 'empty');
  bad({ contentType: 'application/x-www-form-urlencoded', data: [{ type: 'rawData', bytes: Buffer.from([0x6d, 0xff, 0xfe]) }] }, 'post-body', 'not utf-8');
  bad(formBody({ ...f.fields, extra: '1' }), 'post-body', 'extra field');
  bad(formBody({ manifesto: f.fields.manifest }), 'post-body', 'wrong field');
  bad({ contentType: 'application/x-www-form-urlencoded', data: [{ type: 'rawData', bytes: Buffer.from(`${new URLSearchParams(f.fields)}&${new URLSearchParams(f.fields)}`) }] }, 'post-body', 'field twice');
  bad({ contentType: 'application/x-www-form-urlencoded', data: [{ type: 'rawData', bytes: Buffer.alloc(64 * 1024 + 1, 0x61) }] }, 'post-body', 'oversize body');
  bad({ contentType: 'application/x-www-form-urlencoded', data: [{ type: 'rawData', bytes: Buffer.alloc(40 * 1024, 0x61) }, { type: 'rawData', bytes: Buffer.alloc(40 * 1024, 0x61) }] }, 'post-body', 'oversize across parts');
  // the manifest itself
  bad(withManifest('not json'), 'manifest', 'non-JSON');
  bad(withManifest('[1]'), 'manifest', 'array');
  bad(withManifest('null'), 'manifest', 'null');
  bad(withManifest({ ...good, name: 'x'.repeat(20 * 1024) }), 'manifest', 'oversize manifest');
  for (const extra of ['setup_url', 'description', 'request_oauth_on_install', 'setup_on_update', '__proto__', 'constructor']) {
    bad(withManifest(`{${JSON.stringify(extra)}:"https://evil.example/x",${JSON.stringify(good).slice(1)}`), 'manifest', `unexpected key ${extra}`);
  }
  for (const k of ['name', 'url', 'hook_attributes', 'redirect_url']) { const m = { ...good }; delete m[k]; bad(withManifest(m), 'manifest', `missing ${k}`); }
  for (const redirect_url of ['https://evil.example/integrations/github/callback', 'https://app.plexiform.dev.evil/integrations/github/callback', 'http://app.plexiform.dev/integrations/github/callback', `${MF_HUB}/integrations/slack/callback`, `${MF_HUB}/integrations/github/callback/`, `${MF_HUB}/integrations/github/callback?x=1`, `${MF_HUB}/`, `https://u@app.plexiform.dev/integrations/github/callback`, `${MF_HUB}:443/integrations/github/callback`]) {
    bad(withManifest({ ...good, redirect_url }), 'manifest', redirect_url);
  }
  bad(withManifest({ ...good, callback_urls: ['https://evil.example/cb'] }), 'manifest', 'callback_urls off hub');
  bad(withManifest({ ...good, callback_urls: [] }), 'manifest', 'callback_urls empty');
  for (const url of ['https://evil.example/hook', `${MF_HUB}/integrations/github/callback`, `${MF_HUB}/integrations/not-a-uuid/webhook`, `http://app.plexiform.dev/integrations/0b6f1c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e/webhook`, `${MF_HOOK}?x=1`, `${MF_HOOK}#x`]) {
    bad(withManifest({ ...good, hook_attributes: { ...good.hook_attributes, url } }), 'manifest', `hook ${url}`);
  }
  bad(withManifest({ ...good, hook_attributes: { ...good.hook_attributes, secret: 'x' } }), 'manifest', 'hook extra key');
  bad(withManifest({ ...good, public: true }), 'manifest', 'public app');
  bad(withManifest({ ...good, default_permissions: { ...good.default_permissions, contents: 'write' } }), 'manifest', 'write permission');
  bad(withManifest({ ...good, default_permissions: { __proto__x: 'read' } }), 'manifest', 'odd permission name');
  bad(withManifest({ ...good, default_events: ['push', 42] }), 'manifest', 'event not a string');
  bad(withManifest({ ...good, url: 'http://plexiform.dev' }), 'manifest', 'homepage http');
  bad(withManifest({ ...good, url: 'https://localhost./' }), 'manifest', 'homepage loopback');
  bad(withManifest({ ...good, name: '<script>' }), 'manifest', 'name charset');
  // Duplicate JSON keys: what is checked is what is sent.
  const dup = `${JSON.stringify(good).slice(0, -1)},"redirect_url":"https://evil.example/cb"}`;
  bad(withManifest(dup), 'manifest', 'duplicate key, last one wins and is checked');
  const sent = JSON.parse(new URLSearchParams(try_(withManifest(` ${JSON.stringify(good)} `)).post.postData[0].bytes.toString()).get('manifest'));
  assert.deepEqual(sent, good, 're-encoded from the parsed manifest, not forwarded');
});

test('manifest POST: a refusal carries a fixed reason only; nothing from the body or URL reaches the result or the log line', async () => {
  const f = await githubForm();
  const marker = ['LEAK', 'MARKER', 'x9'].join('_');
  const outs = [
    connectDecision(mfBase({ url: f.action, postBody: formBody({ manifest: `{"name":"${marker}"` }) })),
    connectDecision(mfBase({ url: f.action, postBody: formBody({ manifest: JSON.stringify({ ...JSON.parse(f.fields.manifest), redirect_url: `https://${marker}.example/` }) }) })),
    connectDecision(mfBase({ url: `https://github.com/settings/apps/new?state=${marker}${'a'.repeat(20)}&x=${marker}`, postBody: formBody(f.fields) })),
    connectDecision(mfBase({ url: f.action, postBody: formBody({ [marker]: '1' }) })),
  ];
  for (const o of outs) {
    assert.equal(o.ok, false);
    assert.deepEqual(Object.keys(o), ['ok', 'reason']);
    assert.ok(!JSON.stringify(o).includes(marker));
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'index.js'), 'utf8');
  const hubView = src.slice(src.indexOf('function makeHubView('), src.indexOf('async function openConnect'));
  assert.match(hubView, /connectDecision\(\{ url, frameName, referrer: referrer\?\.url \?\? '', postBody,/);
  assert.match(hubView, /else log\('connect window refused', c\.reason\);/);
  assert.ok(!/log\([^)]*postBody/.test(src), 'the POST body is never logged');
  const fn = src.slice(src.indexOf('async function openConnect'), src.indexOf('async function showHubPage'));
  assert.match(fn, /\(post \? w\.loadURL\(post\.url, \{ postData: post\.postData, extraHeaders: post\.extraHeaders \}\) : w\.loadURL\(url\)\)/);
  assert.match(fn, /const authorizeHost = new URL\(post\?\.url \?\? url\)\.host;/);
  assert.ok(!/postBody/.test(fn), 'the raw body never reaches the connect window');
});

// ── connect window lifetime ──────────────────────────────────────────────

const { createConnectLife, CONNECT_LIFETIME_MS } = require('../buddy-window/connect-life');
function lifeTimers() {
  const live = new Map();
  let next = 1;
  return {
    live,
    setTimer: (fn, ms) => { const id = next++; live.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { live.delete(id); },
    fire(id) { const t = live.get(id); live.delete(id); t.fn(); },
  };
}
function lifeWin() {
  const w = new EventEmitter();
  w.destroyed = false;
  w.closes = 0;
  w.isDestroyed = () => w.destroyed;
  w.close = () => { w.closes += 1; if (!w.destroyed) { w.destroyed = true; w.emit('closed'); } };
  return w;
}

test('connect window lifetime: closes itself 10 minutes after it opens, expiry runs before the close, one timer per window', () => {
  assert.equal(CONNECT_LIFETIME_MS, 10 * 60 * 1000);
  const t = lifeTimers();
  const life = createConnectLife({ setTimer: t.setTimer, clearTimer: t.clearTimer });
  const w = lifeWin();
  const order = [];
  w.on('closed', () => order.push('closed'));
  life.arm(w, () => order.push(`expire:${w.isDestroyed()}`));
  life.arm(w, () => order.push('second'));
  assert.equal(t.live.size, 1, 'one timer per window');
  const [[id, timer]] = [...t.live];
  assert.equal(timer.ms, CONNECT_LIFETIME_MS);
  t.fire(id);
  assert.deepEqual(order, ['expire:false', 'closed']);
  assert.equal(w.closes, 1);
  assert.equal(t.live.size, 0);
});

test('connect window lifetime: a normal close clears the timer; a window already gone is left alone', () => {
  const t = lifeTimers();
  const life = createConnectLife({ setTimer: t.setTimer, clearTimer: t.clearTimer });
  const w = lifeWin();
  let expired = 0;
  life.arm(w, () => { expired += 1; });
  w.close();
  assert.equal(t.live.size, 0, 'cleared on normal close');
  const w2 = lifeWin();
  life.arm(w2, () => { expired += 1; });
  const [[id]] = [...t.live];
  w2.destroyed = true; // destroyed without a 'closed' we saw
  t.fire(id);
  assert.equal(expired, 0);
  assert.equal(w2.closes, 0);
});

test('connect window lifetime wiring: armed on every connect window; an expired one also loses its partition’s storage on close', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'index.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function openConnect'), src.indexOf('async function showHubPage'));
  assert.match(src, /const connectLife = createConnectLife\(\);/);
  assert.equal(src.split('createConnectLife(').length - 1, 1, 'one life (and so one timer set) for the app');
  assert.ok(fn.indexOf('connectWin = w;') < fn.indexOf('connectLife.arm(w,') && fn.indexOf('connectLife.arm(w,') < fn.indexOf('w.loadURL'), 'armed as soon as the window exists, before it loads');
  assert.match(fn, /connectLife\.arm\(w, \(\) => \{ expired = true; log\('connect window closed: 10 minutes passed'\); \}\);/);
  const closed = fn.slice(fn.indexOf("w.on('closed'"));
  assert.match(closed, /ses\.cookies\.remove\(cookie\.url, cookie\.name\)/);
  assert.match(closed, /if \(expired\) connectLife\.clearing\(integrationPartitionFor\(w\.hubOrigin\), \(\) => ses\.clearStorageData\(\)\)\.catch\(\(\) => \{\}\);/);
});

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function lifeSession() {
  const s = { sets: [], removes: [], pending: [] };
  s.cookies = {
    set: (c) => { s.sets.push(c); const d = deferred(); s.pending.push(d); return d.promise; },
    remove: async (url, name) => { s.removes.push([url, name]); },
  };
  return s;
}
const LIFE_PART = 'persist:integration-auth-x';
const LIFE_COOKIE = { url: 'https://app.plexiform.dev/', name: '__Host-board_int_github', value: 'b' };

test('connect sign-out generation: a sign-out or switch while the bind cookie is being set refuses the open and removes the cookie', async () => {
  const life = createConnectLife({ setTimer: () => 0, clearTimer: () => {} });
  // nothing happened meanwhile: open
  let ses = lifeSession();
  let p = life.setBindCookie(ses, LIFE_PART, LIFE_COOKIE);
  ses.pending[0].resolve();
  assert.equal(await p, true);
  assert.deepEqual(ses.removes, []);
  // signed out (or switched account / hub) while the set was in flight
  ses = lifeSession();
  p = life.setBindCookie(ses, LIFE_PART, LIFE_COOKIE);
  life.bump();
  ses.pending[0].resolve();
  assert.equal(await p, false);
  assert.deepEqual(ses.removes, [[LIFE_COOKIE.url, LIFE_COOKIE.name]], 'the cookie it set is removed');
  // the partition was cleared while the set was in flight
  ses = lifeSession();
  p = life.setBindCookie(ses, LIFE_PART, LIFE_COOKIE);
  const clear = deferred();
  const cleared = life.clearing(LIFE_PART, () => clear.promise);
  ses.pending[0].resolve();
  assert.equal(await p, false);
  assert.deepEqual(ses.removes, [[LIFE_COOKIE.url, LIFE_COOKIE.name]]);
  // and while the clear is still running, no cookie is even set
  const ses2 = lifeSession();
  assert.equal(await life.setBindCookie(ses2, LIFE_PART, LIFE_COOKIE), false);
  assert.deepEqual(ses2.sets, []);
  clear.resolve();
  await cleared;
  // a clear that finished during the set counts too
  ses = lifeSession();
  p = life.setBindCookie(ses, LIFE_PART, LIFE_COOKIE);
  await life.clearing(LIFE_PART, async () => {});
  ses.pending[0].resolve();
  assert.equal(await p, false);
  // a clear that failed still ends, and a later open works
  await assert.rejects(life.clearing(LIFE_PART, async () => { throw new Error('x'); }));
  ses = lifeSession();
  p = life.setBindCookie(ses, LIFE_PART, LIFE_COOKIE);
  ses.pending[0].resolve();
  assert.equal(await p, true);
});

test('connect sign-out generation wiring: bumped on sign-out, account and hub switch; openConnect refuses before any window exists', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'index.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function openConnect'), src.indexOf('async function showHubPage'));
  assert.ok(src.indexOf('const connectLife = createConnectLife();') < src.indexOf('createHubSupervisor({'), 'exists before anything can call forgetHub');
  assert.match(src, /function forgetHub\(\) \{\n\s+gen \+= 1;\n\s+connectLife\.bump\(\);/);
  assert.match(src, /if \(!id \|\| !store\.setActive\(id\)\) return;\n\s+connectLife\.bump\(\);/);
  assert.match(src, /await connectLife\.clearing\(integrationPartitionFor\(origin\), \(\) => clearHubSessions\(origin, \(p\) => session\.fromPartition\(p\)\)\);/);
  const refuse = fn.indexOf("if (!current) { log('connect window refused', 'signed out or switched while opening'); return; }");
  assert.ok(refuse > fn.indexOf('connectLife.setBindCookie(') && refuse < fn.indexOf('new BrowserWindow('), 'refused after the cookie set, before the window');
  assert.ok(!/ses\.cookies\.set\(/.test(fn), 'the cookie is set only through the generation check');
});

// ── hub env ────────────────────────────────────────────────────────────────

test('hub env is an allowlist: no secrets from our env, loopback bind, no secret in local mode', () => {
  const base = { HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-x', GITHUB_TOKEN: 'ghp_x', BOARD_LOCAL_SECRET: 'x'.repeat(40), BOARD_AUTH: 'access' };
  const local = hubEnv({ mode: 'local', dataDir: '/d', baseEnv: base });
  assert.equal(local.BOARD_AUTH, 'local');
  assert.equal(local.BOARD_BIND, '127.0.0.1');
  assert.equal(local.BOARD_PORT, '0');
  assert.equal(local.HOME, '/h');
  for (const k of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'BOARD_LOCAL_SECRET', 'BOARD_DEV_LOGIN_SECRET']) assert.equal(local[k], undefined, k);
  const dev = hubEnv({ mode: 'dev', dataDir: '/d', port: 4321, devSecret: 's', baseEnv: base });
  assert.equal(dev.BOARD_AUTH, 'dev');
  assert.equal(dev.BOARD_PORT, '4321');
  assert.equal(dev.BOARD_DEV_LOGIN_SECRET, 's');
});

test('dev auth is refused in a packaged build', () => {
  assert.throws(() => createHubSupervisor({ fork: () => {}, hubEntry: '/x/board/hub/server.js', dataDir: '/tmp/x', mode: 'dev', isPackaged: true }), /packaged/);
});

// ── supervisor ─────────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  constructor() { super(); this.pid = 0; this.killed = 0; this.sent = []; this.stderr = new (require('node:stream').PassThrough)(); }
  // exitOnKill:false models a hub that ignores the request, so only the force-kill ends it.
  kill() { this.killed += 1; if (this.exitOnKill !== false) setImmediate(() => this.emit('exit', 0)); return true; }
  postMessage(m) { this.sent.push(m); }
}

// Fake clock for the supervisor's ready/grace timers: real unref'd timers never
// fire when nothing else holds the event loop open (Windows CI), so tests fire them.
function fakeTimers() {
  const pending = new Set();
  return {
    setTimeout: (fn) => { const t = { fn, unref() {} }; pending.add(t); return t; },
    clearTimeout: (t) => { pending.delete(t); },
    fire() { for (const t of [...pending]) { pending.delete(t); t.fn(); } },
    get count() { return pending.size; },
  };
}

function harness(overrides = {}) {
  const children = [];
  const statuses = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-hub-'));
  let t = 0;
  const timers = fakeTimers();
  const sup = createHubSupervisor({
    fork: (entry, args, opts) => { const c = new FakeChild(); c.entry = entry; c.opts = opts; children.push(c); return c; },
    hubEntry: '/app/board/hub/server.js',
    dataDir: path.join(dataDir, 'board'),
    onStatus: (s) => statuses.push(s),
    now: () => t,
    readyTimeoutMs: 200,
    timers,
    ...overrides,
  });
  return { sup, children, statuses, timers, dataDir: path.join(dataDir, 'board'), tick: (ms) => { t += ms; } };
}

const SECRET = 'a'.repeat(43);

test('local mode: ready on board.listening; the secret comes from the port report, never env', async () => {
  const { sup, children, dataDir } = harness();
  const p = sup.ensure();
  await new Promise((r) => setImmediate(r));
  assert.equal(children.length, 1);
  assert.equal(children[0].opts.env.BOARD_AUTH, 'local');
  assert.equal(children[0].opts.serviceName, 'Plexiform Board Hub');
  // NTFS has no POSIX mode bits.
  if (process.platform !== 'win32') assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
  children[0].emit('message', { type: 'board.listening', port: 5123, hub_epoch: 'e1', local_secret: SECRET });
  const info = await p;
  assert.deepEqual({ url: info.url, port: info.port, mode: info.mode, localSecret: info.localSecret }, { url: 'http://127.0.0.1:5123', port: 5123, mode: 'local', localSecret: SECRET });
  assert.equal(sup.status().state, 'ready');
  // A second ensure() reuses the running hub.
  assert.equal(await sup.ensure(), info);
  assert.equal(children.length, 1);
});

test('local mode: a hub without local auth (no secret) is a start failure, not a silent open board', async () => {
  const { sup, children } = harness();
  const p = sup.ensure();
  await new Promise((r) => setImmediate(r));
  children[0].emit('message', { type: 'board.listening', port: 5123, hub_epoch: 'e1' });
  await assert.rejects(p, /no local secret/);
  assert.equal(sup.status().state, 'failed');
});

test('board.fatal before exit fails the start with the hub message', async () => {
  const { sup, children } = harness();
  const p = sup.ensure();
  await new Promise((r) => setImmediate(r));
  children[0].emit('message', { type: 'board.fatal', message: 'EADDRINUSE' });
  children[0].emit('exit', 1);
  await assert.rejects(p, /EADDRINUSE/);
  assert.equal(sup.status().state, 'failed');
  assert.match(sup.status().error, /EADDRINUSE/);
});

test('no report in time → failed; retry() starts a new child', async () => {
  const { sup, children, timers } = harness();
  const first = sup.ensure();
  await new Promise((r) => setImmediate(r));
  timers.fire();
  await assert.rejects(first, /did not report/);
  const p = sup.retry();
  await new Promise((r) => setImmediate(r));
  assert.equal(children.length, 2);
  children[1].emit('message', { type: 'board.listening', port: 5, local_secret: SECRET });
  await p;
  assert.equal(sup.status().state, 'ready');
});

test('a crash after ready restarts with backoff; the 6th crash in 10 min gives up', async () => {
  const delays = [];
  const pending = [];
  const { sup, children, tick } = harness({ schedule: (fn, ms) => { delays.push(ms); pending.push(fn); } });
  const ready = async (c) => { await new Promise((r) => setImmediate(r)); c.emit('message', { type: 'board.listening', port: 5, local_secret: SECRET }); };
  const p = sup.ensure();
  await ready(children[0]);
  await p;
  for (let i = 0; i < MAX_RESTARTS; i += 1) {
    children.at(-1).emit('exit', 1);
    assert.equal(sup.status().state, 'restarting');
    tick(1000);
    pending.shift()();
    await ready(children.at(-1));
    await new Promise((r) => setImmediate(r));
    assert.equal(sup.status().state, 'ready');
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000]);
  children.at(-1).emit('exit', 1);
  assert.equal(sup.status().state, 'failed');
  assert.match(sup.status().error, /keeps crashing/);
  assert.equal(pending.length, 0);
});

test('crashes older than the window no longer count', async () => {
  const pending = [];
  const { sup, children, tick } = harness({ schedule: (fn) => pending.push(fn) });
  const ready = async (c) => { await new Promise((r) => setImmediate(r)); c.emit('message', { type: 'board.listening', port: 5, local_secret: SECRET }); };
  const p = sup.ensure();
  await ready(children[0]);
  await p;
  for (let i = 0; i < MAX_RESTARTS * 2; i += 1) {
    children.at(-1).emit('exit', 1);
    tick(11 * 60_000);
    assert.equal(sup.status().state, 'restarting');
    pending.shift()();
    await ready(children.at(-1));
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(sup.status().state, 'ready');
});

async function readyHub(h) {
  const p = h.sup.ensure();
  await new Promise((r) => setImmediate(r));
  h.children[0].emit('message', { type: 'board.listening', port: 5, local_secret: SECRET });
  await p;
}

test('stop() asks the hub to shut down, sends SIGTERM (kill) and resolves on exit; no restart after stop', async () => {
  const h = harness({ platform: 'linux' });
  await readyHub(h);
  await h.sup.stop({ graceMs: 1000 });
  assert.deepEqual(h.children[0].sent, [{ type: 'hub.shutdown' }]);
  assert.equal(h.children[0].killed, 1);
  assert.equal(h.sup.status().state, 'stopped');
  assert.equal(h.timers.count, 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.children.length, 1);
});

test('stop() on win32: message only, no kill while the hub shuts down by itself', async () => {
  const h = harness({ platform: 'win32' });
  await readyHub(h);
  const c = h.children[0];
  c.exitOnKill = false;
  let done = false;
  const stopped = h.sup.stop({ graceMs: 1000 }).then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(c.sent, [{ type: 'hub.shutdown' }]);
  assert.equal(c.killed, 0);
  assert.equal(done, false);
  c.emit('exit', 0); // the hub closed its DB and left
  await stopped;
  assert.equal(c.killed, 0);
  assert.equal(h.sup.status().state, 'stopped');
  assert.equal(h.timers.count, 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.children.length, 1);
});

test('stop() on win32: a hub that does not exit within the grace is force-killed', async () => {
  const h = harness({ platform: 'win32' });
  await readyHub(h);
  const c = h.children[0];
  c.exitOnKill = false;
  const stopped = h.sup.stop({ graceMs: 1000 });
  await new Promise((r) => setImmediate(r));
  assert.equal(c.killed, 0);
  h.timers.fire(); // the grace ran out
  await stopped;
  assert.equal(c.killed, 1);
  assert.equal(h.sup.status().state, 'stopped');
});

test('stop() off win32: a hub that ignores SIGTERM is SIGKILLed by pid after the grace', async () => {
  const kills = [];
  const h = harness({ platform: 'linux', killPid: (pid, sig) => kills.push([pid, sig]) });
  await readyHub(h);
  const c = h.children[0];
  c.pid = 4242;
  c.exitOnKill = false;
  const stopped = h.sup.stop({ graceMs: 1000 });
  await new Promise((r) => setImmediate(r));
  assert.equal(c.killed, 1);
  assert.deepEqual(kills, []);
  h.timers.fire();
  await stopped;
  assert.deepEqual(kills, [[4242, 'SIGKILL']]);
});

test('retry() while a hub is running stops it first: never two hubs on one DB', async () => {
  const { sup, children } = harness();
  const p = sup.ensure();
  await new Promise((r) => setImmediate(r));
  children[0].emit('message', { type: 'board.listening', port: 5, local_secret: SECRET });
  await p;
  const q = sup.retry();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(children[0].killed, 1);
  assert.equal(children.length, 2);
  children[1].emit('message', { type: 'board.listening', port: 6, local_secret: SECRET });
  const info = await q;
  assert.equal(info.port, 6);
  assert.equal(sup.status().state, 'ready');
  // The old child's late exit must not disturb the new one.
  assert.equal(sup.status().url, 'http://127.0.0.1:6');
});

test('a failed start kills only its own child', async () => {
  const { sup, children, timers } = harness();
  const first = sup.ensure();
  await new Promise((r) => setImmediate(r));
  timers.fire();
  await assert.rejects(first, /did not report/);
  assert.equal(children[0].killed, 1);
  const p = sup.retry();
  await new Promise((r) => setImmediate(r));
  children[1].emit('message', { type: 'board.listening', port: 7, local_secret: SECRET });
  await p;
  assert.equal(children[1].killed, 0);
});

test('stop() during a dev start (before the fork) forks nothing; final stop blocks later starts', async () => {
  let release;
  const { sup, children } = harness({ mode: 'dev', pickPort: () => new Promise((r) => { release = r; }) });
  const p = sup.ensure();
  await new Promise((r) => setImmediate(r));
  await sup.stop({ final: true });
  release(4444);
  await assert.rejects(p, /stopped/);
  assert.equal(children.length, 0);
  await assert.rejects(sup.ensure(), /quitting/);
  assert.equal(sup.status().state, 'stopped');
});

test('dev mode never logs the dev login secret from the hub stderr', async () => {
  const lines = [];
  const { sup, children } = harness({ mode: 'dev', pickPort: async () => 4555, log: (...a) => lines.push(a.join(' ')), fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  await sup.ensure();
  children[0].stderr.write('Sign in at:\n  http://127.0.0.1:4555/#dev_secret=SuperSecretValue123\n');
  await new Promise((r) => setImmediate(r));
  assert.ok(lines.some((l) => l.includes('dev_secret=<redacted>')), lines.join('|'));
  assert.ok(!lines.some((l) => l.includes('SuperSecretValue123')));
});

// ── workspaces ─────────────────────────────────────────────────────────────

const { createWorkspaceStore, buildWorkspaceList, teamsFromAccount, normalizeHubUrl, normalizeLinkHub, isPrivateHost, accessTeamFromLocation, partitionFor: teamPartition, integrationPartitionFor, hubKey } = require('../buddy-window/workspaces');

test('team hub URLs: https origins only, bare hosts become https, junk refused', () => {
  assert.equal(normalizeHubUrl('buddy.bondly.co.za'), 'https://buddy.bondly.co.za');
  assert.equal(normalizeHubUrl(' https://buddy.bondly.co.za/some/path?x=1#y '), 'https://buddy.bondly.co.za');
  assert.throws(() => normalizeHubUrl('http://buddy.bondly.co.za'), /https/);
  assert.throws(() => normalizeHubUrl('https://user:pw@buddy.bondly.co.za'), /password/);
  assert.throws(() => normalizeHubUrl('localhost:8787'), /public address/);
  assert.throws(() => normalizeHubUrl('https://127.0.0.1'), /public address/);
  assert.throws(() => normalizeHubUrl(''), /Enter/);
  assert.throws(() => normalizeHubUrl('javascript:alert(1)'), /web address|https/);
  assert.match(teamPartition('https://buddy.bondly.co.za'), /^persist:board-[0-9a-f]{16}$/);
});

test('hub files and partitions are named by sha256(origin)[0:16], never by the host spelling', () => {
  const crypto = require('node:crypto');
  const o = 'https://buddy.bondly.co.za';
  const key = crypto.createHash('sha256').update(o).digest('hex').slice(0, 16);
  assert.equal(hubKey(o), key);
  assert.equal(teamPartition(o), `persist:board-${key}`);
  assert.equal(integrationPartitionFor(o), `persist:integration-auth-${key}`);
  // The old host-derived names collided (a.b_c vs a.b:c); hashes of distinct origins don't.
  assert.notEqual(hubKey('http://127.0.0.1:5123'), hubKey('http://127.0.0.1:5124'));
  assert.notEqual(teamPartition(o), integrationPartitionFor(o));
});

test('link hubs: no private, link-local, CGNAT or loopback addresses (the dev mock origin excepted)', () => {
  for (const h of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.169.254', '100.64.0.1', '100.127.255.254', '127.0.0.1', '0.0.0.0']) {
    assert.equal(isPrivateHost(h), true, h);
    assert.throws(() => normalizeLinkHub(`https://${h}`), /public address/, h);
  }
  for (const h of ['172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '8.8.8.8', 'buddy.example.com']) assert.equal(isPrivateHost(h), false, h);
  assert.equal(normalizeLinkHub('https://8.8.8.8'), 'https://8.8.8.8');
  assert.equal(normalizeLinkHub('buddy.example.com'), 'https://buddy.example.com');
  // Typed hubs keep today's rule: a private address the member typed is their call.
  assert.equal(normalizeHubUrl('https://10.0.0.5'), 'https://10.0.0.5');
  assert.equal(normalizeLinkHub('http://127.0.0.1:5000', { allowOrigins: ['http://127.0.0.1:5000'] }), 'http://127.0.0.1:5000');
  const { parseInvite: parse } = require('../buddy-window/accounts');
  assert.equal(parse('claudebuddy://join?hub=https://192.168.1.10&t=inv_x', { normalizeHub: (u) => normalizeLinkHub(u) }), null);
  assert.equal(parse('https://10.1.2.3/invite#inv_x', { normalizeHub: (u) => normalizeLinkHub(u) }), null);
});

test('the Access team comes only from a *.cloudflareaccess.com redirect', () => {
  assert.equal(accessTeamFromLocation('https://restless-hall-ab0c.cloudflareaccess.com/cdn-cgi/access/login/buddy.bondly.co.za?kid=1'), 'restless-hall-ab0c');
  assert.equal(accessTeamFromLocation('https://evil.example.com/cloudflareaccess.com'), null);
  assert.equal(accessTeamFromLocation('https://a.b.cloudflareaccess.com/'), null);
  assert.equal(accessTeamFromLocation('not a url'), null);
});

test('workspace list from /api/account: this Mac, then each signed-in hub’s teams, then Access-fallback hubs', () => {
  const A = 'https://a.example.com';
  const B = 'https://b.example.com';
  const acct = { user: { id: 'u' }, teams: [{ id: 'team_2', name: 'Zeta', role: 'member', boards: [] }, { id: 'team_1', name: 'Alpha', role: 'owner', boards: [] }, { id: 'bad id/..', name: 'x' }, { id: 't3' }] };
  const teams = { [A]: teamsFromAccount(acct), [B]: teamsFromAccount({ teams: [{ id: 'b1', name: 'Bee', role: 'weird' }] }) };
  assert.deepEqual(teams[A].map((t) => t.id), ['team_2', 'team_1'], 'junk ids and nameless teams dropped');
  assert.equal(teams[B][0].role, 'member', 'unknown role read as member');
  const list = buildWorkspaceList({ hubs: [A, B], teams, access: [{ url: 'https://old.example.com', name: 'Old', accessTeam: 'x' }] });
  assert.deepEqual(list.map((w) => w.id), ['local', 'team:a.example.com:team_1', 'team:a.example.com:team_2', 'team:b.example.com:b1', 'access:old.example.com']);
  assert.deepEqual(list.map((w) => w.group ?? null), [null, 'a.example.com', 'a.example.com', 'b.example.com', null], 'hub names shown when there are several');
  assert.deepEqual({ hub: list[1].hub, teamId: list[1].teamId, role: list[1].role }, { hub: A, teamId: 'team_1', role: 'owner' });
  const one = buildWorkspaceList({ hubs: [A, B], teams, signedIn: (h) => h === A });
  assert.deepEqual(one.map((w) => w.id), ['local', 'team:a.example.com:team_1', 'team:a.example.com:team_2'], 'a signed-out hub shows no teams');
  assert.equal(one[1].group, null);
  // Every team on one hub shares that hub's partition.
  assert.equal(teamPartition(A), `persist:board-${hubKey(A)}`);
});

test('workspace store: hubs, teams from the account, active team, persisted without secrets, 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ws-'));
  const file = path.join(dir, 'ws.json');
  const s1 = createWorkspaceStore(file);
  assert.equal(s1.active().id, 'local');
  const hub = s1.addHub('buddy.bondly.co.za');
  assert.equal(hub, 'https://buddy.bondly.co.za');
  assert.equal(s1.lastHub(), hub);
  assert.equal(s1.setTeams(hub, { teams: [{ id: 't1', name: 'Bondly', role: 'owner' }, { id: 't2', name: 'Side', role: 'viewer' }] }), true);
  assert.equal(s1.activateTeam(hub, 't2'), true);
  assert.equal(s1.active().name, 'Side');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = fs.readFileSync(file, 'utf8');
  assert.ok(!/token|bdt_|secret/i.test(saved), saved);
  const s2 = createWorkspaceStore(file);
  assert.equal(s2.active().id, 'team:buddy.bondly.co.za:t2');
  // Removed from a team (the next /api/account lacks it) → back to this Mac.
  s2.setTeams(hub, { teams: [{ id: 't1', name: 'Bondly', role: 'owner' }] });
  assert.equal(s2.active().id, 'local');
  s2.activateTeam(hub, 't1');
  s2.forgetTeams(hub);
  assert.equal(s2.active().id, 'local');
  assert.deepEqual(s2.list().map((w) => w.id), ['local']);
  assert.equal(s2.knows(hub), true, 'the hub is remembered for the next sign-in');
  assert.equal(s2.setActive('team:nope'), false);
  assert.equal(s2.sharesPresence(hub), false, 'presence is off by default');
  s2.setSharesPresence(hub, true);
  assert.equal(createWorkspaceStore(file).sharesPresence(hub), true);
});

test('workspace store: v1 files migrate: every entry the old probe accepted stays an Access workspace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ws-'));
  const file = path.join(dir, 'ws.json');
  fs.writeFileSync(file, JSON.stringify({ active: 'team:signedin.example.com', teams: [
    { name: 'Old', url: 'https://old.example.com', accessTeam: 'restless-hall' },
    // Saved while already signed in to Access: the probe got a 200 and no team.
    { name: 'Signed in', url: 'https://signedin.example.com', accessTeam: null },
    { name: 'Bad team', url: 'https://bad.example.com', accessTeam: 'evil.example.com/..' },
  ] }));
  const s = createWorkspaceStore(file);
  assert.deepEqual(s.list().map((w) => w.id), ['local', 'access:old.example.com', 'access:signedin.example.com', 'access:bad.example.com']);
  assert.equal(s.active().id, 'access:signedin.example.com');
  assert.equal(s.get('access:old.example.com').accessTeam, 'restless-hall');
  assert.equal(s.get('access:bad.example.com').accessTeam, null);
  assert.deepEqual(s.hubs(), [], 'nothing became an account hub to sign in to');
  assert.equal(s.lastHub(), null);
  s.setActive('local');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
  assert.equal(s.removeAccess('access:old.example.com'), true);
});

test('workspace store: a tampered file cannot smuggle in a non-https hub, a loopback hub or a bad Access team', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ws-'));
  const file = path.join(dir, 'ws.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, active: 'team:evil', hubs: ['http://evil.example.com', 'http://127.0.0.1:5000', 'https://ok.example.com', 'https://ok.example.com/path'],
    teams: { 'https://ok.example.com': [{ id: '../x', name: 'bad' }, { id: 'good', name: 'Good' }] },
    access: [{ name: 'y', url: 'https://acc.example.com', accessTeam: 'evil.example.com/../' }] }));
  const s = createWorkspaceStore(file);
  assert.deepEqual(s.hubs(), ['https://ok.example.com']);
  assert.deepEqual(s.list().map((w) => w.id), ['local', 'team:ok.example.com:good', 'access:acc.example.com']);
  assert.equal(s.get('access:acc.example.com').accessTeam, null);
  assert.equal(s.active().id, 'local');
  // The dev mock's exact origin is let through only when named.
  const d = createWorkspaceStore(file, { allowOrigins: ['http://127.0.0.1:5000'] });
  assert.deepEqual(d.hubs(), ['http://127.0.0.1:5000', 'https://ok.example.com']);
  assert.throws(() => normalizeHubUrl('http://127.0.0.1:5001', { allowOrigins: ['http://127.0.0.1:5000'] }));
});

// ── this Mac as a runner ──────────────────────────────────────────────────

const { createDeviceController, defaultDeviceName, presenceSessions, runnerTokenFrom, scrubTokens, NO_RUNNER } = require('../buddy-window/device');

const HUB = 'https://buddy.bondly.co.za';
// Token-shaped strings are built here, never written out whole.
const brtOf = (c) => ['brt', c.repeat(43)].join('_');
const CONFIG_KEYS = ['data_dir', 'hub_url', 'runner_token', 'team_id', 'type'];

function deviceHarness(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-dev-'));
  const calls = [];
  const children = [];
  const statuses = [];
  const pending = [];
  const logs = [];
  const events = [];
  let t = 0;
  let n = 0;
  const account = over.account ?? {
    origin: HUB,
    enrol: async (team, opts) => { calls.push({ op: 'enrol', team, opts }); n += 1; return over.enrol ? over.enrol(n) : { ok: true, enrollment_id: 'enr-1', team_id: team, runner_token: brtOf('abcdefghij'[n % 10]) }; },
    unenrol: async (team) => { calls.push({ op: 'unenrol', team }); return over.unenrol ? over.unenrol() : { ok: true }; },
  };
  const make = (teamId = 'team-1') => createDeviceController({
    account, teamId, credsFile: path.join(dir, `device-${teamId}.bin`), canSeal: () => over.canSeal ?? true,
    seal: over.seal ?? ((s) => Buffer.from(`SEALED:${Buffer.from(s).toString('base64')}`)),
    unseal: (b) => Buffer.from(String(b).slice(7), 'base64').toString(),
    fork: (entry, args, opts) => { const c = new FakeChild(); c.entry = entry; c.args = args; c.opts = opts; c.sent = []; c.postMessage = (m) => c.sent.push(m); children.push(c); return c; },
    runnerEntry: '/app/board/runner/app-entry.js', entryExists: () => over.entryExists ?? true, dataDir: path.join(dir, 'runner', teamId),
    onStatus: (s) => statuses.push(s), onEvent: (e) => { if (over.onEventThrows) throw new Error('subscriber bug'); events.push(e); }, schedule: (fn) => pending.push(fn), now: () => t, stopGraceMs: 1000, log: (...a) => logs.push(a.map(String).join(' ')),
  });
  const credsFile = (teamId = 'team-1') => path.join(dir, `device-${teamId}.bin`);
  const unsealed = (teamId) => JSON.parse(Buffer.from(fs.readFileSync(credsFile(teamId), 'utf8').slice(7), 'base64').toString());
  return { dir, calls, children, statuses, pending, logs, events, make, credsFile, unsealed, tick: (ms) => { t += ms; } };
}

test('device name reads like a person made it', () => {
  assert.equal(defaultDeviceName('Callum', 'Callums-MacBook-Air.local'), 'Callum’s Callums MacBook Air');
  assert.equal(defaultDeviceName('', ''), 'My’s Mac');
});

test('enable: enrols with the device name, seals the runner token 0600, and runner.config has exactly the five fields', async () => {
  const h = deviceHarness();
  const d = h.make();
  assert.match((await d.enable({ name: '  ' })).error, /name/);
  assert.equal(h.calls.length, 0);
  assert.equal((await d.enable({ name: 'Callum’s Mac' })).ok, true);
  assert.deepEqual(h.calls[0], { op: 'enrol', team: 'team-1', opts: { deviceName: 'Callum’s Mac' } });
  const token = brtOf('b');
  const raw = fs.readFileSync(h.credsFile(), 'utf8');
  assert.ok(raw.startsWith('SEALED:') && !raw.includes('brt_'), 'sealed, never plain');
  assert.equal(fs.statSync(h.credsFile()).mode & 0o777, 0o600);
  assert.equal(h.unsealed().runner_token, token);
  const c = h.children[0];
  assert.deepEqual(Object.keys(c.sent[0]).sort(), CONFIG_KEYS, 'no device_id, device_token or cf_* fields');
  assert.deepEqual(c.sent[0], { type: 'runner.config', hub_url: HUB, runner_token: token, team_id: 'team-1', data_dir: path.join(h.dir, 'runner', 'team-1') });
  // The token only ever crosses parentPort: not argv, env or a log line, even when the runner echoes it.
  assert.deepEqual(c.args, [], 'app-entry takes no args');
  assert.equal(c.opts.cwd, undefined);
  assert.deepEqual(Object.keys(c.opts.env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR', 'USER']);
  c.stderr.write(`connect failed with ${token} and ${['bdt', 'x'.repeat(43)].join('_')}\n`);
  c.emit('message', { type: 'runner.fatal', message: `bad ${token}` });
  await new Promise((r) => setImmediate(r));
  for (const where of [JSON.stringify(c.args), JSON.stringify(c.opts), ...h.logs, JSON.stringify(h.statuses)]) {
    assert.ok(!where.includes(token) && !/b[rd]t_[A-Za-z0-9_-]{20}/.test(where), `token leaked: ${where.slice(0, 80)}`);
  }
  assert.ok(h.logs.some((l) => l.includes('<token>')), 'the runner’s line is kept, the token cut');
  assert.equal(scrubTokens(`a ${token} b`), 'a <token> b');
});

test('enable while on rotates: the new token replaces the sealed one and the runner restarts on it', async () => {
  const h = deviceHarness();
  const d = h.make();
  await d.enable({ name: 'Mac' });
  h.children[0].emit('message', { type: 'runner.ready' });
  assert.equal(h.unsealed().runner_token, brtOf('b'));
  assert.equal((await d.enable({ name: 'Mac' })).ok, true);
  assert.equal(h.unsealed().runner_token, brtOf('c'), 'replaced, not appended');
  assert.equal(h.children[0].killed, 1, 'the runner on the dead token stopped');
  assert.equal(h.children.length, 2);
  assert.equal(h.children[1].sent[0].runner_token, brtOf('c'));
  assert.equal(h.pending.length, 0, 'a restart, not the crash backoff');
  assert.equal(fs.readdirSync(h.dir).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp file left');
  // Two clicks at once never enrol twice.
  const both = await Promise.all([d.enable({ name: 'Mac' }), d.enable({ name: 'Mac' })]);
  assert.deepEqual(both.map((r) => r.ok), [true, false]);
  assert.equal(h.calls.filter((x) => x.op === 'enrol').length, 3);
});

test('rotation race: the old runner reporting its 4403 while the new token arrives never deletes the new token', async () => {
  let h;
  h = deviceHarness({ enrol: (n) => {
    // The hub closes the old socket as it answers: the old runner says so before the answer lands.
    if (n === 2) h.children[0].emit('message', { type: 'runner.status', state: 'revoked' });
    return { ok: true, enrollment_id: 'enr-1', team_id: 'team-1', runner_token: brtOf(String(n)) };
  } });
  const d = h.make();
  await d.enable({ name: 'Mac' });
  h.children[0].emit('message', { type: 'runner.ready' });
  assert.equal((await d.enable({ name: 'Mac' })).ok, true);
  assert.equal(h.unsealed().runner_token, brtOf('2'));
  assert.deepEqual([d.status().enabled, d.status().ended], [true, null]);
  assert.equal(h.children[1].sent[0].runner_token, brtOf('2'));
  // A refused rotation: the old token keeps working, but a real 4403 that came meanwhile still counts.
  const g = deviceHarness({ enrol: (n) => {
    if (n === 1) return { ok: true, enrollment_id: 'enr-1', team_id: 'team-1', runner_token: brtOf('a') };
    g.children[0].emit('message', { type: 'runner.status', state: 'revoked' });
    return { ok: false, status: 429, error: 'wait' };
  } });
  const gd = g.make();
  await gd.enable({ name: 'Mac' });
  assert.equal((await gd.enable({ name: 'Mac' })).ok, false);
  assert.deepEqual([gd.status().runner.state, gd.status().ended], ['removed', 4403]);
  assert.equal(fs.existsSync(g.credsFile()), false);
});

test('an enrolment that answers after a turn-off, sign-out or quit is unenrolled and never stored or run', async () => {
  let release;
  const h = deviceHarness({ enrol: () => new Promise((r) => { release = () => r({ ok: true, enrollment_id: 'e', team_id: 'team-1', runner_token: brtOf('l') }); }) });
  const d = h.make();
  const p = d.enable({ name: 'Mac' });
  await new Promise((r) => setImmediate(r));
  await d.discard();
  release();
  assert.match((await p).error, /cancelled/);
  assert.equal(fs.existsSync(h.credsFile()), false);
  assert.equal(h.children.length, 0);
  assert.deepEqual(h.calls.map((c) => c.op), ['enrol', 'unenrol']);
});

test('disable (the switch off): DELETE enrol, the runner stops, the token leaves this Mac; an unreached hub is said', async () => {
  const h = deviceHarness();
  const d = h.make();
  await d.enable({ name: 'Mac' });
  assert.equal((await d.disable()).ok, true);
  assert.equal(h.children[0].killed, 1);
  assert.deepEqual(h.calls.at(-1), { op: 'unenrol', team: 'team-1' });
  assert.equal(fs.existsSync(h.credsFile()), false);
  assert.deepEqual([d.status().enabled, d.status().enrolled, d.status().runner.state], [false, false, 'off']);
  await h.make().resume();
  assert.equal(h.children.length, 1, 'off stays off at the next launch');
  const g = deviceHarness({ unenrol: () => ({ ok: false, status: 404 }) });
  const gd = g.make();
  await gd.enable({ name: 'Mac' });
  assert.deepEqual(await gd.disable(), { ok: true }, 'already gone on the hub is fine');
  const off = deviceHarness({ unenrol: () => ({ ok: false, error: 'Couldn’t reach' }) });
  const od = off.make();
  await od.enable({ name: 'Mac' });
  const r = await od.disable();
  assert.equal(r.ok, true);
  assert.match(r.notice, /didn’t hear it/);
  assert.equal(fs.existsSync(off.credsFile()), false);
});

for (const [state, code] of [['revoked', 4403], ['unauthenticated', 4401]]) {
  test(`the runner's socket closed ${code}: the runner stops, the sealed token is deleted, plain state, no restart`, async () => {
    const h = deviceHarness();
    const d = h.make();
    await d.enable({ name: 'Mac' });
    const c = h.children[0];
    c.emit('message', { type: 'runner.ready' });
    c.emit('message', { type: 'runner.status', state: 'connected' });
    c.emit('message', { type: 'runner.status', state, detail: `closed ${code}` });
    assert.equal(fs.existsSync(h.credsFile()), false);
    assert.equal(c.killed, 1);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual([d.status().runner.state, d.status().ended, d.status().enabled, d.running()], ['removed', code, false, false]);
    assert.equal(h.pending.length, 0);
    assert.equal(h.calls.filter((x) => x.op === 'unenrol').length, 0, 'the hub already ended it');
    await h.make().resume();
    assert.equal(h.children.length, 1);
    // Turn on again: a fresh enrolment.
    assert.equal((await d.enable({ name: 'Mac' })).ok, true);
    assert.equal(d.status().ended, null);
    assert.equal(h.children.length, 2);
  });
}

test('the legacy path is gone: a sealed file without a runner token is deleted, and only a brt_ token is ever used', async () => {
  assert.equal(runnerTokenFrom({ runner_token: brtOf('x') }), brtOf('x'));
  assert.equal(runnerTokenFrom({ device_token: brtOf('x') }), null, 'never a device_token field');
  assert.equal(runnerTokenFrom({ runner_token: ['bdt', 'x'.repeat(43)].join('_') }), null);
  assert.equal(runnerTokenFrom({ runner_token: ['brt', 'x'.repeat(10)].join('_') }), null);
  assert.equal(runnerTokenFrom({}), null);
  const h = deviceHarness();
  fs.writeFileSync(h.credsFile(), `SEALED:${Buffer.from(JSON.stringify({ hub: HUB, team_id: 'team-1', enrollment_id: 'e', runner_token: null, name: 'Mac', enabled: true })).toString('base64')}`);
  const d = h.make();
  assert.equal(d.status().enrolled, false);
  assert.equal(fs.existsSync(h.credsFile()), false);
  await d.resume();
  assert.equal(h.children.length, 0);
  const src = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'device.js'), 'utf8');
  assert.ok(!/accessToken|device_token:|device_id:/.test(src), 'the runner never gets the account token or the device id');
  assert.ok(!/accessToken|deviceId:/.test(fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'accounts.js'), 'utf8')), 'the client hands the account token to no one');
});

test('enable: an answer without a usable runner token, or one for another team, is undone on the hub and nothing is stored', async () => {
  for (const bad of [{ ok: true, enrollment_id: 'e', team_id: 'team-1' }, { ok: true, enrollment_id: 'e', team_id: 'team-2', runner_token: brtOf('q') }, { ok: true, team_id: 'team-1', runner_token: brtOf('q') }]) {
    const h = deviceHarness({ enrol: () => bad });
    const d = h.make();
    assert.match((await d.enable({ name: 'Mac' })).error, /didn’t set this Mac up/);
    assert.deepEqual(h.calls.map((c) => c.op), ['enrol', 'unenrol']);
    assert.equal(fs.existsSync(h.credsFile()), false);
    assert.equal(h.children.length, 0);
  }
});

test('enable: no Keychain, no enrolment; a sealing failure after the hub enrolled undoes it on the hub', async () => {
  const no = deviceHarness({ canSeal: false });
  assert.match((await no.make().enable({ name: 'Mac' })).error, /securely/);
  assert.equal(no.calls.length, 0, 'the hub was never asked');
  const bad = deviceHarness({ seal: () => { throw new Error('keychain locked'); } });
  const d = bad.make();
  const r = await d.enable({ name: 'Mac' });
  assert.equal(r.ok, false);
  assert.match(r.error, /securely/);
  assert.deepEqual(bad.calls.map((c) => c.op), ['enrol', 'unenrol']);
  assert.equal(d.status().enrolled, false);
  assert.equal(bad.children.length, 0, 'no runner started');
  assert.equal(fs.existsSync(bad.credsFile()), false);
  assert.equal(fs.readdirSync(bad.dir).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('discard: stops the runner and deletes the sealed file without asking the hub', async () => {
  const h = deviceHarness();
  const d = h.make();
  await d.enable({ name: 'Mac' });
  h.children[0].emit('message', { type: 'runner.ready' });
  h.children[0].emit('message', { type: 'runner.status', state: 'connected' });
  assert.equal(d.running(), true);
  await d.discard();
  assert.equal(h.children[0].killed, 1);
  assert.equal(fs.existsSync(h.credsFile()), false);
  assert.deepEqual(h.calls.map((c) => c.op), ['enrol'], 'no unenrol');
  assert.equal(d.running(), false);
});

test('enable: signed out or refused says so in words; nothing is stored', async () => {
  const h = deviceHarness({ enrol: () => ({ ok: false, signedOut: true, error: 'x' }) });
  assert.match((await h.make().enable({ name: 'Mac' })).error, /Sign in again/);
  const g = deviceHarness({ enrol: () => ({ ok: false, error: 'You already have 5 Macs running cards, the most allowed. Turn one off or remove one, then try again.' }) });
  assert.match((await g.make().enable({ name: 'Mac' })).error, /5 Macs/);
  assert.equal(fs.existsSync(h.credsFile()) || fs.existsSync(g.credsFile()), false);
});

test('app quit stops the runner and keeps the enrolment; the next launch resumes it with the sealed token; remove unenrols', async () => {
  const h = deviceHarness();
  const d = h.make();
  await d.enable({ name: 'Mac' });
  await d.stop();
  assert.equal(h.children[0].killed, 1);
  assert.equal(fs.existsSync(h.credsFile()), true);
  const d2 = h.make();
  await d2.resume();
  assert.equal(h.children.length, 2);
  assert.equal(h.children[1].sent[0].runner_token, brtOf('b'));
  await d2.remove();
  assert.equal(h.children[1].killed, 1);
  assert.equal(fs.existsSync(h.credsFile()), false);
  assert.deepEqual(h.calls.at(-1), { op: 'unenrol', team: 'team-1' });
});

test('runner crash restarts with backoff; a 4403 after a restart does not loop', async () => {
  const h = deviceHarness();
  const d = h.make();
  await d.enable({ name: 'Mac' });
  h.children[0].emit('message', { type: 'runner.ready' });
  h.tick(60_000);
  h.children[0].emit('exit', 1);
  assert.equal(d.status().runner.state, 'restarting');
  await h.pending.shift()();
  assert.equal(h.children.length, 2);
  h.children[1].emit('message', { type: 'runner.ready' });
  h.children[1].emit('message', { type: 'runner.status', state: 'revoked', detail: 'closed 4403' });
  h.children[1].emit('exit', 0);
  assert.equal(h.pending.length, 0);
  assert.equal(d.status().runner.state, 'removed');
});

test('no runner in this build (missing entry, or an exit before ready) is "not available", not a crash loop', async () => {
  const gone = deviceHarness({ entryExists: false });
  const g = gone.make();
  assert.match((await g.enable({ name: 'Mac' })).error, /not available/);
  assert.equal(gone.calls.length, 0, 'nothing enrolled on the hub');
  assert.equal(gone.children.length, 0);
  assert.deepEqual(g.status().runner, { state: 'missing', detail: NO_RUNNER });
  const h = deviceHarness();
  const d = h.make();
  await d.enable({ name: 'Mac' });
  h.tick(300);
  h.children[0].emit('exit', 2);
  assert.deepEqual(d.status().runner, { state: 'missing', detail: NO_RUNNER });
  assert.equal(h.pending.length, 0);
});

test('runner.fatal with exit 2 (bad config) is shown and not restarted; runner.stopped reports parked runs', async () => {
  const h = deviceHarness();
  const d = h.make();
  await d.enable({ name: 'Mac' });
  const c = h.children[0];
  c.emit('message', { type: 'runner.ready' });
  c.emit('message', { type: 'runner.status', state: 'unavailable', detail: 'hub unreachable' });
  assert.equal(d.status().runner.state, 'unavailable');
  c.emit('message', { type: 'runner.stopped', parked: 2, orphaned: 0 });
  assert.equal(d.status().parked, 2);
  c.emit('message', { type: 'runner.fatal', message: 'bad runner.config: runner_token required' });
  h.tick(60_000);
  c.emit('exit', 2);
  assert.deepEqual(d.status().runner, { state: 'failed', detail: 'bad runner.config: runner_token required' });
  assert.equal(h.pending.length, 0);
});

test('presence: off by default; on sends the minimal session fields once ready; off clears at once', async () => {
  const h = deviceHarness();
  const d = h.make();
  await d.enable({ name: 'Mac' });
  const c = h.children[0];
  const sessions = [{ sessionId: 's1', via: 'claude', cwd: '/Users/callum/Development/secret-client/proj', signal: 'tool-use', signalSince: '2026-09-30T10:00:00.000Z', model: 'secret-ish', tasks: [{ title: 'x' }] }];
  d.setPresence(true, sessions);
  assert.equal(c.sent.length, 1, 'nothing before ready');
  c.emit('message', { type: 'runner.ready' });
  assert.deepEqual(c.sent[1], { type: 'runner.presence', enabled: true, share_summaries: false, sessions: [{ session_id: 's1', agent: 'claude', cwd: '/Users/callum/Development/secret-client/proj', state: 'tool-use', since: '2026-09-30T10:00:00.000Z' }] });
  // The runner needs `cwd` to find the repo (D37b) and never forwards it; only the runner's own channel carries it.
  assert.equal(c.sent[1].sessions[0].cwd, sessions[0].cwd);
  assert.ok(!('model' in c.sent[1].sessions[0]) && !('tasks' in c.sent[1].sessions[0]), 'nothing else from the widget rides along');
  d.setPresence(true, sessions);
  assert.equal(c.sent.length, 2, 'unchanged: not resent');
  d.setPresence(false, sessions);
  assert.deepEqual(c.sent[2], { type: 'runner.presence', enabled: false, share_summaries: false, sessions: [] });
  assert.deepEqual(presenceSessions([{ nope: 1 }, null]), []);
});

test('presence summaries: sent only when sharing and summaries are both on; one line, never a path from the app', async () => {
  const h = deviceHarness();
  const d = h.make();
  await d.enable({ name: 'Mac' });
  const c = h.children[0];
  c.emit('message', { type: 'runner.ready' });
  const sessions = [{ sessionId: 's1', cwd: '/Users/me/p/proj', signal: 'tool-use', tool: 'Bash', signalSince: '2026-09-30T10:00:00.000Z' }, { sessionId: 's2', cwd: '/x/y', signal: 'working', summary: '  fixing\nthe   login  bug '.padEnd(300, '!') }];
  d.setPresence(false, sessions, { shareSummaries: true });
  d.setPresence(true, sessions, { shareSummaries: false });
  let last = c.sent.at(-1);
  assert.equal(last.share_summaries, false);
  assert.ok(last.sessions.every((x) => x.summary === undefined), 'no summaries unless asked');
  d.setPresence(true, sessions, { shareSummaries: true });
  last = c.sent.at(-1);
  assert.equal(last.share_summaries, true);
  assert.equal(last.sessions[0].summary, 'Using Bash');
  assert.ok(last.sessions[1].summary.startsWith('fixing the login bug'));
  assert.ok(last.sessions[1].summary.length <= 120 && !last.sessions[1].summary.includes('\n'));
  d.setPresence(false, sessions, { shareSummaries: true });
  assert.deepEqual(c.sent.at(-1), { type: 'runner.presence', enabled: false, share_summaries: false, sessions: [] });
});

test('runner.stopped: parked_pending is read and shown as runs being handed over', async () => {
  const h = deviceHarness();
  const d = h.make();
  await d.enable({ name: 'Mac' });
  const c = h.children[0];
  c.emit('message', { type: 'runner.stopped', parked: 1, parked_pending: 3, orphaned: 0 });
  assert.deepEqual([d.status().parked, d.status().parkedPending], [1, 3]);
  c.emit('message', { type: 'runner.stopped', parked: 0, parked_pending: -2 });
  assert.equal(d.status().parkedPending, 0);
  const page = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'account.js'), 'utf8');
  assert.match(page, /being moved to another AI/);
});

test('runner.config: data_dir is made 0700, ours and not a symlink, else the runner does not start', async () => {
  const { ensurePrivateDir, hubUrlOk } = require('../buddy-window/device');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-priv-'));
  const fresh = path.join(dir, 'a', 'b');
  assert.equal(ensurePrivateDir(fresh), null);
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);
  const loose = path.join(dir, 'loose');
  fs.mkdirSync(loose, { mode: 0o755 });
  fs.chmodSync(loose, 0o755);
  assert.equal(ensurePrivateDir(loose), null, 'tightened');
  assert.equal(fs.statSync(loose).mode & 0o777, 0o700);
  const link = path.join(dir, 'link');
  fs.symlinkSync(loose, link);
  assert.equal(ensurePrivateDir(link), 'not a directory');
  assert.equal(ensurePrivateDir(fresh, { uid: 12345 }), 'owned by someone else');
  const file = path.join(dir, 'file');
  fs.writeFileSync(file, 'x');
  assert.equal(ensurePrivateDir(file), 'not a directory');
  // Through the controller: a symlinked data_dir means no fork at all.
  const hh = deviceHarness();
  fs.mkdirSync(path.join(hh.dir, 'runner'));
  fs.symlinkSync(loose, path.join(hh.dir, 'runner', 'team-1'));
  const d = hh.make();
  await d.enable({ name: 'Mac' });
  assert.equal(hh.children.length, 0);
  assert.equal(d.status().runner.state, 'failed');
  for (const u of ['https://app.plexiform.dev', 'wss://app.plexiform.dev', 'http://127.0.0.1:4100', 'http://localhost:3000', 'ws://[::1]:1']) assert.equal(hubUrlOk(u), true, u);
  for (const u of ['http://app.plexiform.dev', 'ws://10.0.0.2', 'ftp://x', 'nope']) assert.equal(hubUrlOk(u), false, u);
});

test('runner.config: a cleartext hub that is not this machine never gets the token', async () => {
  const h = deviceHarness({ account: { origin: 'http://buddy.example.com', enrol: async (t) => ({ ok: true, enrollment_id: 'e', team_id: t, runner_token: brtOf('z') }), unenrol: async () => ({ ok: true }) } });
  const d = h.make();
  await d.enable({ name: 'Mac' });
  assert.equal(h.children.length, 0);
  assert.match(d.status().runner.detail, /https/);
});

test('embedded hub env drops the hub-side secrets even when the parent env has them', () => {
  const secret = { BOARD_GITHUB_TOKEN: 'ghp_x', BOARD_PUBLIC_URL: 'https://x', BOARD_TUNNEL_PROBE_URL: 'https://p', BOARD_ACCESS_TEAM: 't', BOARD_ACCESS_AUD: 'aud', BOARD_ENC_KEY: 'k'.repeat(44), BOARD_LOCAL_SECRET: 's'.repeat(40) };
  for (const mode of ['local', 'dev']) {
    const env = hubEnv({ mode, dataDir: '/d', port: 1, devSecret: 'dev', baseEnv: { HOME: '/h', PATH: '/bin', ...secret } });
    for (const k of Object.keys(secret)) assert.equal(env[k], undefined, `${mode}: ${k}`);
    assert.equal(env.HOME, '/h');
  }
});

test('creds for another hub or team are ignored', async () => {
  const h = deviceHarness();
  await h.make().enable({ name: 'Mac' });
  fs.copyFileSync(h.credsFile(), h.credsFile('team-2'));
  assert.equal(h.make('team-2').status().enrolled, false);
  const other = createDeviceController({
    account: { origin: 'https://other.example.com' }, teamId: 'team-1', credsFile: h.credsFile(),
    seal: (s) => Buffer.from(s), unseal: (b) => Buffer.from(String(b).slice(7), 'base64').toString(),
    fork: () => { throw new Error('must not start'); }, runnerEntry: 'x', dataDir: path.join(h.dir, 'r2'),
  });
  assert.equal(other.status().enrolled, false);
  assert.equal(fs.existsSync(h.credsFile()), true, 'another hub’s file is left alone');
});

// ── Buddy accounts (client against the mock hub) ─────────────────────────

const { createAccountClient, ROUTES, parseInvite, routeInvite, bearerScope, maskEmail } = require('../buddy-window/accounts');
const { createMockAccountsHub, VERIFY_PER_ADDRESS } = require('../buddy-window/mock-accounts-hub');

function memStore() {
  let v = null;
  return { load: () => v, save: (o) => { v = JSON.parse(JSON.stringify(o)); }, clear: () => { v = null; }, peek: () => v };
}

async function withHub(fn) {
  const hub = createMockAccountsHub();
  const origin = await hub.listen();
  try { await fn(hub, origin); } finally { await hub.close(); }
}

async function signIn(hub, origin, email, extra = {}) {
  const store = memStore();
  const c = createAccountClient({ origin, store, ...extra });
  assert.equal((await c.startEmail(email)).ok, true);
  const r = await c.verifyCode(hub.lastCode(email), { deviceName: 'Test Mac', platform: 'darwin' });
  assert.equal(r.ok, true, r.error);
  return { c, store, r };
}

test('ROUTES: every endpoint is one [method, path] row', () => {
  for (const [name, [method, p]] of Object.entries(ROUTES)) {
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method), name);
    assert.match(p, /^\/api\//, name);
  }
});

// ── P4 runner enrolment against the mock hub ─────────────────────────────

const RUNNER_CLOSE = { 4401: 'unauthenticated', 4403: 'revoked' };
// What app-entry does with the config: one socket, the two headers, the close code back.
function runnerSocket(origin, { token, team }) {
  const WebSocket = require('ws');
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (team) headers['Board-Team'] = team;
  const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws/runner`, { headers });
  const welcome = new Promise((resolve) => ws.on('message', (d) => { const f = JSON.parse(d); if (f.type === 'welcome') resolve(f); }));
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  return { ws, welcome, closed };
}

async function withQuotas(quotas, fn) {
  const hub = createMockAccountsHub({ quotas });
  const origin = await hub.listen();
  try { await fn(hub, origin); } finally { await hub.close(); }
}

test('P4 enrol: a brt_ token shown once, kept as a hash; the same install re-enrolling rotates and the old socket closes 4403', async () => withHub(async (hub, origin) => {
  const { c } = await signIn(hub, origin, 'runner@example.com');
  const team = (await c.createTeam('Runners')).team;
  const r = await c.enrol(team.id, { deviceName: 'Jo’s Mac' });
  assert.equal(r.ok, true);
  assert.equal(runnerTokenFrom(r), r.runner_token);
  assert.equal(r.team_id, team.id);
  const row = hub.enrolments()[0];
  assert.equal(row.name, 'Jo’s Mac');
  assert.ok(!JSON.stringify(hub.enrolments()).includes(r.runner_token), 'the hub keeps only a hash');
  const s1 = runnerSocket(origin, { token: r.runner_token, team: team.id });
  const w = await s1.welcome;
  assert.match(w.device_id, /^dev_/, 'the runner learns its device id from welcome');
  const again = await c.enrol(team.id);
  assert.equal(again.enrollment_id, r.enrollment_id);
  assert.notEqual(again.runner_token, r.runner_token);
  assert.equal(await s1.closed, 4403);
  assert.equal(await runnerSocket(origin, { token: r.runner_token, team: team.id }).closed, 4401, 'the old token is unknown now');
  const s2 = runnerSocket(origin, { token: again.runner_token, team: team.id });
  assert.equal((await s2.welcome).device_id, w.device_id, 'same hub-side device');
  // Unenrol: the socket closes 4403, a second unenrol is 404, the app stays signed in.
  assert.equal((await c.unenrol(team.id)).ok, true);
  assert.equal(await s2.closed, 4403);
  assert.equal((await c.unenrol(team.id)).status, 404);
  assert.equal((await c.me()).ok, true);
}));

test('P4 /ws/runner: a missing or other Board-Team and an unknown token are the same 4401; sign-out is 4401, a removed member 4403', async () => withHub(async (hub, origin) => {
  const { c } = await signIn(hub, origin, 'owner@example.com');
  const a = (await c.createTeam('Alpha')).team;
  const b = (await c.createTeam('Beta')).team;
  const r = await c.enrol(a.id);
  assert.equal(await runnerSocket(origin, { token: r.runner_token }).closed, 4401);
  assert.equal(await runnerSocket(origin, { token: r.runner_token, team: b.id }).closed, 4401);
  assert.equal(await runnerSocket(origin, { token: brtOf('n'), team: a.id }).closed, 4401);
  const live = runnerSocket(origin, { token: r.runner_token, team: a.id });
  await live.welcome;
  await c.signOut();
  assert.equal(await live.closed, 4401, 'signing the install out ends its enrolments');
  assert.equal(hub.enrolments()[0].revoked, true);
  // A member removed by an admin: 4403.
  const { c: owner } = await signIn(hub, origin, 'owner@example.com');
  const { c: mem } = await signIn(hub, origin, 'mem@example.com');
  const inv = await owner.invite(a.id, 'mem@example.com', 'member');
  assert.equal((await mem.acceptInvite({ code: inv.code })).ok, true);
  const mr = await mem.enrol(a.id);
  const ms = runnerSocket(origin, { token: mr.runner_token, team: a.id });
  await ms.welcome;
  const memberId = (await owner.listMembers(a.id)).members.find((m) => m.display_name === 'mem').member_id;
  assert.equal((await owner.setRole(a.id, memberId, 'viewer')).ok, true);
  assert.equal(await ms.closed, 4403, 'demoted to viewer');
  assert.equal(await runnerSocket(origin, { token: mr.runner_token, team: a.id }).closed, 4403, 'refused while a viewer');
}));

test('P4 enrol: cookie sessions get 403, viewers 403, and the caps answer QUOTA_EXCEEDED naming the limit; 30 an hour is 429 with a wait', async () => withQuotas({ enrolPerTeam: 2, enrolTotal: 3, enrolPerHour: 4 }, async (hub, origin) => {
  const { c } = await signIn(hub, origin, 'many@example.com');
  const team = (await c.createTeam('Many')).team;
  const cookie = await fetch(`${origin}/api/teams/${team.id}/enrol`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: '__Host-buddy_session=x' }, body: '{}' });
  assert.equal(cookie.status, 403);
  // Each sign-in is another install; the third in one team is over the per-team cap.
  const installs = [c, (await signIn(hub, origin, 'many@example.com')).c, (await signIn(hub, origin, 'many@example.com')).c];
  assert.equal((await installs[0].enrol(team.id)).ok, true);
  assert.equal((await installs[1].enrol(team.id)).ok, true);
  const over = await installs[2].enrol(team.id);
  assert.deepEqual([over.status, over.code, over.detail.resource, over.detail.limit], [403, 'QUOTA_EXCEEDED', 'runner_enrollments', 2]);
  assert.equal(over.error, 'You already have 2 Macs running cards, the most allowed. Turn one off or remove one, then try again.');
  const other = (await installs[0].createTeam('Other')).team;
  assert.equal((await installs[2].enrol(other.id)).ok, true);
  const total = await installs[1].enrol(other.id);
  assert.match(total.error, /already have 3 Macs/, 'the per-person cap names its own limit');
  // Rotation counts against the hourly limit but never the caps.
  assert.equal((await installs[0].enrol(team.id)).ok, true);
  const slow = await installs[0].enrol(team.id);
  assert.equal(slow.status, 429);
  assert.match(slow.error, /^This Mac was turned on and off too often\. Wait \d+ minutes and try again\.$/);
}));

test('P4 enrolments list and revoke: wrapped, admins see all, members their own; revoke is admin or own, 404 for unknown, revoked or another team', async () => withHub(async (hub, origin) => {
  const { c: owner } = await signIn(hub, origin, 'owner@example.com');
  const team = (await owner.createTeam('Team')).team;
  const elsewhere = (await owner.createTeam('Elsewhere')).team;
  const { c: mem } = await signIn(hub, origin, 'mem@example.com');
  const { c: mem2 } = await signIn(hub, origin, 'mem2@example.com');
  for (const [cl, email] of [[mem, 'mem@example.com'], [mem2, 'mem2@example.com']]) {
    const inv = await owner.invite(team.id, email, 'member');
    assert.equal((await cl.acceptInvite({ code: inv.code })).ok, true);
  }
  const o = await owner.enrol(team.id, { deviceName: 'Owner Mac' });
  const m = await mem.enrol(team.id, { deviceName: 'Mem Mac' });
  await mem2.enrol(team.id, { deviceName: 'Mem2 Mac' });
  const raw = await fetch(`${origin}/api/teams/${team.id}/enrolments`, { headers: { Authorization: `Bearer ${(await signIn(hub, origin, 'owner@example.com')).store.peek().token}` } }).then((x) => x.json());
  assert.ok(Array.isArray(raw.enrolments), 'a wrapped object');
  assert.deepEqual(Object.keys(raw.enrolments[0]).sort(), ['created_at', 'current', 'id', 'last_seen_at', 'name', 'online', 'revoked_at', 'user']);
  const all = await owner.listEnrolments(team.id);
  assert.deepEqual(all.enrolments.map((e) => e.name), ['Mem2 Mac', 'Mem Mac', 'Owner Mac'], 'newest first');
  assert.deepEqual(all.enrolments.map((e) => e.current), [false, false, true]);
  assert.ok(!JSON.stringify(all).includes('brt_'));
  const mine = await mem.listEnrolments(team.id);
  assert.deepEqual(mine.enrolments.map((e) => [e.name, e.current]), [['Mem Mac', true]]);
  const theirs = all.enrolments.find((e) => e.name === 'Mem2 Mac').id;
  assert.equal((await mem.revokeEnrolment(team.id, theirs)).status, 403, 'someone else’s as a member');
  assert.equal((await mem.revokeEnrolment(team.id, m.enrollment_id)).ok, true, 'your own');
  assert.equal((await mem.revokeEnrolment(team.id, m.enrollment_id)).status, 404, 'already revoked');
  assert.equal((await owner.revokeEnrolment(team.id, 'enr_nope')).status, 404);
  assert.equal((await owner.revokeEnrolment(elsewhere.id, theirs)).status, 404, 'another team’s');
  assert.equal((await owner.revokeEnrolment(team.id, theirs)).ok, true, 'an owner revokes anyone’s');
  assert.equal((await owner.listEnrolments(team.id)).enrolments.filter((e) => e.revoked).length, 2, 'revoked ones are still listed');
  assert.equal(o.ok, true);
}));

test('P4 mock: /__mock/runner-close closes an enrolment’s socket with 4401 or 4403 only', async () => withHub(async (hub, origin) => {
  const { c } = await signIn(hub, origin, 'closer@example.com');
  const team = (await c.createTeam('Close')).team;
  const r = await c.enrol(team.id);
  const s = runnerSocket(origin, { token: r.runner_token, team: team.id });
  await s.welcome;
  assert.equal(hub.runnerSockets(r.enrollment_id), 1);
  const bad = await fetch(`${origin}/__mock/runner-close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enrollment_id: r.enrollment_id, code: 1000 }) });
  assert.equal(bad.status, 400);
  await fetch(`${origin}/__mock/runner-close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enrollment_id: r.enrollment_id, code: 4401 }) });
  assert.equal(await s.closed, 4401);
  assert.equal(RUNNER_CLOSE[4401], 'unauthenticated');
}));

test('two teams → two runner processes, each with its own token, team and data_dir', async () => withHub(async (hub, origin) => {
  const { c } = await signIn(hub, origin, 'two@example.com');
  const a = (await c.createTeam('Alpha')).team;
  const b = (await c.createTeam('Beta')).team;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-dev-'));
  const kids = [];
  const make = (teamId) => createDeviceController({
    account: c, teamId, credsFile: path.join(dir, `${teamId}.bin`), seal: (s) => Buffer.from(`SEALED:${Buffer.from(s).toString('base64')}`), unseal: (x) => Buffer.from(String(x).slice(7), 'base64').toString(),
    fork: () => { const k = new FakeChild(); k.sent = []; k.postMessage = (m) => k.sent.push(m); kids.push(k); return k; }, runnerEntry: 'x', entryExists: () => true, dataDir: path.join(dir, 'runner', teamId), schedule: () => {}, stopGraceMs: 1000,
  });
  const da = make(a.id);
  const db = make(b.id);
  assert.equal((await da.enable({ name: 'Mac' })).ok, true);
  assert.equal((await db.enable({ name: 'Mac' })).ok, true);
  assert.equal(kids.length, 2);
  const [ca, cb] = kids.map((k) => k.sent[0]);
  for (const cfg of [ca, cb]) assert.deepEqual(Object.keys(cfg).sort(), CONFIG_KEYS);
  assert.deepEqual([ca.team_id, cb.team_id], [a.id, b.id]);
  assert.notEqual(ca.runner_token, cb.runner_token);
  assert.notEqual(ca.data_dir, cb.data_dir);
  // A team's token is only good for that team.
  assert.equal(await runnerSocket(origin, { token: ca.runner_token, team: b.id }).closed, 4401);
  await da.disable();
  assert.equal(kids[0].killed, 1);
  assert.equal(kids[1].killed, 0, 'the other team’s runner keeps going');
  assert.deepEqual(hub.enrolments().map((e) => e.revoked), [true, false]);
}));

test('provider sign-in: start and exchange go over one pinned address, so one network; a pinned transport never leaves its hub', async () => withHub(async (hub, origin) => {
  const { pinnedTransport } = require('../buddy-window/accounts');
  const lookups = [];
  const t = await pinnedTransport(origin, { lookup: async (host) => { lookups.push(host); return { address: '127.0.0.1', family: 4 }; } });
  const viaPin = [];
  const pin = async (o) => { assert.equal(o, origin); return (u, init) => { viaPin.push(new URL(u).pathname); return t(u, init); }; };
  const store = memStore();
  const plain = [];
  const c = createAccountClient({ origin, store, pin, fetchImpl: (u, init) => { plain.push(new URL(u).pathname); return fetch(u, init); } });
  const { startProviderSignIn } = require('../buddy-window/oauth');
  const run = startProviderSignIn({ client: c, provider: 'google', device: { deviceName: 'Mac' }, brand: 'Plexiform', allowOrigins: [origin], openExternal: async (u) => { const r = await fetch(u, { redirect: 'manual' }); await fetch(r.headers.get('location')); } });
  const r = await run.done;
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(viaPin, ['/api/auth/oauth/start', '/api/auth/oauth/exchange']);
  assert.ok(!plain.includes('/api/auth/oauth/start') && !plain.includes('/api/auth/oauth/exchange'));
  assert.equal(lookups.length, 1, 'resolved once for both');
  await assert.rejects(t('http://127.0.0.2:1/x', {}), /not this hub/);
  assert.equal(await pinnedTransport(origin, { lookup: async () => { throw new Error('ENOTFOUND'); } }), null);
  assert.equal(await pinnedTransport('ftp://x.example'), null);
}));

test('accounts: email + 6-digit code signs in; the device token is sealed in the store, never returned', async () => withHub(async (hub, origin) => {
  const store = memStore();
  const c = createAccountClient({ origin, store });
  assert.match((await c.startEmail('nope')).error, /email/);
  assert.equal((await c.startEmail(' Callum@Example.com ')).ok, true);
  assert.equal(c.pendingEmail(), 'callum@example.com');
  assert.match((await c.verifyCode('12')).error, /6 digits/);
  const code = hub.lastCode('callum@example.com');
  const r = await c.verifyCode(`${code.slice(0, 3)} ${code.slice(3)}`, { deviceName: 'Mac' });
  assert.equal(r.ok, true);
  assert.equal(r.user.email, 'callum@example.com');
  assert.deepEqual(r.teams, []);
  assert.ok(!JSON.stringify(r).includes('bdt_'), 'no token in the result');
  assert.match(store.peek().token, /^bdt_/);
  assert.equal(store.peek().hub, origin);
  assert.equal(c.signedIn(), true);
  const me = await c.me();
  assert.equal(me.user.email, 'callum@example.com');
  assert.deepEqual(me.teams, []);
}));

test('accounts: start names the client, device and platform; wrong, used and expired codes are one message with tries left', async () => withHub(async (hub, origin) => {
  const c = createAccountClient({ origin, store: memStore() });
  await c.startEmail('a@example.com', { deviceName: 'Jo’s MacBook Pro', platform: 'darwin-arm64' });
  assert.deepEqual(hub.starts().at(-1), { email: 'a@example.com', client: 'buddy_desktop', purpose: 'signin', device_name: 'Jo’s MacBook Pro', platform: 'darwin-arm64' });
  const good = hub.lastCode('a@example.com');
  const wrong = good === '000000' ? '111111' : '000000';
  assert.equal((await c.verifyCode(wrong)).error, 'That code didn’t work. 4 tries left.');
  for (let left = 3; left >= 1; left -= 1) assert.equal((await c.verifyCode(wrong)).error, `That code didn’t work. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
  assert.equal((await c.verifyCode(wrong)).error, 'That code didn’t work. Send a new code.', 'the flow died');
  assert.equal((await c.verifyCode(good)).error, 'That code didn’t work. Send a new code.', 'even the right code: same words');
  assert.equal(c.pendingEmail(), 'a@example.com', '"Send a new code" still knows the address');
  await c.startEmail('a@example.com');
  hub.setNow(Date.now() + 10 * 60_000 + 1);
  assert.equal((await c.verifyCode(hub.lastCode('a@example.com'))).error, 'That code didn’t work. Send a new code.', 'expired');
}));

test('accounts: too many tries (429 RATE_LIMITED) says to wait, whatever the code', async () => withHub(async (hub, origin) => {
  const c = createAccountClient({ origin, store: memStore() });
  let r;
  for (let i = 0; i <= VERIFY_PER_ADDRESS; i += 1) {
    if (i % 5 === 0) await c.startEmail('rl@example.com');
    r = await c.verifyCode('000000');
  }
  assert.equal(r.status, 429);
  assert.match(r.error, /^Too many tries\. Wait (a minute|\d+ minutes) and try again\.$/);
  await c.startEmail('rl@example.com');
  assert.match((await c.verifyCode(hub.lastCode('rl@example.com'))).error, /Too many tries/, 'locked out even with the right code');
  const { humanError } = require('../buddy-window/accounts');
  assert.equal(humanError(429, { error: { code: 'RATE_LIMITED', retry_after_s: 30 } }, 'h'), 'Too many tries. Wait a minute and try again.');
  assert.equal(humanError(429, { error: { code: 'RATE_LIMITED', retry_after_s: 600 } }, 'h'), 'Too many tries. Wait 10 minutes and try again.');
}));

test('accounts: a 401 means the token was revoked: wiped, signed-out callback, plain error', async () => withHub(async (hub, origin) => {
  let signedOut = 0;
  const { c, store } = await signIn(hub, origin, 'b@example.com', { onSignedOut: () => { signedOut += 1; } });
  hub.revokeAll('b@example.com');
  const r = await c.me();
  assert.equal(r.ok, false);
  assert.equal(r.signedOut, true);
  assert.match(r.error, /signed out/);
  assert.equal(store.peek(), null);
  assert.equal(signedOut, 1);
  assert.equal((await c.createTeam('x')).signedOut, true, 'no request without a token');
}));

test('accounts: a token saved for another hub is never sent', async () => withHub(async (hub, origin) => {
  const seen = [];
  const store = memStore();
  store.save({ hub: 'https://evil.example.com', token: 'bdt_other_hub' });
  const c = createAccountClient({ origin, store, fetchImpl: async (u, init) => { seen.push(init.headers); return fetch(u, init); } });
  assert.equal(c.signedIn(), false);
  assert.equal((await c.me()).signedOut, true);
  assert.equal(seen.length, 0);
  await c.previewInvite('inv_x');
  assert.ok(seen.every((h) => !h.Authorization));
}));

test('accounts: network failure is a sentence, not a thrown fetch error', async () => {
  const c = createAccountClient({ origin: 'https://buddy.example.com', store: memStore(), fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  const r = await c.startEmail('a@example.com');
  assert.deepEqual(r, { ok: false, error: 'Couldn’t reach buddy.example.com. Check the address and your connection.' });
});

test('accounts: create a team, invite by email (link shown once), preview without auth, accept; wrong account and reuse refused', async () => withHub(async (hub, origin) => {
  const owner = await signIn(hub, origin, 'owner@example.com');
  const t = await owner.c.createTeam('Bondly');
  assert.equal(t.ok, true);
  assert.equal(t.team.slug, 'bondly');
  assert.equal(t.board.name, 'Bondly');
  const teamId = t.team.id;
  const inv = await owner.c.invite(teamId, 'Sam@Example.com', 'member');
  assert.equal(inv.ok, true);
  assert.equal(inv.invite.email, 'sam@example.com');
  assert.ok(inv.link.startsWith(`${origin}/invite#`), inv.link);
  const token = inv.link.split('#')[1];
  const listed = (await owner.c.listInvites(teamId)).invites;
  assert.equal(listed.length, 1);
  assert.ok(!JSON.stringify(listed).includes(token), 'the list never carries tokens');

  const seen = [];
  const anon = createAccountClient({ origin, store: memStore(), fetchImpl: async (u, init) => { seen.push(init.headers); return fetch(u, init); } });
  const pv = await anon.previewInvite(token);
  assert.deepEqual({ team: pv.team_name, role: pv.role, inviter: pv.inviter_first_name }, { team: 'Bondly', role: 'member', inviter: 'owner' });
  assert.equal(pv.email_masked, undefined, 'preview never names the invitee');
  assert.equal(seen[0].Authorization, undefined);

  const other = await signIn(hub, origin, 'other@example.com');
  const wrong = await other.c.acceptInvite({ t: token });
  assert.equal(wrong.wrongAccount, true);
  assert.equal(wrong.error, 'This invite was sent to a different email address. Switch account?');

  const sam = await signIn(hub, origin, 'sam@example.com');
  const pending = (await sam.c.me()).pending_invites;
  assert.equal(pending.length, 1);
  assert.deepEqual(Object.keys(pending[0]).sort(), ['expires_at', 'id', 'inviter_first_name', 'role', 'team_name']);
  const acc = await sam.c.acceptInvite({ inviteId: pending[0].id });
  assert.equal(acc.ok, true);
  assert.equal(acc.team.id, teamId);
  assert.equal(acc.member.role, 'member');
  assert.deepEqual((await sam.c.me()).teams.map((x) => [x.name, x.role]), [['Bondly', 'member']]);
  const again = await sam.c.acceptInvite({ t: token });
  assert.equal(again.ok, true, 'the same user accepting again gets the same answer');
  assert.equal(again.member.member_id, acc.member.member_id);
  const used = await other.c.acceptInvite({ t: token });
  assert.equal(used.gone, true, 'used by someone else');
  assert.equal(used.error, 'This invite link isn’t valid any more. Ask for a new one.');
  const members = (await owner.c.listMembers(teamId)).members;
  assert.deepEqual(members.map((m) => m.email).sort(), ['owner@example.com', 'sam@example.com']);
  assert.ok(members.every((m) => m.member_id && m.user_id && m.joined_at));
  assert.ok((await sam.c.listMembers(teamId)).members.every((m) => m.email === undefined), 'emails only for admins');
  assert.equal((await owner.c.listInvites(teamId)).invites.length, 0);
}));

test('accounts: a replayed invite request is "already made", with no link or code', async () => {
  const { createAccountClient: make } = require('../buddy-window/accounts');
  const fetchImpl = async () => new Response(JSON.stringify({ error: { code: 'CONFLICT', message: 'This invite was already made. Resend it to get a new link.', reason: 'REPLAYED' } }), { status: 409 });
  const c = make({ origin: 'https://h.example.com', store: { load: () => ({ hub: 'https://h.example.com', token: 'bdt_x' }), save() {}, clear() {} }, fetchImpl });
  const r = await c.invite('t1', 'sam@example.com', 'member');
  assert.deepEqual([r.ok, r.replayed, r.error, r.link, r.code], [false, true, 'This invite was already made. Resend it to get a new link.', undefined, undefined]);
});

test('accounts: the accept error codes are read in either encoding', () => {
  const { createAccountClient: make } = require('../buddy-window/accounts');
  const reply = (status, error) => async () => new Response(JSON.stringify({ error }), { status });
  const run = (status, error) => make({ origin: 'https://h.example.com', store: { load: () => ({ hub: 'https://h.example.com', token: 'bdt_x' }), save() {}, clear() {} }, fetchImpl: reply(status, error) }).acceptInvite({ t: 'tok' });
  return Promise.all([
    run(403, { code: 'WRONG_ACCOUNT' }).then((r) => assert.deepEqual([r.wrongAccount, r.error], [true, 'This invite was sent to a different email address. Switch account?'])),
    run(403, { code: 'WRONG_ACCOUNT', email_masked: 'c…@example.com' }).then((r) => assert.equal(r.error, 'This invite was sent to a different email address. Switch account?', 'never the address')),
    run(403, { code: 'FORBIDDEN', reason: 'WRONG_ACCOUNT', email_masked: 'c…@example.com' }).then((r) => assert.equal(r.wrongAccount, true)),
    run(409, { code: 'ALREADY_MEMBER', team: { id: 't1', name: 'Bondly' } }).then((r) => assert.deepEqual([r.alreadyMember, r.team, r.error], [true, { id: 't1', name: 'Bondly' }, 'You’re already in Bondly.'])),
    run(409, { code: 'CONFLICT', reason: 'ALREADY_MEMBER', team: { id: 't1', name: 'Bondly' } }).then((r) => assert.equal(r.alreadyMember, true)),
    run(400, { code: 'INVALID_TOKEN' }).then((r) => assert.equal(r.error, 'This invite link isn’t valid any more. Ask for a new one.')),
    run(403, { code: 'FORBIDDEN' }).then((r) => assert.equal(r.wrongAccount, undefined)),
  ]);
});

test('accounts: roles: members cannot manage; the last owner cannot be demoted or removed', async () => withHub(async (hub, origin) => {
  const owner = await signIn(hub, origin, 'o@example.com');
  const teamId = (await owner.c.createTeam('T')).team.id;
  const inv = await owner.c.invite(teamId, 'm@example.com', 'member');
  const m = await signIn(hub, origin, 'm@example.com');
  await m.c.acceptInvite({ t: inv.link.split('#')[1] });
  const list = (await owner.c.listMembers(teamId)).members;
  const me = list.find((x) => x.email === 'o@example.com');
  const them = list.find((x) => x.email === 'm@example.com');
  const r = await owner.c.setRole(teamId, me.member_id, 'admin');
  assert.deepEqual([r.status, r.code, r.detail.reason], [409, 'CONFLICT', 'LAST_OWNER']);
  assert.match(r.error, /at least one owner/);
  assert.match((await owner.c.removeMember(teamId, me.member_id)).error, /at least one owner/);
  assert.match((await m.c.setRole(teamId, them.member_id, 'admin')).error, /permission/);
  assert.match((await m.c.invite(teamId, 'x@example.com', 'member')).error, /permission/);
  assert.equal((await owner.c.setRole(teamId, them.member_id, 'owner')).ok, true);
  assert.equal((await owner.c.setRole(teamId, me.member_id, 'admin')).ok, true, 'fine once there is another owner');
  assert.match((await owner.c.setRole(teamId, them.member_id, 'boss')).error, /Pick a role/);
}));

test('accounts: resend mints a new link and the old one dies; a revoked link is refused with a plain sentence', async () => withHub(async (hub, origin) => {
  const owner = await signIn(hub, origin, 'o@example.com');
  const teamId = (await owner.c.createTeam('T')).team.id;
  const a = await owner.c.invite(teamId, 'x@example.com', 'viewer');
  const dup = await owner.c.invite(teamId, 'x@example.com', 'viewer');
  assert.deepEqual([dup.status, dup.code, dup.detail.invite_id], [409, 'CONFLICT', a.invite.id]);
  assert.equal(dup.error, 'There’s already an invite waiting for that address. Resend it instead.');
  const b = await owner.c.resendInvite(teamId, a.invite.id);
  assert.equal(b.ok, true);
  assert.notEqual(b.invite.id, a.invite.id, 'a new invite id');
  assert.notEqual(a.link, b.link);
  assert.ok(b.link.startsWith(`${origin}/invite#`));
  const live = (await owner.c.listInvites(teamId)).invites;
  assert.deepEqual(live.map((i) => i.id), [b.invite.id]);
  assert.match((await owner.c.previewInvite(a.link.split('#')[1])).error, /isn’t valid any more/);
  assert.equal((await owner.c.revokeInvite(teamId, b.invite.id)).ok, true);
  assert.equal((await owner.c.listInvites(teamId)).invites.length, 0);
  assert.match((await owner.c.previewInvite(b.link.split('#')[1])).error, /isn’t valid any more/);
  assert.match((await owner.c.previewInvite('inv_nope')).error, /isn’t valid any more/);
}));

test('accounts: already a member gets a clear answer with the team', async () => withHub(async (hub, origin) => {
  const owner = await signIn(hub, origin, 'o@example.com');
  const team = (await owner.c.createTeam('T')).team;
  const inv = await owner.c.invite(team.id, 'o2@example.com', 'member');
  const o2 = await signIn(hub, origin, 'o2@example.com');
  await o2.c.acceptInvite({ t: inv.link.split('#')[1] });
  const again = await owner.c.invite(team.id, 'o2@example.com', 'member');
  assert.deepEqual([again.status, again.code, again.detail.team], [409, 'ALREADY_MEMBER', { id: team.id, name: 'T' }]);
  assert.equal(again.error, 'They’re already in this team.');
}));

test('accounts: sign out revokes on the hub and forgets locally', async () => withHub(async (hub, origin) => {
  const a = await signIn(hub, origin, 'a@example.com');
  const token = a.store.peek().token;
  assert.equal((await a.c.signOut()).revoked, true);
  assert.equal(a.store.peek(), null);
  const res = await fetch(`${origin}/api/account`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 401, 'the old token is dead on the hub');
}));

test('accounts: delete = start {purpose:delete} (Bearer) → verify {flow_id, code} → DELETE /api/account {flow_id}', async () => withHub(async (hub, origin) => {
  const d = await signIn(hub, origin, 'd@example.com');
  assert.match((await d.c.deleteAccount('123456')).error, /new code/);
  assert.deepEqual(await d.c.startDelete(), { ok: true, email: 'd@example.com' });
  assert.deepEqual(hub.starts().at(-1), { purpose: 'delete', client: 'buddy_desktop' });
  const code = hub.lastCode('d@example.com');
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await d.c.deleteAccount(wrong)).error, 'That code didn’t work. 4 tries left.');
  assert.equal(d.store.peek() !== null, true, 'a bad code is not a sign-out');
  assert.equal((await d.c.deleteAccount(code)).ok, true);
  assert.equal(d.store.peek(), null);
  const again = await signIn(hub, origin, 'd@example.com');
  assert.deepEqual((await again.c.me()).teams, [], 'a fresh account');
  // The old route is gone from the client.
  assert.deepEqual(ROUTES.deleteAccount, ['DELETE', '/api/account']);
  assert.ok(!Object.values(ROUTES).some(([, p]) => p === '/api/account/delete'));
}));

test('accounts: delete is refused while sole owner (names the team); a stale check asks to do it again', async () => withHub(async (hub, origin) => {
  const o = await signIn(hub, origin, 'solo@example.com');
  const team = (await o.c.createTeam('Bondly')).team;
  const inv = await o.c.invite(team.id, 'mate@example.com', 'member');
  const mate = await signIn(hub, origin, 'mate@example.com');
  await mate.c.acceptInvite({ t: inv.link.split('#')[1] });
  await o.c.startDelete();
  const r = await o.c.deleteAccount(hub.lastCode('solo@example.com'));
  assert.deepEqual([r.ok, r.soleOwner, r.error], [false, true, 'Transfer ownership of Bondly first.']);
  assert.ok(o.store.peek(), 'still signed in');
  // Ownership handed over within the 5 minutes: the verified check is reused.
  const list = (await o.c.listMembers(team.id)).members;
  await o.c.setRole(team.id, list.find((m) => m.email === 'mate@example.com').member_id, 'owner');
  hub.setNow(Date.now() + 6 * 60_000);
  const late = await o.c.deleteAccount('');
  assert.deepEqual([late.ok, late.stepUp, late.error], [false, true, 'That check timed out. Send a new code and do the check again.']);
  assert.ok(o.store.peek(), 'STEP_UP_REQUIRED is a 401 that must not sign anyone out');
  await o.c.startDelete();
  assert.equal((await o.c.deleteAccount(hub.lastCode('solo@example.com'))).ok, true);
  const { humanError } = require('../buddy-window/accounts');
  assert.equal(humanError(409, { error: { code: 'CONFLICT' } }, 'h').length > 0, true);
}));

// ── invite links ───────────────────────────────────────────────────────────

const httpsOnly = (s) => normalizeHubUrl(s);

test('invite links: the accepted shapes', () => {
  const T = 'inv_AbC-123_xyz';
  assert.deepEqual(parseInvite(`claudebuddy://join?hub=https://buddy.example.com&t=${T}`, { normalizeHub: httpsOnly }), { hub: 'https://buddy.example.com', token: T });
  assert.deepEqual(parseInvite(`claudebuddy://join?hub=https%3A%2F%2Fbuddy.example.com%2F&t=${T}`, { normalizeHub: httpsOnly }), { hub: 'https://buddy.example.com', token: T });
  assert.deepEqual(parseInvite(`claudebuddy://invite/${T}`, { normalizeHub: httpsOnly }), { hub: null, token: T });
  assert.deepEqual(parseInvite(`claudebuddy://invite?t=${T}`, { normalizeHub: httpsOnly }), { hub: null, token: T });
  assert.deepEqual(parseInvite(`https://buddy.example.com/invite#${T}`, { normalizeHub: httpsOnly }), { hub: 'https://buddy.example.com', token: T });
  assert.deepEqual(parseInvite(`https://buddy.example.com/invite/${T}`, { normalizeHub: httpsOnly }), { hub: 'https://buddy.example.com', token: T });
  assert.deepEqual(parseInvite(`  ${T}  `, { normalizeHub: httpsOnly }), { hub: null, token: T });
});

test('invite links: anything else is ignored', () => {
  const T = 'inv_ok';
  const bad = [
    '', 'x'.repeat(201), `claudebuddy://invite/${'a'.repeat(201)}`, 'claudebuddy://invite/a+b', 'claudebuddy://invite/a%2Fb',
    'claudebuddy://invite/a.b', `claudebuddy://invite/${T}/more`, 'claudebuddy://invite/', 'claudebuddy://invite?t=',
    `claudebuddy://join?t=${T}`, `claudebuddy://join?hub=http://buddy.example.com&t=${T}`, `claudebuddy://join?hub=https://127.0.0.1&t=${T}`,
    `claudebuddy://join?hub=https://buddy.example.com/evil&t=${T}`, `claudebuddy://join?hub=https://u:p@buddy.example.com&t=${T}`,
    `claudebuddy://join/x?hub=https://buddy.example.com&t=${T}`, `claudebuddy://settings?t=${T}`, `javascript:alert(1)`,
    `http://buddy.example.com/invite/${T}`, `http://buddy.example.com/invite#${T}`, `https://buddy.example.com/other#${T}`, `https://buddy.example.com/invite?x=1#${T}`, 'https://buddy.example.com/invite#', `https://buddy.example.com/other/${T}`, `file:///invite/${T}`, `claudebuddy://invite/<script>`,
  ];
  for (const s of bad) assert.equal(parseInvite(s, { normalizeHub: httpsOnly }), null, s);
});

test('invite links: plexiform:// and the legacy claudebuddy:// parse identically; any other scheme is ignored', () => {
  const T = 'inv_AbC-123_xyz';
  const shapes = [`://join?hub=https://buddy.example.com&t=${T}`, `://invite/${T}`, `://invite?t=${T}`, `://join?hub=https://127.0.0.1&t=${T}`, `://invite/${T}/more`, `://settings?t=${T}`, `://join?hub=https://buddy.example.com/evil&t=${T}`];
  for (const rest of shapes) {
    const a = parseInvite(`plexiform${rest}`, { normalizeHub: httpsOnly });
    assert.deepEqual(a, parseInvite(`claudebuddy${rest}`, { normalizeHub: httpsOnly }), rest);
    assert.deepEqual(parseInvite(`PLEXIFORM${rest}`, { normalizeHub: httpsOnly }), a, 'schemes are case-insensitive');
  }
  assert.deepEqual(parseInvite(`plexiform://join?hub=https://buddy.example.com&t=${T}`, { normalizeHub: httpsOnly }), { hub: 'https://buddy.example.com', token: T });
  assert.deepEqual(parseInvite(`plexiform://invite/${T}`, { normalizeHub: httpsOnly }), { hub: null, token: T });
  for (const other of ['plexi', 'buddy', 'claude', 'plexiformx', 'x-plexiform']) {
    assert.equal(parseInvite(`${other}://invite/${T}`, { normalizeHub: httpsOnly }), null, other);
    assert.equal(parseInvite(`${other}://join?hub=https://buddy.example.com&t=${T}`, { normalizeHub: httpsOnly }), null, other);
  }
});

test('brand: one module holds the name, scheme and the Plexiform window’s copy', () => {
  const BRAND = require('../buddy-window/brand');
  assert.equal(BRAND.NAME, 'Plexiform');
  assert.equal(BRAND.SCHEME, 'plexiform');
  assert.deepEqual(BRAND.LEGACY_SCHEMES, ['claudebuddy']);
  assert.deepEqual(BRAND.SCHEMES, ['plexiform', 'claudebuddy']);
  assert.ok(Object.isFrozen(BRAND) && Object.isFrozen(BRAND.HUB_TEXT) && Object.isFrozen(BRAND.COPY));
  for (const s of [BRAND.WINDOW_TITLE, BRAND.OPEN_MENU_LABEL, BRAND.COPY.signInHeading, BRAND.COPY.inviteHint, BRAND.COPY.startingBoard]) assert.match(s, /Plexiform/);
  assert.ok(!JSON.stringify(BRAND).includes('Buddy'));
  // No old name in what the window shows: its pages, and the strings main sends them.
  const dir = path.join(__dirname, '..', 'buddy-window');
  for (const f of ['sidebar.html', 'info.html', 'account.html', 'account.js', 'sidebar.js', 'info.js']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/Claude Buddy|['"`>][^'"`<]*\bBuddy\b/.test(src), f);
  }
  assert.ok(!/blurb: [^\n]*\bBuddy\b/.test(fs.readFileSync(path.join(dir, 'pages.js'), 'utf8')));
});

test('invite links: malformed percent-encoding is null, never a thrown URIError', () => {
  for (const s of ['claudebuddy://invite/%E0%A4%A', 'claudebuddy://invite/%', 'https://buddy.example.com/invite#%E0%A4%A', 'https://buddy.example.com/invite/%ZZ%']) {
    assert.doesNotThrow(() => parseInvite(s, { normalizeHub: httpsOnly }), s);
    assert.equal(parseInvite(s, { normalizeHub: httpsOnly }), null, s);
  }
});

test('invite routing: unknown hub → confirm; known + signed out → sign in; known + signed in → preview', () => {
  const known = ['https://buddy.example.com'];
  const signedIn = (h) => h === 'https://buddy.example.com';
  assert.deepEqual(routeInvite({ hub: 'https://evil.example.com', token: 't' }, { knownHubs: known, signedIn }), { action: 'confirm', hub: 'https://evil.example.com' });
  assert.deepEqual(routeInvite({ hub: 'https://buddy.example.com', token: 't' }, { knownHubs: known, signedIn: () => false }), { action: 'signin', hub: 'https://buddy.example.com' });
  assert.deepEqual(routeInvite({ hub: 'https://buddy.example.com', token: 't' }, { knownHubs: known, signedIn }), { action: 'preview', hub: 'https://buddy.example.com' });
  // No hub in the link: the one known hub, else ask.
  assert.deepEqual(routeInvite({ hub: null, token: 't' }, { knownHubs: known, signedIn }), { action: 'preview', hub: 'https://buddy.example.com' });
  assert.deepEqual(routeInvite({ hub: null, token: 't' }, { knownHubs: [], signedIn }), { action: 'need-hub' });
  // Several known hubs: ask, never guess the last one used (it would get a token minted elsewhere).
  const two = ['https://a.example.com', 'https://b.example.com'];
  assert.deepEqual(routeInvite({ hub: null, token: 't' }, { knownHubs: two, signedIn, lastHub: 'https://b.example.com' }), { action: 'need-hub' });
  assert.deepEqual(routeInvite({ hub: null, token: 't' }, { knownHubs: [], lastHub: 'https://evil.example.com', signedIn }), { action: 'need-hub' });
  assert.equal(maskEmail('callum@example.com'), 'c…@example.com');
});

test('bearer scope: the exact hub origin and its WebSocket twin, never another host, port or scheme', () => {
  const s = bearerScope('https://buddy.example.com');
  assert.deepEqual(s.urls, ['https://buddy.example.com/*', 'wss://buddy.example.com/*']);
  for (const u of ['https://buddy.example.com/', 'https://buddy.example.com/api/me?x=1', 'wss://buddy.example.com/ws/board?org=t', 'https://buddy.example.com:443/x']) assert.equal(s.matches(u), true, u);
  for (const u of ['http://buddy.example.com/', 'ws://buddy.example.com/ws', 'https://buddy.example.com:8443/', 'wss://buddy.example.com:8443/',
    'https://evil.buddy.example.com/', 'https://buddy.example.com.evil.com/', 'https://evilbuddy.example.com/', 'https://u:p@buddy.example.com/',
    'https://other.example.com/', 'file:///x', 'not a url']) assert.equal(s.matches(u), false, u);
  const l = bearerScope('http://127.0.0.1:5123');
  assert.deepEqual(l.urls, ['http://127.0.0.1:5123/*', 'ws://127.0.0.1:5123/*']);
  assert.equal(l.matches('http://127.0.0.1:5123/api'), true);
  assert.equal(l.matches('ws://127.0.0.1:5123/ws/board'), true);
  assert.equal(l.matches('http://127.0.0.1:5124/api'), false);
  assert.equal(l.matches('http://localhost:5123/api'), false);
  assert.throws(() => bearerScope('https://buddy.example.com/path'));
});


test('hub probes reuse one in-memory partition, emptied before each probe', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'index.js'), 'utf8');
  const name = /const PROBE_PARTITION = '([^']+)';/.exec(src)?.[1];
  assert.ok(name && !name.startsWith('persist:'), 'in memory only');
  assert.match(src, /probe: \(origin\) => probeHub\(origin, PROBE_PARTITION\)/);
  assert.ok(!/board-probe-\$\{/.test(src), 'no partition per probe');
  const body = src.slice(src.indexOf('async function probeHub('));
  const cleared = body.indexOf('session.fromPartition(partition).clearStorageData()');
  assert.ok(cleared > 0 && cleared < body.indexOf('net.request('), 'cleared before the request');
});

test('runner events: only a validated run.budget_reached is forwarded (with the team); everything else from the runner is dropped', async () => {
  const { runnerEventFrom } = require('../buddy-window/device');
  const h = deviceHarness();
  const d = h.make('team-9');
  await d.enable({ name: 'Mac' });
  const c = h.children[0];
  const ok = { type: 'runner.event', event: 'run.budget_reached', run_id: 'run_1-a', card_id: 'c-123', card_key: 'PLX-123', spent_usd: 5.01, budget_usd: 5 };
  c.emit('message', ok);
  assert.deepEqual(h.events, [{ type: 'run.budget_reached', run_id: 'run_1-a', card_id: 'c-123', card_key: 'PLX-123', spent_usd: 5.01, budget_usd: 5, team_id: 'team-9' }]);
  c.emit('message', { ...ok, extra: 'x', title: 'Rewrite the thing', message: 'hello' });
  assert.deepEqual(Object.keys(h.events[1]).sort(), ['budget_usd', 'card_id', 'card_key', 'run_id', 'spent_usd', 'team_id', 'type'], 'no field outside the list crosses');
  const bad = [
    { ...ok, event: 'run.finished' }, { ...ok, type: 'runner.status' }, { ...ok, run_id: '' }, { ...ok, run_id: 'a'.repeat(65) }, { ...ok, run_id: 'a b' },
    { ...ok, card_id: 7 }, { ...ok, card_id: 'x/../y' }, { ...ok, spent_usd: -1 }, { ...ok, spent_usd: Infinity }, { ...ok, spent_usd: '5' }, { ...ok, budget_usd: NaN },
    { ...ok, budget_usd: 1e9 }, null, 'run.budget_reached', { type: 'runner.event' },
  ];
  for (const m of bad) { const before = h.events.length; c.emit('message', m); assert.equal(h.events.length, before, JSON.stringify(m)); }
  // A bad or hostile card key is left out of the event rather than shown.
  for (const key of ['PLX 123', 'plx-<b>', `PLX-${'1'.repeat(40)}`, 'PLX-1\nMORE', 'javascript:alert(1)', 7]) {
    c.emit('message', { ...ok, card_key: key });
    assert.equal('card_key' in h.events.at(-1), false, String(key));
  }
  assert.equal(runnerEventFrom({ ...ok, card_key: 'PLX-9' }).card_key, 'PLX-9');
});

test('runner events: a subscriber that throws never reaches the runner loop', async () => {
  const h = deviceHarness({ onEventThrows: true });
  const d = h.make();
  await d.enable({ name: 'Mac' });
  const c = h.children[0];
  assert.doesNotThrow(() => c.emit('message', { type: 'runner.event', event: 'run.budget_reached', run_id: 'r1', card_id: 'c1', spent_usd: 1, budget_usd: 1 }));
});

test('runner events: the window object exposes onRunnerEvent(cb) → unsubscribe, fed by every team device', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'index.js'), 'utf8');
  assert.match(idx, /const runnerListeners = new Set\(\);/);
  assert.match(idx, /onEvent: emitRunnerEvent,/);
  assert.match(idx, /onRunnerEvent\(cb\) \{ if \(typeof cb !== 'function'\) return \(\) => \{\}; runnerListeners\.add\(cb\); return \(\) => runnerListeners\.delete\(cb\); \},/);
});

test('Setups is hidden from the sidebar until Apply and Undo exist, but its page stays addressable', () => {
  const { SECTIONS, pageById, sectionOf } = require('../buddy-window/pages');
  assert.ok(!SECTIONS.some(s => s.pages.includes('setups')));
  assert.equal(sectionOf('setups'), null);
  assert.equal(pageById('setups').hidden, true);
});

test('Calendar and Timeline leave the sidebar but stay addressable; PLEXIFORM_SHOW_PLANNER=1 restores them', () => {
  const board = SECTIONS.find((s) => s.id === 'board');
  assert.ok(!board.pages.includes('board:calendar') && !board.pages.includes('board:timeline'));
  assert.equal(pageById('board:calendar').view, 'calendar');
  assert.equal(pageById('board:timeline').view, 'timeline');
  const out = require('node:child_process').execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./buddy-window/pages').SECTIONS.find((s) => s.id === 'board').pages))"], { cwd: path.join(__dirname, '..'), env: { ...process.env, PLEXIFORM_SHOW_PLANNER: '1' } });
  assert.deepEqual(JSON.parse(out), ['board', 'board:table', 'board:history', 'board:calendar', 'board:timeline', 'board:dashboard']);
});
