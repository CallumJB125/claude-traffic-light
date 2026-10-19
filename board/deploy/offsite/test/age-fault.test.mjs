import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AgeCipher } from '../age.mjs';
import { rig } from './helpers.mjs';

for(const fault of ['child-error','timeout','output-overflow'])test(`age process ${fault} aborts privately and releases child tracking`,async t=>{
  const r=rig(t),executable=path.join(r.root,'fake-age');
  const script=fault==='child-error'?"process.stderr.write('fixture PRIVATE_KEY path');process.exit(1);":fault==='timeout'?"process.stdin.resume();setInterval(()=>{},1000);":"process.stdin.resume();process.stdout.write(Buffer.alloc(10000));setInterval(()=>{},1000);";
  fs.writeFileSync(executable,`#!${process.execPath}\n${script}\n`,{mode:0o700});
  const cipher=new AgeCipher({executable,publicRecipient:'age1'+'q'.repeat(58),timeoutMs:fault==='timeout'?30:2000});
  await assert.rejects(cipher.encrypt(Readable.from(['private fixture bytes']),path.join(r.root,'incomplete.age'),10),e=>e.code==='ENCRYPTION'&&!e.message.includes('PRIVATE_KEY')&&!e.message.includes(r.root));
  assert.equal(cipher.active.size,0);cipher.close();
});
test('age refuses plugin/SSH recipients and private identities containing executable stanzas',t=>{
  const r=rig(t),executable=path.join(r.root,'fake-age'),identity=path.join(r.root,'identity.txt');
  fs.writeFileSync(executable,`#!${process.execPath}\nprocess.exit(0);\n`,{mode:0o700});
  for(const publicRecipient of ['age1plugin1fixture','ssh-ed25519 fixture','https://key.example.test'])assert.throws(()=>new AgeCipher({executable,publicRecipient}),e=>e.code==='KEY');
  fs.writeFileSync(identity,'AGE-PLUGIN-IDENTITY-1fixture\n',{mode:0o600});assert.throws(()=>new AgeCipher({executable,identity}),e=>e.code==='KEY');
});

test('stalled input and noncooperative return cannot retain the age deadline or active job',async t=>{
  const r=rig(t),executable=path.join(r.root,'fake-age');
  fs.writeFileSync(executable,`#!${process.execPath}\nprocess.stdin.resume();setInterval(()=>{},1000);\n`,{mode:0o700});
  let returned=0,advanced=0;
  const input={ [Symbol.asyncIterator](){return this;},next(){advanced++;return new Promise(()=>{});},return(){returned++;return new Promise(()=>{});} };
  const cipher=new AgeCipher({executable,publicRecipient:'age1'+'q'.repeat(58),timeoutMs:30});
  const operation=cipher.encrypt(input,path.join(r.root,'pending.age'),1024).then(()=> 'unexpected success',e=>e.code);
  let timer;const timeout=new Promise(resolve=>timer=setTimeout(()=>resolve('still pending'),300));
  const outcome=await Promise.race([operation,timeout]);clearTimeout(timer);cipher.close();
  assert.equal(outcome,'ENCRYPTION');assert.equal(cipher.active.size,0);assert.equal(advanced,1);assert.equal(returned,1);
});
test('blocked child stdin backpressure cancels without advancing further input',async t=>{
  const r=rig(t),executable=path.join(r.root,'fake-age');
  fs.writeFileSync(executable,`#!${process.execPath}\nsetInterval(()=>{},1000);\n`,{mode:0o700});
  let advanced=0,returned=0;const b=Buffer.alloc(1024*1024);
  const input={ [Symbol.asyncIterator](){return this;},async next(){advanced++;return {done:false,value:b};},async return(){returned++;return {done:true};} };
  const cipher=new AgeCipher({executable,publicRecipient:'age1'+'q'.repeat(58),timeoutMs:50});
  await assert.rejects(cipher.encrypt(input,path.join(r.root,'pending.age'),1024),e=>e.code==='ENCRYPTION');
  assert.equal(advanced,1);assert.equal(returned,1);assert.equal(cipher.active.size,0);
});
test('explicit close cancels a stalled iterator and waits for child close without later writes',async t=>{
  const r=rig(t),executable=path.join(r.root,'fake-age');
  fs.writeFileSync(executable,`#!${process.execPath}\nprocess.stdin.resume();setInterval(()=>{},1000);\n`,{mode:0o700});
  let finishNext,advanced=0,returned=0;
  const input={ [Symbol.asyncIterator](){return this;},next(){advanced++;return new Promise(resolve=>finishNext=resolve);},return(){returned++;return new Promise(()=>{});} };
  const cipher=new AgeCipher({executable,publicRecipient:'age1'+'q'.repeat(58)});
  const operation=cipher.encrypt(input,path.join(r.root,'pending.age'),1024).then(()=> 'unexpected success',e=>e.code);
  setTimeout(()=>cipher.close(),30);let timer;
  const outcome=await Promise.race([operation,new Promise(resolve=>timer=setTimeout(()=>resolve('still pending'),300))]);clearTimeout(timer);cipher.close();
  assert.equal(outcome,'ENCRYPTION');assert.equal(cipher.active.size,0);assert.equal(returned,1);
  finishNext({done:false,value:Buffer.from('late bytes')});await new Promise(resolve=>setImmediate(resolve));assert.equal(advanced,1);
});

test('an observed early child close cannot wait for unbounded input',async t=>{
  const r=rig(t),executable=path.join(r.root,'fake-age');
  const ready=path.join(r.root,'child-ready'),release=path.join(r.root,'child-release');
  // Measure close handling after actual process readiness. A cold Node launch
  // can exceed 300 ms; the cipher's separate deadline must not make this pass.
  fs.writeFileSync(executable,`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0);},10);\n`,{mode:0o700});
  let advanced=0,returned=0;
  const input={[Symbol.asyncIterator](){return this;},next(){advanced++;return new Promise(()=>{});},return(){returned++;return new Promise(()=>{});}};
  const cipher=new AgeCipher({executable,publicRecipient:'age1'+'q'.repeat(58),timeoutMs:10000});
  t.after(()=>cipher.close());
  const operation=cipher.encrypt(input,path.join(r.root,'early.age'),1024).then(()=> 'unexpected success',e=>e.code);
  const started=Date.now();
  while(!fs.existsSync(ready)&&Date.now()-started<5000)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(fs.existsSync(ready),'real child must be ready before close handling is timed');
  let timer;const pending=new Promise(resolve=>timer=setTimeout(()=>resolve('still pending'),300));
  fs.writeFileSync(release,'exit',{mode:0o600});
  const outcome=await Promise.race([operation,pending]);clearTimeout(timer);cipher.close();
  assert.equal(outcome,'ENCRYPTION');assert.equal(cipher.active.size,0);assert.equal(advanced,1);assert.equal(returned,1);
});

test('synchronous input next errors remain private and release child tracking',async t=>{
  const r=rig(t),executable=path.join(r.root,'fake-age');
  fs.writeFileSync(executable,`#!${process.execPath}\nsetInterval(()=>{},1000);\n`,{mode:0o700});
  let returned=0;
  const input={[Symbol.asyncIterator](){return this;},next(){throw new Error('fixture private source');},return(){returned++;return new Promise(()=>{});}};
  const cipher=new AgeCipher({executable,publicRecipient:'age1'+'q'.repeat(58),timeoutMs:10000});
  t.after(()=>cipher.close());
  await assert.rejects(cipher.encrypt(input,path.join(r.root,'sync.age'),1024),e=>e.code==='ENCRYPTION'&&!e.message.includes('private source')&&!e.message.includes(r.root));
  assert.equal(cipher.active.size,0);assert.equal(returned,1);
});
