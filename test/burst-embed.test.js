'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const E = require('../src/burst-embed.js');
const { createBurstClient } = require('../src/burst-client.js');
const { createFakeBurst, stateV019, stateV012 } = require('./fixtures/fake-burst.js');

const O = 'http://127.0.0.1:7788';

test('navigation: only the exact Burst origin is allowed; docs and GitHub over https go to the browser; the rest is refused', () => {
  assert.equal(E.navDecision(`${O}/`, O), 'allow');
  assert.equal(E.navDecision(`${O}/api/state?x=1#sec`, O), 'allow');
  for (const u of ['http://127.0.0.1:7789/', 'http://localhost:7788/', 'https://127.0.0.1:7788/', 'http://127.0.0.1/', `http://127.0.0.1:7788@evil.test/`]) assert.notEqual(E.navDecision(u, O), 'allow', u);
  assert.equal(E.navDecision('https://github.com/andrewbakercloudscale/claude-burst', O), 'external');
  assert.equal(E.navDecision('https://docs.anthropic.com/en/docs/claude-code', O), 'external');
  for (const u of ['http://github.com/x', 'https://github.com.evil.test/', 'https://evil.test/', 'https://andrewbaker.ninja', 'https://github.com:8443/x', 'https://u:p@github.com/x', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'not a url', '']) assert.equal(E.navDecision(u, O), 'deny', u);
  assert.equal(E.navDecision(`${O}/`, null), 'deny');
});

test('window.open never makes a window: allow-listed https is handed to the browser, everything else is dropped', () => {
  assert.equal(E.openDecision(`${O}/x`, O), 'deny');
  assert.equal(E.openDecision('https://github.com/a/b', O), 'external');
  assert.equal(E.openDecision('https://evil.test/', O), 'deny');
});

test('page requests: Burst origin and inline data only', () => {
  assert.equal(E.requestAllowed(`${O}/api/state`, O), true);
  assert.equal(E.requestAllowed('data:image/svg+xml,x', O), true);
  assert.equal(E.requestAllowed('https://fonts.googleapis.com/x', O), false);
  assert.equal(E.requestAllowed('http://127.0.0.1:9999/', O), false);
  assert.equal(E.requestAllowed(`${O}/`, null), false);
});

const ASIDE = fs.readFileSync(path.join(__dirname, 'fixtures', 'burst-aside.html'), 'utf8');

test('sub-nav: read from a trimmed copy of the real aside, one item per group, Codex skipped, Burst\'s own ids', () => {
  const nav = E.extractSubnav(ASIDE);
  assert.deepEqual(nav.map((n) => n.label), ['Setup', 'Burst: Overview', 'Spend', 'Context & compaction', 'Routing', 'Sessions & handover', 'Burst: This Mac', 'Health', 'Burst: Requests']);
  assert.deepEqual(nav.find((n) => n.label === 'Spend'), { id: 'sec-models', label: 'Spend' });
  assert.deepEqual(nav.find((n) => n.id === 'cards'), { id: 'cards', label: 'Burst: Overview' });
  assert.ok(!nav.some((n) => n.id === 'sec-codex'));
  assert.ok(nav.length <= E.MAX_ITEMS);
});

test('sub-nav: hostile or renamed markup is whitelisted, capped, or empty', () => {
  assert.deepEqual(E.extractSubnav(''), []);
  assert.deepEqual(E.extractSubnav(null), []);
  assert.deepEqual(E.extractSubnav('<aside class="renamed"><nav>nothing</nav></aside>'), []);
  const evil = '<div class="navgroup">Ok</div><a class="navlink" data-target="x&quot;);alert(1)//"><span class="label">A</span></a>'
    + '<div class="navgroup">&lt;img onerror=x&gt;</div><a class="navlink" data-target="sec-a"><span class="label">fine</span></a>'
    + '<div class="navgroup">Fine</div><a class="navlink" data-target="1bad"><span class="label">x</span></a>';
  assert.deepEqual(E.extractSubnav(evil), []);
  const many = Array.from({ length: 30 }, (_, i) => `<div class="navgroup">G${i}</div><a class="navlink" data-target="sec-${i}"><span class="label">L${i}</span></a>`).join('');
  assert.equal(E.extractSubnav(many).length, E.MAX_ITEMS);
  // no group headings: the links themselves are used
  assert.deepEqual(E.extractSubnav('<a class="navlink" data-target="a1"><span class="label">One</span></a><a class="navlink" data-target="a2"><span class="label">Two</span></a>'), [{ id: 'a1', label: 'One' }, { id: 'a2', label: 'Two' }]);
});

test('section script: only a plain id becomes code, and it is quoted', () => {
  assert.equal(E.sectionScript('sec-models'), E.sectionScript('sec-models'));
  assert.match(E.sectionScript('sec-models'), /\("sec-models"\)$/);
  for (const bad of ['', 'a b', 'x");alert(1)//', '1abc', null, 42, 'a'.repeat(65)]) assert.equal(E.sectionScript(bad), null, String(bad));
  assert.match(E.sectionScript('cards'), /\.click\(\)/);
  assert.match(E.sectionScript('cards'), /scrollIntoView/);
});

// fake-Burst states, through the real client's handshake
const BIN = (home) => path.join(home, '.local', 'bin', 'claude-burst');
async function detectWith(routes, { inspect, installed = true } = {}) {
  const fake = await createFakeBurst(routes);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-embed-'));
  if (installed) { fs.mkdirSync(path.dirname(BIN(home)), { recursive: true }); fs.writeFileSync(BIN(home), '#!/bin/sh\n', { mode: 0o755 }); }
  fs.mkdirSync(path.join(home, '.config', 'claude-burst'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'claude-burst', 'config.json'), JSON.stringify({ admin_listen: `127.0.0.1:${fake.port}` }));
  const trusted = { launchdPid: async () => process.pid, listenerPid: async () => process.pid, exePath: async () => BIN(home) };
  const client = createBurstClient({ home, platform: 'darwin', inspect: inspect ? inspect(home) : trusted, timeoutMs: 800 });
  const d = await client.detect();
  const out = { d, state: E.pageState(d, { platform: 'darwin' }), url: client.adminUrl() };
  await fake.close();
  fs.rmSync(home, { recursive: true, force: true });
  return out;
}

test('fake Burst present: ready, the dashboard may load', async () => {
  const r = await detectWith({ '/api/state': { body: stateV019() }, '/api/upgrade-status': { body: { up_to_date: true, can_upgrade: false } } });
  assert.equal(r.state.mode, 'ready');
  assert.equal(r.state.reason, 'present');
  assert.match(r.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
});

test('fake Burst old: native empty state offering Update, nothing loaded', async () => {
  const r = await detectWith({ '/api/state': { body: stateV012() } });
  assert.equal(r.state.mode, 'empty');
  assert.equal(r.state.reason, 'old');
  assert.deepEqual(r.state.actions.map((a) => a.kind), ['update']);
});

test('fake Burst untrusted (another program on the port): empty, read nothing, only Turn off', async () => {
  const r = await detectWith({ '/api/state': { body: stateV019() } }, { inspect: (home) => ({ launchdPid: async () => process.pid, listenerPid: async () => process.pid, exePath: async () => '/usr/bin/other' }) });
  assert.equal(r.d.kind, 'untrusted');
  assert.equal(r.state.mode, 'empty');
  assert.equal(r.state.reason, 'untrusted');
  assert.deepEqual(r.state.actions.map((a) => a.kind), ['off']);
});

test('fake Burst down (nothing listening): "Burst isn\'t answering" with Repair first', async () => {
  const fake = await createFakeBurst({});
  const port = fake.port;
  await fake.close();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-embed-'));
  fs.mkdirSync(path.dirname(BIN(home)), { recursive: true });
  fs.writeFileSync(BIN(home), '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.config', 'claude-burst'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'claude-burst', 'config.json'), JSON.stringify({ admin_listen: `127.0.0.1:${port}` }));
  const d = await createBurstClient({ home, platform: 'darwin', timeoutMs: 500 }).detect();
  fs.rmSync(home, { recursive: true, force: true });
  const s = E.pageState(d, { platform: 'darwin' });
  assert.equal(s.mode, 'empty');
  assert.equal(s.reason, 'down');
  assert.equal(s.headline, "Burst isn't answering");
  assert.equal(s.actions[0].kind, 'repair');
});

test('absent, broken and non-macOS states are never a blank view', () => {
  const absent = E.pageState({ kind: 'not_installed' }, { platform: 'darwin' });
  assert.equal(absent.mode, 'empty');
  assert.equal(absent.actions[0].kind, 'install');
  assert.equal(absent.docs, true);
  assert.equal(E.pageState({ kind: 'broken', state: { version: '0.19.0' } }, { platform: 'darwin' }).actions[0].kind, 'repair');
  const win = E.pageState({ kind: 'unsupported' }, { platform: 'win32' });
  assert.equal(win.mode, 'empty');
  assert.equal(win.reason, 'unsupported');
  for (const kind of ['not_installed', 'unreachable', 'broken', 'untrusted', 'surprise']) {
    const s = E.pageState({ kind, state: { version: '0.19.0' }, reason: 'why.' }, { platform: 'darwin' });
    assert.ok(s.mode === 'empty' && s.headline && s.detail, kind);
    for (const a of s.actions) assert.ok(E.PAGE_ACTIONS.includes(a.kind), a.kind);
  }
});
