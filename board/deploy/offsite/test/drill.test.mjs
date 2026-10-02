import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createBackup, validateBackup } from '../../pi/backup-lib.mjs';
import { AgeCipher } from '../age.mjs';
import { drill, NOT_PROVEN, REAL_PASSED } from '../drill.mjs';
import { prepare, upload } from '../offsite-lib.mjs';
import { prefix } from '../schema.mjs';
import { main } from '../cli.mjs';
import { rig, fixtureCipher, MemoryStore } from './helpers.mjs';
import { fakeS3 } from './fake-s3.mjs';

const AGE=process.env.OFFSITE_TEST_AGE,KEYGEN=process.env.OFFSITE_TEST_KEYGEN;
const cli=fileURLToPath(new URL('../cli.mjs',import.meta.url));
// R2-realistic default: uploader holds Object Read & Write (which includes
// delete) but the bucket lock refuses deletion; recovery holds Object Read.
const R2_LIKE={permissions:{uploader:['put','get','delete'],recovery:['get']},objectLock:true};

async function run(t,{fake=R2_LIKE,encryptCipher,decryptCipher,policy={chunkBytes:4096},big=false}={}){
  const r=rig(t),s=await fakeS3(t,fake),workDir=path.join(r.root,'drills');fs.mkdirSync(workDir,{mode:0o700});
  let bundle=r.bundle;
  if(big){r.conn.exec('CREATE TABLE filler(b BLOB)');r.conn.prepare('INSERT INTO filler VALUES (?)').run(randomBytes(300_000));bundle=createBackup({dataDir:r.data}).bundle;}
  const before=validateBackup(bundle),cipher=fixtureCipher();
  const out=await drill({bundle,workDir,installation:r.installation,recipientId:'recovery-a',signingKeyId:'signer-a',signingKey:r.signing.privateKey,
    trustedKeys:r.trustedKeys,encryptCipher:encryptCipher??cipher,decryptCipher:decryptCipher??cipher,
    uploaderStore:s.storeFor('uploader'),recoveryStore:s.storeFor('recovery'),policy});
  // Every outcome: original bundle untouched, drill plaintext removed, receipt private.
  assert.deepEqual(validateBackup(bundle),before);
  assert.deepEqual(fs.readdirSync(workDir),[path.basename(out.receiptFile)]);
  assert.equal(fs.statSync(out.receiptFile).mode&0o777,0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(out.receiptFile)),out.receipt);
  assert.equal(out.receipt.local_drill_plaintext_removed,true);
  return {...r,s,workDir,bundle,...out};
}
const failed=(receipt,step,error)=>{assert.equal(receipt.result,'failed');assert.equal(receipt.failed_step,step);assert.equal(receipt.error,error);assert.equal(receipt.offsite_acceptance,NOT_PROVEN);};

test('drill: encrypt, chunked put, probes, delete local, get, decrypt, verify and restore over HTTP fake; receipt refuses to claim acceptance',async t=>{
  const d=await run(t,{big:true,policy:{chunkBytes:65536}});
  assert.equal(d.receipt.result,'passed',JSON.stringify(d.receipt));assert.equal(d.receipt.error,null);
  assert.equal(d.receipt.offsite_acceptance,NOT_PROVEN);assert.match(d.receipt.acceptance_basis,/loopback-fixture/);
  assert.deepEqual(d.receipt.steps,{source_copied:true,encrypted:true,uploaded_and_read_back:true,local_source_deleted:true,decrypted_hashes_match_source:true,restored_integrity_ok:true});
  assert.deepEqual(d.receipt.probes,{uploader_delete_refused:true,recovery_write_refused:true,recovery_delete_refused:true});
  assert.ok(d.receipt.object_count>5,'database split across several bounded objects');
  const base='/fixture-private/'+prefix(d.installation,d.receipt.transport_id);
  assert.ok([...d.s.bytes.keys()].every(k=>k.startsWith(base)));assert.ok(d.s.bytes.has(base+'drill-canary.bin'));
  assert.ok(!Buffer.concat([...d.s.bytes.values()]).includes(d.bytes),'no plaintext artifact left the machine');
  assert.ok(d.s.calls.filter(c=>c.method==='PUT'&&c.access==='recovery').every(c=>!d.s.bytes.has(c.key)));
  assert.ok(d.s.calls.filter(c=>c.method==='GET'&&c.key.endsWith('.age')).some(c=>c.access==='recovery'),'retrieval used the recovery credential');
  assert.ok(!JSON.stringify(d.receipt).includes('fixture-secret'));
});

test('drill with genuine age: passes against fake and still reports NOT_PROVEN; wrong age identity fails at retrieval',{skip:!AGE||!KEYGEN},async t=>{
  const r0=rig(t),key=(n)=>{const f=path.join(r0.root,n);execFileSync(KEYGEN,['--output',f],{stdio:'ignore'});fs.chmodSync(f,0o600);return f;};
  const identity=key('id.txt'),publicRecipient=execFileSync(KEYGEN,['-y',identity],{encoding:'utf8'}).trim();
  const enc=new AgeCipher({executable:AGE,publicRecipient}),dec=new AgeCipher({executable:AGE,identity});
  const ok=await run(t,{encryptCipher:enc,decryptCipher:dec});
  assert.equal(ok.receipt.result,'passed',JSON.stringify(ok.receipt));assert.equal(ok.receipt.offsite_acceptance,NOT_PROVEN);
  for(const [k,b]of ok.s.bytes)if(k.endsWith('.age'))assert.ok(b.subarray(0,21).toString()==='age-encryption.org/v1');
  const wrong=await run(t,{encryptCipher:enc,decryptCipher:new AgeCipher({executable:AGE,identity:key('wrong.txt')})});
  failed(wrong.receipt,'retrieve-decrypt-verify','ENCRYPTION');
});

for(const [name,fake,step,error] of [
  ['uploader token that can delete (no bucket lock)',{permissions:{uploader:['put','get','delete'],recovery:['get']}},'privilege-probes','UPLOADER_CAN_DELETE'],
  ['recovery token that can write',{permissions:{uploader:['put','get'],recovery:['get','put']},objectLock:true},'privilege-probes','RECOVERY_CAN_WRITE'],
  ['recovery token that can delete (no bucket lock)',{permissions:{uploader:['put','get'],recovery:['get','delete']}},'privilege-probes','RECOVERY_CAN_DELETE'],
  ['recovery token without read',{permissions:{uploader:['put','get'],recovery:[]},objectLock:true},'privilege-probes','AUTH'],
  ['tampered ciphertext on recovery read',{...R2_LIKE,faults:{tamperGet:(k,b,a)=>a==='recovery'&&k.endsWith('/000000.age')?Buffer.concat([b.subarray(0,-1),Buffer.from([b.at(-1)^1])]):null}},'retrieve-decrypt-verify','BYTES'],
  ['forged completion descriptor',{...R2_LIKE,faults:{tamperGet:(k,b,a)=>a==='recovery'&&k.endsWith('/completion.json')?Buffer.from(b.toString().replace(/"snapshot_at":"[^"]+"/,'"snapshot_at":"2000-01-01T00:00:00.000Z"')):null}},'retrieve-decrypt-verify','SIGNATURE'],
  ['truncated object stream',{...R2_LIKE,faults:{truncateGet:(k,a)=>a==='recovery'&&k.endsWith('/000000.age')}},'retrieve-decrypt-verify',null],
  ['20-minute signer clock skew',{...R2_LIKE,clockOffsetMs:20*60_000},'upload','AUTH'],
])test(`drill fails closed: ${name}`,async t=>{
  const d=await run(t,{fake});
  if(error)failed(d.receipt,step,error);else{assert.equal(d.receipt.result,'failed');assert.equal(d.receipt.failed_step,step);assert.equal(d.receipt.offsite_acceptance,NOT_PROVEN);}
  assert.equal(d.receipt.steps.restored_integrity_ok,undefined);
});

test('drill fails closed with a different decryption key',async t=>{
  // The test-only AES-GCM cipher surfaces its auth failure as IO; genuine age maps it to ENCRYPTION (age test above).
  const d=await run(t,{decryptCipher:fixtureCipher()});failed(d.receipt,'retrieve-decrypt-verify','IO');
});

test('receipt cannot claim real acceptance for in-memory or injected stores; real claim needs R2 kind and genuine age',async t=>{
  const r=rig(t),workDir=path.join(r.root,'w');fs.mkdirSync(workDir,{mode:0o700});const cipher=fixtureCipher();
  const base={bundle:r.bundle,workDir,installation:r.installation,recipientId:'recovery-a',signingKeyId:'signer-a',signingKey:r.signing.privateKey,trustedKeys:r.trustedKeys,encryptCipher:cipher,decryptCipher:cipher};
  const mem=await drill({...base,uploaderStore:new MemoryStore(),recoveryStore:new MemoryStore()});
  assert.equal(mem.receipt.offsite_acceptance,NOT_PROVEN);assert.notEqual(mem.receipt.offsite_acceptance,REAL_PASSED);
  const forged=Object.assign(new MemoryStore(),{kind:'r2'});
  const lied=await drill({...base,uploaderStore:forged,recoveryStore:Object.assign(new MemoryStore(),{kind:'r2'})});
  assert.equal(lied.receipt.offsite_acceptance,NOT_PROVEN,'fixture stores or cipher never produce a real claim');
  await assert.rejects(drill({...base,uploaderStore:forged,recoveryStore:forged}),e=>e.code==='CONFIG');
});

test('interrupted PUT over HTTP resumes on the next upload without rewriting confirmed objects',async t=>{
  const r=rig(t);let drops=3;
  const s=await fakeS3(t,{faults:{dropPut:k=>k.endsWith('/000001.age')&&drops-->0}});
  const p=await prepare({...r.options,bundle:r.bundle,cipher:fixtureCipher(),policy:{chunkBytes:4096}});
  const options={...r.options,transport:p.transport_id,trustedKeys:r.trustedKeys,store:s.store,wait:async()=>{},policy:{chunkBytes:4096}};
  await assert.rejects(upload(options));
  const base='/fixture-private/'+prefix(r.installation,p.transport_id);
  assert.ok(s.bytes.has(base+'000000.age'));assert.ok(!s.bytes.has(base+'000001.age'));assert.ok(!s.bytes.has(base+'completion.json'));
  assert.ok(!fs.existsSync(path.join(r.outbox,p.transport_id,'receipt.json')));
  await upload(options);
  assert.equal(s.calls.filter(c=>c.method==='PUT'&&c.key===base+'000000.age').length,1);assert.ok(s.bytes.has(base+'completion.json'));
});

test('CLI drill refuses loopback endpoints, shared credentials and mixed buckets before any network use',async t=>{
  const r=rig(t),trusted=path.join(r.root,'trusted.pem'),signing=path.join(r.root,'signing.pem');
  fs.writeFileSync(trusted,r.signing.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
  fs.writeFileSync(signing,r.signing.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const r2=`https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,storage=(accessKeyId,o={})=>({endpoint:r2,bucket:'fixture-private',accessKeyId,secretAccessKey:'x',...o});
  const write=(n,c)=>{const f=path.join(r.root,n);fs.writeFileSync(f,JSON.stringify({installation_id:r.installation,trusted_signing_keys:{'signer-a':trusted},...c}),{mode:0o600});return f;};
  const up=o=>write('up.json',{recipient_id:'escrow-a',public_recipient:'age1'+'q'.repeat(58),age_executable:process.execPath,signing_key_id:'signer-a',signing_private_key:signing,storage:storage('up'),...o});
  const rec=o=>write('rec.json',{age_executable:process.execPath,recovery_identity:path.join(r.root,'none'),storage:storage('rec'),...o});
  for(const [u,c] of [[{storage:storage('up',{endpoint:'http://127.0.0.1:9'})},{storage:storage('rec',{endpoint:'http://127.0.0.1:9'})}],[{},{storage:storage('up')}],[{},{storage:storage('rec',{bucket:'other-bucket'})}]]){
    await assert.rejects(main(['--drill',up(u),rec(c),r.bundle,r.root],()=>{}),e=>e.code==='CONFIG');
  }
  const out=spawnSync(process.execPath,[cli,'--drill',up({}),rec({storage:storage('up')}),r.bundle,r.root],{encoding:'utf8'});
  assert.equal(out.status,1);assert.equal(out.stdout,'');assert.deepEqual(JSON.parse(out.stderr.trim().split('\n').at(-1)),{ok:false,error:'CONFIG'});
});
