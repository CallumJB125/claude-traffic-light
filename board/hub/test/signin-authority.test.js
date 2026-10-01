import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { tenancy } from './tenancy/fixture.js';
import { handleRpc } from '../rpc.js';
import { FakeRunner, until, runMsg, runHb } from './helpers.js';

async function rig(t, { runner = false } = {}) {
  const fx = await tenancy(); t.after(() => fx.h.close());
  if (!runner) return fx;
  const { h, A, users } = fx;
  const e = await fx.as(users.amember, 'POST', `/api/teams/${A.team}/enrol`, {}); assert.equal(e.status, 200);
  fx.open = async () => {
    const r = new FakeRunner(h.base, { device_id: '', device_token: e.body.runner_token, team: A.team });
    t.after(() => r.terminate()); await r.open(); await r.hello(); await r.advertise([{ repo_id: A.repo }]); return r;
  };
  fx.r = await fx.open();
  const d = await fx.as(users.amember, 'POST', `/api/cards/${A.card}/actions/dispatch`, { request_id: randomUUID(), budget_usd: 5 }); assert.equal(d.status, 200, d.text);
  const offer = await fx.r.next('offer', o => o.card_id === A.card), claim = await fx.r.claim(offer); assert.equal(claim.ok, true);
  fx.run = { ...claim, card_id: A.card, repo_id: A.repo };
  await fx.r.out({ ...runMsg(fx.run), kind: 'activity', source: 'init' }); await fx.r.hb([runHb(fx.run)]);
  fx.conn = h.hub.runners.get(fx.r.welcome.device_id); return fx;
}
const snapshot = fx => JSON.stringify(['cards','comments','journal','dispatches','permission_requests','board_labels','evidence','events'].map(table => fx.db.all(`SELECT * FROM ${table} ORDER BY rowid`)));
async function queued(fx, call, invalidate) {
  const original = fx.h.hub.withBoard.bind(fx.h.hub); let release, observed;
  const entered = new Promise(resolve => observed = resolve);
  const held = original(fx.A.board, () => new Promise(resolve => release = resolve)); await new Promise(resolve => setImmediate(resolve));
  fx.h.hub.withBoard = (id, fn) => { if (id === fx.A.board) observed(); return original(id, fn); };
  let timeout;
  try {
    const pending = call();
    await Promise.race([entered, new Promise((_,reject) => timeout = setTimeout(() => reject(Error('write did not enter queue')), 5000))]);
    await invalidate(); const before = snapshot(fx); release(); await held;
    const result = await pending; assert.equal(snapshot(fx), before, 'no revoked action, permission, label or card effect'); return result;
  } finally { clearTimeout(timeout); release(); await held; fx.h.hub.withBoard = original; }
}
const losses = {
 device: [401, (fx,u) => fx.db.run('UPDATE user_devices SET revoked_at = ? WHERE id = ?', fx.h.hub.iso(), u.device_id)],
 epoch: [401, fx => fx.db.setMeta('session_epoch', Number(fx.db.meta('session_epoch')) + 1)],
 member: [403, (fx,u) => fx.db.run('UPDATE members SET removed_at = ? WHERE user_id = ? AND org_id = ?', fx.h.hub.iso(), u.id, fx.A.team)],
 role: [403, (fx,u) => fx.db.run("UPDATE members SET role = 'viewer' WHERE user_id = ? AND org_id = ?", u.id, fx.A.team)],
 team: [403, fx => fx.db.run('UPDATE orgs SET deleted_at = ? WHERE id = ?', fx.h.hub.iso(), fx.A.team)],
};
for (const op of ['dispatch','archive','restore','label-create','label-rename','label-delete','permission']) for (const [loss,[status,invalidate]] of Object.entries(losses)) {
 test(`sign-in ${op} denies queued ${loss} loss`, async t => {
  const fx = await rig(t, { runner: op === 'permission' }), { A, users, h } = fx;
  const u = op === 'label-rename' || op === 'label-delete' ? users.aadmin : users.amember;
  let method = 'POST', path, body = { request_id: randomUUID() };
  if (op === 'dispatch') { path = `/api/cards/${A.card}/actions/dispatch`; body.budget_usd = 5; }
  else if (op === 'permission') {
    const p = await fx.r.rpc(fx.run,'approval',{tool_name:'Bash',input_summary:'fixture test'}); assert.equal(p.ok,true);
    path = `/api/permission-requests/${p.result.permission_request_id}/answer`; body.decision = 'allow';
  } else if (op.startsWith('label')) {
    if (op !== 'label-create') assert.equal((await fx.as(u,'POST',`/api/boards/${A.board}/labels`,{name:'fixture-label',color:'blue'})).status,200);
    path = `/api/boards/${A.board}/labels${op === 'label-create' ? '' : '/fixture-label'}`;
    if (op === 'label-create') Object.assign(body,{name:'new-label',color:'red'});
    if (op === 'label-rename') { method = 'PATCH'; body.name = 'renamed-label'; }
    if (op === 'label-delete') method = 'DELETE';
  } else {
    path = `/api/cards/${A.card}/${op}`;
    if (op === 'restore') fx.db.run('UPDATE cards SET archived_at = ? WHERE id = ?', h.hub.iso(), A.card);
  }
  const result = await queued(fx,() => fx.as(u,method,path,body),() => invalidate(fx,u)); assert.equal(result.status,status,result.text);
 });
}
for (const op of ['label-rename','label-delete']) test(`${op} cannot retain admin authority after becoming ordinary member`, async t => {
 const fx = await rig(t), {A,users} = fx; const u = users.aadmin;
 assert.equal((await fx.as(u,'POST',`/api/boards/${A.board}/labels`,{name:'original',color:'red'})).status,200);
 const method = op === 'label-rename' ? 'PATCH' : 'DELETE';
 const r = await queued(fx,() => fx.as(u,method,`/api/boards/${A.board}/labels/original`,{name:'changed'}),() => fx.db.run("UPDATE members SET role = 'member' WHERE id = ?",A.admin));
 assert.equal(r.status,403,r.text);
});

test('stable paid dispatch retains one-effect retry, checks payload and current authority', async t => {
 const fx = await rig(t), {A,users} = fx, path = `/api/cards/${A.card}/actions/dispatch`, body = {request_id:randomUUID(),budget_usd:5};
 const first = await fx.as(users.amember,'POST',path,body); assert.equal(first.status,200,first.text);
 const before = snapshot(fx); const second = await fx.as(users.amember,'POST',path,body); assert.equal(second.status,200,second.text); assert.equal(second.headers.get('board-replayed'),'1');
 assert.equal((await fx.as(users.amember,'POST',path,{...body,budget_usd:10})).status,409); assert.equal(snapshot(fx),before);
 fx.h.hub.requestCache.clear(); const dispatches = fx.db.all('SELECT * FROM dispatches'), card = fx.h.hub.card(A.card);
 const durable = await fx.as(users.amember,'POST',path,body); assert.equal(durable.status,200,durable.text);
 assert.deepEqual(fx.db.all('SELECT * FROM dispatches'),dispatches,'cache loss never creates another paid dispatch'); assert.deepEqual(fx.h.hub.card(A.card),card,'retry never widens budget or changes the task');
 const afterDurable = snapshot(fx);
 fx.db.run("UPDATE members SET role='viewer' WHERE id=?",A.member); const denied = await fx.as(users.amember,'POST',path,body); assert.equal(denied.status,403); assert.equal(denied.headers.get('board-replayed'),null); assert.equal(snapshot(fx),afterDurable);
});

for (const cacheHit of [false,true]) test(`generic immediate write rechecks credentials after body read (cached:${cacheHit})`, async t => {
 const fx = await rig(t), {h,users} = fx; const u = users.ua;
 const body = {request_id:randomUUID(),url:'https://github.com/alpha/queued-repo'}, path='/api/repos';
 if(cacheHit) assert.equal((await fx.as(u,'POST',path,body)).status,200);
 const before=fx.db.all('SELECT * FROM repos'); const serialized=JSON.stringify(body); let auth;
 const accepted=new Promise(resolve=>auth=resolve), original=h.hub.accounts.authenticate.bind(h.hub.accounts);
 h.hub.accounts.authenticate=(...args)=>{const result=original(...args);auth();return result;}; t.after(()=>h.hub.accounts.authenticate=original);
 const pending=new Promise((resolve,reject)=>{
  const req=http.request(h.base+path,{method:'POST',headers:{Authorization:`Bearer ${u.token}`,Origin:h.base,'Content-Type':'application/json','Content-Length':Buffer.byteLength(serialized)}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,replayed:res.headers['board-replayed'],body:JSON.parse(text)}));});req.on('error',reject);req.write(serialized.slice(0,1));
  accepted.then(()=>{fx.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',h.hub.iso(),u.device_id);req.end(serialized.slice(1));}).catch(reject);
 });
 const result=await pending;assert.equal(result.status,401);assert.equal(result.replayed,undefined);assert.deepEqual(fx.db.all('SELECT * FROM repos'),before);
});

for(const loss of ['revoke','replacement','role']) test(`queued runner RPC checks current connection after ${loss}`, async t=>{
 const fx=await rig(t,{runner:true});
 const call = loss === 'replacement'
  ? () => handleRpc(fx.h.hub,fx.h.hub.device(fx.conn.device_id),{...runMsg(fx.run),run_token:fx.run.run_token,method:'board_ask_human',params:{kind:'question',text:'should not persist'}},{connection:fx.conn}).then(result=>({ok:true,result}),error=>({ok:false,error}))
  : () => fx.r.rpc(fx.run,'board_ask_human',{kind:'question',text:'should not persist'});
 const result=await queued(fx,call,async()=>{
  if(loss==='replacement')await fx.open();
  else if(loss==='role')fx.db.run("UPDATE members SET role='viewer' WHERE id=?",fx.A.member);
  else fx.db.run('UPDATE runner_enrollments SET revoked_at=?,token_hash=NULL WHERE id=?',fx.h.hub.iso(),fx.conn.enrollmentId);
 });assert.equal(result.ok,false);assert.equal(result.error.code,'FORBIDDEN');assert.equal(fx.h.hub.openAsks(fx.A.card).length,0);
});

test('async evidence continuation rechecks enrollment before returning to queue',async t=>{
 const fx=await rig(t,{runner:true});let answer,called;
 const entered=new Promise(resolve=>called=resolve);fx.h.hub.github.getCommit=()=>{called();return new Promise(resolve=>answer=resolve);};
 const pending=fx.r.rpc(fx.run,'board_attach_evidence',{kind:'commit',ref:'a'.repeat(40)});await entered;
 fx.db.run('UPDATE runner_enrollments SET revoked_at=?,token_hash=NULL WHERE id=?',fx.h.hub.iso(),fx.conn.enrollmentId);
 const before=snapshot(fx);answer({sha:'a'.repeat(40)});const result=await pending;assert.equal(result.ok,false);assert.equal(result.error.code,'FORBIDDEN');assert.equal(snapshot(fx),before);
});

for(const operation of ['rename','delete']) test(`cached label ${operation} rechecks live admin role`,async t=>{
 const fx=await rig(t),{A,users}=fx,u=users.aadmin,path=`/api/boards/${A.board}/labels/original`;
 assert.equal((await fx.as(u,'POST',`/api/boards/${A.board}/labels`,{name:'original',color:'blue'})).status,200);
 const method=operation==='rename'?'PATCH':'DELETE',body={request_id:randomUUID(),...(operation==='rename'?{name:'renamed'}:{})};
 const first=await fx.as(u,method,path,body);assert.equal(first.status,200,first.text);const before=snapshot(fx);
 fx.db.run("UPDATE members SET role='member' WHERE id=?",A.admin);
 const retry=await fx.as(u,method,path,body);assert.equal(retry.status,403,retry.text);assert.equal(retry.headers.get('board-replayed'),null);assert.equal(snapshot(fx),before);
});

test('queued paid dispatch rechecks repo opt-in; stopping revoked repo work stays available',async t=>{
 const fx=await rig(t),{A,users}=fx;
 const denied=await queued(fx,()=>fx.as(users.amember,'POST',`/api/cards/${A.card}/actions/dispatch`,{request_id:randomUUID(),budget_usd:5}),()=>fx.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?',A.board,A.repo));
 assert.equal(denied.status,404,denied.text);
 const live=await rig(t,{runner:true});live.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?',live.A.board,live.A.repo);
 const result=await live.as(live.users.amember,'POST',`/api/cards/${live.A.card}/actions/stop`,{request_id:randomUUID()});assert.equal(result.status,200,result.text);assert.equal(live.h.hub.card(live.A.card).run_state,'failed');assert.equal(live.h.hub.card(live.A.card).fail_kind,'stopped');assert.ok(live.h.hub.run(live.run.run_id).ended_at);
});
