// The GitHub organization an admin names at connect (D42 addendum "start
// inputs"), through the real registry and HTTP routes: validated at /start,
// signed into the state, checked against the app GitHub made at the callback,
// and never stored, logged or journalled as typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { defineConnector } from '../integrations/connector.js';
import { startHub } from './helpers.js';
import { createLogger } from '../log.js';

// Assembled at run time: no key- or secret-shaped literal in the source.
const PEM_LINE = (w) => ['-----' + w, 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
const pem = () => `${PEM_LINE('BEGIN')}\n${'M'.repeat(64)}\n${'Q'.repeat(40)}==\n${PEM_LINE('END')}\n`;
let nextId = 700;
const app = (owner) => {
  nextId += 1;
  return {
    id: nextId, slug: `plexiform-x-${nextId}`, owner: { id: 5, ...owner }, pem: pem(), webhook_secret: randomBytes(20).toString('hex'),
    permissions: { pull_requests: 'read', checks: 'read', metadata: 'read' }, events: ['pull_request', 'pull_request_review', 'check_suite'],
  };
};
const ORG_A = { login: 'acme-co', type: 'Organization' };

function capture() {
  const lines = [];
  return { lines, log: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) };
}

async function setup() {
  const gh = { app: null, calls: 0 };
  // api.github.com's manifest conversion: whatever app this test says GitHub made.
  const fetchImpl = async (url) => {
    gh.calls += 1;
    if (!/^https:\/\/api\.github\.com\/app-manifests\/[A-Za-z0-9]+\/conversions$/.test(url)) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(gh.app), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const log = capture();
  const h = await startHub({ fetchImpl, log: log.log });
  h.hub.setVaultKey(randomBytes(32));
  const alice = await h.login('alice');
  const bob = await h.login('bob');
  return { h, reg: h.app.integrations, gh, log, alice, bob };
}

const start = (h, cookie, body = {}) => h.api(cookie, 'POST', '/api/integrations/github/start', { request_id: randomUUID(), ...body });
const stateOf = (r) => new URL(r.body.form.action).searchParams.get('state');
const payloadOf = (state) => JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString('utf8'));
const reencode = (state, edit) => `${Buffer.from(JSON.stringify(edit(payloadOf(state)))).toString('base64url')}.${state.split('.')[1]}`;
const callback = (h, state, bind) => h.app.integrations.oauthCallback({ provider: 'github', query: new URLSearchParams({ state, code: 'abc123' }), publicUrl: h.base, bindCookie: bind });
const written = (h) => ({
  connections: h.db.get("SELECT COUNT(*) AS n FROM connections WHERE provider = 'github'").n,
  secrets: h.db.get('SELECT COUNT(*) AS n FROM connection_secrets').n,
  journal: h.db.get("SELECT COUNT(*) AS n FROM journal WHERE kind = 'integration.connect'").n,
});
const everything = (h) => JSON.stringify([
  h.db.all('SELECT * FROM connections'), h.db.all('SELECT * FROM journal'), h.db.all('SELECT * FROM integration_audit'),
]);

test('start input: GitHub offers org; the form goes to that organization and the org is signed into the state', async () => {
  const { h, alice } = await setup();
  try {
    const list = await h.api(alice, 'GET', '/api/integrations');
    assert.deepEqual(list.body.available.find((c) => c.id === 'github').start, ['org']);
    const r = await start(h, alice, { input: { org: 'Acme-Co' } });
    assert.equal(r.status, 200, r.text);
    assert.match(r.body.form.action, /^https:\/\/github\.com\/organizations\/Acme-Co\/settings\/apps\/new\?state=/);
    assert.deepEqual(payloadOf(stateOf(r)).si, { org: 'Acme-Co' });
    // No org: the signed-in account's page, and no si at all.
    const plain = await start(h, alice, { input: {} });
    assert.equal(plain.status, 200, plain.text);
    assert.match(plain.body.form.action, /^https:\/\/github\.com\/settings\/apps\/new\?state=/);
    assert.equal(Object.hasOwn(payloadOf(stateOf(plain)), 'si'), false);
    const none = await start(h, alice);
    assert.equal(Object.hasOwn(payloadOf(stateOf(none)), 'si'), false);
  } finally { await h.close(); }
});

test('start input: a bad, odd or undeclared input is a fixed VALIDATION before anything is minted; non-admins can\'t start', async () => {
  const { h, alice, bob } = await setup();
  try {
    const bad = [
      { org: '../evil' }, { org: 'ac/me' }, { org: 'ac%2Fme' }, { org: 'acme?state=x' }, { org: '-acme' }, { org: 'acme-' }, { org: 'ac--me' },
      { org: 'a'.repeat(40) }, { org: '' }, { org: ' acme' }, { org: 'acme\n' }, { org: 'ácme' }, { org: 42 }, { org: null }, { org: ['acme'] }, { org: { x: 1 } },
      { org: 'x'.repeat(5000) }, { owner: 'acme' }, { org: 'acme', extra: 'x' }, JSON.parse('{"__proto__":{"org":"acme"}}'), JSON.parse('{"constructor":"acme"}'),
      'acme', ['acme'], 7, true,
    ];
    for (const input of bad) {
      const r = await start(h, alice, { input });
      assert.equal(r.status, 400, `${JSON.stringify(input)} ${r.text}`);
      assert.equal(r.body.error.code, 'VALIDATION');
      assert.ok(['this connection takes no such input', 'that value is not valid here: check it and try again'].includes(r.body.error.message), r.body.error.message);
      assert.equal(r.headers.get('set-cookie'), null, 'no bind cookie for a refused start');
    }
    const member = await start(h, bob, { input: { org: 'acme-co' } });
    assert.equal(member.status, 403);
  } finally { await h.close(); }
});

test('start input: a connector that declares none refuses any input; input reaches manifestForm, startInput reaches exchange, both {} when absent', async () => {
  const { h, reg, alice } = await setup();
  try {
    const seen = { form: [], exchange: [] };
    let accept = true;
    const conn = (id, over = {}) => defineConnector({
      id, name: id, scopes: [], secrets: [], hosts: ['example.com'],
      connect: {
        kind: 'app_install', formHost: 'example.com',
        manifestForm: (a) => { seen.form.push(a.input); return { action: `https://example.com/new?state=${encodeURIComponent(a.state)}`, fields: { m: 'x' } }; },
        exchange: async (a) => { seen.exchange.push(a.startInput); return { external_id: randomUUID(), display_name: 'x', scopes: [], secrets: {} }; },
        ...over,
      },
    });
    reg.register(conn('no-inputs'));
    reg.register(conn('with-inputs', { startInputs: ['team'], startInput: (k, v) => (accept && k === 'team' && /^[a-z]{1,10}$/.test(v) ? v : null) }));
    const r0 = await h.api(alice, 'POST', '/api/integrations/no-inputs/start', { request_id: randomUUID(), input: { org: 'acme' } });
    assert.equal(r0.status, 400);
    assert.equal(r0.body.error.code, 'VALIDATION');
    const r1 = await h.api(alice, 'POST', '/api/integrations/no-inputs/start', { request_id: randomUUID() });
    assert.equal(r1.status, 200);
    const r2 = await h.api(alice, 'POST', '/api/integrations/with-inputs/start', { request_id: randomUUID(), input: { team: 'blue' } });
    assert.equal(r2.status, 200, r2.text);
    assert.deepEqual(seen.form, [{}, { team: 'blue' }]);
    const st1 = new URL(r1.body.form.action).searchParams.get('state');
    const st2 = new URL(r2.body.form.action).searchParams.get('state');
    const cb = (p, s, b) => reg.oauthCallback({ provider: p, query: new URLSearchParams({ state: s, code: 'c' }), publicUrl: h.base, bindCookie: b });
    assert.equal((await cb('no-inputs', st1, r1.body.bind)).ok, true);
    // The callback checks the signed value again with the connector's rule.
    accept = false;
    const refused = await cb('with-inputs', st2, r2.body.bind);
    assert.deepEqual(refused, { ok: false, error: 'This link is not valid. Start again from Buddy.' });
    accept = true;
    const r3 = await h.api(alice, 'POST', '/api/integrations/with-inputs/start', { request_id: randomUUID(), input: { team: 'red' } });
    assert.equal((await cb('with-inputs', new URL(r3.body.form.action).searchParams.get('state'), r3.body.bind)).ok, true);
    assert.deepEqual(seen.exchange, [{}, { team: 'red' }]);
  } finally { await h.close(); }
});

const NOT_OWNED_TEXT = 'GitHub created this app under a different owner than the organization you named. Delete that app on GitHub and start again.';

test('callback: an app owned by another organization, or by a user, is refused for an org start with the coded NOT_OWNED text and a link to that app; nothing is written', async () => {
  const { h, gh, alice } = await setup();
  try {
    const before = written(h);
    for (const owner of [{ login: 'other-org', type: 'Organization' }, { login: 'callum', type: 'User' }, { login: 'acme-co', type: 'User' }]) {
      const r = await start(h, alice, { input: { org: 'acme-co' } });
      gh.app = app(owner);
      const out = await callback(h, stateOf(r), r.body.bind);
      assert.deepEqual(out, { ok: false, code: 'NOT_OWNED', error: NOT_OWNED_TEXT, link: { url: `https://github.com/apps/${gh.app.slug}`, text: 'Open that app on GitHub' } }, JSON.stringify(owner));
    }
    assert.equal(gh.calls, 3, 'refused on GitHub\'s answer, not before it');
    assert.deepEqual(written(h), before, 'no connection, sealed secret or journal row');
  } finally { await h.close(); }
});

test('callback page: NOT_OWNED shows the fixed sentence and one plain link to the app, built from its checked slug', async () => {
  const { h, gh, alice } = await setup();
  try {
    const r = await start(h, alice, { input: { org: 'acme-co' } });
    gh.app = app({ login: 'other-org', type: 'Organization' });
    const res = await fetch(`${h.base}/integrations/github/callback?${new URLSearchParams({ state: stateOf(r), code: 'abc123' })}`, { headers: { cookie: `board_int_github=${r.body.bind}` } });
    const page = await res.text();
    assert.equal(res.status, 400);
    assert.match(page, /data-connect="error"/);
    assert.ok(page.includes(NOT_OWNED_TEXT.replace(/'/g, '&#39;')), page);
    assert.deepEqual([...page.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]), [[`https://github.com/apps/${gh.app.slug}`, 'Open that app on GitHub']]);
    assert.equal(page.includes('did not accept'), false);
  } finally { await h.close(); }
});

test('NOT_OWNED: the registry keeps only its own text; a link off the connector\'s hosts, an unknown code or a start with no inputs is the generic refusal', async () => {
  const { h, reg, alice } = await setup();
  try {
    let thrown = null;
    reg.register(defineConnector({
      id: 'owner-test', name: 'Owner Test', scopes: [], secrets: [], hosts: ['example.com'],
      connect: {
        kind: 'app_install', formHost: 'example.com', startInputs: ['org'], startInput: (k, v) => (/^[a-z]{1,10}$/.test(v) ? v : null),
        manifestForm: (a) => ({ action: `https://example.com/new?state=${encodeURIComponent(a.state)}`, fields: { m: 'x' } }),
        exchange: async () => { throw thrown; },
      },
    }));
    const run = async (input) => {
      const s = await h.api(alice, 'POST', '/api/integrations/owner-test/start', { request_id: randomUUID(), ...(input ? { input } : {}) });
      assert.equal(s.status, 200, s.text);
      return reg.oauthCallback({ provider: 'owner-test', query: new URLSearchParams({ state: new URL(s.body.form.action).searchParams.get('state'), code: 'c' }), publicUrl: h.base, bindCookie: s.body.bind });
    };
    const generic = { ok: false, error: 'The provider did not accept the connection. Try again.' };
    const text = 'Owner Test created this app under a different owner than the organization you named. Delete that app on Owner Test and start again.';
    thrown = Object.assign(new Error('<b>provider words</b>'), { code: 'NOT_OWNED', url: 'https://example.com/apps/x' });
    assert.deepEqual(await run({ org: 'acme' }), { ok: false, code: 'NOT_OWNED', error: text, link: { url: 'https://example.com/apps/x', text: 'Open that app on Owner Test' } });
    for (const url of ['https://evil.example/apps/x', 'http://example.com/apps/x', 'javascript:alert(1)', 'https://example.com:8443/x', 'https://u:p@example.com/x', 42, { href: 'https://example.com/' }]) {
      thrown = Object.assign(new Error('x'), { code: 'NOT_OWNED', url });
      assert.deepEqual(await run({ org: 'acme' }), { ok: false, code: 'NOT_OWNED', error: text }, String(url));
    }
    thrown = Object.assign(new Error('x'), { code: 'NOT_OWNED', url: 'https://example.com/apps/x' });
    assert.deepEqual(await run(), generic, 'no organization was named: the owner sentence would be wrong');
    thrown = Object.assign(new Error('Delete everything'), { code: 'SOMETHING_ELSE', url: 'https://example.com/apps/x' });
    assert.deepEqual(await run({ org: 'acme' }), generic);
  } finally { await h.close(); }
});

test('no org named: a previous connection\'s provider.org is not where the app is made; the state carries no org and GitHub\'s owner is taken', async () => {
  const { h, reg, gh, alice } = await setup();
  try {
    reg.createConnection({
      external_id: '9001', display_name: 'old-org', scopes: [], secrets: { app_private_key: pem(), webhook_secret: randomBytes(20).toString('hex') },
      settings: { provider: { app_id: 9001, app_slug: 'plexiform-old-org-abcd', login: 'old-org', org: 'old-org' } }, orgId: h.ids.org, memberId: h.ids.alice, provider: 'github',
    });
    let newest = 'old-org';
    for (const owner of [{ login: 'callum', type: 'User' }, { login: 'new-org', type: 'Organization' }]) {
      const r = await start(h, alice, { input: {} });
      assert.equal(r.status, 200, r.text);
      assert.match(r.body.form.action, /^https:\/\/github\.com\/settings\/apps\/new\?state=/, 'the user\'s own page, not an earlier org\'s');
      assert.match(JSON.parse(r.body.form.fields.manifest).name, new RegExp(`^Plexiform-${newest}-[a-z0-9]{4}$`), 'named from the newest connection\'s login only');
      assert.equal(Object.hasOwn(payloadOf(stateOf(r)), 'si'), false);
      gh.app = app(owner);
      const out = await callback(h, stateOf(r), r.body.bind);
      assert.equal(out.ok, true, out.error);
      const settings = JSON.parse(h.db.get('SELECT settings FROM connections WHERE id = ?', out.connection.id).settings);
      assert.equal(settings.provider.login, owner.login);
      assert.equal(settings.provider.org, owner.type === 'Organization' ? owner.login : undefined);
      newest = owner.login;
    }
  } finally { await h.close(); }
});

test('/start: a replayed request_id is the fixed REPLAYED 409 whatever its input; the cache holds no org, state, form or bind', async () => {
  const { h, alice } = await setup();
  try {
    const rid = randomUUID();
    const first = await h.api(alice, 'POST', '/api/integrations/github/start', { request_id: rid, input: { org: 'acme-co' } });
    assert.equal(first.status, 200, first.text);
    const replayed = { error: { code: 'CONFLICT', message: 'This request was already sent. Reload the page.', reason: 'REPLAYED' } };
    for (const input of [{ org: 'evil-org' }, { org: 'acme-co' }, undefined]) {
      const again = await h.api(alice, 'POST', '/api/integrations/github/start', { request_id: rid, ...(input ? { input } : {}) });
      assert.equal(again.status, 409, again.text);
      assert.deepEqual(again.body, replayed);
      assert.equal(again.headers.get('set-cookie'), null, 'no bind cookie on a replay');
    }
    const entry = JSON.stringify(h.hub.cachedResponse(h.ids.alice, rid));
    for (const leak of ['acme-co', stateOf(first), first.body.bind, 'form', 'bind', 'state', 'github.com']) assert.equal(entry.includes(leak), false, leak);
    // A refused start is cached the same way: its replay can't tell which value was refused.
    const rid2 = randomUUID();
    assert.equal((await h.api(alice, 'POST', '/api/integrations/github/start', { request_id: rid2, input: { org: '../x' } })).status, 400);
    assert.deepEqual((await h.api(alice, 'POST', '/api/integrations/github/start', { request_id: rid2, input: { org: 'acme-co' } })).body, replayed);
  } finally { await h.close(); }
});

test('start input: the normalised value is held to 256 bytes too (a multibyte answer under 256 characters is refused)', async () => {
  const { h, reg, alice } = await setup();
  try {
    let answer = null;
    reg.register(defineConnector({
      id: 'wide-test', name: 'Wide', scopes: [], secrets: [], hosts: ['example.com'],
      connect: {
        kind: 'app_install', formHost: 'example.com', startInputs: ['team'], startInput: () => answer,
        manifestForm: (a) => ({ action: `https://example.com/new?state=${encodeURIComponent(a.state)}`, fields: { m: 'x' } }),
        exchange: async () => ({ external_id: randomUUID(), display_name: 'x', scopes: [], secrets: {} }),
      },
    }));
    const go = () => h.api(alice, 'POST', '/api/integrations/wide-test/start', { request_id: randomUUID(), input: { team: 'a' } });
    for (const a of ['\u00e9'.repeat(129), '\u{1F600}'.repeat(65), `${'x'.repeat(255)}\u00e9`]) {
      answer = a;
      assert.ok(a.length <= 256 && Buffer.byteLength(a) > 256);
      const r = await go();
      assert.equal(r.status, 400, r.text);
      assert.deepEqual(r.body.error, { code: 'VALIDATION', message: 'that value is not valid here: check it and try again' });
      assert.equal(r.headers.get('set-cookie'), null);
    }
    for (const a of ['\u00e9'.repeat(128), 'x'.repeat(256)]) {
      answer = a;
      assert.equal((await go()).status, 200, `${Buffer.byteLength(a)} bytes`);
    }
  } finally { await h.close(); }
});

test('callback: the named organization in another letter case is accepted; the typed spelling is never stored, logged or journalled', async () => {
  const { h, gh, log, alice } = await setup();
  try {
    const r = await start(h, alice, { input: { org: 'ACME-co' } });
    gh.app = app(ORG_A);
    const out = await callback(h, stateOf(r), r.body.bind);
    assert.equal(out.ok, true, out.error);
    const row = h.db.get('SELECT display_name, settings FROM connections WHERE id = ?', out.connection.id);
    assert.equal(row.display_name, 'acme-co');
    const settings = JSON.parse(row.settings);
    assert.equal(settings.provider.org, 'acme-co');
    assert.equal(settings.provider.login, 'acme-co');
    assert.equal(settings.config, undefined);
    assert.equal(everything(h).includes('ACME-co'), false, 'the typed value is nowhere in the DB');
    assert.equal(log.lines.join('\n').includes('ACME-co'), false, 'nor in the log');
  } finally { await h.close(); }
});

test('callback: no org named and a user-owned app is accepted as before (no provider.org)', async () => {
  const { h, gh, log, alice } = await setup();
  try {
    const r = await start(h, alice);
    gh.app = app({ login: 'callum', type: 'User' });
    const out = await callback(h, stateOf(r), r.body.bind);
    assert.equal(out.ok, true, `${out.error} ${log.lines.filter((l) => l.includes('"warn"')).join(' ')}`);
    const settings = JSON.parse(h.db.get('SELECT settings FROM connections WHERE id = ?', out.connection.id).settings);
    assert.equal(settings.provider.login, 'callum');
    assert.equal(settings.provider.org, undefined);
  } finally { await h.close(); }
});

test('callback: a tampered or swapped state can\'t move the org (MAC and bind), and GitHub is never asked', async () => {
  const { h, gh, alice } = await setup();
  try {
    gh.app = app({ login: 'evil-org', type: 'Organization' });
    const a = await start(h, alice, { input: { org: 'acme-co' } });
    const b = await start(h, alice, { input: { org: 'evil-org' } });
    const plain = await start(h, alice);
    const invalid = { ok: false, error: 'This link is not valid. Start again from Buddy.' };
    const [sa, sb, sp] = [stateOf(a), stateOf(b), stateOf(plain)];
    // The org changed or added under the old MAC.
    assert.deepEqual(await callback(h, reencode(sa, (p) => ({ ...p, si: { org: 'evil-org' } })), a.body.bind), invalid);
    assert.deepEqual(await callback(h, reencode(sp, (p) => ({ ...p, si: { org: 'evil-org' } })), plain.body.bind), invalid);
    assert.deepEqual(await callback(h, reencode(sa, (p) => { const { si, ...rest } = p; return rest; }), a.body.bind), invalid);
    // One start's payload under another start's MAC.
    assert.deepEqual(await callback(h, `${sb.split('.')[0]}.${sa.split('.')[1]}`, a.body.bind), invalid);
    // Another start's (signed) state, with this browser's bind.
    assert.deepEqual(await callback(h, sb, a.body.bind), { ok: false, error: 'Open this link in the window Plexiform opened. Start again.' });
    assert.equal(gh.calls, 0);
    assert.equal(written(h).connections, 0);
    // The untouched state still works for its own org only: evil-org's app is refused under acme-co's state.
    assert.equal((await callback(h, sa, a.body.bind)).ok, false);
    gh.app = app(ORG_A);
    assert.equal((await callback(h, sb, b.body.bind)).ok, false, 'evil-org\'s state refuses acme-co\'s app');
    assert.equal(written(h).connections, 0);
  } finally { await h.close(); }
});

test('defineConnector: startInputs are 1–4 distinct names, need startInput, and only on oauth/app_install without prepare', () => {
  const base = (connect) => ({ id: 'si-test', name: 'S', scopes: [], secrets: [], hosts: ['example.com'], connect });
  const form = { kind: 'app_install', formHost: 'example.com', manifestForm: () => ({}), exchange: async () => ({}) };
  const v = () => null;
  const ok = defineConnector(base({ ...form, startInputs: ['org'], startInput: v }));
  assert.ok(Object.isFrozen(ok.connect.startInputs));
  assert.doesNotThrow(() => defineConnector(base({ kind: 'oauth', authorizeUrl: () => 'https://example.com', exchange: async () => ({}), startInputs: ['org', 'team'], startInput: v })));
  for (const [label, over] of [
    ['no validator', { startInputs: ['org'] }],
    ['validator not a function', { startInputs: ['org'], startInput: 'x' }],
    ['validator without names', { startInput: v }],
    ['empty', { startInputs: [], startInput: v }],
    ['too many', { startInputs: ['a', 'b', 'c', 'd', 'e'], startInput: v }],
    ['duplicate', { startInputs: ['org', 'org'], startInput: v }],
    ['upper case', { startInputs: ['Org'], startInput: v }],
    ['proto', { startInputs: ['__proto__'], startInput: v }],
    ['constructor', { startInputs: ['constructor'], startInput: v }],
    ['prototype', { startInputs: ['prototype'], startInput: v }],
    ['not an array', { startInputs: 'org', startInput: v }],
  ]) assert.throws(() => defineConnector(base({ ...form, ...over })), /startInput/, label);
  assert.throws(() => defineConnector(base({ kind: 'token', verifyToken: async () => ({}), startInputs: ['org'], startInput: v })), /startInput/);
  assert.throws(() => defineConnector(base({ kind: 'oauth', authorizeUrl: () => '', exchange: async () => ({}), prepare: async () => ({}), prepareInputs: ['x'], startInputs: ['org'], startInput: v })), /startInput/);
});
