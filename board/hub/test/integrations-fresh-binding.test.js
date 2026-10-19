// Frozen7d authority-boundary regressions plus current credential/delivery cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {rmSync} from 'node:fs';
import {startHub} from './helpers.js';
import {startAccounts} from './accounts-helpers.js';
import {defineConnector} from '../integrations/connector.js';
import {createSentryConnector} from '../integrations/sentry/index.js';
function connector(over={}){return defineConnector({id:'review-probe',name:'Review probe',hosts:[],scopes:[],secrets:[],connect:{kind:'token',verifyToken:async()=>({external_id:'synthetic'})},actions:{'card.create':{default:'auto'},'comment.create':{default:'auto'}},...over});}
async function fixture(t,over={}){const h=await startHub();t.after(()=>h.destroy());h.hub.setVaultKey(randomBytes(32));h.app.integrations.register(connector(over));const c=h.app.integrations.createConnection({orgId:h.ids.org,memberId:h.ids.alice,provider:'review-probe',external_id:'synthetic'});return{h,c};}
function user(h){const id=randomUUID();h.db.insert('users',{id,display_name:'Synthetic',created_at:h.hub.iso()});return id;}
for(const operation of ['createCard','comment'])test(`a captured integration ${operation} handle refuses member user rebind across an await`,async t=>{
 const {h,c}=await fixture(t),cookie=await h.login('alice'),card=await h.createCard(cookie);
 h.db.run('UPDATE members SET user_id=? WHERE id=?',user(h),h.ids.alice);
 const ctx=h.app.integrations.ctxFor(c.id);let release,entered;
 const admitted=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 const pending=ctx.act(operation==='createCard'?'card.create':'comment.create',{},async s=>{const actor=s.actAs(h.ids.alice);entered();await hold;return operation==='createCard'?actor.createCard(h.ids.board,{request_id:'captured-1',title:'stale authority'}):actor.comment(card.id,{request_id:'captured-1',body:'stale authority'});});
 const refusal=assert.rejects(pending,e=>['FORBIDDEN','ACTOR_UNAVAILABLE','UNAUTHENTICATED'].includes(e.code));
 await admitted;h.db.run('UPDATE members SET user_id=? WHERE id=?',user(h),h.ids.alice);release();await refusal;
 assert.equal(h.db.get('SELECT count(*) n FROM integration_requests WHERE connection_id=?',c.id).n,0);
 assert.equal(h.db.get('SELECT count(*) n FROM integration_comment_requests WHERE connection_id=?',c.id).n,0);
});
for(const change of ['role','removed'])test(`token HTTP connect refuses current ${change} change after verification await`,async t=>{
 let release,entered;const admitted=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 const h=await startHub();t.after(()=>h.destroy());h.hub.setVaultKey(randomBytes(32));
 h.app.integrations.register(connector({connect:{kind:'token',verifyToken:async()=>{entered();await hold;return{external_id:'synthetic'};}}}));
 h.db.run("UPDATE members SET role='owner' WHERE id=?",h.ids.bob);
 const cookie=await h.login('alice');const pending=h.api(cookie,'POST','/api/integrations/review-probe/token',{token:'synthetic'});
 await admitted;if(change==='role')h.db.run("UPDATE members SET role='viewer' WHERE id=?",h.ids.alice);else h.db.run('UPDATE members SET removed_at=? WHERE id=?',h.hub.iso(),h.ids.alice);
 release();const response=await pending;
 assert.ok([401,403,404].includes(response.status),`stale request must refuse, got ${response.status}`);
 assert.equal(h.db.get("SELECT count(*) n FROM connections WHERE provider='review-probe'").n,0,'no connection or secret inserted after admin lost authority');
});
test('unchanged captured actor positive writes remain untrusted and replay once',async t=>{
 const {h,c}=await fixture(t);h.db.run('UPDATE members SET user_id=? WHERE id=?',user(h),h.ids.alice);
 const ctx=h.app.integrations.ctxFor(c.id),made=await ctx.act('card.create',{},s=>s.actAs(h.ids.alice).createCard(h.ids.board,{request_id:'ok-1',title:'Synthetic'}));
 const card=made.result.card.id;
 const comment=()=>h.app.integrations.ctxFor(c.id).act('comment.create',{},s=>s.actAs(h.ids.alice).comment(card,{request_id:'ok-2',body:'Synthetic'}));
 const one=await comment(),two=await comment();assert.equal(one.result.comment.id,two.result.comment.id);assert.equal(one.result.comment.source,'integration');assert.equal(one.result.comment.trusted,false);assert.equal(one.result.comment.for_agent,false);
 assert.equal(h.db.get('SELECT count(*) n FROM comments WHERE card_id=?',card).n,1);
});

function eventsConnector(){return defineConnector({id:'review-events',name:'Review events',hosts:[],scopes:[],secrets:[],connect:{kind:'token',verifyToken:async()=>({external_id:'synthetic'})},actions:{'link.pr':{default:'auto'},'system.pr_merged':{default:'auto'},'comment.create':{default:'auto'}},systemEvents:['pr_merged']});}
async function eventsFixture(t){const h=await startHub();t.after(()=>h.destroy());h.hub.setVaultKey(randomBytes(32));h.app.integrations.register(eventsConnector());const c=h.app.integrations.createConnection({orgId:h.ids.org,memberId:h.ids.alice,provider:'review-events',external_id:'synthetic'});return{h,c};}
async function reviewed(t){const {h,c}=await eventsFixture(t),cookie=await h.login('alice'),card=await h.createCard(cookie);const rid=randomUUID(),at=h.hub.iso();
 h.db.insert('dispatches',{request_id:rid,card_id:card.id,dispatched_by:h.ids.alice,state:'claimed',created_at:at});
 h.db.insert('runs',{id:randomUUID(),card_id:card.id,fence:1,on_behalf_of:h.ids.alice,dispatched_by:h.ids.alice,dispatch_request_id:rid,backend:'codex_cli',repo_id:h.ids.repo,base_ref:'main',branch:`board/${card.key}-r1`,started_at:at,ended_at:at});
 h.db.run("UPDATE cards SET run_state='in_review',column_name='in_review' WHERE id=?",card.id);
 const ctx=h.app.integrations.ctxFor(c.id);await ctx.act('link.pr',{},s=>s.link(card.id,'pr','synthetic-pr','https://github.com/acme/app/pull/10'));
 h.db.insert('evidence',{id:randomUUID(),card_id:card.id,kind:'pr',ref:'https://github.com/acme/app/pull/10',verification:'hub_verified',verified_at:at,created_at:at});
 return{h,c,card,ctx,event:()=>ctx.system.event('pr_merged',{kind:'pr',external_id:'synthetic-pr',pr:10,repo:'acme/app'})};}
for(const change of ['pause','autonomy'])test(`queued system event refuses current connection ${change}`,async t=>{
 const f=await reviewed(t);let release;
 const held=f.h.hub.withBoard(f.h.ids.board,()=>new Promise(r=>release=r));await new Promise(r=>setImmediate(r));
 const pending=f.event();await new Promise(r=>setImmediate(r));
 if(change==='pause')f.h.db.run("UPDATE connections SET status='paused' WHERE id=?",f.c.id);
 else f.h.app.integrations.setSettings(f.c.id,{autonomy:{'system.pr_merged':'off'}});
 release();await held;let outcome;try{outcome=await pending;}catch(e){outcome={done:false,code:e.code};}
 assert.equal(f.h.card(f.card.id).column_name,'in_review',`current ${change} must withhold transition; outcome ${JSON.stringify(outcome)}`);
 assert.equal(f.h.db.get("SELECT count(*) n FROM journal WHERE card_id=? AND kind='card.transition'",f.card.id).n,0);
});
test('current verified system event positive still completes ordinary reviewed card',async t=>{const f=await reviewed(t);assert.equal((await f.event()).done,true);assert.equal(f.h.card(f.card.id).column_name,'done');});
test('046 exact cross-team receipt insert and retarget refuse and underlying comment deletion erases receipt',async t=>{
 const {h,c}=await eventsFixture(t),cookie=await h.login('alice'),card=await h.createCard(cookie);
 const out=await h.app.integrations.ctxFor(c.id).act('comment.create',{},s=>s.actAs(h.ids.alice).comment(card.id,{request_id:'once',body:'Synthetic'}));
 const otherOrg=randomUUID(),otherBoard=randomUUID(),otherMember=randomUUID(),otherCard=randomUUID(),otherComment=randomUUID(),at=h.hub.iso();
 h.db.insert('orgs',{id:otherOrg,name:'Synthetic other',created_at:at});h.db.insert('boards',{id:otherBoard,org_id:otherOrg,name:'Other',key_prefix:'OTH'});h.db.insert('members',{id:otherMember,org_id:otherOrg,github_id:999,github_login:'other',display_name:'Other',role:'owner',created_at:at});h.db.insert('cards',{id:otherCard,board_id:otherBoard,key:'OTH-1',title:'Other',created_by:otherMember,created_at:at,updated_at:at});h.db.insert('comments',{id:otherComment,card_id:otherCard,author_member_id:otherMember,source:'web',trusted:1,body:'Private synthetic',created_at:at});
 assert.throws(()=>h.db.insert('integration_comment_requests',{connection_id:c.id,request_id:'other',comment_id:otherComment,created_at:at}),/cross-team reference/);
 assert.throws(()=>h.db.run('UPDATE integration_comment_requests SET comment_id=? WHERE connection_id=? AND request_id=?',otherComment,c.id,'once'),/cross-team reference/);
 assert.equal(h.db.get('SELECT comment_id FROM integration_comment_requests WHERE connection_id=?',c.id).comment_id,out.result.comment.id);
 h.db.run('DELETE FROM comments WHERE id=?',out.result.comment.id);assert.equal(h.db.get('SELECT count(*) n FROM integration_comment_requests WHERE connection_id=?',c.id).n,0);assert.deepEqual(h.db.all('PRAGMA foreign_key_check'),[]);
});

test('cached token-connect reply cannot bypass current admin check',async t=>{
 const h=await startHub();t.after(()=>h.destroy());h.hub.setVaultKey(randomBytes(32));h.app.integrations.register(createSentryConnector());
 h.db.run("UPDATE members SET role='owner' WHERE id=?",h.ids.bob);
 const cookie=await h.login('alice'),body={request_id:randomUUID(),token:randomBytes(24).toString('base64url')};
 const first=await h.api(cookie,'POST','/api/integrations/sentry/token',body);assert.equal(first.status,200,first.text);assert.ok(first.body.connection.webhook_url);
 h.db.run("UPDATE members SET role='viewer' WHERE id=?",h.ids.alice);
 const replay=await h.api(cookie,'POST','/api/integrations/sentry/token',body);
 assert.equal(replay.status,403,`current nonadmin replay must refuse, received ${replay.status}, board-replayed=${replay.headers.get('board-replayed')}`);
 assert.ok(!replay.text.includes('/webhook'));assert.equal(h.db.get("SELECT count(*) n FROM connections WHERE provider='sentry'").n,1);
});

for (const change of ['user', 'link', 'remove']) test(`captured linked provider actor refuses ${change} after an await`, async t => {
  const {h,c}=await fixture(t);
  h.db.run('UPDATE members SET user_id=? WHERE id=?',user(h),h.ids.bob);
  h.db.insert('external_identities',{provider:'review-probe',workspace_id:'synthetic',subject:'provider-user',member_id:h.ids.bob,connection_id:c.id,verified_via:'oauth_link',linked_at:h.hub.iso()});
  const ctx=h.app.integrations.ctxFor(c.id);
  let release,entered;
  const admitted=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  const pending=ctx.act('card.create',{subject:'provider-user'},async s=>{
    const actor=s.actAs(h.ids.bob);entered();await hold;
    return actor.createCard(h.ids.board,{request_id:'linked-1',title:'Stale linked authority'});
  });
  const refusal=assert.rejects(pending,e=>change==='remove'
    ? e.code==='ACTOR_UNAVAILABLE'&&e.scope==='member'
    : e.code==='FORBIDDEN');
  await admitted;
  if(change==='user')h.db.run('UPDATE members SET user_id=? WHERE id=?',user(h),h.ids.bob);
  else if(change==='link'){
    h.db.run('DELETE FROM external_identities WHERE connection_id=?',c.id);
    h.db.insert('external_identities',{provider:'review-probe',workspace_id:'synthetic',subject:'provider-user',member_id:h.ids.alice,connection_id:c.id,verified_via:'oauth_link',linked_at:h.hub.iso()});
  }
  else h.db.run('UPDATE members SET removed_at=? WHERE id=?',h.hub.iso(),h.ids.bob);
  release();await refusal;
  assert.equal(h.db.get('SELECT count(*) n FROM integration_requests WHERE connection_id=?',c.id).n,0);
});

test('queued captured user refusal is not sticky: same request succeeds once after identity recovery', async t=>{
  const {h,c}=await fixture(t),old=user(h);
  h.db.run('UPDATE members SET user_id=? WHERE id=?',old,h.ids.alice);
  const ctx=h.app.integrations.ctxFor(c.id);let release,admitted;
  const entered=new Promise(r=>admitted=r),create=h.app.api.createCard;
  const held=h.hub.withBoard(h.ids.board,()=>new Promise(r=>release=r));await new Promise(r=>setImmediate(r));
  h.app.api.createCard=function(...args){const out=create.apply(this,args);admitted();return out;};
  const make=()=>ctx.act('card.create',{},s=>s.actAs(h.ids.alice).createCard(h.ids.board,{request_id:'queued-user',title:'Current identity'}));
  const pending=make(),refusal=assert.rejects(pending,e=>e.code==='FORBIDDEN');await entered;
  h.db.run('UPDATE members SET user_id=? WHERE id=?',user(h),h.ids.alice);
  release();await held;await refusal;h.app.api.createCard=create;
  assert.equal(h.db.get('SELECT count(*) n FROM integration_requests WHERE connection_id=?',c.id).n,0);
  h.db.run('UPDATE members SET user_id=? WHERE id=?',old,h.ids.alice);
  const first=await make(),second=await make();assert.equal(first.result.card.id,second.result.card.id);
  assert.equal(h.db.get('SELECT count(*) n FROM integration_requests WHERE connection_id=?',c.id).n,1);
});

for (const change of ['user','viewer','settings','target']) test(`queued verified system event refuses current ${change}`,async t=>{
  const f=await reviewed(t);hardenOwner(f.h);
  let release;const held=f.h.hub.withBoard(f.h.ids.board,()=>new Promise(r=>release=r));await new Promise(r=>setImmediate(r));
  const pending=f.event(),refusal=assert.rejects(pending,e=>['FORBIDDEN','ACTOR_UNAVAILABLE'].includes(e.code));await new Promise(r=>setImmediate(r));
  if(change==='user')f.h.db.run('UPDATE members SET user_id=? WHERE id=?',user(f.h),f.h.ids.alice);
  else if(change==='viewer')f.h.db.run("UPDATE members SET role='viewer' WHERE id=?",f.h.ids.alice);
  else if(change==='settings')f.h.app.integrations.setSettings(f.c.id,{config:{channel:'changed'}});
  else{const id=randomUUID();f.h.db.insert('boards',{id,org_id:f.h.ids.org,name:'Other intake',key_prefix:'OTH'});f.h.app.integrations.setSettings(f.c.id,{target_board_id:id});}
  release();await held;await refusal;assert.equal(f.h.card(f.card.id).column_name,'in_review');
});

function hardenOwner(h){h.db.run("UPDATE members SET role='owner' WHERE id=?",h.ids.bob);}

for (const kind of ['session','device']) for (const change of ['revoke','owner']) test(`token connect captures ${kind} credential across verification ${change}`,async t=>{
  const h=await startAccounts();t.after(async()=>{await h.close();rmSync(h.hub.config.dataDir,{recursive:true,force:true});});
  h.hub.setVaultKey(randomBytes(32));hardenOwner(h);
  const signed=kind==='session'?await h.webSignIn('alice@dev.local'):await h.signIn('alice@dev.local');
  assert.equal(kind==='session'?signed.res.status:signed.status,200);
  const owner=signed.body.user.id;
  const id=kind==='session'?h.db.get('SELECT id FROM sessions WHERE user_id=?',owner).id:signed.body.device_id;
  let release,entered;const admitted=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  h.app.integrations.register(connector({secrets:['webhook_secret'],connect:{kind:'token',verifyToken:async()=>{entered();await hold;return{external_id:'synthetic',secrets:{webhook_secret:'synthetic-webhook-signing-key'}};}}}));
  const pending=h.call('POST','/api/integrations/review-probe/token',{body:{request_id:randomUUID(),token:'synthetic'},...(kind==='session'?{cookie:signed.cookie,headers:{origin:h.base,'x-csrf-token':signed.csrf}}:{token:signed.body.device_token})});
  await admitted;
  const table=kind==='session'?'sessions':'user_devices';
  if(change==='revoke')h.db.run(`UPDATE ${table} SET revoked_at=? WHERE id=?`,h.hub.iso(),id);
  else h.db.run(`UPDATE ${table} SET user_id=? WHERE id=?`,user(h),id);
  release();const response=await pending;assert.equal(response.status,401,response.text);
  assert.equal(h.db.get("SELECT count(*) n FROM connections WHERE provider='review-probe'").n,0);
  assert.equal(h.db.get('SELECT count(*) n FROM connection_secrets').n,0);
});

test('postverify current-admin refusal is uncached so the same request recovers',async t=>{
  const h=await startHub();t.after(()=>h.destroy());h.hub.setVaultKey(randomBytes(32));hardenOwner(h);
  let release,entered,calls=0;const admitted=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  h.app.integrations.register(connector({connect:{kind:'token',verifyToken:async()=>{calls++;if(calls===1){entered();await hold;}return{external_id:'synthetic'};}}}));
  const cookie=await h.login('alice'),body={request_id:randomUUID(),token:'synthetic'};
  const pending=h.api(cookie,'POST','/api/integrations/review-probe/token',body);await admitted;
  h.db.run("UPDATE members SET role='viewer' WHERE id=?",h.ids.alice);release();assert.equal((await pending).status,403);
  h.db.run("UPDATE members SET role='owner' WHERE id=?",h.ids.alice);
  assert.equal((await h.api(cookie,'POST','/api/integrations/review-probe/token',body)).status,200);
  const replay=await h.api(cookie,'POST','/api/integrations/review-probe/token',body);assert.equal(replay.status,200);assert.equal(replay.headers.get('board-replayed'),'1');assert.equal(calls,2);
});

test('current HTTP result guard withholds a postcommit admin reply without claiming rollback',async t=>{
  const h=await startHub();t.after(()=>h.destroy());h.hub.setVaultKey(randomBytes(32));hardenOwner(h);h.app.integrations.register(createSentryConnector());
  const create=h.app.integrations.createConnection;
  h.app.integrations.createConnection=function(...args){const out=create.apply(this,args);h.db.run("UPDATE members SET role='viewer' WHERE id=?",h.ids.alice);return out;};
  const cookie=await h.login('alice'),request=randomUUID();
  const response=await h.api(cookie,'POST','/api/integrations/sentry/token',{request_id:request,token:randomBytes(24).toString('base64url')});
  assert.equal(response.status,403);assert.ok(!response.text.includes('/webhook'));assert.ok(!response.body.connection);
  assert.equal(h.db.get("SELECT count(*) n FROM connections WHERE provider='sentry'").n,1,'already committed connection remains; only the stale response is withheld');
  assert.equal(h.hub.cachedResponse(h.ids.alice,request),null);
});

test('overview guard withholds captured admin-only configuration after current demotion',async t=>{
  const {h,c}=await fixture(t);hardenOwner(h);h.app.integrations.setSettings(c.id,{config:{channel:'private-synthetic-channel'}});
  const list=h.app.integrations.list;
  h.app.integrations.list=function(...args){const out=list.apply(this,args);h.db.run("UPDATE members SET role='viewer' WHERE id=?",h.ids.alice);return out;};
  const cookie=await h.login('alice'),response=await h.api(cookie,'GET','/api/integrations');
  assert.equal(response.status,403);assert.ok(!response.text.includes('private-synthetic-channel'));
});

test('request JSON cannot manufacture the private integration route guard',async t=>{
  const {h}=await fixture(t),cookie=await h.login('bob');
  const response=await h.api(cookie,'POST','/api/integrations/review-probe/token',{request_id:randomUUID(),token:'synthetic',integrationAccess:'member',integrationCurrent:'forged',via:{member_id:h.ids.alice}});
  assert.equal(response.status,403);assert.equal(h.db.get("SELECT count(*) n FROM connections WHERE provider='review-probe'").n,1);
});

test('final admin guard withholds the private OAuth bind header along with a stale reply',async t=>{
  const h=await startHub();t.after(()=>h.destroy());h.hub.setVaultKey(randomBytes(32));hardenOwner(h);
  h.app.integrations.register(defineConnector({id:'review-oauth',name:'Review OAuth',hosts:['review.example'],scopes:[],secrets:[],actions:{},connect:{kind:'oauth',authorizeUrl:({state})=>`https://review.example/auth?state=${state}`,exchange:async()=>({external_id:'synthetic'})}}));
  const original=h.app.integrations.oauthStart;
  h.app.integrations.oauthStart=function(...args){const out=original.apply(this,args);assert.ok(out.cookie.value);h.db.run("UPDATE members SET role='viewer' WHERE id=?",h.ids.alice);return out;};
  const cookie=await h.login('alice'),response=await h.api(cookie,'POST','/api/integrations/review-oauth/start',{request_id:randomUUID()});
  assert.equal(response.status,403);assert.equal(response.headers.get('set-cookie'),null);assert.ok(!response.body.bind);assert.ok(!response.body.url);
});
