import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { createBackup, validateBackup } from '../../pi/backup-lib.mjs';
import { AgeCipher, genuineAge, pinnedAgeSha256 } from '../age.mjs';
import { drill, classify, sweepDrills, DRILL_MARKER, NOT_PROVEN, REAL_PASSED } from '../drill.mjs';
import { prepare, upload, retrieve } from '../offsite-lib.mjs';
import { prefix, verifyCompletion } from '../schema.mjs';
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
  assert.deepEqual(d.receipt.steps,{source_copied:true,encrypted:true,uploaded_and_read_back:true,remote_objects_are_age_ciphertext:true,local_source_deleted:true,decrypted_hashes_match_source:true,restored_integrity_ok:true});
  const locked={refused:true,http_status:403,code:'ObjectLockedByBucketPolicy'},denied={refused:true,http_status:403,code:'AccessDenied'};
  assert.deepEqual(d.receipt.probes,{uploader_conditional_overwrite:{refused:true,http_status:412,code:'EXISTS'},uploader_unconditional_overwrite:locked,uploader_delete:locked,recovery_write:denied,recovery_delete:denied});
  const canaryKey='/fixture-private/'+prefix(d.installation,d.receipt.transport_id)+'drill-canary.bin';
  assert.equal(d.s.calls.filter(c=>c.method==='PUT'&&c.key===canaryKey&&c.access==='uploader'&&c.conditional===undefined).length,1,'raw unconditional overwrite was attempted');
  assert.equal(d.s.calls.filter(c=>c.method==='PUT'&&c.key===canaryKey&&c.access==='uploader'&&c.conditional==='*').length,2,'create plus conditional overwrite');
  assert.equal(d.receipt.drill_backup,true);
  const completion=JSON.parse(d.s.bytes.get('/fixture-private/'+prefix(d.installation,d.receipt.transport_id)+'completion.json'));
  assert.equal(completion.drill,true,'signed completion marks the drill backup');
  const {drill:_,...stripped}=completion;
  assert.throws(()=>verifyCompletion(stripped,{installation:d.installation,transport:d.receipt.transport_id,trustedKeys:d.trustedKeys}),e=>e.code==='SIGNATURE');
  await assert.rejects(retrieve({installation:d.installation,transport:d.receipt.transport_id,trustedKeys:d.trustedKeys,store:d.s.storeFor('recovery'),cipher:fixtureCipher(),destination:path.join(d.root,'operational-restore')}),e=>e.code==='DRILL_ARTIFACT');
  assert.ok(d.receipt.object_count>5,'database split across several bounded objects');
  const base='/fixture-private/'+prefix(d.installation,d.receipt.transport_id);
  assert.ok([...d.s.bytes.keys()].every(k=>k.startsWith(base)));assert.ok(d.s.bytes.has(base+'drill-canary.bin'));
  assert.ok(!Buffer.concat([...d.s.bytes.values()]).includes(d.bytes),'no plaintext artifact left the machine');
  assert.ok(d.s.calls.filter(c=>c.method==='PUT'&&c.access==='recovery').every(c=>!d.s.bytes.has(c.key)));
  assert.ok(d.s.calls.filter(c=>c.method==='GET'&&c.key.endsWith('.age')).some(c=>c.access==='recovery'),'retrieval used the recovery credential');
  assert.ok(!JSON.stringify(d.receipt).includes('fixture-secret'));
});

// Shell impostors of the age CLI. PATH is restricted to their directory, so
// they use absolute tool paths.
const ROT=String.raw`export LC_ALL=C
if [ "$1" = --encrypt ]; then printf 'age-encryption.org/v1\n'; exec /usr/bin/tr '\000-\377' '\001-\377\000'; fi
/usr/bin/tail -c +23 | /usr/bin/tr '\001-\377\000' '\000-\377'
`;
function impostor(root,name,body){
  const exe=path.join(root,name);fs.writeFileSync(exe,'#!/bin/sh\n'+body,{mode:0o700});
  const id=path.join(root,name+'-id.txt');fs.writeFileSync(id,'AGE-SECRET-KEY-1'+'Q'.repeat(58)+'\n',{mode:0o600});
  return {encryptCipher:new AgeCipher({executable:exe,publicRecipient:'age1'+'q'.repeat(58)}),decryptCipher:new AgeCipher({executable:exe,identity:id})};
}

test('drill with genuine age (or an unpinned age-shaped impostor): passes against fake and still reports NOT_PROVEN',async t=>{
  const r0=rig(t);let ciphers;
  if(AGE&&KEYGEN){
    const identity=path.join(r0.root,'id.txt');execFileSync(KEYGEN,['--output',identity],{stdio:'ignore'});fs.chmodSync(identity,0o600);
    const publicRecipient=execFileSync(KEYGEN,['-y',identity],{encoding:'utf8'}).trim();
    ciphers={encryptCipher:new AgeCipher({executable:AGE,publicRecipient}),decryptCipher:new AgeCipher({executable:AGE,identity})};
  }else ciphers=impostor(r0.root,'rot-age',ROT);
  const ok=await run(t,ciphers),pinned=genuineAge(ciphers.encryptCipher)&&genuineAge(ciphers.decryptCipher);
  assert.equal(ok.receipt.result,'passed',JSON.stringify(ok.receipt));assert.equal(ok.receipt.offsite_acceptance,NOT_PROVEN);
  assert.match(ok.receipt.acceptance_basis,new RegExp(`uploader=loopback-fixture, recovery=loopback-fixture, pinned_age=${pinned}`));
  for(const [k,b]of ok.s.bytes)if(k.endsWith('.age'))assert.equal(b.subarray(0,22).toString(),'age-encryption.org/v1\n');
  // The loopback kind alone must withhold the claim even when age is pinned.
  assert.equal(classify({error:null,uploaderKind:'loopback-fixture',recoveryKind:'loopback-fixture',encryptAge:true,decryptAge:true}).offsite_acceptance,NOT_PROVEN);
});

test('genuine age with the wrong identity fails at retrieval',{skip:!AGE||!KEYGEN},async t=>{
  const r0=rig(t),key=(n)=>{const f=path.join(r0.root,n);execFileSync(KEYGEN,['--output',f],{stdio:'ignore'});fs.chmodSync(f,0o600);return f;};
  const publicRecipient=execFileSync(KEYGEN,['-y',key('id.txt')],{encoding:'utf8'}).trim();
  const wrong=await run(t,{encryptCipher:new AgeCipher({executable:AGE,publicRecipient}),decryptCipher:new AgeCipher({executable:AGE,identity:key('wrong.txt')})});
  failed(wrong.receipt,'retrieve-decrypt-verify','ENCRYPTION');
});

test('age pin: only the pinned official binary counts as genuine age',t=>{
  assert.equal(pinnedAgeSha256('darwin-arm64'),'4012dfc2725883beafb710894af4f599b7a94f8c8e0f51f02cc96ab8df33915e');
  assert.equal(pinnedAgeSha256('plan9-mips'),null);
  assert.equal(genuineAge(fixtureCipher()),false);
  const r0=rig(t);assert.equal(genuineAge(impostor(r0.root,'cat-age','exec /bin/cat\n').encryptCipher),false);
  if(AGE&&`${process.platform}-${process.arch}`==='darwin-arm64')assert.equal(genuineAge(new AgeCipher({executable:AGE,publicRecipient:'age1'+'q'.repeat(58)})),true);
});

test('drill refuses pass-through or header-faking "age" that would upload plaintext',async t=>{
  const r0=rig(t);
  failed((await run(t,impostor(r0.root,'cat-age','exec /bin/cat\n'))).receipt,'verify-remote-ciphertext','NOT_AGE_CIPHERTEXT');
  failed((await run(t,impostor(r0.root,'fake-header-age',"printf 'age-encryption.org/v1\\n'\nexec /bin/cat\n"))).receipt,'verify-remote-ciphertext','PLAINTEXT_UPLOADED');
});

test('receipt classifier: REAL only for both R2 kinds, both pinned age and no error',()=>{
  const ok={error:null,uploaderKind:'r2',recoveryKind:'r2',encryptAge:true,decryptAge:true};
  assert.equal(classify(ok).offsite_acceptance,REAL_PASSED);
  for(const over of [{error:'IO'},{uploaderKind:'loopback-fixture'},{recoveryKind:'injected-client'},{uploaderKind:undefined},{encryptAge:false},{decryptAge:false},{encryptAge:'yes'}])
    assert.equal(classify({...ok,...over}).offsite_acceptance,NOT_PROVEN,JSON.stringify(over));
});

test('drill artifacts are marked: an operational restore refuses them and a drill restore refuses operational backups',async t=>{
  const r=rig(t),store=new MemoryStore(),cipher=fixtureCipher();
  const p=await prepare({...r.options,bundle:r.bundle,cipher});await upload({...r.options,transport:p.transport_id,trustedKeys:r.trustedKeys,store});
  await assert.rejects(retrieve({...r.options,transport:p.transport_id,trustedKeys:r.trustedKeys,store,cipher,destination:path.join(r.root,'x'),drill:true}),e=>e.code==='DRILL_ARTIFACT');
});

test('stale drill directories are swept only when this tool created them and their process is gone',t=>{
  const r=rig(t),work=path.join(r.root,'drills');fs.mkdirSync(work,{mode:0o700});
  const dead=spawnSync(process.execPath,['-e','0']).pid,mk=(name,pid)=>{const d=path.join(work,name);fs.mkdirSync(d);fs.writeFileSync(path.join(d,'plain'),'x');if(pid)fs.writeFileSync(path.join(d,DRILL_MARKER),JSON.stringify({pid}));return d;};
  const stale=mk('drill-00000000-0000-4000-8000-000000000001',dead),foreign=mk('drill-00000000-0000-4000-8000-000000000002',null);
  const mine=mk('drill-00000000-0000-4000-8000-000000000003',process.pid),odd=mk('not-a-drill',dead);
  assert.equal(sweepDrills(work),1);assert.ok(!fs.existsSync(stale));assert.ok(fs.existsSync(foreign)&&fs.existsSync(mine)&&fs.existsSync(odd));
  assert.equal(sweepDrills(work,{own:true}),1);assert.ok(!fs.existsSync(mine));assert.ok(fs.existsSync(foreign));
});

test('SIGTERM mid-drill removes the plaintext drill directory and exits 143',t=>{
  const here=path.dirname(fileURLToPath(import.meta.url)),scratch=rig(t).root,child=path.join(scratch,'child.mjs');
  const u=f=>JSON.stringify(new URL(f,'file://'+here+'/').href);
  fs.writeFileSync(child,`import fs from 'node:fs';import path from 'node:path';
import {drill} from ${u('../drill.mjs')};import {guardDrill} from ${u('../cli.mjs')};import {rig,fixtureCipher,MemoryStore} from ${u('./helpers.mjs')};
const r=rig({after(){}});process.stdout.write(r.root+'\\n');const workDir=path.join(r.root,'drills');fs.mkdirSync(workDir,{mode:0o700});
const store=new MemoryStore();store.hook=async op=>{if(op!=='put')return;
  const seen=fs.readdirSync(workDir).flatMap(n=>fs.readdirSync(path.join(workDir,n)).map(x=>n+'/'+x));fs.writeFileSync(path.join(r.root,'seen.json'),JSON.stringify(seen));
  setTimeout(()=>{},10000);process.kill(process.pid,'SIGTERM');await new Promise(()=>{});};
guardDrill(workDir,[{close(){}}]);const cipher=fixtureCipher();
await drill({bundle:r.bundle,workDir,installation:r.installation,recipientId:'recovery-a',signingKeyId:'signer-a',signingKey:r.signing.privateKey,trustedKeys:r.trustedKeys,encryptCipher:cipher,decryptCipher:cipher,uploaderStore:store,recoveryStore:new MemoryStore()});
`,{mode:0o600});
  const out=spawnSync(process.execPath,[child],{encoding:'utf8',timeout:30_000}),root=out.stdout.trim();
  t.after(()=>root&&fs.rmSync(root,{recursive:true,force:true}));
  assert.equal(out.status,143,out.stderr);
  const seen=JSON.parse(fs.readFileSync(path.join(root,'seen.json')));
  assert.ok(seen.some(x=>x.endsWith('/source'))&&seen.some(x=>x.endsWith('/outbox')),'plaintext existed when the signal arrived');
  assert.deepEqual(fs.readdirSync(path.join(root,'drills')),[]);
});

for(const [name,fake,step,error] of [
  ['uploader token that can overwrite (no bucket lock)',{permissions:{uploader:['put','get','delete'],recovery:['get']}},'privilege-probes','UPLOADER_CAN_OVERWRITE'],
  ['uploader token that can delete (lock covers overwrite only)',{permissions:{uploader:['put','get','delete'],recovery:['get']},objectLock:m=>m==='PUT'},'privilege-probes','UPLOADER_CAN_DELETE'],
  ['uploader delete answered 403 but canary removed',{...R2_LIKE,faults:{deleteDespiteDenied:(k,a)=>a==='uploader'}},'privilege-probes','UPLOADER_CAN_DELETE'],
  ['uploader overwrite answered 403 but canary replaced',{...R2_LIKE,faults:{writeDespiteDenied:(k,a,inm)=>a==='uploader'&&inm!=='*'}},'privilege-probes','UPLOADER_CAN_OVERWRITE'],
  ['If-None-Match ignored by the store',{...R2_LIKE,objectLock:m=>m==='DELETE',faults:{ignoreIfNoneMatch:true}},'privilege-probes','CONDITIONAL_WRITE_NOT_ENFORCED'],
  ['uploader delete answered 400 (not an exact 403)',{...R2_LIKE,faults:{deleteStatus:(k,a)=>a==='uploader'?400:0}},'privilege-probes','PROBE_INCONCLUSIVE'],
  ['uploader delete answered 404',{...R2_LIKE,faults:{deleteStatus:(k,a)=>a==='uploader'?404:0}},'privilege-probes','PROBE_INCONCLUSIVE'],
  ['uploader delete throttled 429',{...R2_LIKE,faults:{deleteStatus:(k,a)=>a==='uploader'?429:0}},'privilege-probes','RETRY'],
  ['uploader overwrite answered 400 (not an exact 403)',{...R2_LIKE,faults:{putStatus:(k,a,inm)=>a==='uploader'&&inm!=='*'?400:0}},'privilege-probes','PROBE_INCONCLUSIVE'],
  ['recovery delete answered 401 (not an exact 403)',{...R2_LIKE,faults:{deleteStatus:(k,a)=>a==='recovery'?401:0}},'privilege-probes','PROBE_INCONCLUSIVE'],
  ['recovery token that can write',{permissions:{uploader:['put','get'],recovery:['get','put']},objectLock:true},'privilege-probes','RECOVERY_CAN_WRITE'],
  ['recovery write answered 403 but object stored',{...R2_LIKE,faults:{writeDespiteDenied:(k,a)=>a==='recovery'}},'privilege-probes','RECOVERY_CAN_WRITE'],
  ['recovery token that can delete (lock covers overwrite only)',{permissions:{uploader:['put','get'],recovery:['get','delete']},objectLock:m=>m==='PUT'},'privilege-probes','RECOVERY_CAN_DELETE'],
  ['recovery token without read',{permissions:{uploader:['put','get'],recovery:[]},objectLock:true},'verify-remote-ciphertext','AUTH'],
  ['tampered ciphertext on recovery read',{...R2_LIKE,faults:{tamperGet:(k,b,a)=>a==='recovery'&&k.endsWith('/000000.age')?Buffer.concat([b.subarray(0,-1),Buffer.from([b.at(-1)^1])]):null}},'retrieve-decrypt-verify','BYTES'],
  ['forged completion descriptor',{...R2_LIKE,faults:{tamperGet:(k,b,a)=>a==='recovery'&&k.endsWith('/completion.json')?Buffer.from(b.toString().replace(/"snapshot_at":"[^"]+"/,'"snapshot_at":"2000-01-01T00:00:00.000Z"')):null}},'retrieve-decrypt-verify','SIGNATURE'],
  ['truncated object stream',{...R2_LIKE,faults:{truncateGet:(k,a)=>a==='recovery'&&k.endsWith('/000000.age')}},'verify-remote-ciphertext',null],
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
  const other=path.join(r.root,'other.pem');fs.writeFileSync(other,generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
  const identity=path.join(r.root,'id.txt');fs.writeFileSync(identity,'AGE-SECRET-KEY-1'+'Q'.repeat(58)+'\n',{mode:0o600});
  for(const [u,c,code] of [[{storage:storage('up',{endpoint:'http://127.0.0.1:9'})},{storage:storage('rec',{endpoint:'http://127.0.0.1:9'})},'CONFIG'],[{},{storage:storage('up')},'CONFIG'],[{},{storage:storage('rec',{bucket:'other-bucket'})},'CONFIG'],
    [{},{storage:storage('rec',{endpoint:`https://${'b'.repeat(32)}.r2.cloudflarestorage.com`})},'CONFIG'],
    [{recovery_identity:identity},{recovery_identity:identity},'CONFIG'],[{},{recovery_identity:identity,signing_private_key:signing},'CONFIG'],
    [{},{recovery_identity:identity,trusted_signing_keys:{'signer-a':other}},'KEY'],
    [{},{recovery_identity:identity},'AGE_UNPINNED']]){
    await assert.rejects(main(['--drill',up(u),rec(c),r.bundle,r.root],()=>{}),e=>e.code===code,JSON.stringify([u,c,code]));
  }
  assert.ok(!fs.readdirSync(r.root).some(n=>n.startsWith('drill-')),'no drill started');
  const out=spawnSync(process.execPath,[cli,'--drill',up({}),rec({storage:storage('up')}),r.bundle,r.root],{encoding:'utf8'});
  assert.equal(out.status,1);assert.equal(out.stdout,'');assert.deepEqual(JSON.parse(out.stderr.trim().split('\n').at(-1)),{ok:false,error:'CONFIG'});
});
