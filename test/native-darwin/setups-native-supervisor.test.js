'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const {spawn}=require('node:child_process');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const C=require('../../src/borrow/native-codec');
const {createNativeSupervisor}=require('../../src/borrow/native-supervisor');
const {fixture}=require('../helpers/setups-native/runtime');
const helper=process.env.PLEXIFORM_TEST_HELPER;
const config=f=>({...f.roots(),mode:1,generation:2n,authority_hash:C.hash(Buffer.from('synthetic-only'))});
test('owned fixed Node channels bootstrap, fragment requests, authenticate and observe close',async t=>{const f=fixture(t,helper),s=await f.sup.open(config(f),performance.now()+8000);const out=await s.request(0x30,new C.Writer().u32(1).finish());assert.equal(out.result,0);assert.equal(typeof s.nativeCutoff,'bigint');assert.equal((await s.close()).status,'closed');assert.equal(s.reapPending,false);await assert.rejects(s.request(0x30));});
test('current authority loss withholds a successful response and captured child is reaped',async t=>{const f=fixture(t,helper),s=await f.sup.open(config(f),performance.now()+8000);f.state.foreground=false;await assert.rejects(s.request(0x30,new C.Writer().u32(1).finish()));assert.equal((await s.close()).status,'closed');assert.ok(f.state.children.every(c=>c.exitCode!==null||c.signalCode!==null));});
test('bootstrap absolute cutoff kills child that never acknowledges',async t=>{
 const f=fixture(t,helper),kills=[];let child,resolveClose,completed=false;
 // Install the observation inside launch, before the supervisor can retire it.
 const closed=new Promise(resolve=>{resolveClose=resolve;});
 const waitForClose=()=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('owned cutoff child did not close after SIGKILL')),2000);
  closed.then(value=>{clearTimeout(timer);resolve(value);});
 });
 t.after(async()=>{if(!completed&&child){try{child.kill('SIGKILL');}catch{}await waitForClose().catch(()=>{});}});
 const sup=createNativeSupervisor({current:()=>true,childMs:200,terminateMs:50,launch:o=>{
  const c=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],o);child=c;
  c.once('close',(code,signal)=>resolveClose({code,signal,at:performance.now()}));
  const kill=c.kill.bind(c);c.kill=signal=>{
   const call={signal,at:performance.now()};kills.push(call);
   try{call.result=kill(signal);return call.result;}catch(error){call.error=error.code??error.name;throw error;}
  };return c;
 }});
 const start=performance.now();await assert.rejects(sup.open(config(f),start+200));
 const rejectedAt=performance.now();assert.ok(rejectedAt-start<1000);
 assert.ok(kills.some(call=>call.signal==='SIGKILL'&&call.result===true&&call.at<=rejectedAt),JSON.stringify(kills));
 // open() may reject while close is still being observed (reap_pending).
 // Independently prove this owned child actually died; do not retry open().
 const receipt=await waitForClose();
 assert.equal(receipt.signal,'SIGKILL',JSON.stringify({kills,receipt}));
 assert.equal(child.signalCode,'SIGKILL');completed=true;
});
test('an expired launch budget blocks renewal until the captured child close is observed',async t=>{
 const f=fixture(t,helper),children=[];let clock=0;
 t.after(()=>{for(const record of children){record.close();for(const stream of record.child.stdio)stream.destroy();}});
 const sup=createNativeSupervisor({now:()=>clock,current:()=>true,childMs:200,terminateMs:50,launch:()=>{
  const child=new EventEmitter();child.pid=1000000+children.length;
  child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.stdio=[child.stdin,child.stdout,child.stderr,new PassThrough()];
  const kills=[];child.kill=signal=>{kills.push(signal);return true;};
  let closed=false;const record={child,kills,close(){if(!closed){closed=true;child.emit('close',null,'SIGKILL');}}};
  children.push(record);
  clock+=201; // Synchronous launch consumed the entire original 200ms budget.
  return child;
 }});
 await assert.rejects(sup.open(config(f),clock+200));
 assert.equal(children.length,1);assert.ok(children[0].kills.includes('SIGKILL'));
 assert.equal(sup.blocked,true);
 await assert.rejects(sup.open(config(f),clock+200));assert.equal(children.length,1,'no new child while reap is pending');
 children[0].close();assert.equal(sup.blocked,false);
 const next=sup.open(config(f),clock+200);assert.equal(children.length,2,'the captured close permits a new launch');
 await assert.rejects(next);assert.equal(sup.blocked,true);
 children[1].close();assert.equal(sup.blocked,false);
});
test('malformed and duplicate native operations never renew a session',async t=>{const f=fixture(t,helper),s=await f.sup.open(config(f),performance.now()+8000);const out=await s.request(0x30,Buffer.alloc(0));assert.equal(out.result,1);await assert.rejects(s.request(0x30,new C.Writer().u32(1).finish()));assert.equal((await s.close()).status,'closed');});
