// The /invite page script (web/js/invite.js, CONTRACT D70): a malformed
// fragment shows the generic message; the token goes to plexiform:// at once
// and to the legacy claudebuddy:// scheme only on a click of "Open with older
// Buddy", offered when the page is still in front after the timeout. Signed in
// on the browser it joins right here; signed out it can sign in and come back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { BRAND } from '../../shared/brand.js';
import * as text from '../js/account-text.js';

const SRC = readFileSync(new URL('../js/invite.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '');
const TOKEN = `inv_${'A'.repeat(43)}`;

const SIGNED_OUT = { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } };

function run(hash, { visible = true, preview = { team_name: 'Acme', inviter_first_name: 'Jo', role: 'member' }, account = SIGNED_OUT, methods = { google: true, github: true, email: false }, accept = null } = {}) {
  const els = {};
  const el = (id) => (els[id] ??= { id, textContent: '', className: '', hidden: true, disabled: false, href: '', clicks: [], addEventListener(type, fn) { this.clicks.push(fn); } });
  const hrefs = [];
  const moves = [];
  const timers = [];
  const fetches = [];
  const location = {
    hash, pathname: '/invite',
    set href(v) { hrefs.push(v); },
    get href() { return hrefs.at(-1) ?? ''; },
    assign: (u) => moves.push(['assign', u]),
    replace: (u) => moves.push(['replace', u]),
  };
  const routes = { '/api/invites/preview': { status: 200, body: preview }, '/api/account': account, '/api/auth/methods': { status: 200, body: methods }, '/api/invites/accept': accept, '/api/auth/signout': { status: 200, body: { ok: true } } };
  const ctx = {
    BRAND, ...text, location, console,
    document: { getElementById: el, visibilityState: visible ? 'visible' : 'hidden' },
    history: { replaceState() {} },
    setTimeout: (fn) => timers.push(fn),
    fetch: async (url, opts) => { fetches.push({ url, opts }); const r = routes[url]; return { ok: r.status < 400, status: r.status, json: async () => r.body }; },
    decodeURIComponent, encodeURIComponent, JSON, Promise, String,
  };
  vm.runInNewContext(SRC, ctx);
  return { els: new Proxy(els, { get: (t, k) => el(k) }), hrefs, moves, timers, fetches };
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

const IN = { status: 200, body: { user: { id: 'u' }, teams: [], pending_invites: [], csrf_token: 'csrf-1' } };

test('signed in on this browser: join here (CSRF, same-origin), no jump to the app, then the team board', async () => {
  const p = run(`#${TOKEN}`, { account: IN, accept: { status: 200, body: { team: { id: 't-1', name: 'Acme' }, member: { member_id: 'm', role: 'member' } } } });
  await settle();
  assert.deepEqual(p.hrefs, [], 'no plexiform:// jump over a browser that can join itself');
  assert.equal(p.els['join-web'].hidden, false);
  assert.equal(p.els['join-web'].textContent, 'Join Acme');
  assert.equal(p.els['open-app'].hidden, false, 'the app is still offered');
  await p.els['join-web'].clicks[0]();
  const acc = p.fetches.find((f) => f.url === '/api/invites/accept');
  assert.equal(acc.opts.credentials, 'same-origin');
  assert.equal(acc.opts.headers['X-CSRF-Token'], 'csrf-1');
  assert.deepEqual(JSON.parse(acc.opts.body), { t: TOKEN });
  assert.deepEqual(p.moves, [['replace', '/?org=t-1']]);
  const pv = p.fetches.find((f) => f.url === '/api/invites/preview');
  assert.equal(pv.opts.credentials, 'omit', 'the preview never carries the session');
});

test('signed in as someone else: plain words, no address shown, and a switch that signs out then signs in for this invite', async () => {
  const p = run(`#${TOKEN}`, { account: IN, accept: { status: 403, body: { error: { code: 'WRONG_ACCOUNT', email_masked: 'c•••@example.com' } } } });
  await settle();
  await p.els['join-web'].clicks[0]();
  assert.equal(p.els['invite-lead'].textContent, text.WRONG_ACCOUNT);
  assert.doesNotMatch(p.els['invite-lead'].textContent, /@/);
  assert.equal(p.els['switch-web'].hidden, false);
  await p.els['switch-web'].clicks[0]();
  assert.ok(p.fetches.some((f) => f.url === '/api/auth/signout' && f.opts.headers['X-CSRF-Token'] === 'csrf-1'));
  assert.deepEqual(p.moves.at(-1), ['assign', `/signin#invite=${TOKEN}`]);
});

test('already in the team: says so and opens that board', async () => {
  const p = run(`#${TOKEN}`, { account: IN, accept: { status: 409, body: { error: { code: 'ALREADY_MEMBER', team: { id: 't-9', name: 'Acme' } } } } });
  await settle();
  await p.els['join-web'].clicks[0]();
  assert.equal(p.els['invite-lead'].textContent, 'You’re already in Acme.');
  assert.equal(p.els['open-board'].hidden, false);
  assert.equal(p.els['open-board'].href, '/?org=t-9');
});

test('signed out on a hub with email codes: Join in your browser signs in first and carries the invite', async () => {
  const p = run(`#${TOKEN}`, { methods: { google: false, github: false, email: true } });
  await settle();
  assert.equal(p.els['join-web'].hidden, false);
  assert.equal(p.els['join-web'].textContent, 'Join in your browser');
  p.els['join-web'].clicks[0]();
  assert.deepEqual(p.moves, [['assign', `/signin#invite=${TOKEN}`]]);
  const q = run(`#${TOKEN}`);
  await settle();
  assert.equal(q.els['join-web'].hidden, true, 'no browser sign-in to offer without a mailer');
});
