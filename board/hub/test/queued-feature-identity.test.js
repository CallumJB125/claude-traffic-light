// Preserved independent full-feature fail-before authority probes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {tenancy} from './tenancy/fixture.js';
import {until} from './helpers.js';
import { Workflows } from '../workflows.js';
const definition={name:'Synthetic review recipe',steps:[{title:'Review synthetic work',body:'No executable instruction',acceptance:'Human review',plan_approval:true}]};
const sideEffects=f=>JSON.stringify(['cards','dispatches','journal','workflow_recipes','workflow_versions','workflow_instances','workflow_step_cards','task_packets','client_items','client_delivery_updates','client_projects','client_feedback_intake','client_feedback','client_approval_decisions'].map(table=>f.db.all(`SELECT * FROM ${table} ORDER BY rowid`)));
async function fixture(t){const f=await tenancy();t.after(()=>f.h.close());return f;}
async function queued(f,key,call,invalidate){
 const original=f.h.hub.withBoard.bind(f.h.hub);let release,entered=false;
 const hold=original(key,()=>new Promise(resolve=>release=resolve));await new Promise(resolve=>setImmediate(resolve));
 f.h.hub.withBoard=(id,fn)=>{if(id===key)entered=true;return original(id,fn);};
 try{const pending=call();await until(()=>entered);invalidate();const before=sideEffects(f);release();await hold;return {result:await pending,before,after:sideEffects(f)};}
 finally{release?.();await hold;f.h.hub.withBoard=original;}
}
for(const operation of ['publish','apply'])for(const identityChange of ['device-owner','member-owner'])test(`integrated workflow ${operation} denies queued ${identityChange} reassignment`,async t=>{
 const f=await fixture(t),{A,users,as}=f;
 const created=await as(users.amember,'POST','/api/workflows',{request_id:randomUUID(),definition});assert.equal(created.status,200,created.text);
 const w=created.body.workflow,key=operation==='publish'?`workflows:${A.team}`:A.board;
 const body=operation==='publish'?{request_id:randomUUID(),expected_version:1,definition:{...definition,name:'Changed recipe'}}:{request_id:randomUUID(),version:1,content_hash:w.content_hash};
 const path=operation==='publish'?`/api/workflows/${w.id}/versions`:`/api/boards/${A.board}/workflows/${w.id}/apply`;
 const check=await queued(f,key,()=>as(users.amember,'POST',path,body),()=>{
  if(identityChange==='device-owner')f.db.run('UPDATE user_devices SET user_id=? WHERE id=?',users.n.id,users.amember.device_id);
  else f.db.run('UPDATE members SET user_id=? WHERE id=?',users.n.id,A.member);
 });
 assert.ok([401,403,404].includes(check.result.status),`must refuse stale identity, status=${check.result.status}`);assert.equal(check.after,check.before,'no recipe/task/journal effect after identity loss');
});
test('workflow and packet durable routes bypass a colliding generic request cache',async t=>{
 const f=await fixture(t),{A,users,as}=f,id=randomUUID();
 assert.equal((await as(users.amember,'POST',`/api/boards/${A.board}/labels`,{request_id:id,name:'synthetic-cache-label',color:'red'})).status,200);
 const created=await as(users.amember,'POST','/api/workflows',{request_id:id,definition});assert.equal(created.status,200,created.text);assert.equal(created.headers.get('board-replayed'),null);assert.ok(created.body.workflow.id);
 const packet={request_id:id,expected_version:0,expected_fence:f.h.hub.card(A.card).fence,data:{brief:'Synthetic packet',decisions:[],progress:'Read only report',nextAction:'Human review',artifacts:[],reportedChecks:[]}};
 const saved=await as(users.amember,'POST',`/api/cards/${A.card}/packet`,packet);assert.equal(saved.status,200,saved.text);assert.equal(saved.headers.get('board-replayed'),null);assert.equal(saved.body.packet.author.account_id,users.amember.id);
 const applied=await as(users.amember,'POST',`/api/boards/${A.board}/workflows/${created.body.workflow.id}/apply`,{request_id:id,version:1,content_hash:created.body.workflow.content_hash});assert.equal(applied.status,200,applied.text);assert.equal(applied.headers.get('board-replayed'),null);
 const card=f.h.hub.card(applied.body.instance.steps[0].id);assert.equal(card.repo_id,null);assert.equal(card.active_run_id,null);assert.equal(card.column_name,'todo');assert.equal(f.db.get('SELECT count(*) n FROM dispatches WHERE card_id=?',card.id).n,0);
});
test('paid choices retain durable row without generic replay or second dispatch',async t=>{
 const f=await fixture(t),{A,users,as}=f,path=`/api/cards/${A.card}/actions/dispatch`,body={request_id:randomUUID(),ai:'codex',budget_usd:null};
 const calls=await Promise.all([as(users.amember,'POST',path,body),as(users.amember,'POST',path,body)]);for(const result of calls){assert.equal(result.status,200,result.text);assert.equal(result.headers.get('board-replayed'),null);}
 const dispatches=f.db.all('SELECT * FROM dispatches WHERE card_id=?',A.card),card=f.h.hub.card(A.card);assert.equal(dispatches.length,1);assert.equal(dispatches[0].backend,'codex_cli');assert.equal(dispatches[0].budget_mode,'none');
 const before=sideEffects(f);assert.equal((await as(users.amember,'POST',path,{...body,ai:'claude',budget_usd:5})).status,409);assert.equal(sideEffects(f),before);
 f.db.run("UPDATE members SET role='viewer' WHERE id=?",A.member);assert.equal((await as(users.amember,'POST',path,body)).status,403);assert.equal(sideEffects(f),before);assert.deepEqual(f.h.hub.card(A.card),card);assert.deepEqual(f.db.all('SELECT * FROM dispatches WHERE card_id=?',A.card),dispatches);
});

for(const operation of ['publish','unpublish'])for(const identityChange of ['device-owner','member-owner'])test(`integrated client ${operation} denies queued ${identityChange} reassignment`,async t=>{
 const f=await fixture(t),{B,users,as}=f;
 const path=operation==='publish'?`/api/boards/${B.board}/client-items`:`/api/client-items/${B.clientItem}`;
 const body=operation==='publish'?{request_id:randomUUID(),card_id:B.card,title:'Synthetic public item',summary:'Safe synthetic text',status:'review'}:{};
 const check=await queued(f,B.board,()=>as(users.ub,operation==='publish'?'POST':'DELETE',path,body),()=>{
  if(identityChange==='device-owner')f.db.run('UPDATE user_devices SET user_id=? WHERE id=?',users.n.id,users.ub.device_id);
  else f.db.run('UPDATE members SET user_id=? WHERE id=?',users.n.id,B.owner);
 });
 assert.ok([401,403,404].includes(check.result.status),`must refuse stale client staff identity, status=${check.result.status}`);assert.equal(check.after,check.before,'no client publication/journal effect after identity loss');
});

for(const identityChange of ['device-owner','member-owner'])test(`integrated client feedback configure denies queued ${identityChange} reassignment`,async t=>{
 const f=await fixture(t),{B,users,as}=f;
 const check=await queued(f,B.board,()=>as(users.ub,'PATCH',`/api/boards/${B.board}/client-feedback-intake`,{enabled:false}),()=>{
  if(identityChange==='device-owner')f.db.run('UPDATE user_devices SET user_id=? WHERE id=?',users.n.id,users.ub.device_id);
  else f.db.run('UPDATE members SET user_id=? WHERE id=?',users.n.id,B.owner);
 });
 assert.ok([401,403,404].includes(check.result.status),`must refuse stale configuring identity, status=${check.result.status}`);assert.equal(check.after,check.before,'no intake/journal effect after identity loss');
});
test('integrated guest feedback denies queued credential owner reassignment',async t=>{
 const f=await fixture(t),{B,users,as}=f;
 f.db.run('UPDATE client_grants SET scopes=? WHERE guest_id=?',JSON.stringify(['status.read','feedback.create']),B.clientGuest);
 const check=await queued(f,B.board,()=>as(users.bguest,'POST',`/api/client/items/${B.clientItem}/feedback`,{request_id:randomUUID(),message:'Synthetic client change'}),()=>f.db.run('UPDATE user_devices SET user_id=? WHERE id=?',users.n.id,users.bguest.device_id));
 assert.ok([401,403,404].includes(check.result.status),`must refuse stale guest credential owner, status=${check.result.status}`);assert.equal(check.after,check.before,'no delegated task/intake/journal effect after credential ownership loss');
});

for (const operation of ['workflow', 'client', 'intake', 'feedback']) {
  for (const change of ['session-owner', 'member-and-device-owner']) {
    if (operation === 'feedback' && change === 'member-and-device-owner') continue;
    test(`${operation} retains the captured identity after ${change} changes`, async t => {
      const f = await fixture(t), { A, B, users, as } = f;
      const user = operation === 'workflow' ? users.amember : operation === 'feedback' ? users.bguest : users.ub;
      let path, method, body, key;
      if (operation === 'workflow') {
        path = '/api/workflows'; method = 'POST'; key = `workflows:${A.team}`;
        body = { request_id: randomUUID(), definition };
      } else if (operation === 'client') {
        path = `/api/client-items/${B.clientItem}`; method = 'DELETE'; key = B.board; body = {};
      } else if (operation === 'intake') {
        path = `/api/boards/${B.board}/client-feedback-intake`; method = 'PATCH'; key = B.board; body = { enabled: false };
      } else {
        f.db.run('UPDATE client_grants SET scopes=? WHERE guest_id=?', JSON.stringify(['status.read', 'feedback.create']), B.clientGuest);
        path = `/api/client/items/${B.clientItem}/feedback`; method = 'POST'; key = B.board;
        body = { request_id: randomUUID(), message: 'Synthetic session feedback' };
      }
      const session = change === 'session-owner' ? await f.h.webSignIn(user.email) : null;
      if (session) assert.equal(session.res.status, 200, session.res.text);
      const sessionId = session && f.db.get('SELECT id FROM sessions WHERE user_id = ?', user.id).id;
      const check = await queued(f, key, () => session
        ? f.h.call(method, path, { cookie: session.cookie, body, headers: { origin: f.h.base, 'x-csrf-token': session.csrf } })
        : as(user, method, path, body), () => {
        if (session) f.db.run('UPDATE sessions SET user_id=? WHERE id=?', users.n.id, sessionId);
        else {
          f.db.run('UPDATE user_devices SET user_id=? WHERE id=?', users.n.id, user.device_id);
          f.db.run('UPDATE members SET user_id=? WHERE id=?', users.n.id, operation === 'workflow' ? A.member : B.owner);
        }
      });
      assert.ok([401, 403, 404].includes(check.result.status), check.result.text);
      assert.equal(check.after, check.before, 'retired request must not inherit a new credential/member identity');
    });
  }
}

test('packet write binds captured membership even when credential and member are reassigned together', async t => {
  const f = await fixture(t), { A, users, as } = f;
  const body = { request_id: randomUUID(), expected_version: 0, expected_fence: f.h.hub.card(A.card).fence,
    data: { brief: 'Synthetic packet', decisions: [], progress: 'Reported', nextAction: 'Human review', artifacts: [], reportedChecks: [] } };
  const check = await queued(f, A.board, () => as(users.amember, 'POST', `/api/cards/${A.card}/packet`, body), () => {
    f.db.run('UPDATE members SET user_id=? WHERE id=?', users.n.id, A.member);
    f.db.run('UPDATE user_devices SET user_id=? WHERE id=?', users.n.id, users.amember.device_id);
  });
  assert.ok([401, 403, 404].includes(check.result.status), check.result.text);
  assert.equal(check.after, check.before);
});

test('workflow durable retry refuses a retired captured member after both identities change', async t => {
  const f = await fixture(t), { A, users } = f, member = f.h.hub.activeMember(A.member);
  const cred = { kind: 'device', id: users.amember.device_id }, body = { request_id: randomUUID(), definition };
  const workflows = new Workflows(f.h.hub);
  await workflows.publish(member, null, body, cred);
  f.db.run('UPDATE members SET user_id=? WHERE id=?', users.n.id, A.member);
  f.db.run('UPDATE user_devices SET user_id=? WHERE id=?', users.n.id, users.amember.device_id);
  const before = sideEffects(f);
  await assert.rejects(async () => workflows.publish(member, null, body, cred), e => ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND'].includes(e.code));
  assert.equal(sideEffects(f), before);
});
