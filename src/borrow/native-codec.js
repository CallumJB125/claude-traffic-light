'use strict';
// Private binary data codecs. Decoding never grants filesystem/actor authority.
const {createHash,createHmac,timingSafeEqual,randomBytes}=require('node:crypto');
const LIMITS=Object.freeze({content:256*1024,snapshot:320*1024,receipt:704*1024,payload:768*1024,aggregate:4*1024*1024,frames:64,bootstrap:16*1024});
const fail=()=>{throw new Error('Setups native data is unavailable');};
const hash=b=>createHash('sha256').update(b).digest();
const same=(a,b)=>Buffer.isBuffer(a)&&Buffer.isBuffer(b)&&a.length===b.length&&timingSafeEqual(a,b);
const bytes=(b,n)=>{if(!Buffer.isBuffer(b)||b.length!==n)fail();return b;};
const nonzero=b=>b.some(x=>x!==0);
const closed=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join('|')===[...keys].sort().join('|');
class Reader {
 constructor(b,max=LIMITS.payload){if(!Buffer.isBuffer(b)||b.length>max)fail();this.b=b;this.at=0;}
 raw(n){if(!Number.isSafeInteger(n)||n<0||n>this.b.length-this.at)fail();const out=this.b.subarray(this.at,this.at+n);this.at+=n;return out;}
 u32(){return this.raw(4).readUInt32BE();} u64(){return this.raw(8).readBigUInt64BE();} i64(){return this.raw(8).readBigInt64BE();}
 blob(max){const n=this.u32();if(n>max)fail();return this.raw(n);} done(){if(this.at!==this.b.length)fail();}
}
class Writer {
 constructor(max=LIMITS.payload){this.parts=[];this.size=0;this.max=max;}
 raw(b){if(!Buffer.isBuffer(b)||b.length>this.max-this.size)fail();this.parts.push(b);this.size+=b.length;return this;}
 u32(n){if(!Number.isInteger(n)||n<0||n>0xffffffff)fail();const b=Buffer.alloc(4);b.writeUInt32BE(n);return this.raw(b);}
 u64(n){if(typeof n!=='bigint'||n<0n||n>0xffffffffffffffffn)fail();const b=Buffer.alloc(8);b.writeBigUInt64BE(n);return this.raw(b);}
 i64(n){if(typeof n!=='bigint'||n<-(1n<<63n)||n>=(1n<<63n))fail();const b=Buffer.alloc(8);b.writeBigInt64BE(n);return this.raw(b);}
 blob(b,max){if(!Buffer.isBuffer(b)||b.length>max)fail();return this.u32(b.length).raw(b);} finish(){return Buffer.concat(this.parts,this.size);}
}
const STAMP=['device','inode','size','uid','mode','links','mtime_seconds','mtime_nanoseconds','ctime_seconds','ctime_nanoseconds'];
function stamp(r){const s={};STAMP.forEach((k,i)=>s[k]=i<6?r.u64():r.i64());if(s.uid>0xffffffffn||s.mode>0o177777n||s.mtime_nanoseconds<0n||s.mtime_nanoseconds>999999999n||s.ctime_nanoseconds<0n||s.ctime_nanoseconds>999999999n)fail();return s;}
function writeStamp(w,s){if(!closed(s,STAMP))fail();STAMP.forEach((k,i)=>i<6?w.u64(s[k]):w.i64(s[k]));return w;}
function binding(r){const b={};for(const k of ['device','inode','uid','mode','gid','flags'])b[k]=r.u64();b.acl_hash=Buffer.from(r.raw(32));if(b.uid>0xffffffffn||b.gid>0xffffffffn||b.flags>0xffffffffn||b.mode>0o177777n)fail();return b;}
function writeBinding(w,b){for(const k of ['device','inode','uid','mode','gid','flags'])w.u64(b[k]);return w.raw(bytes(b.acl_hash,32));}
function bindingHash(snapshot){const domain=Buffer.alloc(16);domain.write('PF-BINDINGS-V1');const w=new Writer(8192).raw(domain).u32(snapshot.bindings.length).raw(snapshot.profile_hash);snapshot.bindings.forEach(b=>writeBinding(w,b));return hash(w.finish());}
function snapshot(b){
 const r=new Reader(b,LIMITS.snapshot),version=r.u32(),os=r.u32(),arch=r.u32(),format=r.u32();
 if(version!==1||os!==1||![1,2].includes(arch)||format!==1)fail();
 const recipe=r.u32(),exists=r.u32(),count=r.u32();if(recipe<1||recipe>3||exists>1||!count||count>64)fail();
 const out={recipe,exists:!!exists,arch,profile_hash:Buffer.from(r.raw(32)),bindings:[]};
 try{for(let i=0;i<count;i++){const v=binding(r);if((v.mode&0o170000n)!==0o040000n)fail();out.bindings.push(v);}
 out.stamp=stamp(r);out.gid=r.u64();out.flags=r.u64();out.content_hash=Buffer.from(r.raw(32));out.acl_hash=Buffer.from(r.raw(32));out.acl_tag=r.u32();const aclSize=r.u32();
 if(out.acl_tag>2||aclSize>32768||out.stamp.size>BigInt(LIMITS.content)||out.gid>0xffffffffn||out.flags>0xffffffffn)fail();
 out.acl=Buffer.from(r.raw(aclSize));out.attrs=[];
 for(let i=0;i<2;i++){const present=r.u32(),size=r.u32(),digest=Buffer.from(r.raw(32));if(present>1||size>8192||(!present&&size))fail();const content=Buffer.from(r.raw(size));if(!same(digest,present?hash(content):Buffer.alloc(32)))fail();out.attrs.push({present:!!present,bytes:content,hash:digest});}
 out.content=Buffer.from(r.raw(Number(out.stamp.size)));r.done();
 if(exists){if((out.stamp.mode&0o170000n)!==0o100000n||out.stamp.links!==1n||(out.stamp.mode&0o7022n)||out.flags||!same(hash(out.content),out.content_hash)||!same(hash(out.acl_tag===2?out.acl:Buffer.alloc(0)),out.acl_hash))fail();}
 else if(Object.values(out.stamp).some(v=>v!==0n)||out.gid||out.flags||nonzero(out.content_hash)||nonzero(out.acl_hash)||out.acl_tag||aclSize||out.attrs.some(a=>a.present||a.bytes.length))fail();
 out.raw=Buffer.from(b);out.digest=hash(Buffer.concat([Buffer.from('PF-SNAPSHOT-V1\0'),b]));out.binding_hash=bindingHash(out);return out;}catch(error){wipe(out);throw error;}
}
function meta(r){const m={stamp:stamp(r),gid:r.u64(),flags:r.u64(),acl_hash:Buffer.from(r.raw(32)),hash:Buffer.from(r.raw(32)),attrs:[]};if(m.stamp.size>BigInt(LIMITS.content))fail();for(let i=0;i<2;i++){const present=r.u64(),size=r.u64(),digest=Buffer.from(r.raw(32));if(present>1n||size>8192n||(!present&&size))fail();m.attrs.push({present,size,hash:digest});}return m;}
function nativeState(r){const start=r.at,s={recipe:r.u32(),phase:r.u32(),result:r.u32(),sequence:r.u32(),effect:r.u32(),existed:r.u32()};if(s.recipe<1||s.recipe>3||s.phase>8||s.result>8||s.sequence>8||s.effect>2||s.existed>1)fail();s.target=stamp(r);s.displaced=stamp(r);s.target_hash=Buffer.from(r.raw(32));s.displaced_hash=Buffer.from(r.raw(32));s.receipt_hold=Buffer.from(r.raw(64));s.profile=stamp(r);s.parent=stamp(r);s.hold=stamp(r);s.hold_binding=binding(r);s.hold_id=Buffer.from(r.raw(64));s.before=meta(r);s.stage=meta(r);s.accepted_after=meta(r);s.restore_stage=meta(r);s.snapshots=[meta(r),meta(r)];const n=r.u32();if(n>8)fail();s.records=Array.from({length:n},()=>meta(r));s.raw=Buffer.from(r.b.subarray(start,r.at));return s;}
function receipt(b){const r=new Reader(b,LIMITS.receipt),o={schema:r.u32(),action:r.u32(),target_index:r.u32(),sequence:r.u32(),effect:r.u32(),hold_status:r.u32(),result:r.u32()};if(o.schema!==2||o.action>2||o.target_index>=128||o.sequence>8||o.effect>2||o.hold_status>2||o.result>8)fail();try{o.transaction=Buffer.from(r.raw(16));o.plan_hash=Buffer.from(r.raw(32));o.intent_hash=Buffer.from(r.raw(32));o.record_hash=Buffer.from(r.raw(32));o.native=nativeState(r);o.objects=[];for(let i=0;i<2;i++){const tag=r.u32(),result=r.u32(),identity=stamp(r),raw=r.blob(LIMITS.snapshot);if(tag>3||result>8||([1,2].includes(tag)!==!!raw.length))fail();const s=raw.length?snapshot(raw):null;if(s&&(s.exists!==(tag===2)||STAMP.some(k=>s.stamp[k]!==identity[k])))fail();o.objects.push({tag,result,identity,snapshot:s});}r.done();o.raw=Buffer.from(b);return o;}catch(error){wipe(o);throw error;}}
const COMMON=['transaction','target_index','recipe','generation','cutoff','session_nonce'];
function fields(w,f,type){w.raw(bytes(f.transaction,16)).u32(f.target_index).u32(f.recipe);if(type==='permit')w.u32(f.action).u32(f.sequence);if(type==='recovery')w.u32(f.schema);w.u64(f.generation).u64(f.cutoff).raw(bytes(f.session_nonce,16));const sizes=type==='prepare'?[['nonce',16],...['plan_hash','before_hash','after_hash','binding_hash','prepared_record_hash'].map(k=>[k,32])]:type==='permit'?[['nonce',16],...['plan_hash','before_hash','stage_hash','binding_hash','intent_hash','native_record_hash','record_hash','previous_hash'].map(k=>[k,32])]:[['confirmation_nonce',16],...['profile_hash','plan_hash','record_hash','before_hash'].map(k=>[k,32])];sizes.forEach(([k,n])=>w.raw(bytes(f[k],n)));return w;}
function intent(b){const r=new Reader(b,16384);if(r.u32()!==2)fail();const f={transaction:Buffer.from(r.raw(16)),target_index:r.u32(),recipe:r.u32(),action:r.u32(),sequence:r.u32(),generation:r.u64(),cutoff:r.u64(),session_nonce:Buffer.from(r.raw(16))};for(const k of ['plan_hash','before_hash','stage_hash','binding_hash','native_record_hash'])f[k]=Buffer.from(r.raw(32));f.native=nativeState(r);r.done();if(f.target_index>=128||f.recipe<1||f.recipe>3||![1,2].includes(f.action)||!f.generation||!f.cutoff||f.sequence>8)fail();f.intent_hash=hash(b);f.raw=Buffer.from(b);return f;}
function frame(session,op,sequence,nonce,payload){if(!((op>=0x30&&op<=0x35)||(op>=0x40&&op<=0x48))||!Number.isInteger(sequence)||sequence<0||sequence>=64||!nonzero(bytes(nonce,16)))fail();bytes(session.key,32);bytes(session.nonce,16);const w=new Writer(LIMITS.payload+72).raw(Buffer.from('PFFRME02')).raw(Buffer.from([0,2,op>>8,op&255])).raw(nonce).u32(sequence).u32(0).blob(payload,LIMITS.payload),b=w.finish();const mac=createHmac('sha256',session.key).update(Buffer.from('PF-CHANNEL-V1\0')).update(session.nonce).update(b).digest();return Buffer.concat([b,mac]);}
function reply(session,pending,b){const r=new Reader(b,LIMITS.payload+72);if(!same(r.raw(8),Buffer.from('PFFRME02'))||r.raw(2).readUInt16BE()!==2||r.raw(2).readUInt16BE()!==(pending.op|0x8000)||!same(r.raw(16),pending.nonce)||r.u32()!==pending.sequence||r.u32()!==0)fail();const payload=r.blob(LIMITS.payload),mac=r.raw(32);r.done();const expected=createHmac('sha256',session.key).update(Buffer.from('PF-CHANNEL-V1\0')).update(session.nonce).update(b.subarray(0,-32)).digest();if(!same(mac,expected))fail();const p=new Reader(payload),result=p.u32(),effect=p.u32(),body=Buffer.from(p.blob(LIMITS.payload));p.done();if(result>8||![0,1,2,4].includes(effect))fail();return {result,effect,body};}
function uuid(s){if(typeof s!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s))fail();return Buffer.from(s.replaceAll('-',''),'hex');}
function uuidText(b){bytes(b,16);const h=b.toString('hex');const s=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;uuid(s);return s;}
function sealedHeader(id,role,index,sequence,size){if(!Number.isInteger(role)||role<0||role>5||!Number.isInteger(index)||index<0||index>=128||!Number.isInteger(sequence)||sequence<0||sequence>=64||!Number.isInteger(size)||size>LIMITS.receipt-44||size<0||(role===0&&(index||sequence))||(role===5&&index)||(role>0&&role<5&&sequence))fail();return new Writer(44).raw(Buffer.from('PFSEAL02')).u32(2).u32(role).u32(index).u32(sequence).raw(uuid(id)).u32(size).finish();}
function inventory(b){const r=new Reader(b,10264),namespaces=r.u32(),total=r.u64(),own=r.u64(),n=r.u32();if(namespaces>16||total>128n*1024n*1024n||own>64n*1024n*1024n||n>512||own>total)fail();const entries=[],seen=new Set();let sum=0n;for(let i=0;i<n;i++){const role=r.u32(),index=r.u32(),sequence=r.u32(),size=r.u64();if(size>BigInt(LIMITS.receipt))fail();sealedHeader('00000000-0000-4000-8000-000000000000',role,index,sequence,4);const id=role+':'+index+':'+sequence;if(seen.has(id))fail();seen.add(id);sum+=size;entries.push({role,index,sequence,bytes:size});}r.done();if(sum!==own)fail();return {namespaces,total_bytes:total,transaction_bytes:own,entries};}
function wipe(v){if(Buffer.isBuffer(v)){v.fill(0);return;}if(Array.isArray(v))v.forEach(wipe);else if(v&&typeof v==='object')Object.values(v).forEach(wipe);}
module.exports={LIMITS,Reader,Writer,STAMP,stamp,writeStamp,hash,same,bytes,nonzero,closed,snapshot,receipt,intent,fields,frame,reply,uuid,uuidText,sealedHeader,inventory,wipe,randomBytes,fail};
