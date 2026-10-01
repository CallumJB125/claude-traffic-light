import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { S3Store, storageConfig } from '../s3.mjs';
import { rig } from './helpers.mjs';
import { fakeS3 } from './fake-s3.mjs';

const config = { endpoint:`https://${'a'.repeat(32)}.r2.cloudflarestorage.com`, bucket:'fixture-private', accessKeyId:'fixture-access', secretAccessKey:'fixture-secret' };
test('storage configuration fixes authenticated HTTPS R2 origins and rejects public/insecure/arbitrary endpoints',()=>{
  assert.equal(storageConfig(config).endpoint,config.endpoint);
  for(const endpoint of ['http://example.test','https://example.test','https://public.r2.dev','https://user:password@'+ 'a'.repeat(32)+'.r2.cloudflarestorage.com','https://'+ 'a'.repeat(32)+'.r2.cloudflarestorage.com/path','https://'+ 'a'.repeat(32)+'.r2.cloudflarestorage.com?token=bad','http://127.0.0.1:1234'])assert.throws(()=>storageConfig({...config,endpoint}));
  assert.throws(()=>storageConfig({...config,bucket:'../other'}));
});

test('adapter declares only conditional private object Put and Get, sanitizes errors and passes abort authority',async t=>{
  const r=rig(t),file=path.join(r.root,'cipher.age');fs.writeFileSync(file,'cipher',{mode:0o600});
  const sent=[],client={async send(command,options){sent.push([command,options]);return {Body:Readable.from(['cipher']),ContentLength:6};}};
  const store=new S3Store(config,{client}); const signal=new AbortController().signal;
  await store.put('paired/fixture/000000.age',file,{byte_length:6},{signal});
  assert.equal(sent[0][0].constructor.name,'PutObjectCommand');assert.equal(sent[0][0].input.IfNoneMatch,'*');
  assert.equal(sent[0][0].input.CacheControl,'no-store');assert.equal(sent[0][0].input.ACL,undefined);assert.equal(sent[0][1].abortSignal,signal);
  const got=await store.get('paired/fixture/000000.age',{signal});assert.equal(got.byte_length,6);got.body.destroy();
  for(const [status,code] of [[412,'EXISTS'],[409,'RETRY'],[503,'RETRY'],[429,'RETRY'],[403,'AUTH'],[404,'MISSING']]){
    client.send=async()=>{throw Object.assign(new Error('PRIVATE_HEADERS secret-token fixture'),{$metadata:{httpStatusCode:status}});};
    await assert.rejects(store.get('paired/fixture/x'),e=>e.code===code&&!e.message.includes('secret'));
  }
});

test('actual SDK signs synthetic loopback HTTP and conditionally creates objects without overwrite',async t=>{
  const r=rig(t),s=await fakeS3(t),file=path.join(r.root,'cipher.age');fs.writeFileSync(file,'cipher',{mode:0o600});
  await s.store.put('paired/v1/fixture.age',file,{byte_length:6});
  await assert.rejects(s.store.put('paired/v1/fixture.age',file,{byte_length:6}),e=>e.code==='EXISTS');
  const got=await s.store.get('paired/v1/fixture.age');const parts=[];for await(const b of got.body)parts.push(b);
  assert.equal(Buffer.concat(parts).toString(),'cipher');assert.equal(s.calls[0].conditional,'*');
  assert.match(s.calls[0].authorization,/^AWS4-HMAC-SHA256 Credential=fixture-access\//);
  assert.deepEqual(s.calls.map(c=>c.method),['PUT','PUT','GET']);
});
