import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { remoteRig, session, oauth, spareBoard, grant } from './remote-helpers.js';
import { PROTOCOLS } from '../remote/transport.js';
async function request(f, path, identity, body, method = body ? 'POST' : 'GET') {
  const res = await fetch(f.h.base + path, { method, headers: { cookie: identity.cookie,
    ...(body ? { origin: f.h.base, 'x-csrf-token': identity.csrf, 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
for (const dimension of ['session-revoked', 'session-owner', 'both-owner', 'role-demoted', 'board-archived', 'grant-narrowed', 'grant-revoked', 'epoch']) {
  test(`final management create response withholds token after ${dimension}; does not pretend committed effects rolled back`, async t => {
    const f = await remoteRig(t), identity = await session(f), path = `/api/teams/${f.A.team}/remote-grants`, spare = dimension === 'grant-narrowed' ? await spareBoard(f) : null;
    const gesture = await request(f, path + '/gesture', identity, { purpose: 'create' }); assert.equal(gesture.status, 200);
    const original = f.authority.create.bind(f.authority); let committed;
    f.authority.create = (...args) => {
      const result = original(...args); committed = result;
      queueMicrotask(() => {
        if (dimension === 'session-revoked') f.db.run('UPDATE sessions SET revoked_at=? WHERE id=?', f.h.hub.iso(), identity.cred.id);
        if (['session-owner', 'both-owner'].includes(dimension)) f.db.run('UPDATE sessions SET user_id=? WHERE id=?', f.users.n.id, identity.cred.id);
        if (dimension === 'both-owner') f.db.run('UPDATE members SET user_id=? WHERE id=?', f.users.n.id, f.A.member);
        if (dimension === 'role-demoted') f.db.run("UPDATE members SET role='viewer' WHERE id=?", f.A.member);
        if (dimension === 'board-archived') f.db.run('UPDATE boards SET archived_at=? WHERE id=?', f.h.hub.iso(), f.A.board);
        if (dimension === 'grant-narrowed') f.db.run('UPDATE remote_grants SET board_ids=? WHERE id=?', JSON.stringify([spare]), result.grant.id);
        if (dimension === 'grant-revoked') f.authority.revokeFamily(result.grant.id);
        if (dimension === 'epoch') f.db.setMeta('session_epoch', String(f.authority.epoch() + 1));
      }); return result;
    };
    const r = await request(f, path, identity, { gesture_id: gesture.data.gesture_id, name: 'Unverified response-bound app',
      board_ids: spare ? [f.A.board, spare] : [f.A.board], mode: 'collaborate', expires_days: 1 });
    assert.ok([401,403,404,409].includes(r.status), JSON.stringify(r)); assert.equal(r.data.token, undefined); assert.equal(r.data.grant, undefined);
    assert.equal(JSON.stringify(r.data).includes(committed.token), false);
    assert.equal(f.db.get('SELECT count(*) n FROM remote_grants WHERE id=?', committed.grant.id).n, 1, 'earlier transaction already committed');
    assert.equal(f.db.get('SELECT count(*) n FROM remote_tokens WHERE grant_id=?', committed.grant.id).n, 1);
    assert.ok(f.db.get('SELECT consumed_at FROM remote_gestures WHERE id=?', gesture.data.gesture_id).consumed_at);
  });
}
for (const operation of ['list', 'gesture', 'revoke']) test(`final management ${operation} response withholds data after captured SESSION revocation`, async t => {
  const f = await remoteRig(t), g = operation === 'revoke' ? await grant(f) : null, identity = g?.identity ?? await session(f), path = `/api/teams/${f.A.team}/remote-grants`;
  let body, target=path, method='GET';
  if (operation === 'gesture') { body={purpose:'create'}; target+='/gesture'; method='POST'; }
  if (operation === 'revoke') {
    const gesture=await request(f,path+'/gesture',identity,{purpose:'revoke'});assert.equal(gesture.status,200);
    body={gesture_id:gesture.data.gesture_id};target+='/'+g.grant.id;method='DELETE';
  }
  const original=f.authority[operation].bind(f.authority);
  f.authority[operation]=(...args)=>{const result=original(...args);queueMicrotask(()=>f.db.run('UPDATE sessions SET revoked_at=? WHERE id=?',f.h.hub.iso(),identity.cred.id));return result;};
  const r=await request(f,target,identity,body,method);assert.equal(r.status,401);assert.equal(r.data.grants,undefined);assert.equal(r.data.gesture_id,undefined);assert.equal(r.data.ok,undefined);
});
test('final list reprojects changed selected scope/revocation metadata rather than delivering its earlier read', async t => {
  const f=await remoteRig(t),spare=await spareBoard(f),g=await grant(f,{boardIds:[f.A.board,spare]}),original=f.authority.list.bind(f.authority);let first=true;
  f.authority.list=(...args)=>{const result=original(...args);if(first){first=false;queueMicrotask(()=>{f.db.run('UPDATE remote_grants SET board_ids=? WHERE id=?',JSON.stringify([spare]),g.grant.id);f.authority.revokeFamily(g.grant.id);});}return result;};
  const r=await request(f,`/api/teams/${f.A.team}/remote-grants`,g.identity);assert.equal(r.status,200);assert.deepEqual(r.data.grants[0].board_ids,[spare]);assert.ok(r.data.grants[0].revoked_at);assert.equal(JSON.stringify(r.data).includes(g.token),false);
});
test('unchanged viewer SESSION can create and read an explicit read-only grant without private identity headers', async t => {
  const f=await remoteRig(t);f.db.run("UPDATE members SET role='viewer' WHERE id=?",f.A.member);const identity=await session(f),path=`/api/teams/${f.A.team}/remote-grants`;
  const gesture=await request(f,path+'/gesture',identity,{purpose:'create'});assert.equal(gesture.status,200);
  const r=await request(f,path,identity,{gesture_id:gesture.data.gesture_id,name:'Explicit viewer read app',board_ids:[f.A.board],mode:'read',expires_days:1});assert.equal(r.status,200);assert.equal(f.authority.authenticate(r.data.token).mode,'read');
  const list=await request(f,path,identity);assert.equal(list.status,200);assert.equal(list.data.grants[0].id,r.data.grant.id);
});
test('initialize body version must be Streamable HTTP supported even without the protocol header; every advertised HTTP version works', async t => {
  const f=await remoteRig(t),q=await oauth(f),token=f.authority.token(q.body).access_token;
  for(const version of ['2024-11-05','1900-01-01',null,...PROTOCOLS]){
    const res=await fetch(f.h.base+'/api/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'initialize',params:{protocolVersion:version,capabilities:{},clientInfo:{name:'Synthetic version fixture',version:'1'}}})});
    assert.equal(res.status,PROTOCOLS.includes(version)?200:400);if(res.status===200)assert.equal((await res.json()).result.protocolVersion,version);
  }
});
