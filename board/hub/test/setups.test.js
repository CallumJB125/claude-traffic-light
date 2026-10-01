import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {tenancy} from './tenancy/fixture.js';
import {validatePayload,canonical,SETUP_LIMITS} from '../../shared/setups.js';
import {createVault} from '../vault.js';
import {Setups} from '../setups.js';
const content='[alias]\n st = status\n[user]\n name = {{NAME}}\n email = {{EMAIL}}\n';
const payload=()=>({schema:1,files:[{id:randomUUID(),source_id:'git',relative_path:'.gitconfig',format:'gitconfig',content,note:''}],items:[],note:'Reviewed team setup'});
const body=(p=payload(),expected=null)=>{const c=validatePayload(p);return {request_id:randomUUID(),expected_version_id:expected,payload:p,review:{schema:1,approved:true,content_hash:c.content_hash,file_hashes:c.file_hashes}};};
async function fixture(t){const fx=await tenancy();t.after(()=>fx.h.close());const call=fx.as;fx.as=(u,method,path,body,headers={})=>call(u,method,path,body,{'x-plexiform-account':u.id,'x-plexiform-member':fx.db.get('SELECT id FROM members WHERE user_id=? AND org_id=? AND removed_at IS NULL',u.id,fx.A.team)?.id??'missing',...headers});return fx;}
const path=fx=>`/api/teams/${fx.A.team}/setups`;
async function publish(fx,b=body(),user=fx.users.ua){const r=await fx.as(user,'POST',path(fx),b);assert.equal(r.status,200,r.text);return r.body;}
const until=async fn=>{for(let n=0;n<100&&!fn();n++)await new Promise(resolve=>setImmediate(resolve));assert.ok(fn(),'request reached actual held queue');};

test('encrypted immutable publish/read, bound replay and restart keep one exact version without general content rows',async t=>{
  const fx=await fixture(t),b=body(),first=await publish(fx,b);
  const row=fx.db.get('SELECT * FROM setup_versions');assert.notEqual(Buffer.from(row.ciphertext).toString(),canonical(b.payload));assert.equal(Buffer.from(row.nonce).length,12);
  const replay=await publish(fx,JSON.parse(JSON.stringify(b)));assert.equal(replay.replayed,true);assert.equal(replay.version.id,first.version.id);assert.equal(fx.db.get('SELECT COUNT(*) n FROM setup_versions').n,1);
  const other={...b,payload:{...b.payload,note:'Changed'}};const c=validatePayload(other.payload);other.review={schema:1,approved:true,content_hash:c.content_hash,file_hashes:c.file_hashes};assert.equal((await fx.as(fx.users.ua,'POST',path(fx),other)).status,409);
  const restarted=new Setups(fx.h.app.api);const member=fx.h.hub.member(fx.A.owner),cred={kind:'device',id:fx.users.ua.device_id};
  const read=restarted.read(member,first.profile.id,first.version.id,cred);assert.deepEqual(read.payload,validatePayload(b.payload).payload);
  assert.ok(!JSON.stringify(fx.db.all('SELECT * FROM journal')).includes('Reviewed team setup'));
  assert.ok(!JSON.stringify([...fx.h.hub.requestCache.values()]).includes('Reviewed team setup'));
  assert.throws(()=>fx.db.run('UPDATE setup_versions SET content_hash=? WHERE id=?','b'.repeat(64),row.id),/immutable/);
});
test('staff viewers read; guests, foreign staff and stale owner devices cannot read or publish',async t=>{
  const fx=await fixture(t),p=await publish(fx),endpoint=`/api/setup-profiles/${p.profile.id}`;
  assert.equal((await fx.as(fx.users.aviewer,'GET',endpoint)).status,200);
  assert.equal((await fx.as(fx.users.aviewer,'POST',path(fx),body())).status,403);
  for(const u of [fx.users.ub,fx.users.n,fx.users.bguest]) assert.equal((await fx.as(u,'GET',endpoint)).status,404);
  fx.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',fx.h.hub.iso(),fx.users.ua.device_id);
  assert.equal((await fx.as(fx.users.ua,'GET',endpoint)).status,401);
});
test('captured credential owner cannot be rebound during an actual held publish or reply',async t=>{
  const fx=await fixture(t),b=body();let release;fx.h.hub.setups.queues.set(fx.A.team,new Promise(resolve=>release=resolve));
  const pending=fx.as(fx.users.ua,'POST',path(fx),b);await until(()=>fx.h.hub.setups.waiting===1);
  fx.db.run('UPDATE user_devices SET user_id=? WHERE id=?',fx.users.amember.id,fx.users.ua.device_id);release();
  assert.equal((await pending).status,401);assert.equal(fx.db.get('SELECT COUNT(*) n FROM setup_versions').n,0);
});
for(const boundary of ['member','role','device','team','account']) test(`actual queued publish rechecks ${boundary} authority before writing`,async t=>{
  const fx=await fixture(t);let release;fx.h.hub.setups.queues.set(fx.A.team,new Promise(resolve=>release=resolve));
  const pending=fx.as(fx.users.amember,'POST',path(fx),body());await until(()=>fx.h.hub.setups.waiting===1);
  if(boundary==='member')fx.db.run('UPDATE members SET removed_at=? WHERE id=?',fx.h.hub.iso(),fx.A.member);
  if(boundary==='role')fx.db.run("UPDATE members SET role='viewer' WHERE id=?",fx.A.member);
  if(boundary==='device')fx.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',fx.h.hub.iso(),fx.users.amember.device_id);
  if(boundary==='team')fx.db.run('UPDATE orgs SET deleted_at=? WHERE id=?',fx.h.hub.iso(),fx.A.team);
  if(boundary==='account')fx.db.run('UPDATE users SET deleted_at=? WHERE id=?',fx.h.hub.iso(),fx.users.amember.id);
  release();assert.ok((await pending).status>=400);assert.equal(fx.db.get('SELECT COUNT(*) n FROM setup_versions').n,0);
});
test('post-await read response rechecks captured owner and blocks plaintext after identity changes',async t=>{
  const fx=await fixture(t),p=await publish(fx),setups=fx.h.hub.setups,original=setups.read.bind(setups);
  setups.read=(...args)=>{const out=original(...args);queueMicrotask(()=>fx.db.run('UPDATE user_devices SET user_id=? WHERE id=?',fx.users.amember.id,fx.users.ua.device_id));return out;};
  const result=await fx.as(fx.users.ua,'GET',`/api/setup-profiles/${p.profile.id}`);assert.equal(result.status,401);assert.ok(!result.text.includes(content));
});
test('baseline and receipts select exact retained entries, are reminder/client reports, and retry once',async t=>{
  const fx=await fixture(t),p=await publish(fx),selected=[p.payload.files[0].id];
  const b={request_id:randomUUID(),profile_id:p.profile.id,version_id:p.version.id,selection:selected,required:true};
  assert.equal((await fx.as(fx.users.amember,'PUT',`/api/teams/${fx.A.team}/setup-baseline`,b)).status,403);
  const result=await fx.as(fx.users.aadmin,'PUT',`/api/teams/${fx.A.team}/setup-baseline`,b);assert.equal(result.status,200,result.text);assert.equal(result.body.baseline.meaning,'reminder_only');
  const receipt={request_id:randomUUID(),version_id:p.version.id,selection:selected,outcome:'reviewed'};
  const r=await fx.as(fx.users.aviewer,'POST',`/api/setup-profiles/${p.profile.id}/borrow-receipts`,receipt);assert.equal(r.status,200,r.text);assert.equal(r.body.client_reported,true);
  assert.equal((await fx.as(fx.users.aviewer,'POST',`/api/setup-profiles/${p.profile.id}/borrow-receipts`,receipt)).body.replayed,true);assert.equal(fx.db.get('SELECT COUNT(*) n FROM setup_receipts').n,1);
  assert.equal((await fx.as(fx.users.amember,'GET',`/api/setup-profiles/${p.profile.id}/activity`)).status,403);
  assert.equal((await fx.as(fx.users.aadmin,'GET',`/api/setup-profiles/${p.profile.id}/activity`)).status,200);
  assert.equal((await fx.as(fx.users.aadmin,'PUT',`/api/teams/${fx.A.team}/setup-baseline`,{...b,request_id:randomUUID(),selection:[randomUUID()]})).status,400);
});
for(const boundary of ['unpublish','member','account','team']) test(`${boundary} deletes sealed bytes, baseline and receipts; old retries never restore sharing`,async t=>{
  const fx=await fixture(t),b=body(),p=await publish(fx,b),rid={request_id:randomUUID(),expected_version_id:p.version.id};
  await fx.as(fx.users.aadmin,'PUT',`/api/teams/${fx.A.team}/setup-baseline`,{request_id:randomUUID(),profile_id:p.profile.id,version_id:p.version.id,selection:[p.payload.files[0].id],required:true});
  await fx.as(fx.users.amember,'POST',`/api/setup-profiles/${p.profile.id}/borrow-receipts`,{request_id:randomUUID(),version_id:p.version.id,selection:[p.payload.files[0].id],outcome:'reviewed'});
  if(boundary==='unpublish')assert.equal((await fx.as(fx.users.ua,'DELETE',`/api/setup-profiles/${p.profile.id}`,rid)).status,200);
  if(boundary==='member'){fx.db.run("UPDATE members SET role='owner' WHERE id=?",fx.A.admin);fx.db.run('UPDATE members SET removed_at=? WHERE id=?',fx.h.hub.iso(),fx.A.owner);}
  if(boundary==='account')fx.db.run('UPDATE users SET deleted_at=? WHERE id=?',fx.h.hub.iso(),fx.users.ua.id);
  if(boundary==='team')fx.db.run('UPDATE orgs SET deleted_at=? WHERE id=?',fx.h.hub.iso(),fx.A.team);
  for(const table of ['setup_versions','setup_baselines','setup_receipts'])assert.equal(fx.db.get(`SELECT COUNT(*) n FROM ${table}`).n,0,table);
  assert.ok((await fx.as(fx.users.ua,'POST',path(fx),b)).status>=400);
  if(boundary==='member'){fx.db.run('UPDATE members SET removed_at=NULL WHERE id=?',fx.A.owner);assert.equal((await fx.as(fx.users.ua,'GET',path(fx))).body.profiles.length,0);assert.equal((await fx.as(fx.users.ua,'POST',path(fx),b)).status,409);}
});
test('unpublish retry cannot remove a newly shared version; stale versions and cross-owner export fail',async t=>{
  const fx=await fixture(t),first=await publish(fx),remove={request_id:randomUUID(),expected_version_id:first.version.id};
  assert.equal((await fx.as(fx.users.amember,'GET',`/api/setup-profiles/${first.profile.id}/export`)).status,403);
  assert.equal((await fx.as(fx.users.ua,'DELETE',`/api/setup-profiles/${first.profile.id}`,remove)).status,200);
  const next=await publish(fx);assert.equal(next.version.number,2);
  assert.equal((await fx.as(fx.users.ua,'DELETE',`/api/setup-profiles/${first.profile.id}`,remove)).status,409);
  assert.equal((await fx.as(fx.users.ua,'GET',`/api/setup-profiles/${first.profile.id}/versions/${first.version.id}`)).status,404);
  assert.equal((await fx.as(fx.users.ua,'GET',`/api/setup-profiles/${next.profile.id}/export`)).status,200);
});
test('metadata-bound AEAD denies swapped ciphertext and wrong keys, rotation is bounded and survives previous key removal',async t=>{
  const fx=await fixture(t),p=await publish(fx),old=fx.h.hub.vaultKey,newKey=randomBytes(32),setups=fx.h.hub.setups;
  const row=fx.db.get('SELECT * FROM setup_versions');fx.db.run('UPDATE setup_versions SET nonce=? WHERE id=?',randomBytes(12),row.id);assert.equal((await fx.as(fx.users.ua,'GET',`/api/setup-profiles/${p.profile.id}`)).status,403);
  fx.db.run('UPDATE setup_versions SET nonce=? WHERE id=?',row.nonce,row.id);fx.h.hub.vaultKey=newKey;fx.h.hub.vaultPrevKey=old;fx.h.hub._vaultFor=null;
  assert.deepEqual(setups.resealBatch(1),{resealed:1,unopened:0,remaining:0});fx.h.hub.vaultPrevKey=null;fx.h.hub._vault=createVault(newKey);fx.h.hub._vaultFor=newKey;
  assert.equal((await fx.as(fx.users.ua,'GET',`/api/setup-profiles/${p.profile.id}`)).status,200);assert.throws(()=>setups.resealBatch(101));
});
test('retained version cap and keyless empty state fail conservatively',async t=>{
  const fx=await fixture(t),p=await publish(fx);
  const row=fx.db.get('SELECT * FROM setup_versions');for(let number=2;number<=SETUP_LIMITS.versions;number++)fx.db.insert('setup_versions',{...row,id:randomUUID(),number});
  assert.equal((await fx.as(fx.users.ua,'POST',path(fx),body(payload(),p.version.id))).status,403);
  fx.h.hub.vaultKey=null;fx.h.hub._vaultFor=undefined;
  const result=await fx.as(fx.users.ua,'GET',path(fx));assert.equal(result.status,200,result.text);assert.equal(result.body.status,'unavailable');assert.deepEqual(result.body.profiles,[]);
});
test('four actual held uploads bound body/queue memory; a fifth is refused before parsing',async t=>{
  const fx=await fixture(t);let release;fx.h.hub.setups.queues.set(fx.A.team,new Promise(resolve=>release=resolve));
  const pending=Array.from({length:4},()=>fx.as(fx.users.ua,'POST',path(fx),body()));await until(()=>fx.h.hub.setups.waiting===4);
  const fifth=await fx.as(fx.users.ua,'POST',path(fx),body());assert.equal(fifth.status,429,fifth.text);release();const completed=await Promise.all(pending);assert.equal(completed.filter(r=>r.status===200).length,1);assert.equal(completed.filter(r=>r.status===409).length,3);assert.equal(fx.db.get('SELECT COUNT(*) n FROM setup_versions').n,1);
});
test('browser cookie publishes require exact origin and CSRF, and a queued revoked session cannot replay content',async t=>{
  const fx=await fixture(t),web=await fx.h.webSignIn(fx.users.ua.email),b=body();
  const call=(body,headers={})=>fx.h.call('POST',path(fx),{cookie:web.cookie,body,headers:{origin:fx.h.base,'x-plexiform-account':fx.users.ua.id,'x-plexiform-member':fx.A.owner,...headers}});
  assert.equal((await call(b)).status,403);const first=await call(b,{'x-csrf-token':web.csrf});assert.equal(first.status,200,first.text);
  let release;fx.h.hub.setups.queues.set(fx.A.team,new Promise(resolve=>release=resolve));const pending=call(b,{'x-csrf-token':web.csrf});await until(()=>fx.h.hub.setups.waiting===1);
  fx.db.run('UPDATE sessions SET revoked_at=? WHERE user_id=?',fx.h.hub.iso(),fx.users.ua.id);release();const retry=await pending;assert.equal(retry.status,401);assert.ok(!retry.text.includes('Reviewed team setup'));assert.equal(fx.db.get('SELECT COUNT(*) n FROM setup_versions').n,1);
});
test('ciphertext cannot move to another immutable version or team even with the same content hash',async t=>{
  const fx=await fixture(t),p=await publish(fx),row=fx.db.get('SELECT * FROM setup_versions'),v={...row,id:randomUUID(),number:2};fx.db.insert('setup_versions',v);
  const result=await fx.as(fx.users.ua,'GET',`/api/setup-profiles/${p.profile.id}/versions/${v.id}`);assert.equal(result.status,403);assert.ok(!result.text.includes(content));
  fx.h.hub.vaultKey=randomBytes(32);fx.h.hub.vaultPrevKey=null;fx.h.hub._vaultFor=null;assert.equal((await fx.as(fx.users.ua,'GET',`/api/setup-profiles/${p.profile.id}`)).status,403);
});
test('current-version privacy erasure works after ordinary retry history fills; stale/no-op closures cannot grow it',async t=>{
  const fx=await fixture(t),p=await publish(fx),now=fx.h.hub.iso();
  for(let n=1;n<SETUP_LIMITS.requests;n++)fx.db.insert('setup_requests',{user_id:fx.users.ua.id,org_id:fx.A.team,member_id:fx.A.owner,request_id:randomUUID(),operation:'receipt',scope_id:p.profile.id,binding:'0'.repeat(64),created_at:now});
  const b={request_id:randomUUID(),expected_version_id:p.version.id};
  const first=await fx.as(fx.users.ua,'DELETE',`/api/setup-profiles/${p.profile.id}`,b);assert.equal(first.status,200,first.text);assert.equal(fx.db.get('SELECT COUNT(*) n FROM setup_versions').n,0);
  assert.equal((await fx.as(fx.users.ua,'DELETE',`/api/setup-profiles/${p.profile.id}`,b)).status,200);
  assert.equal((await fx.as(fx.users.ua,'DELETE',`/api/setup-profiles/${p.profile.id}`,{...b,request_id:randomUUID()})).status,409);assert.equal(fx.db.get('SELECT COUNT(*) n FROM setup_requests WHERE member_id=?',fx.A.owner).n,SETUP_LIMITS.requests+1);
});
test('post-await sharing activity never replies after admin demotion',async t=>{
  const fx=await fixture(t),p=await publish(fx),setups=fx.h.hub.setups,original=setups.activity.bind(setups);
  setups.activity=(...args)=>{const out=original(...args);queueMicrotask(()=>fx.db.run("UPDATE members SET role='viewer' WHERE id=?",fx.A.admin));return out;};
  const r=await fx.as(fx.users.aadmin,'GET',`/api/setup-profiles/${p.profile.id}/activity`);assert.equal(r.status,409,r.text);assert.equal(r.body.activity,undefined);
});
test('membership removal/rejoin retains account-scoped retry tombstones and never republishes an old reviewed body',async t=>{
  const fx=await fixture(t),b=body(),p=await publish(fx,b,fx.users.amember),oldMember=fx.A.member;
  fx.db.run('UPDATE members SET removed_at=? WHERE id=?',fx.h.hub.iso(),oldMember);assert.equal(fx.db.get('SELECT COUNT(*) n FROM setup_versions WHERE profile_id=?',p.profile.id).n,0);
  fx.db.run('UPDATE members SET removed_at=NULL WHERE id=?',oldMember);assert.equal((await fx.as(fx.users.amember,'POST',path(fx),b)).status,409);
  fx.db.run('DELETE FROM members WHERE id=?',oldMember);const joined=fx.addMember(fx.A.team,fx.users.amember,'member');assert.notEqual(joined,oldMember);
  const result=await fx.as(fx.users.amember,'POST',path(fx),b);assert.equal(result.status,409,result.text);assert.equal(fx.db.get('SELECT COUNT(*) n FROM setup_versions').n,0);
  const captured=await fx.as(fx.users.amember,'GET',path(fx),undefined,{'x-plexiform-member':oldMember});assert.equal(captured.status,401);assert.equal(captured.body.profiles,undefined);
});
for(const change of ['required','timestamp','removed','added'])test(`post-await list refuses full baseline ${change} changes`,async t=>{
  const fx=await fixture(t),p=await publish(fx),baseline={request_id:randomUUID(),profile_id:p.profile.id,version_id:p.version.id,selection:[p.payload.files[0].id],required:true};
  if(change!=='added')assert.equal((await fx.as(fx.users.ua,'PUT',`/api/teams/${fx.A.team}/setup-baseline`,baseline)).status,200);
  const s=fx.h.hub.setups,list=s.list.bind(s);s.list=(...args)=>{const out=list(...args);queueMicrotask(()=>{
    if(change==='required')fx.db.run('UPDATE setup_baselines SET required=0 WHERE org_id=?',fx.A.team);
    if(change==='timestamp')fx.db.run('UPDATE setup_baselines SET updated_at=? WHERE org_id=?','2026-10-02T00:00:00.000Z',fx.A.team);
    if(change==='removed')fx.db.run('DELETE FROM setup_baselines WHERE org_id=?',fx.A.team);
    if(change==='added')fx.db.insert('setup_baselines',{org_id:fx.A.team,profile_id:p.profile.id,version_id:p.version.id,selection:canonical(baseline.selection),required:1,updated_at:fx.h.hub.iso()});
  });return out;};
  const result=await fx.as(fx.users.ua,'GET',path(fx));assert.equal(result.status,409,result.text);assert.equal(result.body.baseline,undefined);assert.equal(result.body.profiles,undefined);
});
test('keyless current list withholds an existing baseline and every profile',async t=>{
  const fx=await fixture(t),p=await publish(fx);assert.equal((await fx.as(fx.users.ua,'PUT',`/api/teams/${fx.A.team}/setup-baseline`,{request_id:randomUUID(),profile_id:p.profile.id,version_id:p.version.id,selection:[p.payload.files[0].id],required:true})).status,200);
  fx.h.hub.vaultKey=null;fx.h.hub._vaultFor=undefined;
  const result=await fx.as(fx.users.ua,'GET',path(fx));assert.equal(result.status,200,result.text);assert.equal(result.body.status,'unavailable');assert.equal(result.body.baseline,null);assert.deepEqual(result.body.profiles,[]);
});
