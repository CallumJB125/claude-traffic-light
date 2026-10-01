import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {remoteRig,grant,oauth,business,spareBoard} from './remote-helpers.js';
import {until} from './helpers.js';
import {RemoteActions} from '../remote/actions.js';
import {communicationRig} from './communication-helpers.js';
import {createPlexiformClient} from '../../../sdk/remote-client.mjs';
import {collaborationFixtures} from '../../../sdk/conformance-fixtures.mjs';
const path='/api/integration/v1';
async function request(f,token,body,extra={}){
  const res=await fetch(f.h.base+(extra.path??path),{method:body===undefined?'GET':'POST',headers:{...(token?{authorization:`Bearer ${token}`}:{ }),...(body===undefined?{}:{'content-type':'application/json'}),...extra.headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
  const text=await res.text();let data;try{data=JSON.parse(text);}catch{}return {status:res.status,text,data,res};
}
const call=(f,token,tool,args,extra)=>request(f,token,{tool,arguments:args},extra);

test('actual fetch SDK catalog/read/create/version/comment and durable retry use the integration audience without execution',async t=>{
  const f=await remoteRig(t),g=await grant(f),client=createPlexiformClient({origin:f.h.base,token:g.token});
  const catalog=await client.catalog();assert.equal(catalog.tools.length,12);assert.ok(catalog.tools.some(x=>x.name==='plexiform_get_work_context'));
  const boards=await client.listBoards();assert.deepEqual(boards.boards.map(b=>b.id),[f.A.board]);
  const input={board_id:f.A.board,request_id:randomUUID(),title:'SDK task'},made=await client.createCard(input),retry=await client.createCard(input);
  assert.equal(retry.card.id,made.card.id);assert.equal(f.db.get('SELECT count(*) n FROM remote_actions').n,1);
  const changed=await client.updateCard({card_id:made.card.id,request_id:randomUUID(),version:made.card.version,title:'Current SDK task'});
  assert.equal((await client.createCard(input)).card.title,'Current SDK task');
  await assert.rejects(client.updateCard({card_id:made.card.id,request_id:randomUUID(),version:made.card.version,title:'No overwrite'}),e=>e.code==='VERSION_CONFLICT');
  const comment=await client.addComment({card_id:made.card.id,request_id:randomUUID(),body:'Reported review'});
  assert.equal(comment.comment.application_verified,false);assert.equal(comment.comment.for_agent,false);
  assert.equal((await client.getCard({card_id:made.card.id})).card.version,changed.card.version);
  const before=business(f);await assert.rejects(client.getCard({card_id:f.B.card}),e=>e.code==='NOT_FOUND');assert.equal(business(f),before);
  assert.equal(f.db.get('SELECT count(*) n FROM dispatches WHERE card_id=?',made.card.id).n,0);
  assert.equal(f.db.get('SELECT count(*) n FROM runs WHERE card_id=?',made.card.id).n,0);
});

test('shared catalog conformance fixtures exercise all twelve fixed SDK methods on actual HTTP and all five ordinary durable retries',async t=>{
  const f=await communicationRig(t);f.h.hub.config.publicUrl=f.h.base;f.authority=f.h.hub.remoteAuthority;
  const g=await grant(f),client=createPlexiformClient({origin:f.h.base,token:g.token}),catalog=await client.catalog(),card_id=f.sender.run.card_id;
  const fixtures=collaborationFixtures({board_id:f.A.board,card_id,recipient_run_id:f.recipient.run.run_id,version:f.h.hub.card(card_id).version,fence:f.sender.run.fence,requestId:randomUUID});
  assert.deepEqual(new Set(fixtures.map(x=>x.tool)),new Set(catalog.tools.map(x=>x.name)));
  for(const fixture of fixtures){const result=await client[fixture.method](fixture.args);assert.ok(Object.hasOwn(result,fixture.key),fixture.tool);
    if(fixture.write){const replay=await client[fixture.method](fixture.args);assert.deepEqual(replay,result,fixture.tool);}
    if(fixture.method==='sendMessage'){assert.equal(result.message.auto_resume,false);assert.equal(result.message.author.application_verified,false);}
  }
  assert.equal(f.db.get('SELECT count(*) n FROM remote_actions WHERE grant_id=?',g.grant.id).n,5);
  assert.equal(f.db.get('SELECT count(*) n FROM dispatches d JOIN cards c ON c.id=d.card_id WHERE c.title=?','Conformance task').n,0);
});

test('actual API rejects MCP/account/device/runner/browser credentials and integration tokens cannot cross to MCP or ordinary API',async t=>{
  const f=await remoteRig(t),g=await grant(f),q=await oauth(f),mcp=f.authority.token(q.body).access_token;
  for(const token of [mcp,f.users.amember.token,'btr_'+'a'.repeat(43)])assert.equal((await request(f,token)).status,401);
  assert.equal((await request(f,null,undefined,{headers:{cookie:g.identity.cookie}})).status,401);
  const crossed=await request(f,g.token,{jsonrpc:'2.0',id:1,method:'tools/list'},{path:'/api/mcp',headers:{accept:'application/json, text/event-stream'}});assert.equal(crossed.status,401);
  const ordinary=await fetch(f.h.base+'/api/me',{headers:{authorization:`Bearer ${g.token}`}});assert.equal(ordinary.status,401);
});

test('closed API request shape, URL tokens, host/origin/protocol and read-only writes refuse with no durable effects',async t=>{
  const f=await remoteRig(t),g=await grant(f,{mode:'read'}),before=business(f);
  for(const body of [{tool:'plexiform_dispatch',arguments:{}},{tool:'plexiform_get_card',arguments:{card_id:f.A.card},token:g.token},{tool:'plexiform_get_card',arguments:{card_id:f.A.card,token:g.token}},'{"tool":"plexiform_get_card","tool":"plexiform_list_boards","arguments":{}}'])assert.equal((await request(f,g.token,body)).status,400);
  for(const extra of [{path:path+'?token='+g.token},{headers:{origin:'https://foreign.invalid'}},{headers:{'mcp-protocol-version':'2025-11-25'}}])assert.ok([400,403].includes((await request(f,g.token,undefined,extra)).status));
  // Fetch normalizes Host. A real raw request proves the configured-host gate.
  const wrongHost=await new Promise((resolve,reject)=>{const req=http.request(f.h.base+path,{headers:{host:'foreign.invalid',authorization:`Bearer ${g.token}`}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});assert.equal(wrongHost,403);
  assert.equal((await call(f,g.token,'plexiform_add_comment',{card_id:f.A.card,body:'No',request_id:randomUUID()})).status,403);
  assert.equal(business(f),before);
});

for(const change of ['grant','member-owner','epoch','board','repository'])test(`actual queued API comment refuses ${change} before a receipt or mutation`,async t=>{
  const f=await remoteRig(t),g=await grant(f),hub=f.h.hub,original=hub.withBoard.bind(hub);let entered=false,release;
  const held=original(f.A.board,()=>new Promise(r=>{release=r;}));await new Promise(r=>setImmediate(r));hub.withBoard=(id,fn)=>{if(id===f.A.board)entered=true;return original(id,fn);};
  try{const pending=call(f,g.token,'plexiform_add_comment',{card_id:f.A.card,request_id:randomUUID(),body:'Never committed'});await until(()=>entered);
    if(change==='grant')f.authority.revokeFamily(g.grant.id);
    if(change==='member-owner')f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.member);
    if(change==='epoch')f.db.setMeta('session_epoch',String(f.authority.epoch()+1));
    if(change==='board')f.db.run('UPDATE boards SET archived_at=? WHERE id=?',hub.iso(),f.A.board);
    if(change==='repository')f.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?',f.A.board,f.A.repo);
    const before=business(f);release();await held;const response=await pending;assert.ok([401,403,404,409].includes(response.status),response.text);assert.equal(response.text.includes('Never committed'),false);assert.equal(business(f),before);
  }finally{release?.();await held;hub.withBoard=original;}
});

for(const end of ['disconnect','deadline'])test(`actual API ${end} cancels a queued mutation before any durable effects`,async t=>{
  const f=await remoteRig(t,{remoteLimits:{httpDeadlineMs:300}}),g=await grant(f),hub=f.h.hub,originalQueue=hub.withBoard.bind(hub),originalCall=RemoteActions.prototype.call;let release,signal;
  const held=originalQueue(f.A.board,()=>new Promise(r=>{release=r;}));await new Promise(r=>setImmediate(r));
  RemoteActions.prototype.call=function(...args){signal=args[4]?.signal;return originalCall.apply(this,args);};t.after(()=>{RemoteActions.prototype.call=originalCall;});
  const controller=new AbortController(),input={tool:'plexiform_add_comment',arguments:{card_id:f.A.card,request_id:randomUUID(),body:'Never committed on cancellation'}};
  try{const pending=fetch(f.h.base+path,{method:'POST',headers:{authorization:`Bearer ${g.token}`,'content-type':'application/json'},body:JSON.stringify(input),signal:controller.signal}).then(async res=>({status:res.status,text:await res.text()}),error=>({error}));
    await until(()=>!!signal);if(end==='disconnect')controller.abort();await until(()=>signal.aborted);
    const before=business(f);release();await held;const result=await pending;if(end==='disconnect')assert.ok(result.error);else {assert.equal(result.status,408,result.text);assert.equal(JSON.parse(result.text).error.code,'TIMEOUT');}
    await until(()=>f.h.app.remoteState.inFlight===0);assert.equal(business(f),before);assert.equal(f.db.get('SELECT count(*) n FROM remote_actions').n,0);
  }finally{controller.abort();release?.();await held;}
});

for(const mutation of [false,true])test(`actual API final delivery withholds a revoked grant after ${mutation?'committed comment':'read'} without duplicating effects`,async t=>{
  const f=await remoteRig(t),g=await grant(f),original=RemoteActions.prototype.call;let changed=false;
  RemoteActions.prototype.call=async function(...args){const out=await original.apply(this,args);if(!changed){changed=true;f.authority.revokeFamily(g.grant.id);}return out;};t.after(()=>{RemoteActions.prototype.call=original;});
  const args=mutation?{card_id:f.A.card,request_id:randomUUID(),body:'PRIVATE-RESPONSE'}:{card_id:f.A.card};
  const response=await call(f,g.token,mutation?'plexiform_add_comment':'plexiform_get_card',args);
  assert.equal(changed,true);assert.equal(response.status,401,response.text);assert.equal(response.text.includes('PRIVATE-RESPONSE'),false);
  assert.equal(f.db.get('SELECT count(*) n FROM remote_actions').n,mutation?1:0);assert.equal(f.db.get('SELECT count(*) n FROM comments WHERE body=?','PRIVATE-RESPONSE').n,mutation?1:0);
  const before=business(f);assert.equal((await call(f,g.token,mutation?'plexiform_add_comment':'plexiform_get_card',args)).status,401);assert.equal(business(f),before);
});

test('API final read reflects current board selection and final catalog withholds a rebound actor',async t=>{
  const f=await remoteRig(t),other=await spareBoard(f),g=await grant(f,{boardIds:[f.A.board,other]}),original=RemoteActions.prototype.call;
  RemoteActions.prototype.call=async function(...args){const out=await original.apply(this,args);f.db.run('UPDATE remote_grants SET board_ids=? WHERE id=?',JSON.stringify([other]),g.grant.id);return out;};t.after(()=>{RemoteActions.prototype.call=original;});
  const r=await call(f,g.token,'plexiform_list_boards',{});assert.equal(r.status,200,r.text);assert.deepEqual(r.data.boards.map(b=>b.id),[other]);assert.equal(r.text.includes(f.A.board),false);
  const catalog=RemoteActions.prototype.catalog;RemoteActions.prototype.catalog=function(...args){const out=catalog.apply(this,args);f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.member);return out;};t.after(()=>{RemoteActions.prototype.catalog=catalog;});
  assert.equal((await request(f,g.token)).status,401);
});

test('actual API oversized card read returns no partial data or effects',async t=>{
  const f=await remoteRig(t),g=await grant(f);
  for(let i=0;i<8;i++)assert.equal((await f.as(f.users.amember,'POST',`/api/cards/${f.A.card}/comments`,{body:'x'.repeat(10000)})).status,200);
  const before=business(f);assert.equal((await call(f,g.token,'plexiform_get_card',{card_id:f.A.card})).status,413);
  assert.equal(business(f),before);
});

test('actual API oversized sealed packet write/read/replay preserve bytes, rows, receipts and broadcasts',async t=>{
  const f=await communicationRig(t);f.h.hub.config.publicUrl=f.h.base;f.authority=f.h.hub.remoteAuthority;
  const g=await grant(f),card=f.sender.run.card_id;
  const attached=await f.sender.client.rpc(f.sender.run,'board_attach_evidence',{kind:'log',ref:'https://synthetic.test/log',summary:'Small'});assert.equal(attached.ok,true);
  const evidence=attached.result.evidence_id,input={card_id:card,request_id:randomUUID(),expected_version:0,expected_fence:f.sender.run.fence,
    data:{brief:'Packet',decisions:[],progress:'',nextAction:'',artifacts:Array.from({length:32},()=>({kind:'evidence',id:evidence})),reportedChecks:[]}};
  const grow=()=>f.db.run('UPDATE evidence SET summary=?,ref=? WHERE id=?','x'.repeat(1000),'https://synthetic.test/'+'x'.repeat(1000-'https://synthetic.test/'.length),evidence);
  grow();const before=business(f);
  let broadcasts=0;const broadcast=f.h.hub.broadcastCard.bind(f.h.hub);f.h.hub.broadcastCard=(...args)=>{broadcasts++;return broadcast(...args);};
  const write=await call(f,g.token,'plexiform_write_packet',input);assert.equal(write.status,413,write.text);assert.equal(business(f),before);assert.equal(broadcasts,0);
  f.db.run('UPDATE evidence SET summary=?,ref=? WHERE id=?','Small','https://synthetic.test/log',evidence);
  const accepted=await call(f,g.token,'plexiform_write_packet',input);assert.equal(accepted.status,200,accepted.text);const sealed=f.db.get('SELECT * FROM task_packets WHERE id=?',accepted.data.packet.id);
  grow();const committed=business(f),sent=broadcasts;
  for(const [name,args]of[['plexiform_read_packet',{card_id:card}],['plexiform_write_packet',input]]){const refused=await call(f,g.token,name,args);assert.equal(refused.status,413,refused.text);assert.equal(refused.data.packet,undefined);assert.equal(business(f),committed);assert.equal(broadcasts,sent);}
  assert.deepEqual(f.db.get('SELECT * FROM task_packets WHERE id=?',sealed.id),sealed);assert.equal(f.db.get('SELECT count(*) n FROM remote_actions WHERE request_id=?',input.request_id).n,1);
});
