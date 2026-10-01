import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { remoteRig, session, grant, oauth } from './remote-helpers.js';
import { redirect, registeredRedirect, strictJson, uniqueParams } from '../remote/validation.js';
const denied = error => ['UNAUTHENTICATED','FORBIDDEN','VALIDATION','NOT_FOUND','QUOTA_EXCEEDED'].includes(error.code);
const refresh = (f, x, token) => ({ grant_type: 'refresh_token', refresh_token: token, client_id: x.client.client_id, resource: f.authority.audience('mcp') });

test('personal grant requires current session plus one-use gesture and stores no bearer material', async t => {
  const f = await remoteRig(t), { authority: a, users, A, h, db } = f, identity = await session(f), member = h.hub.activeMember(A.member);
  assert.throws(() => a.gesture(member, { kind:'device',id:users.amember.device_id }, { purpose:'create' }), denied);
  const gesture = a.gesture(member, identity.cred, { purpose:'create' }), body = { gesture_id:gesture.gesture_id,name:'Synthetic API',board_ids:[A.board],mode:'collaborate',expires_days:2 };
  const made = a.create(member, identity.cred, body); assert.match(made.token, /^pfi_[A-Za-z0-9_-]{43}$/);
  assert.equal(a.authenticate(made.token).member.id, A.member); assert.equal(a.authenticate(made.token).boardIds.length,1);
  assert.equal(made.grant.application_verified,false); assert.equal(made.grant.kind,'integration');
  assert.throws(() => a.create(member, identity.cred, body),denied);
  for(const kind of ['mcp','invalid'])assert.throws(() => a.authenticate(made.token,kind),denied);
  for(const token of [users.amember.token, 'pfi_'+'A'.repeat(43), null])assert.throws(() => a.authenticate(token),denied);
  const data=JSON.stringify(['remote_grants','remote_tokens','remote_gestures'].map(table=>db.all(`SELECT * FROM ${table}`)));
  assert.equal(data.includes(made.token),false);assert.equal(data.includes(identity.cookie),false);assert.equal(data.includes(identity.csrf),false);
});

test('PKCE client redirect resource and expiry are checked before the atomic code claim',async t=>{
 const f=await remoteRig(t),x=await oauth(f),a=f.authority;
 assert.equal(x.target.searchParams.get('iss'),f.h.base);assert.equal(x.target.searchParams.get('state'),x.params.state);
 for(const delta of [{code_verifier:'z'.repeat(43)},{client_id:randomUUID()},{redirect_uri:x.body.redirect_uri.replace('31337','31338')},{resource:a.audience('integration')}]){
  assert.throws(()=>a.token({...x.body,...delta}),denied);assert.equal(f.db.get('SELECT consumed_at FROM remote_codes WHERE code_hash=?',createHash('sha256').update(x.code).digest('hex')).consumed_at,null);
 }
 const attempts=await Promise.allSettled(Array.from({length:8},()=>Promise.resolve().then(()=>a.token(x.body))));
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.db.get('SELECT count(*) n FROM remote_tokens').n,2);
 const tokens=attempts.find(r=>r.status==='fulfilled').value;assert.equal(tokens.expires_in,900);assert.equal(a.authenticate(tokens.access_token,'mcp').member.id,f.A.member);
 assert.throws(()=>a.authenticate(tokens.access_token,'integration'),denied);assert.throws(()=>a.authenticate(tokens.refresh_token,'mcp'),denied);
 const data=JSON.stringify(['remote_clients','remote_grants','remote_tokens','remote_intents','remote_codes'].map(table=>f.db.all(`SELECT * FROM ${table}`)));
 for(const material of [x.code,x.verifier,x.intent.browser,tokens.access_token,tokens.refresh_token])assert.equal(data.includes(material),false);
});

test('refresh rotation binds the original family; reuse revokes every previously minted access token',async t=>{
 const f=await remoteRig(t),x=await oauth(f),a=f.authority,first=a.token(x.body);
 for(const delta of [{client_id:randomUUID()},{resource:a.audience('integration')},{board_ids:[f.B.board]}])assert.throws(()=>a.token({...refresh(f,x,first.refresh_token),...delta}),denied);
 assert.equal(a.authenticate(first.access_token,'mcp').member.id,f.A.member);
 const second=a.token(refresh(f,x,first.refresh_token));assert.notEqual(second.refresh_token,first.refresh_token);
 assert.equal(a.authenticate(first.access_token,'mcp').grant.id,a.authenticate(second.access_token,'mcp').grant.id);
 assert.throws(()=>a.token(refresh(f,x,first.refresh_token)),denied);
 for(const token of [first.access_token,second.access_token])assert.throws(()=>a.authenticate(token,'mcp'),denied);
 assert.throws(()=>a.token(refresh(f,x,second.refresh_token)),denied);
 assert.ok(f.db.all('SELECT revoked_at FROM remote_tokens').every(row=>row.revoked_at));
});

test('concurrent refresh has one rotation result and one reuse revocation, never a second live family',async t=>{
 const f=await remoteRig(t),x=await oauth(f),a=f.authority,first=a.token(x.body);
 const results=await Promise.allSettled([1,2].map(()=>Promise.resolve().then(()=>a.token(refresh(f,x,first.refresh_token)))));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.throws(()=>a.authenticate(results.find(r=>r.status==='fulfilled').value.access_token,'mcp'),denied);
 assert.equal(f.db.get('SELECT count(*) n FROM remote_grants').n,1);
});

test('intent cannot transfer to another account/session and cancellation returns only the registered callback',async t=>{
 const f=await remoteRig(t),x=await oauth(f),a=f.authority,other=await session(f,f.users.aadmin);
 assert.throws(()=>a.preview(x.intent.intent_id,x.intent.browser,other),denied);assert.throws(()=>a.preview(x.intent.intent_id,'pfc_'+'A'.repeat(43)),denied);
 // A second unconsumed intent binds the previewing account and session.
 const next=a.authorize(x.params);a.preview(next.intent_id,next.browser,x.identity);
 assert.throws(()=>a.consent(f.h.hub.activeMember(f.A.admin),other.cred,next.intent_id,next.browser,{approve:true,board_ids:[f.A.board],mode:'collaborate'}),denied);
 const result=a.consent(f.h.hub.activeMember(f.A.member),x.identity.cred,next.intent_id,next.browser,{approve:false,board_ids:[],mode:'read'}),target=new URL(result.redirect_uri);
 assert.equal(target.origin,'http://127.0.0.1:31337');assert.equal(target.pathname,'/callback');assert.equal(target.searchParams.get('error'),'access_denied');assert.equal(target.searchParams.get('iss'),f.h.base);assert.equal(target.searchParams.has('code'),false);
 assert.throws(()=>a.consent(f.h.hub.activeMember(f.A.member),x.identity.cred,next.intent_id,next.browser,{approve:true,board_ids:[f.A.board],mode:'read'}),denied);
});

test('restore epochs invalidate grant tokens, codes and consent gestures while independent grants survive browser logout',async t=>{
 const f=await remoteRig(t),personal=await grant(f),x=await oauth(f),a=f.authority;
 f.db.run('UPDATE sessions SET revoked_at=? WHERE id=?',f.h.hub.iso(),personal.identity.cred.id);
 assert.equal(a.authenticate(personal.token).grant.id,personal.grant.id,'a separately granted capability survives ordinary source-session logout');
 const member=f.h.hub.activeMember(f.A.member),gesture=a.gesture(member,x.identity.cred,{purpose:'create'});
 f.db.setMeta('session_epoch',String(a.epoch()+1));
 assert.throws(()=>a.authenticate(personal.token),denied);assert.throws(()=>a.token(x.body),denied);assert.throws(()=>a.preview(x.intent.intent_id,x.intent.browser),denied);
 assert.throws(()=>a.create(member,x.identity.cred,{gesture_id:gesture.gesture_id,name:'No',board_ids:[f.A.board],mode:'read',expires_days:1}),denied);
 assert.equal(f.db.get('SELECT count(*) n FROM remote_tokens').n,1);
});

test('access expiry, refresh inactivity and absolute family expiry all deny issuance',async t=>{
 const f=await remoteRig(t),x=await oauth(f),a=f.authority,first=a.token(x.body);
 f.h.clock.advance(900001);assert.throws(()=>a.authenticate(first.access_token,'mcp'),denied);
 const second=a.token(refresh(f,x,first.refresh_token));assert.equal(a.authenticate(second.access_token,'mcp').member.id,f.A.member);
 f.h.clock.advance(7*86400000+1);assert.throws(()=>a.token(refresh(f,x,second.refresh_token)),denied);
 const another=await oauth(f),last=a.token(another.body);f.h.clock.advance(30*86400000+1);
 assert.throws(()=>a.token(refresh(f,another,last.refresh_token)),denied);
});

test('read-only scopes and current viewer downgrade cannot acquire writes or wider boards',async t=>{
 const f=await remoteRig(t),x=await oauth(f,{mode:'read',scope:'boards:read'}),tokens=f.authority.token(x.body);
 assert.throws(()=>f.authority.authenticate(tokens.access_token,'mcp',true),denied);
 const wide=await grant(f);f.db.run("UPDATE members SET role='viewer' WHERE id=?",f.A.member);
 assert.equal(f.authority.authenticate(wide.token).mode,'read');assert.throws(()=>f.authority.authenticate(wide.token,'integration',true),denied);
 assert.equal(f.actions.catalog(wide.token).length,6);
 assert.throws(()=>f.db.run("UPDATE remote_grants SET mode='collaborate' WHERE id=?",f.authority.authenticate(tokens.access_token,'mcp').grant.id));
 assert.throws(()=>f.db.run('UPDATE remote_grants SET board_ids=? WHERE id=?',JSON.stringify([f.A.board,f.B.board]),wide.grant.id));
});

test('redirect matching is exact except explicitly registered IPv4 loopback port substitution',()=>{
 assert.equal(registeredRedirect(['http://127.0.0.1:1/cb?a=1'],'http://127.0.0.1:45555/cb?a=1'),true);
 for(const uri of ['http://localhost:1/cb','http://[::1]:1/cb','http://private.test/cb','https://u:p@host.test/cb','https://host.test/cb#frag','https://host.test/cb\n'])assert.throws(()=>redirect(uri),denied);
 for(const uri of ['http://127.0.0.1:2/other?a=1','http://127.0.0.1:2/cb?a=2','https://host.test:444/cb'])assert.equal(registeredRedirect(['http://127.0.0.1:1/cb?a=1','https://host.test/cb'],uri),false);
});

test('closed registration and persistent quotas perform no arbitrary metadata fetch',async t=>{
 const f=await remoteRig(t,{remoteLimits:{registeredClients:3,registeredClientsPerIP:2}}),a=f.authority;
 assert.throws(()=>a.register({client_name:'No',redirect_uris:['https://private.test/cb'],logo_uri:'http://127.0.0.1/secret'}),denied);
 assert.throws(()=>a.register({client_name:'No',redirect_uris:['https://private.test/cb'],token_endpoint_auth_method:'client_secret_basic'}),denied);
 a.register({client_name:'One',redirect_uris:['https://public.test/cb']},{ip:'127.0.0.1'});a.register({client_name:'Two',redirect_uris:['https://public.test/cb']},{ip:'127.0.0.1'});
 assert.throws(()=>a.register({client_name:'Three',redirect_uris:['https://public.test/cb']},{ip:'127.0.0.1'}),denied);
 a.register({client_name:'Three',redirect_uris:['https://public.test/cb']},{ip:'127.0.0.2'});
 assert.throws(()=>a.register({client_name:'Four',redirect_uris:['https://public.test/cb']},{ip:'127.0.0.3'}),denied);
 assert.equal(f.db.get('SELECT count(*) n FROM remote_clients').n,3);
});

test('duplicate security inputs are rejected before parsing erases ambiguity',()=>{
 for(const text of ['{"a":1,"a":2}','{"object":{"a":1,"\\u0061":2}}','{"token":1,"token":2}','{"a":'+ '['.repeat(17)+'0'+']'.repeat(17)+'}'])assert.throws(()=>strictJson(text),denied);
 assert.deepEqual(strictJson('{"a":[{"x":1},{"x":2}]}'),{a:[{x:1},{x:2}]});
 assert.throws(()=>uniqueParams(new URLSearchParams('resource=one&resource=two'),['resource']),denied);
 assert.throws(()=>uniqueParams(new URLSearchParams('token=secret'),['resource']),denied);
});
