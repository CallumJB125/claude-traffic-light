import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../cli.mjs';
import { rig } from './helpers.mjs';

const cli=fileURLToPath(new URL('../cli.mjs',import.meta.url));
const AGE=process.env.OFFSITE_TEST_AGE,KEYGEN=process.env.OFFSITE_TEST_KEYGEN;
test('CLI rejects unknown commands and prints only a sanitized error class',t=>{
  const r=rig(t),secret='fixture-secret-not-for-output';
  const bad=path.join(r.root,secret+'.json');fs.writeFileSync(bad,JSON.stringify({provider_response:secret}),{mode:0o600});
  for(const args of [['--unknown',secret,secret],['--prepare',bad,r.bundle],['--retrieve',bad,secret,r.root,'extra']]){
    const out=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
    assert.equal(out.status,1);assert.equal(out.stdout,'');const errors=out.stderr.trim().split('\n').filter(line=>line.startsWith('{'));assert.equal(errors.length,1);assert.deepEqual(Object.keys(JSON.parse(errors[0])),['ok','error']);
    assert.ok(!out.stderr.includes(secret));assert.ok(!out.stderr.includes(r.root));
  }
});
test('CLI cannot enable insecure fixture endpoints or accept private configuration with public modes',async t=>{
  const r=rig(t),key=path.join(r.root,'trusted.pem'),config=path.join(r.root,'operator.json');
  fs.writeFileSync(key,r.signing.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
  const c={installation_id:r.installation,outbox:r.outbox,trusted_signing_keys:{'signer-a':key},storage:{endpoint:'http://127.0.0.1:1',bucket:'fixture-private',accessKeyId:'fixture',secretAccessKey:'fixture',testLoopback:true}};
  fs.writeFileSync(config,JSON.stringify(c),{mode:0o600});
  await assert.rejects(main(['--upload',config,'00000000-0000-0000-0000-000000000000']),e=>e.code==='CONFIG');
  delete c.storage.testLoopback;fs.writeFileSync(config,JSON.stringify(c));
  await assert.rejects(main(['--upload',config,'00000000-0000-0000-0000-000000000000']),e=>e.code==='CONFIG');
  fs.chmodSync(config,0o644);
  await assert.rejects(main(['--upload',config,'00000000-0000-0000-0000-000000000000']),e=>e.code==='PRIVATE_FILE');
});
test('actual CLI prepares a genuine age outbox and explicit fork using separately pinned trusted keys',{skip:!AGE||!KEYGEN},async t=>{
  const r=rig(t),identity=path.join(r.root,'identity.txt');execFileSync(KEYGEN,['--output',identity],{stdio:'ignore'});fs.chmodSync(identity,0o600);
  const pub=execFileSync(KEYGEN,['-y',identity],{encoding:'utf8'}).trim();
  const signing=path.join(r.root,'signing.pem'),trusted=path.join(r.root,'trusted.pem'),config=path.join(r.root,'operator.json');
  fs.writeFileSync(signing,r.signing.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  fs.writeFileSync(trusted,r.signing.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
  fs.writeFileSync(config,JSON.stringify({installation_id:r.installation,outbox:r.outbox,recipient_id:'operator-escrow-a',public_recipient:pub,age_executable:AGE,signing_key_id:'signer-a',signing_private_key:signing,trusted_signing_keys:{'signer-a':trusted}}),{mode:0o600});
  const out=spawnSync(process.execPath,[cli,'--prepare',config,r.bundle],{encoding:'utf8'});assert.equal(out.status,0,out.stderr);
  const prepared=JSON.parse(out.stdout);assert.ok(fs.existsSync(path.join(r.outbox,prepared.transport_id,'ready.json')));
  assert.ok(!out.stdout.includes(pub));assert.ok(!out.stdout.includes(r.root));assert.ok(!out.stdout.includes(r.bytes.toString()));
  const fork=spawnSync(process.execPath,[cli,'--fork',config,prepared.transport_id],{encoding:'utf8'});assert.equal(fork.status,0,fork.stderr);
  const fresh=JSON.parse(fork.stdout);assert.notEqual(fresh.transport_id,prepared.transport_id);assert.equal(fresh.snapshot_at,prepared.snapshot_at);
  assert.deepEqual(fs.readFileSync(path.join(r.outbox,fresh.transport_id,'manifest.age')),fs.readFileSync(path.join(r.outbox,prepared.transport_id,'manifest.age')));
});
