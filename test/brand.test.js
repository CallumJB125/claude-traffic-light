const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Brand = require('../brand.js');

test('brand: the name, the URLs and the deep-link scheme Callum chose', () => {
  assert.equal(Brand.name, 'Plexiform');
  assert.equal(Brand.urls.site, 'https://plexiform.dev');
  assert.equal(Brand.urls.hub, 'https://app.plexiform.dev');
  assert.equal(Brand.urls.downloads, 'https://download.plexiform.dev');
  assert.equal(Brand.urls.phone, 'https://app.plexiform.dev/phone');
  assert.match(Brand.urls.updates, /^https:\/\/[^/]+$/, 'the update feed is an https origin, with no trailing path');
  assert.equal(Brand.urls.updates, 'https://download.plexiform.dev');
  assert.equal(Brand.scheme, 'plexiform');
  assert.deepEqual(Brand.legacySchemes, ['claudebuddy']);
  assert.equal(Brand.mascotName, 'Buddy', 'the pixel character keeps its name');
  assert.ok(Brand.formerNames.includes('Claude Buddy'));
  assert.throws(() => { 'use strict'; Brand.name = 'x'; }, TypeError, 'frozen');
  assert.equal(Brand.email('support'), 'support@plexiform.dev');
  assert.throws(() => Brand.email('a b'));
  assert.equal(Brand.label('Open {name}…'), 'Open Plexiform…');
});

test('brand: invite links carry the token in the fragment and refuse anything a link cannot carry', () => {
  assert.equal(Brand.inviteUrl('abc-DEF_123.~'), 'https://app.plexiform.dev/invite#abc-DEF_123.~');
  for (const bad of ['', 'a b', 'a#b', 'a/b', '?x', null, 'x'.repeat(513)]) assert.throws(() => Brand.inviteUrl(bad), /invite token/);
});

test('brand: deep links build in the new scheme and parse in both', () => {
  assert.equal(Brand.deepLink('add', { id: 'otter', from: 'a b&c' }), 'plexiform://add?id=otter&from=a%20b%26c');
  assert.equal(Brand.deepLink('invite'), 'plexiform://invite');
  assert.throws(() => Brand.deepLink('Bad Action'));
  assert.deepEqual(Brand.parseDeepLink('plexiform://add?id=otter&from=a%20b%26c'), { action: 'add', params: { id: 'otter', from: 'a b&c' }, legacy: false });
  assert.deepEqual(Brand.parseDeepLink('claudebuddy://add?id=otter'), { action: 'add', params: { id: 'otter' }, legacy: true });
  assert.deepEqual(Brand.parseDeepLink('PLEXIFORM://Invite/#frag'), { action: 'invite', params: {}, legacy: false });
});

test('brand: deep links from elsewhere are refused, not interpreted', () => {
  for (const bad of ['https://plexiform.dev/add', 'javascript://add', 'plexiform:add', 'plexiform://', 'plexiform://../etc', 'plexiform://add?x=%E0%A4%A', 'plexiform://add?__proto__=1', 'plexiform://add?constructor=1', 'fileplexiform://add', `plexiform://add?x=${'a'.repeat(5000)}`, null, 5]) assert.equal(Brand.parseDeepLink(bad), null, String(bad).slice(0, 40));
  const r = Brand.parseDeepLink('plexiform://add?a=1&a=2&b');
  assert.deepEqual(r.params, { a: '2', b: '' }, 'the last value wins, a bare key is empty');
  assert.equal(Object.getPrototypeOf(r.params), Object.prototype);
});

test('brand: it ships in the app, and loads in a page as window.Brand', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('brand.js'));
  const { JSDOM } = require('jsdom');
  const w = new JSDOM('', { runScripts: 'outside-only' }).window;
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'brand.js'), 'utf8'));
  assert.equal(w.Brand.name, 'Plexiform');
  assert.equal(w.Brand.deepLink('invite'), 'plexiform://invite');
});
