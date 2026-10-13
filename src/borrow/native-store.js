'use strict';
// Fixed native store adapter. Main owns the supervisor/config/current closures.
// Each session shares the original automated cutoff; no filesystem IO in Node.
const C=require('./native-codec');
const {JOURNAL_LIMITS:L}=require('./transaction-journal');
const fail=()=>{throw new Error('Setups encrypted recovery is unavailable');};
function createNativeStore({supervisor,config,current,cutoff,id=null}) {
 if(!supervisor||typeof config!=='function'||typeof current!=='function'||!Number.isFinite(cutoff))fail();
 if(id!==null)C.uuid(id);let bound=id,created=false,busy=false;
 const valid=()=>{try{if(current()!==true)fail();}catch{fail();}};
 async function session(run,openTxn=true){valid();if(busy)fail();busy=true;let s;
  try{s=await supervisor.open(config(),cutoff);valid();const fixed=await s.request(0x40);valid();if(fixed.result!==0||fixed.body.length)fail();if(openTxn&&bound){const opened=await s.request(0x43,C.uuid(bound));valid();if(opened.result!==0||opened.body.length)fail();}return await run(s);}finally{if(s){const reaped=await s.close();if(reaped.status!=='closed')fail();}busy=false;}
 }
 async function request(s,op,bytes){valid();const out=await s.request(op,bytes);valid();if(out.result!==0){C.wipe(out);fail();}return out.body;}
 return {
  async admit(bytes,children){if(bound||created||!Number.isSafeInteger(bytes)||bytes<1||bytes>L.transaction||!Number.isInteger(children)||children<1||children>L.children)fail();return session(async s=>{const raw=await request(s,0x48);try{const inv=C.inventory(raw);if(inv.namespaces>=L.namespaces||inv.total_bytes+BigInt(bytes)>BigInt(L.total))fail();}finally{raw.fill(0);}},false);},
  async create(txn){if(bound||created)fail();C.uuid(txn);created=true;return session(async s=>{const body=await request(s,0x42,C.uuid(txn));if(body.length)fail();bound=txn;},false);},
  async write(role,index,sequence,bytes){if(!bound||!Buffer.isBuffer(bytes)||bytes.length<72)fail();const header=C.sealedHeader(bound,role,index,sequence,bytes.length-44);if(!C.same(header,bytes.subarray(0,44)))fail();return session(async s=>{const body=await request(s,0x45,new C.Writer().u32(role).u32(index).u32(sequence).blob(bytes,C.LIMITS.receipt).finish());if(body.length)fail();});},
  async sync(){if(!bound)fail();return session(async s=>{const body=await request(s,0x46);if(body.length)fail();});},
  async read(role,index,sequence){if(!bound)fail();C.sealedHeader(bound,role,index,sequence,4);return session(async s=>{const body=await request(s,0x44,new C.Writer().u32(role).u32(index).u32(sequence).finish());try{const r=new C.Reader(body),bytes=Buffer.from(r.blob(C.LIMITS.receipt));r.done();return bytes;}finally{body.fill(0);}});},
  async inventory(){return session(async s=>{const raw=await request(s,0x48);try{return C.inventory(raw);}finally{raw.fill(0);}});},
  async list(){return session(async s=>{const raw=await request(s,0x41);try{const r=new C.Reader(raw),n=r.u32();if(n>16)fail();const ids=Array.from({length:n},()=>C.uuidText(r.raw(16)));r.done();if(new Set(ids).size!==ids.length)fail();return ids;}finally{raw.fill(0);}},false);},
 };
}
module.exports={createNativeStore};
