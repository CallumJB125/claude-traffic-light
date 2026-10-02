import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkflowExecutor} from '../workflow-executor.js';
import {until} from './helpers.js';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function coordinator(){
 const reads=[],admitted=[],checked=[],paused=[];
 const service=Object.assign(Object.create(WorkflowExecutor.prototype),{pending:new Set(),draining:false,closed:false,
  db:{get(sql,id){reads.push(id);return sql.includes('board_id')?{board_id:'synthetic-board'}:{credential_kind:'device',credential_id:'synthetic-credential'};}},
  hub:{withBoard:async(_id,fn)=>fn(),txn:fn=>fn()},core:{pause(id){paused.push(id);}},
  authority(id){checked.push(id);return {row:{revision:0},member:{id:'synthetic-member'},authorization:{selection:['synthetic-board']}};},
  bound:()=>({}),admit:id=>admitted.push(id),executionProjection:()=>({})
 });return {service,reads,admitted,checked,paused};
}
test('observed IDs beyond16 drain fairly without another event, coalesce duplicates and retain fresh checks',async()=>{
 const {service,admitted,checked,paused}=coordinator(),ids=Array.from({length:33},(_,i)=>`observed-${i}`);
 for(const id of ids){service.wake(id);service.wake(id);}
 await turn();assert.equal(admitted.length,16,'first event-loop turn is bounded to16 executions');
 await until(()=>!service.draining);assert.deepEqual(admitted,ids);assert.deepEqual(checked,ids);assert.deepEqual(paused,[]);assert.equal(service.pending.size,0);
 await turn();assert.equal(admitted.length,33,'no polling or synthesized retry');
});
test('close during the inter-batch yield discards only pending wakes and touches no more database rows',async()=>{
 const {service,admitted,reads}=coordinator();for(let i=0;i<33;i++)service.wake(`observed-${i}`);
 await turn();assert.equal(admitted.length,16);const count=reads.length;service.close();service.wake('after-close');
 await until(()=>!service.draining);assert.equal(reads.length,count);assert.equal(admitted.length,16);assert.equal(service.pending.size,0);
});
test('one failed current-authority and failed pause does not lose another observed wake or create a retry',async()=>{
 const {service,admitted,checked,paused}=coordinator(),authority=service.authority;
 service.authority=function(id){if(id==='revoked'){checked.push(id);throw Error('Synthetic current credential refusal');}return authority.call(this,id);};
 service.core.pause=id=>{paused.push(id);throw Error('Synthetic cleanup refusal');};
 service.wake('revoked');service.wake('allowed');await until(()=>!service.draining);
 assert.deepEqual(checked,['revoked','allowed']);assert.deepEqual(paused,['revoked']);assert.deepEqual(admitted,['allowed']);assert.equal(service.pending.size,0);
 await turn();assert.deepEqual(checked,['revoked','allowed']);
});
test('close while failure cleanup awaits its board queue withholds the late pause',async()=>{
 const {service,paused}=coordinator();let release,entered=false,calls=0;
 service.authority=()=>{throw Error('Synthetic current authority refusal');};
 service.hub.withBoard=async(_id,fn)=>{if(++calls===2){entered=true;await new Promise(resolve=>release=resolve);}return fn();};
 service.wake('revoked');await until(()=>entered);service.close();release();await until(()=>!service.draining);
 assert.deepEqual(paused,[]);assert.equal(service.pending.size,0);
});
