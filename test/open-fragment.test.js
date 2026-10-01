// openWithFragment: the feedback sender hands the hub's board page a saved report in the URL
// FRAGMENT (never sent to a server, no bridge into the sandboxed hub view). No Electron: the URL
// builder and the validator are pure; the window method is checked as source, like the neighbours.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hubPageUrl, fragmentOk, pageById } = require('../buddy-window/pages');

const src = fs.readFileSync(path.join(__dirname, '..', 'buddy-window', 'index.js'), 'utf8');
const payload = Buffer.from(JSON.stringify({ v: 1, kind: 'bug', title: 'It broke', body: 'x'.repeat(200), requestId: 'r1' })).toString('base64url');

test('fragmentOk: only plexiform-feedback=<base64url, 1..32768>', () => {
  assert.equal(fragmentOk(`plexiform-feedback=${payload}`), true);
  assert.equal(fragmentOk(`plexiform-feedback=${'A'.repeat(32768)}`), true);
  const budget = Buffer.from(JSON.stringify({ v: 1, card_id: 'c-123' })).toString('base64url');
  assert.equal(fragmentOk(`plexiform-budget=${budget}`), true, 'the budget notice key');
  assert.equal(fragmentOk(`plexiform-budget=${'A'.repeat(512)}`), true);
  for (const bad of [`plexiform-budget=${'A'.repeat(513)}`, 'plexiform-budget=', 'plexiform-budget=a+b', 'plexiform-budgets=abc', 'plexiform-feedback=abc&plexiform-budget=abc']) assert.equal(fragmentOk(bad), false, bad);
  for (const bad of [
    '', 'plexiform-feedback=', `plexiform-feedback=${'A'.repeat(32769)}`, `#plexiform-feedback=${payload}`,
    'plexiform-feedback=a+b', 'plexiform-feedback=a/b', 'plexiform-feedback=a=b', 'plexiform-feedback=a b', 'plexiform-feedback=a\nb',
    'other=abc', 'plexiform-feedback=abc&x=1', 'plexiform-feedback=abc#x', 'plexiform-feedback=%41', null, undefined, 42, {}, ['plexiform-feedback=abc'],
  ]) assert.equal(fragmentOk(bad), false, JSON.stringify(bad));
});

test('hubPageUrl appends the fragment to the hub origin only, with the org and view intact; a bad fragment throws', () => {
  const board = pageById('board');
  const f = `plexiform-feedback=${payload}`;
  const u = new URL(hubPageUrl('https://app.plexiform.dev/some/path?x=1', board, { org: 'org-1', fragment: f }));
  assert.equal(u.origin, 'https://app.plexiform.dev');
  assert.equal(u.pathname, '/');
  assert.equal(u.searchParams.get('org'), 'org-1');
  assert.equal(u.hash, `#${f}`);
  assert.equal(new URL(hubPageUrl('https://app.plexiform.dev', board)).hash, '', 'no fragment unless asked');
  assert.throws(() => hubPageUrl('https://app.plexiform.dev', board, { fragment: 'plexiform-feedback=a b' }), /bad fragment/);
  assert.throws(() => hubPageUrl('https://app.plexiform.dev', board, { fragment: 'x=1' }), /bad fragment/);
});

test('openWithFragment: hub pages only, validated, current team hub only, nothing opens without a team, fragment-only change reaches the page', () => {
  assert.match(src, /async function openWithFragment\(pageId, fragment\) \{/);
  assert.match(src, /page\.kind !== 'hub' \|\| !fragmentOk\(fragment\)\) return \{ ok: false, why: 'invalid' \}/);
  assert.match(src, /if \(!getTeamHub\(\)\) return \{ ok: false, why: 'no-team' \};/, 'no team hub: nothing opens');
  const i = src.indexOf('async function openWithFragment');
  const body = src.slice(i, src.indexOf('function open(pageId = null)', i));
  assert.ok(body.indexOf("why: 'no-team'") < body.indexOf('open(pageId)'), 'the team check comes before the window opens');
  assert.match(body, /hubPageUrl\(hubInfo\.url, page, \{ org: hubInfo\.org, fragment \}\)/, 'built from the current hub, never a caller-supplied URL');
  assert.match(body, /new URL\(url\)\.origin !== hubInfo\.origin/, 'the origin is re-checked');
  assert.match(body, /loadURL\(url\)/, 'a same-page fragment change is a navigation, so hashchange fires');
  assert.match(src, /\n {4}openWithFragment,\n/, 'exported on the window object');
});
