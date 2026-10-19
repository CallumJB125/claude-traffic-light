import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { tenancy } from './tenancy/fixture.js';
import { until } from './helpers.js';
import { RemoteActions } from '../remote/actions.js';
export async function remoteRig(t, config = {}) {
  const f = await tenancy({ config }); t.after(() => f.h.close());
  f.h.hub.config.publicUrl = f.h.base;
  f.authority = f.h.hub.remoteAuthority; f.actions = new RemoteActions(f.h.hub);
  return f;
}
export async function session(f, user = f.users.amember) {
  const result = await f.h.webSignIn(user.email); assert.equal(result.res.status, 200, result.res.text);
  const cred = { kind: 'session', id: f.db.get('SELECT id FROM sessions WHERE user_id = ? ORDER BY rowid DESC LIMIT 1', user.id).id };
  return { user: f.h.hub.accounts.liveUser(user.id), cred, cookie: result.cookie, csrf: result.csrf };
}
export async function grant(f, { user = f.users.amember, memberId = f.A.member, boardIds = [f.A.board], mode = 'collaborate', name = 'Synthetic unverified client', expires_days = 30 } = {}) {
  const identity = await session(f, user), member = f.h.hub.activeMember(memberId);
  const gesture = f.authority.gesture(member, identity.cred, { purpose: 'create' });
  const result = f.authority.create(member, identity.cred, { gesture_id: gesture.gesture_id, name, board_ids: boardIds, mode, expires_days });
  return { ...result, identity, member };
}
export async function oauth(f, { user = f.users.amember, memberId = f.A.member, boardIds = [f.A.board], mode = 'collaborate', redirect = 'http://127.0.0.1:31337/callback?fixed=1', scope = 'boards:read boards:collaborate' } = {}) {
  const identity = await session(f, user), client = f.authority.register({ client_name: 'Unverified synthetic OAuth app', redirect_uris: [redirect] });
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = { client_id: client.client_id, redirect_uri: redirect, response_type: 'code', state: randomUUID(),
    resource: f.authority.audience('mcp'), code_challenge: challenge, code_challenge_method: 'S256', scope };
  const intent = f.authority.authorize(params); f.authority.preview(intent.intent_id, intent.browser, identity);
  const approved = f.authority.consent(f.h.hub.activeMember(memberId), identity.cred, intent.intent_id, intent.browser, { approve: true, board_ids: boardIds, mode });
  const target = new URL(approved.redirect_uri), code = target.searchParams.get('code');
  const body = { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: params.resource };
  return { identity, client, intent, params, code, verifier, body, target };
}
export const business = f => JSON.stringify(['cards','comments','journal','dispatches','task_packets','task_message_threads','task_messages','task_message_recipients','task_message_receipts','remote_actions'].map(table => f.db.all(`SELECT * FROM ${table} ORDER BY rowid`)));
export async function queued(f, key, call, change) {
  const original = f.h.hub.withBoard.bind(f.h.hub); let release, entered = false;
  const held = original(key, () => new Promise(resolve => { release = resolve; })); await new Promise(resolve => setImmediate(resolve));
  f.h.hub.withBoard = (id, fn) => { if (id === key) entered = true; return original(id, fn); };
  try {
    const pending = call().then(result => ({ result }), error => ({ error })); await until(() => entered);
    change(); const before = business(f); release(); await held;
    return { ...await pending, before, after: business(f) };
  } finally { release?.(); await held; f.h.hub.withBoard = original; }
}
export function refused(check) {
  assert.ok(check.error && ['UNAUTHENTICATED','FORBIDDEN','NOT_FOUND','CONFLICT'].includes(check.error.code), `authority refusal required: ${check.error?.code}`);
  assert.equal(check.after, check.before, 'no mutation, audit or replay side effect');
}
export async function spareBoard(f) {
  const result = await f.as(f.users.ua, 'POST', '/api/boards', { name: 'Other explicitly selected board' });
  assert.equal(result.status, 200, result.text);
  f.db.run('INSERT INTO board_repos(board_id,repo_id) VALUES(?,?)', result.body.board.id, f.A.repo);
  return result.body.board.id;
}
