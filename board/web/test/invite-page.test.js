// The /invite page script (web/js/invite.js, CONTRACT D70): a malformed
// fragment shows the generic message; the token goes to plexiform:// at once
// and to the legacy claudebuddy:// scheme only on a click of "Open with older
// Buddy", offered when the page is still in front after the timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { BRAND } from '../../shared/brand.js';

const SRC = readFileSync(new URL('../js/invite.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '');
const TOKEN = `inv_${'A'.repeat(43)}`;

function run(hash, { visible = true, preview = { team_name: 'Acme', inviter_first_name: 'Jo', role: 'member' } } = {}) {
  const els = {};
  const el = (id) => (els[id] ??= { id, textContent: '', hidden: true, href: '', clicks: [], addEventListener(type, fn) { this.clicks.push(fn); } });
  const hrefs = [];
  const timers = [];
  const fetches = [];
  const location = {
    hash, pathname: '/invite',
    set href(v) { hrefs.push(v); },
    get href() { return hrefs.at(-1) ?? ''; },
  };
  const ctx = {
    BRAND, location, console,
    document: { getElementById: el, visibilityState: visible ? 'visible' : 'hidden' },
    history: { replaceState() {} },
    setTimeout: (fn) => timers.push(fn),
    fetch: async (url, opts) => { fetches.push({ url, opts }); return { ok: true, status: 200, json: async () => preview }; },
    decodeURIComponent, JSON, Promise,
  };
  vm.runInNewContext(SRC, ctx);
  return { els: new Proxy(els, { get: (t, k) => el(k) }), hrefs, timers, fetches };
}

const settle = () => new Promise((r) => setImmediate(r));

test('a malformed %-escape in the fragment shows the generic invalid message, not a crash', async () => {
  const p = run('#inv_%E0%A4%A');
  await settle();
  assert.match(p.els['invite-lead'].textContent, /This invite is not valid/);
  assert.equal(p.fetches.length, 0);
  assert.deepEqual(p.hrefs, []);
});

test('plexiform:// first; claudebuddy:// never without a click, and only after the timeout', async () => {
  const p = run(`#${TOKEN}`);
  await settle();
  assert.deepEqual(p.hrefs, [`${BRAND.deepLinkScheme}://invite/${TOKEN}`]);
  assert.equal(p.els['open-legacy'].hidden, true);
  assert.equal(p.timers.length, 1);
  p.timers[0]();
  assert.equal(p.els['open-legacy'].hidden, false, 'offered once nothing handled the first scheme');
  assert.ok(!p.hrefs.some((h) => h.startsWith(BRAND.legacyDeepLinkScheme)), 'the timeout alone sends nothing to the legacy scheme');
  p.els['open-legacy'].clicks[0]();
  assert.equal(p.hrefs.at(-1), `${BRAND.legacyDeepLinkScheme}://invite/${TOKEN}`);
});

test('the app took over (page hidden): no legacy offer at all', async () => {
  const p = run(`#${TOKEN}`, { visible: false });
  await settle();
  p.timers[0]();
  assert.equal(p.els['open-legacy'].hidden, true);
  assert.equal(p.els['open-legacy'].clicks.length, 0);
});
