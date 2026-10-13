import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { prepare, upload, retrieve } from '../offsite-lib.mjs';
import { prefix, encode, hash, cipherMax, signedCompletion, OffsiteError } from '../schema.mjs';
import { source, consume, locked } from '../files.mjs';
import { rig, fixtureCipher, MemoryStore } from './helpers.mjs';

async function remote(t) {
  const r=rig(t),cipher=fixtureCipher(),store=new MemoryStore();
  const p=await prepare({...r.options,bundle:r.bundle,cipher,policy:{chunkBytes:4096}});
  const options={...r.options,transport:p.transport_id,trustedKeys:r.trustedKeys,store,wait:async()=>{}};
  await upload(options);return {...r,p,cipher,store,options,base:prefix(r.installation,p.transport_id)};
}
async function signedManifest(r, change) {
  const original=path.join(r.outbox,r.p.transport_id,'manifest.age'),plain=path.join(r.root,'inspect.json');
  await r.cipher.decrypt(source(original),plain,16*1024**2);
  const manifest=JSON.parse(fs.readFileSync(plain));change(manifest);
  const encrypted=path.join(r.root,'changed.age');
  const wire=await r.cipher.encrypt(Readable.from([encode(manifest)]),encrypted,cipherMax(16*1024**2));
  const c=JSON.parse(r.store.bytes.get(r.base+'completion.json'));
  r.store.bytes.set(r.base+'manifest.age',fs.readFileSync(encrypted));
  r.store.bytes.set(r.base+'completion.json',encode(signedCompletion({...c,manifest:{name:'manifest.age',...wire}},r.signing.privateKey)));
}
for(const fault of ['path','missing-chunk','reordered-chunks','duplicate-file','part-length','zero-chunk','aggregate-limit','database-hash','extra-field']) {
  test(`a correctly signed but invalid encrypted manifest rejects ${fault} before publication`,async t=>{
    const r=await remote(t),destination=path.join(r.root,'recovered');
    await signedManifest(r,m=>{
      if(fault==='path')m.files[0].file='../outside';
      if(fault==='missing-chunk')m.files[0].parts.pop();
      if(fault==='reordered-chunks')m.files[0].parts.reverse();
      if(fault==='duplicate-file')m.files[1]=m.files[0];
      if(fault==='part-length')m.files[0].parts[0].plain_bytes++;
      if(fault==='zero-chunk')m.chunk_bytes=0;
      if(fault==='aggregate-limit')m.paired.database.byte_length=4*1024**3+1;
      if(fault==='database-hash')m.paired.database.sha256='0'.repeat(64);
      if(fault==='extra-field')m.next_url='https://private.example.test';
    });
    const before=r.store.calls.filter(c=>c[0]==='get'&&/\/\d{6}\.age$/.test(c[1])).length;
    await assert.rejects(retrieve({...r.options,cipher:r.cipher,destination}));
    assert.equal(fs.existsSync(destination),false);assert.equal(fs.existsSync(path.join(r.root,'outside')),false);
    assert.ok(!fs.readdirSync(r.root).some(n=>n.startsWith('.retrieve-')));
    assert.deepEqual(fs.readFileSync(path.join(r.data,'client-artifacts',`${r.id}.bin`)),r.bytes);
    if(fault!=='database-hash')assert.equal(r.store.calls.filter(c=>c[0]==='get'&&/\/\d{6}\.age$/.test(c[1])).length,before,'invalid mapping is rejected before new data fetch');
  });
}
for(const field of ['installation_id','transport_id'])test(`valid signature cannot substitute expected ${field}`,async t=>{
  const r=await remote(t),c=JSON.parse(r.store.bytes.get(r.base+'completion.json'));
  r.store.bytes.set(r.base+'completion.json',encode(signedCompletion({...c,[field]:randomUUID()},r.signing.privateKey)));
  await assert.rejects(retrieve({...r.options,cipher:r.cipher,destination:path.join(r.root,'new')}),e=>e.code==='SIGNATURE');
});
for(const fault of ['advertised-oversize','actual-overflow','stalled-body','malformed-body'])test(`bounded retrieval rejects ${fault} and removes its temporary work`,async t=>{
  const r=await remote(t),get=r.store.get.bind(r.store);let stream;
  r.store.get=async(key,opts)=>{
    const result=await get(key,opts);if(!key.endsWith('/completion.json'))return result;
    result.body.destroy();
    if(fault==='advertised-oversize')return {byte_length:8193,body:Readable.from([Buffer.alloc(8193)])};
    if(fault==='actual-overflow')return {byte_length:result.byte_length,body:Readable.from([Buffer.alloc(8193)])};
    if(fault==='malformed-body')return {byte_length:result.byte_length,body:{destroy(){}}};
    stream=new Readable({read(){}});return {byte_length:result.byte_length,body:stream};
  };
  const destination=path.join(r.root,'new');
  await assert.rejects(retrieve({...r.options,cipher:r.cipher,destination,timeoutMs:20}),e=>fault==='stalled-body'?e.code==='RETRY':['BYTES','LIMITS'].includes(e.code));
  assert.equal(fs.existsSync(destination),false);assert.ok(!fs.readdirSync(r.root).some(n=>n.startsWith('.retrieve-')));
  if(stream)assert.equal(stream.destroyed,true);
});

// Real synchronous file errors at durability boundaries, while retaining the
// actual paired backup and private-file implementation beneath the injection.
async function fsyncFault(matches, fn) {
  const open=fs.openSync,close=fs.closeSync,sync=fs.fsyncSync,files=new Map();
  fs.openSync=(file,...args)=>{const fd=open(file,...args);files.set(fd,String(file));return fd;};
  fs.closeSync=fd=>{files.delete(fd);return close(fd);};
  fs.fsyncSync=fd=>{if(matches(files.get(fd)??''))throw Object.assign(new Error('fixture sync failure'),{code:'EIO'});return sync(fd);};
  try{return await fn();}finally{fs.openSync=open;fs.closeSync=close;fs.fsyncSync=sync;}
}
test('ready-marker fsync failure leaves no usable pending set and preserves original paired source',async t=>{
  const r=rig(t);await fsyncFault(file=>file.endsWith('/ready.json'),async()=>{
    await assert.rejects(prepare({...r.options,bundle:r.bundle,cipher:fixtureCipher()}),e=>e.code==='EIO');
  });
  assert.deepEqual(fs.readdirSync(r.outbox),[]);assert.ok(fs.existsSync(path.join(r.bundle,'manifest.json')));
  assert.deepEqual(fs.readFileSync(path.join(r.data,'client-artifacts',`${r.id}.bin`)),r.bytes);
});
test('receipt fsync failure reports failure; restart verifies the completed remote set without new PUTs',async t=>{
  const r=rig(t),cipher=fixtureCipher(),store=new MemoryStore(),p=await prepare({...r.options,bundle:r.bundle,cipher});
  const options={...r.options,transport:p.transport_id,trustedKeys:r.trustedKeys,store};let completed=false;
  store.hook=(kind,key)=>{if(kind==='get'&&key.endsWith('/completion.json')&&store.bytes.has(key))completed=true;};
  await fsyncFault(file=>completed&&path.basename(file).startsWith('.state-'),async()=>{
    await assert.rejects(upload(options),e=>e.code==='EIO');
  });
  assert.equal(fs.existsSync(path.join(r.outbox,p.transport_id,'receipt.json')),false);
  assert.ok([...store.bytes.keys()].at(-1).endsWith('/completion.json'));
  const count=store.calls.filter(c=>c[0]==='put').length;await upload(options);
  assert.equal(store.calls.filter(c=>c[0]==='put').length,count);assert.ok(fs.existsSync(path.join(r.outbox,p.transport_id,'receipt.json')));
});
test('source retention deleting the original during encryption cannot remove the staged snapshot',async t=>{
  const r=rig(t),real=fixtureCipher();let first=true;
  const cipher={async encrypt(...args){if(first){first=false;fs.rmSync(r.bundle,{recursive:true});}return real.encrypt(...args);}};
  const p=await prepare({...r.options,bundle:r.bundle,cipher});assert.ok(fs.existsSync(path.join(r.outbox,p.transport_id,'ready.json')));
});
test('unknown owner and interrupted reaper locks require repair and are never reclaimed',async t=>{
  const r=rig(t),lock=path.join(r.outbox,'.lock');fs.mkdirSync(lock,{mode:0o700});
  await assert.rejects(locked(r.outbox,async()=>{}),e=>e.code==='LOCKED');assert.ok(fs.existsSync(lock));
  fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:2147483647,token:randomUUID()}),{mode:0o600});
  fs.mkdirSync(path.join(r.outbox,'.reaper'),{mode:0o700});
  await assert.rejects(locked(r.outbox,async()=>{}),e=>e.code==='LOCKED');assert.ok(fs.existsSync(lock));
});
test('symlink source and private-mode violations cannot prepare or upload bytes',async t=>{
  const r=rig(t),cipher=fixtureCipher(),db=path.join(r.bundle,'board.db'),saved=db+'.saved';fs.renameSync(db,saved);fs.symlinkSync(saved,db);
  await assert.rejects(prepare({...r.options,bundle:r.bundle,cipher}));assert.deepEqual(fs.readdirSync(r.outbox),[]);
  fs.chmodSync(r.outbox,0o755);await assert.rejects(prepare({...r.options,bundle:r.bundle,cipher}),e=>e.code==='PRIVATE_MODE');
});
test('stalled PUT is bounded without a completion or receipt',async t=>{
  const r=rig(t),store=new MemoryStore(),p=await prepare({...r.options,bundle:r.bundle,cipher:fixtureCipher()});
  store.put=()=>new Promise(()=>{});
  await assert.rejects(upload({...r.options,store,transport:p.transport_id,trustedKeys:r.trustedKeys,attempts:1,timeoutMs:20}),e=>e.code==='MISSING');
  assert.equal(store.bytes.size,0);assert.equal(fs.existsSync(path.join(r.outbox,p.transport_id,'receipt.json')),false);
});

test('explicit local pruning rechecks all remote bytes and removes only a complete selected outbox',async t=>{
  const {pruneConfirmed}=await import('../offsite-lib.mjs');const r=await remote(t);
  const pending=await prepare({...r.options,bundle:r.bundle,cipher:r.cipher});
  const calls=r.store.calls.length;await pruneConfirmed(r.options);
  assert.equal(fs.existsSync(path.join(r.outbox,r.p.transport_id)),false);
  assert.ok(fs.existsSync(path.join(r.outbox,pending.transport_id,'ready.json')));
  assert.ok(r.store.calls.slice(calls).every(c=>c[0]==='get'),'local cleanup has no remote writes/deletes');
  assert.ok(fs.existsSync(r.bundle));
});
test('local pruning cannot delete pending, tampered or missing remote sets',async t=>{
  const {pruneConfirmed}=await import('../offsite-lib.mjs');const r=await remote(t),dir=path.join(r.outbox,r.p.transport_id);
  const key=r.base+'000000.age',before=r.store.bytes.get(key);r.store.bytes.set(key,Buffer.alloc(before.length));
  await assert.rejects(pruneConfirmed(r.options),e=>e.code==='BYTES');assert.ok(fs.existsSync(path.join(dir,'ready.json')));
  r.store.bytes.set(key,before);r.store.bytes.delete(r.base+'completion.json');
  await assert.rejects(pruneConfirmed(r.options),e=>e.code==='MISSING');assert.ok(fs.existsSync(path.join(dir,'receipt.json')));
  const pending=await prepare({...r.options,bundle:r.bundle,cipher:r.cipher});
  await assert.rejects(pruneConfirmed({...r.options,transport:pending.transport_id}));
  assert.ok(fs.existsSync(path.join(r.outbox,pending.transport_id,'ready.json')));
});
