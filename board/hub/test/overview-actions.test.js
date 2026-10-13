import test from 'node:test';
import assert from 'node:assert/strict';
import Overview from '../../../src/overview-service.js';
import { startHub } from './helpers.js';
test('Overview selected owned runner sends through actual fixed HTTP message route without delivery or resume claims',async()=>{
 const h=await startHub();try{
  const cookie=await h.login('alice'),device=await h.enroll(cookie),runner=await h.runner(device),run=await h.startRun(cookie,runner);
  let sentReply;const source={key:'synthetic-hub',kind:'team',current:()=>true,read:async()=>{const r=await h.api(cookie,'GET','/api/my-day');return {...r.body,ok:r.status===200};},open:async()=>true,send:async(row,text,requestId,fresh)=>{assert(fresh());const r=await h.api(cookie,'POST',`/api/cards/${encodeURIComponent(row.card.id)}/messages?board_id=${encodeURIComponent(row.board_id)}`,{request_id:requestId,expected_fence:row.card.fence,kind:'coordination',body:text,recipient_run_ids:[row.card.run.id]});sentReply=r.body;return{ok:r.status===200};}};
  const svc=Overview.createOverviewService({work:async()=>({sources:[source],capture:[]})});
  const state=await svc.snapshot(),row=state.sessions.find(r=>r.task.key===run.key);assert(row,JSON.stringify(state));assert.equal(row.capabilities.message.enabled,true);
  const before=JSON.stringify(h.db.all('SELECT request_id,state FROM dispatches'));
  assert.deepEqual(await svc.message({handle:row.handle,text:'Explicit selected task message'}),{ok:true,status:'queued',error:''});
  assert.equal(h.db.get('SELECT COUNT(*) n FROM task_messages').n,1);assert.equal(sentReply.message.auto_resume,false);assert.equal(JSON.stringify(h.db.all('SELECT request_id,state FROM dispatches')),before);
  assert.equal(runner.all('comment.deliver').length,0);
  assert.equal((await svc.message({handle:row.handle,text:'Repeat click'})).ok,false);assert.equal(h.db.get('SELECT COUNT(*) n FROM task_messages').n,1);
  const refresh=await svc.snapshot();h.db.run('UPDATE devices SET revoked_at=? WHERE id=?',h.hub.iso(),device.device_id);assert.equal((await svc.message({handle:refresh.sessions[0].handle,text:'Revoked runner'})).ok,false);assert.equal(h.db.get('SELECT COUNT(*) n FROM task_messages').n,1);
 }finally{await h.destroy();}
});
