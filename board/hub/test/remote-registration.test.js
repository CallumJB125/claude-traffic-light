import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteRig } from './remote-helpers.js';

// Documented actual Codex CLI 0.159.2 DCR shape; all fixture values synthetic.
const codex = { client_name: 'Codex', redirect_uris: ['http://127.0.0.1:31337/callback'],
  grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  token_endpoint_auth_method: 'none', scope: 'boards:read boards:collaborate', application_type: 'native' };
async function register(f, body) {
  const res = await fetch(f.h.base + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
test('actual Codex-shaped native DCR metadata registers only a bounded unverified public client; no board authority', async t => {
  const f = await remoteRig(t), r = await register(f, codex);
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.application_type, 'native');
  assert.deepEqual(r.body.redirect_uris, codex.redirect_uris); assert.equal(r.body.token_endpoint_auth_method, 'none');
  assert.equal(r.body.client_secret, undefined); assert.equal(r.body.access_token, undefined);
  assert.equal(f.db.get('SELECT count(*) n FROM remote_clients').n, 1);
  assert.equal(f.db.get('SELECT count(*) n FROM remote_grants').n, 0);
  assert.equal(f.db.get('SELECT count(*) n FROM remote_tokens').n, 0);
  assert.throws(() => f.authority.authenticate(r.body.client_id, 'mcp'), e => e.code === 'UNAUTHENTICATED');
});
test('optional web metadata and omitted metadata preserve exact registered HTTPS redirects without granting access', async t => {
  const f = await remoteRig(t), { application_type, ...base } = codex;
  for (const extra of [{ application_type: 'web' }, {}]) {
    const r = await register(f, { ...base, redirect_uris: ['https://synthetic-client.test/oauth/callback'], ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.application_type, extra.application_type);
  }
  assert.equal(f.db.get('SELECT count(*) n FROM remote_grants').n, 0);
});
for (const value of [null, '', 'NATIVE', 'desktop', 'native ', {}, [], true, 42, 'n'.repeat(8192)]) {
  test(`DCR application_type refuses ${typeof value}:${String(value).slice(0,12)} with no client or authority`, async t => {
    const f = await remoteRig(t), r = await register(f, { ...codex, application_type: value });
    assert.equal(r.status, typeof value === 'string' && value.length === 8192 ? 413 : 400);
    assert.equal(f.db.get('SELECT count(*) n FROM remote_clients').n, 0);
    assert.equal(f.db.get('SELECT count(*) n FROM remote_grants').n, 0);
    assert.equal(f.db.get('SELECT count(*) n FROM remote_tokens').n, 0);
  });
}
test('native/web metadata cannot relax closed DCR fields or redirect validation', async t => {
  const f = await remoteRig(t);
  for (const body of [{ ...codex, application_type: 'native', trusted: true },
    { ...codex, application_type: 'web', redirect_uris: ['http://synthetic-client.test/callback'] },
    { ...codex, application_type: 'native', redirect_uris: ['file:///tmp/callback'] }]) {
    const r = await register(f, body); assert.equal(r.status, 400, JSON.stringify(r.body));
  }
  assert.equal(f.db.get('SELECT count(*) n FROM remote_clients').n, 0);
});
