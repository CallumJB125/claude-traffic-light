// Member identity for internet exposure: one Access email in several orgs
// resolves by the resource's org (never a silent first pick), email-only
// Access members (one-time PIN IdP, no GitHub identity), removal closes live
// browser sockets and revokes devices, and sockets close at Access expiry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { startHub, FakeBrowser } from './helpers.js';

const TEAM = 'acme';
const AUD = 'aud-123';

function keypair(kid) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

function jwtFor(k, claims) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b({ alg: 'RS256', kid: k.kid, typ: 'JWT' });
  const body = b({ iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600, ...claims });
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), k.privateKey).toString('base64url')}`;
}

async function accessHub() {
  const k = keypair('k1');
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ keys: [k.jwk] }) });
  const h = await startHub({ config: { auth: 'access', accessTeam: TEAM, accessAud: AUD }, fetchImpl });
  const as = (email, extra = {}) => ({ 'cf-access-jwt-assertion': jwtFor(k, { email, ...extra }) });
  return { h, k, as };
}

// A second org where alice (same email) is also a member, with its own board.
function secondOrg(h) {
  const now = h.hub.iso();
  const org = { id: randomUUID(), name: 'other', created_at: now };
  h.db.insert('orgs', org);
  const board = { id: randomUUID(), org_id: org.id, name: 'OTHER', key_prefix: 'OTH' };
  h.db.insert('boards', board);
  const member = { id: randomUUID(), org_id: org.id, github_id: -10, github_login: 'alice', email: 'alice@dev.local', display_name: 'Alice (other)', role: 'owner', created_at: now };
  h.db.insert('members', member);
  return { org, board, member };
}

test('Access: an email in two orgs resolves by the resource\'s org; without one it lists the orgs instead of picking', async () => {
  const { h, as } = await accessHub();
  try {
    const other = secondOrg(h);
    const me = await h.api(null, 'GET', '/api/me', null, as('alice@dev.local'));
    assert.equal(me.status, 409);
    assert.equal(me.body.error.code, 'CONFLICT');
    assert.deepEqual(me.body.error.orgs.map((o) => o.name).sort(), ['dev', 'other']);
    const pick = await h.api(null, 'GET', '/api/me', null, { ...as('alice@dev.local'), 'board-org': other.org.id });
    assert.equal(pick.status, 200);
    assert.equal(pick.body.org.name, 'other');
    assert.equal((await h.api(null, 'GET', `/api/me?org=${h.ids.org}`, null, as('alice@dev.local'))).body.org.name, 'dev');
    assert.equal((await h.api(null, 'GET', '/api/me', null, { ...as('alice@dev.local'), 'board-org': 'nope' })).status, 403);

    // The board in the URL decides which member acts.
    assert.equal((await h.api(null, 'GET', `/api/boards/${other.board.id}`, null, as('alice@dev.local'))).status, 200);
    assert.equal((await h.api(null, 'GET', `/api/boards/${h.ids.board}`, null, as('alice@dev.local'))).status, 200);
    const made = await h.api(null, 'POST', `/api/boards/${other.board.id}/cards`, { request_id: randomUUID(), title: 'in other' }, as('alice@dev.local'));
    assert.equal(made.status, 200);
    assert.equal(h.db.get('SELECT created_by FROM cards WHERE id = ?', made.body.card.id).created_by, other.member.id);
    // Bob is only in dev: one candidate, nothing ambiguous.
    assert.equal((await h.api(null, 'GET', '/api/me', null, as('bob@dev.local'))).status, 200);
    assert.equal((await h.api(null, 'GET', `/api/boards/${other.board.id}`, null, as('bob@dev.local'))).status, 404);

    // Browser socket: the subscribed board's org decides.
    const b = new FakeBrowser(h.base, '');
    await b.open(as('alice@dev.local'));
    const snap = await b.subscribe(other.board.id);
    assert.equal(snap.board.key_prefix, 'OTH');
    b.terminate();
  } finally { await h.destroy(); }
});

test('Access with the one-time PIN IdP: an email-only JWT (no GitHub identity) maps to members.email; members need no github_login', async () => {
  const { h, as } = await accessHub();
  try {
    const admin = as('alice@dev.local');
    const add = await h.api(null, 'POST', '/api/members', { request_id: randomUUID(), email: 'Pat@Example.com', role: 'member' }, admin);
    assert.equal(add.status, 200, add.text);
    assert.equal(add.body.member.github_login, null);
    assert.equal(add.body.member.display_name, 'Pat');
    assert.equal(add.body.member.avatar_url, null);
    // Cloudflare OTP token shape: email + identity_nonce/sub/type/country, no GitHub claims.
    const otp = as('pat@example.com', { type: 'app', identity_nonce: 'n0nce', sub: randomUUID(), country: 'ZA', iat: Math.floor(Date.now() / 1000) });
    const me = await h.api(null, 'GET', '/api/me', null, otp);
    assert.equal(me.status, 200);
    assert.equal(me.body.member.id, add.body.member.id);
    assert.equal(me.body.member.github_login, null);
    const snap = await h.api(null, 'GET', `/api/boards/${h.ids.board}`, null, otp);
    assert.ok(snap.body.members.some((m) => m.member_id === add.body.member.id && m.login === null));
    const card = await h.api(null, 'POST', `/api/boards/${h.ids.board}/cards`, { request_id: randomUUID(), title: 'from OTP' }, otp);
    assert.equal(card.status, 200);
    assert.equal((await h.api(null, 'POST', '/api/members', { request_id: randomUUID(), email: 'not-an-email', role: 'member' }, admin)).status, 400);
  } finally { await h.destroy(); }
});

test('removing a member closes their live board socket (4403), refuses them everywhere and revokes their devices', async () => {
  const h = await startHub();
  try {
    const alice = await h.login('alice');
    const bob = await h.login('bob');
    const bobBrowser = await h.browser(bob);
    const dev = await h.enroll(bob);
    const r = await h.runner(dev);
    const aliceBrowser = await h.browser(alice);
    const del = await h.api(alice, 'DELETE', `/api/members/${h.ids.bob}`, { request_id: randomUUID() });
    assert.equal(del.status, 200);
    assert.equal(await bobBrowser.closed(), 4403);
    assert.equal(await r.closed(), 4403);
    assert.equal(aliceBrowser.closeCode, null, 'others keep their socket');
    assert.equal((await h.api(bob, 'GET', '/api/me')).status, 401);
    // A socket opened with the old cookie is refused.
    const again = new FakeBrowser(h.base, bob);
    await again.open().catch(() => {});
    assert.equal(await again.closed(), 4401);
    const ws = new WebSocket(`${h.base.replace('http', 'ws')}/ws/runner`, { headers: { authorization: `Bearer ${dev.device_token}` } });
    assert.equal(await new Promise((res) => ws.on('close', (c) => res(c))), 4403);
    assert.equal((await h.api(alice, 'DELETE', `/api/members/${h.ids.alice}`, { request_id: randomUUID() })).status, 403, 'not yourself');
    assert.equal(h.hub.db.get('SELECT removed_at FROM members WHERE id = ?', h.ids.bob).removed_at != null, true);
  } finally { await h.destroy(); }
});

test('a subscribe re-checks membership; a removed member gets nothing', async () => {
  const h = await startHub();
  try {
    const bob = await h.login('bob');
    const b = new FakeBrowser(h.base, bob);
    await b.open();
    b.send({ type: 'hello', protocol: 1 });
    await b.next('welcome');
    h.db.run('UPDATE members SET removed_at = ? WHERE id = ?', h.hub.iso(), h.ids.bob);   // removed without a notification
    b.send({ type: 'subscribe', board_id: h.ids.board });
    assert.equal(await b.closed(), 4403);
    assert.equal(b.all('snapshot').length, 0);
  } finally { await h.destroy(); }
});

test('Access: a long-lived board socket is closed when its Access session expires', async () => {
  const { h, as } = await accessHub();
  try {
    const exp = Math.floor(h.clock.wall() / 1000) + 60;
    const b = new FakeBrowser(h.base, '');
    await b.open(as('bob@dev.local', { exp }));
    await b.subscribe(h.ids.board);
    await h.tick(30_000);
    assert.equal(b.closeCode, null);
    await h.tick(31_000);
    assert.equal(await b.closed(), 4401);
  } finally { await h.destroy(); }
});

test('BOARD_BOOTSTRAP accepts an email-only owner', async () => {
  const { bootstrapAdmin } = await import('../seed.js');
  const h = await startHub();
  try {
    h.db.run('PRAGMA foreign_keys = OFF');
    for (const t of ['card_assignees', 'members']) h.db.run(`DELETE FROM ${t}`);
    assert.equal(bootstrapAdmin(h.hub, 'owner@example.com', 'Ops:OPS'), true);
    const m = h.db.get("SELECT * FROM members WHERE email = 'owner@example.com'");
    assert.equal(m.role, 'owner');
    assert.equal(m.display_name, 'owner');
    assert.throws(() => { h.db.run('DELETE FROM members'); bootstrapAdmin(h.hub, 'nope'); }, /BOARD_BOOTSTRAP must be/);
  } finally { await h.destroy(); }
});
