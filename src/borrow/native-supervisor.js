'use strict';
const {performance}=require('node:perf_hooks');
const {createHmac}=require('node:crypto');
const C=require('./native-codec');
const unavailable=()=>new Error('Setups helper is unavailable');
function bootstrap(config,budgetMs){
 if(!C.closed(config,['profile','app','generation','mode','authority_hash'])||typeof config.generation!=='bigint'||config.generation<=0n||![1,2].includes(config.mode)||!C.nonzero(C.bytes(config.authority_hash,32)))throw unavailable();
 const key=C.randomBytes(32),nonce=C.randomBytes(16),w=new C.Writer(C.LIMITS.bootstrap).raw(Buffer.from('PFBOOT03')).u32(3).u32(config.mode).u64(config.generation).u32(budgetMs).raw(key).raw(nonce).raw(config.authority_hash);
 for(const root of [config.profile,config.app]){if(!C.closed(root,['path','stamp'])||typeof root.path!=='string'||!root.path.startsWith('/')||root.path.includes('\0')||Buffer.byteLength(root.path)>4096||new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(root.path))!==root.path)throw unavailable();w.blob(Buffer.from(root.path),4096);C.writeStamp(w,root.stamp);}
 const body=w.finish(),prefix=Buffer.alloc(4);prefix.writeUInt32BE(body.length);return {key,nonce,bytes:Buffer.concat([prefix,body])};
}
// Main-only factory: launch is fixed by trusted construction; there is no
// executable, argv, environment or descriptor override accepted by open().
function createNativeSupervisor({launch,now=()=>performance.now(),current=()=>false,childMs=8000,terminateMs=250}={}){
 if(typeof launch!=='function'||typeof current!=='function'||childMs<=terminateMs||childMs>8000||terminateMs<1||terminateMs>1000)throw unavailable();
 const sessions=new Set();let blocked=false;
 async function open(config,overallCutoff=Infinity){
  if(blocked||[...sessions].some(s=>s.reapPending)||current()!==true||!Number.isFinite(overallCutoff))throw unavailable();
  const deadline=Math.min(now()+childMs,overallCutoff),workCutoff=deadline-terminateMs,budget=Math.floor(workCutoff-now());if(budget<1)throw unavailable();
  const auth=bootstrap(config,budget);let child;
  try{child=launch({args:[],env:{},shell:false,stdio:['pipe','pipe','pipe','pipe']});}catch{C.wipe(auth);throw unavailable();}
  if(!child||!Number.isSafeInteger(child.pid)||child.pid<=1||!child.stdin||!child.stdout||!child.stderr||!child.stdio?.[3]){C.wipe(auth);blocked=true;if(child&&Number.isSafeInteger(child.pid)&&child.pid>1){child.once?.('close',()=>{blocked=false;});try{child.kill?.('SIGKILL');}catch{}}throw unavailable();}
  let retired=false,closed=false,buffer=Buffer.alloc(0),waiter=null,pending=null,sequence=0,aggregate=0,stderrBytes=0,exitCode=null;
  let exitResolve,retireResolve;const exited=new Promise(resolve=>{exitResolve=resolve;}),retiredSignal=new Promise(resolve=>{retireResolve=resolve;});
  const result={get cutoff(){return workCutoff;},get nativeCutoff(){return result._nativeCutoff;},get session(){return {key:Buffer.from(auth.key),nonce:Buffer.from(auth.nonce)};},get reapPending(){return retired&&!closed;}};
  const reject=()=>{if(waiter){const v=waiter;waiter=null;v.reject(unavailable());}};
  function retire(){if(retired)return;retired=true;retireResolve();reject();try{child.kill('SIGKILL');}catch{}C.wipe(buffer);buffer=Buffer.alloc(0);}
  const timer=setTimeout(retire,Math.max(1,workCutoff-now()));timer.unref?.();
  child.once('error',retire);child.once('close',code=>{closed=true;exitCode=code;retireResolve();reject();exitResolve();});
  child.stdout.on('data',chunk=>{
   if(retired||closed)return;const b=Buffer.from(chunk);if(b.length>C.LIMITS.payload+72-buffer.length){retire();return;}buffer=Buffer.concat([buffer,b]);pump();
  });
  child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>64*1024)retire();});
  child.stdout.once('error',retire);child.stdin.once('error',retire);child.stdio[3].once('error',retire);
  function valid(){try{return !retired&&!closed&&now()<workCutoff&&current()===true;}catch{return false;}}
  function pump(){if(!waiter)return;let size=waiter.size;
   if(size===null){if(buffer.length<40)return;const n=buffer.readUInt32BE(36);if(n>C.LIMITS.payload){retire();return;}size=n+72;}
   if(buffer.length<size)return;if(buffer.length!==size){retire();return;}const bytes=buffer;buffer=Buffer.alloc(0);const v=waiter;waiter=null;if(!valid()){C.wipe(bytes);v.reject(unavailable());retire();return;}v.resolve(bytes);
  }
  function read(size){if(!valid()||waiter)throw unavailable();return new Promise((resolve,reject)=>{waiter={size,resolve,reject};pump();});}
  async function write(stream,bytes){if(!valid())throw unavailable();await new Promise((resolve,reject)=>{const onClose=()=>{cleanup();reject(unavailable());};const cleanup=()=>{stream.removeListener('close',onClose);};stream.once('close',onClose);try{stream.write(bytes,error=>{cleanup();error?reject(unavailable()):resolve();});}catch{cleanup();reject(unavailable());}});if(!valid())throw unavailable();}
  function bounded(promise){return new Promise((resolve,reject)=>{let t;retiredSignal.then(()=>{clearTimeout(t);reject(unavailable());});t=setTimeout(()=>{retire();reject(unavailable());},Math.max(1,workCutoff-now()));Promise.resolve(promise).then(v=>{clearTimeout(t);if(valid())resolve(v);else reject(unavailable());},()=>{clearTimeout(t);retire();reject(unavailable());});});}
  result.request=async(op,payload=Buffer.alloc(0))=>{
   if(!valid()||pending||sequence>=64)throw unavailable();const nonce=C.randomBytes(16);pending={op,nonce,sequence};const wire=C.frame(auth,op,sequence,nonce,payload);
   // Reserve the exact native worst reply before any request side effect.
   const worst=op===0x30?C.LIMITS.snapshot+104:op===0x31||op===0x35?C.LIMITS.receipt+16384+104:op>=0x32&&op<=0x34?C.LIMITS.receipt+104:op===0x44?C.LIMITS.receipt+104:op===0x41?360:op===0x48?10368:104;
   if(wire.length+worst>C.LIMITS.aggregate-aggregate){retire();throw unavailable();}
   try{const incoming=read(null);const [,raw]=await bounded(Promise.all([write(child.stdin,wire),incoming]));let out;try{out=C.reply(auth,pending,raw);aggregate+=wire.length+raw.length;sequence++;if(!valid()){C.wipe(out);throw unavailable();}return out;}finally{raw.fill(0);}}catch{retire();throw unavailable();}finally{C.wipe(wire);C.wipe(pending);pending=null;}
  };
  result.close=async()=>{
   if(!retired){retired=true;retireResolve();reject();try{child.stdin.end();child.stdio[3].end();}catch{}}
   clearTimeout(timer);await new Promise(resolve=>{const t=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}resolve();},Math.max(1,deadline-now()));exited.then(()=>{clearTimeout(t);resolve();});});
   if(!closed){blocked=true;child.once('close',()=>{if([...sessions].every(s=>!s.reapPending))blocked=false;});}
   C.wipe(auth);C.wipe(buffer);if(closed)sessions.delete(result);else child.once('close',()=>sessions.delete(result));return {status:closed?'closed':'reap_pending',exit_code:exitCode};
  };
  sessions.add(result);
  try{const waiting=read(48);const [,ack]=await bounded(Promise.all([write(child.stdio[3],auth.bytes),waiting]));if(!C.same(ack.subarray(0,8),Buffer.from('PFACK003')))throw unavailable();const mac=createHmac('sha256',auth.key).update(Buffer.from('PF-BOOT-ACK-V1\0')).update(auth.nonce).update(ack.subarray(0,16)).digest();if(!C.same(mac,ack.subarray(16)))throw unavailable();result._nativeCutoff=ack.readBigUInt64BE(8);if(!result._nativeCutoff)throw unavailable();C.wipe(auth.bytes);return result;}catch{retire();await result.close();throw unavailable();}
 }
 return {open,invalidate(){for(const s of sessions)void s.close();},get blocked(){return blocked;}};
}
module.exports={createNativeSupervisor,bootstrap};
