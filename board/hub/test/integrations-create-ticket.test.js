// Create ticket from a session (Wave 2 lane 6): the linear, jira and fake
// connectors' createIssue against fakes, and POST /api/integrations/:id/issues
// (auth, team, viewer, rate limit, fixed provider error, audit codes only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import linear, { createLinearIssue } from '../integrations/linear/index.js';
import jira, { createJiraIssue } from '../integrations/jira/index.js';
import { startHub } from './helpers.js';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });
const TEAM_ID = '11111111-2222-4333-8444-555555555555';
const CLOUD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const LIN_KEY = `lin_api_${'a'.repeat(40)}`;

test('linear: verifyToken takes the secret alone, or secret + API key + team key; nothing else', async () => {
  const one = await linear.connect.verifyToken({ token: 'x'.repeat(32) });
  assert.deepEqual(Object.keys(one.secrets), ['webhook_secret']);
  assert.equal(one.settings, undefined);
  const three = await linear.connect.verifyToken({ token: `${'x'.repeat(32)} ${LIN_KEY} ENG` });
  assert.deepEqual(three.secrets, { webhook_secret: 'x'.repeat(32), api_key: LIN_KEY });
  assert.deepEqual(three.settings, { team_key: 'ENG' });
  assert.equal(three.external_id, one.external_id);
  await assert.rejects(linear.connect.verifyToken({ token: `${'x'.repeat(32)} nope ENG` }));
  await assert.rejects(linear.connect.verifyToken({ token: `${'x'.repeat(32)} ${LIN_KEY}` }));
});

test('linear: createIssue resolves the team, creates the issue and returns a checked link', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    if (calls.length === 1) return json(200, { data: { teams: { nodes: [{ id: TEAM_ID }] } } });
    return json(200, { data: { issueCreate: { success: true, issue: { identifier: 'ENG-42', url: 'https://linear.app/acme/issue/ENG-42/fix-it' } } } });
  };
  const out = await createLinearIssue({ title: 'Fix it', description: 'Body', secrets: { api_key: LIN_KEY }, provider: { team_key: 'ENG' }, fetch });
  assert.deepEqual(out, { key: 'ENG-42', url: 'https://linear.app/acme/issue/ENG-42' });
  assert.equal(calls[0].url, 'https://api.linear.app/graphql');
  assert.equal(calls[0].auth, LIN_KEY);
  assert.deepEqual(calls[1].body.variables.input, { teamId: TEAM_ID, title: 'Fix it', description: 'Body' });
  await assert.rejects(createLinearIssue({ title: 't', description: '', secrets: {}, provider: { team_key: 'ENG' }, fetch }), (e) => e.code === 'not_configured');
  await assert.rejects(createLinearIssue({ title: 't', description: '', secrets: { api_key: LIN_KEY }, provider: { team_key: 'ENG' }, fetch: async () => json(401, {}) }), (e) => e.code === 'provider_auth');
  await assert.rejects(createLinearIssue({ title: 't', description: '', secrets: { api_key: LIN_KEY }, provider: { team_key: 'ENG' }, fetch: async () => json(200, { errors: [{ message: 'secret detail' }] }) }), (e) => e.code === 'provider_error' && !/secret detail/.test(e.message));
});

test('jira: verifyToken six parts; createIssue posts a Task through api.atlassian.com', async () => {
  const tok = `${'s'.repeat(20)} me@acme.com ${'t'.repeat(24)} ${CLOUD} ENG acme.atlassian.net`;
  const v = await jira.connect.verifyToken({ token: tok });
  assert.deepEqual(v.settings, { cloud_id: CLOUD, project_key: 'ENG', site: 'acme.atlassian.net' });
  assert.deepEqual(Object.keys(v.secrets).sort(), ['api_email', 'api_token', 'webhook_secret']);
  await assert.rejects(jira.connect.verifyToken({ token: `${'s'.repeat(20)} me@acme.com` }));
  let seen;
  const fetch = async (url, init) => { seen = { url, init }; return json(201, { id: '10001', key: 'ENG-7', self: 'x' }); };
  const out = await createJiraIssue({ title: 'T', description: 'a\nb', secrets: v.secrets, provider: v.settings, fetch });
  assert.deepEqual(out, { key: 'ENG-7', url: 'https://acme.atlassian.net/browse/ENG-7' });
  assert.equal(seen.url, `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue`);
  const body = JSON.parse(seen.init.body);
  assert.equal(body.fields.summary, 'T');
  assert.equal(body.fields.description.content.length, 2);
  assert.match(seen.init.headers.authorization, /^Basic /);
});

async function setup(fetchImpl) {
  const h = await startHub({ fetchImpl, log: { debug() {}, info() {}, warn: (...a) => process.env.DBG && console.log("W", ...a), error: (...a) => process.env.DBG && console.log("E", ...a), child() { return this; } } });
  h.hub.setVaultKey(randomBytes(32));
  const alice = await h.login('alice');
  const bob = await h.login('bob');
  const roles = Object.fromEntries(h.db.all('SELECT id, role FROM members').map((m) => [m.id, m.role]));
  const [admin, other] = roles[h.ids.alice] === 'member' ? [bob, alice] : [alice, bob];
  const ok = await h.api(admin, 'POST', '/api/integrations/fake/token', { request_id: randomUUID(), token: 'fake_abcdef123456' });
  assert.equal(ok.status, 200);
  return { h, admin, other, conn: ok.body.connection };
}

test('HTTP: a member creates an issue with exactly the approved text; the audit keeps the key only', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: init.body }); return json(201, { key: 'FAKE-9' }); };
  const { h, other, conn } = await setup(fetchImpl);
  try {
    const list = await h.api(other, 'GET', '/api/integrations');
    assert.equal(list.body.connections.find((c) => c.id === conn.id).creates_issues, true);
    const r = await h.api(other, 'POST', `/api/integrations/${conn.id}/issues`, { request_id: randomUUID(), title: 'Approved title', description: 'Approved body' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.issue, { key: 'FAKE-9', url: 'https://fake.example/issue/FAKE-9' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://api.fake.example/issues');
    assert.deepEqual(JSON.parse(sent[0].body), { title: 'Approved title', description: 'Approved body' });
    const audit = h.db.all("SELECT * FROM integration_audit WHERE action = 'issue.create'");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].external_ref, 'FAKE-9');
    assert.ok(!JSON.stringify(audit).includes('Approved'));
    assert.equal((await h.api(other, 'POST', `/api/integrations/${conn.id}/issues`, { request_id: randomUUID(), title: '' })).status, 400);
    assert.equal((await h.api(other, 'POST', `/api/integrations/${randomUUID()}/issues`, { request_id: randomUUID(), title: 't' })).status, 404);
  } finally { await h.close(); }
});

test('HTTP: a provider failure is fixed text and an audit code; the rate limit holds at 10 an hour', async () => {
  let fail = true;
  const fetchImpl = async () => (fail ? json(500, { detail: 'internal provider text' }) : json(201, { key: 'FAKE-1' }));
  const { h, other, conn } = await setup(fetchImpl);
  try {
    const r = await h.api(other, 'POST', `/api/integrations/${conn.id}/issues`, { request_id: randomUUID(), title: 't' });
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.ok(!JSON.stringify(r.body).includes('internal provider text'));
    assert.equal(h.db.get("SELECT decision FROM integration_audit WHERE action = 'issue.create'").decision, 'failed');
    fail = false;
    let last;
    for (let i = 0; i < 10; i += 1) last = await h.api(other, 'POST', `/api/integrations/${conn.id}/issues`, { request_id: randomUUID(), title: `t${i}` });
    assert.equal(last.status, 429);
  } finally { await h.close(); }
});
