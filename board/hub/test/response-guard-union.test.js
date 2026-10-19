// The three independent guarded route families share delivery plumbing but
// Setups alone carries the captured desktop account/member headers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteRig,session} from './remote-helpers.js';

test('real guarded route families retain their distinct account binding requirements',async t=>{
  const f=await remoteRig(t),identity=await session(f);
  const coordination=await f.as(f.users.amember,'GET',`/api/cards/${f.A.card}/ownership`);
  assert.equal(coordination.status,200,coordination.text);
  assert.equal(coordination.body.grants_execution,false);
  const connections=await f.h.call('GET',`/api/teams/${f.A.team}/remote-grants`,{cookie:identity.cookie});
  assert.equal(connections.status,200,connections.text);
  assert.deepEqual(connections.body.grants,[]);
  const path=`/api/teams/${f.A.team}/setups`;
  const missing=await f.as(f.users.amember,'GET',path);
  assert.equal(missing.status,401);
  assert.equal(missing.body.profiles,undefined);
  const owner={'x-plexiform-account':f.users.amember.id,'x-plexiform-member':f.A.member};
  const correct=await f.as(f.users.amember,'GET',path,undefined,owner);
  assert.equal(correct.status,200,correct.text);
  assert.deepEqual(correct.body.profiles,[]);
  const rebound=await f.as(f.users.amember,'GET',path,undefined,{...owner,'x-plexiform-member':f.A.admin});
  assert.equal(rebound.status,401);
  assert.equal(rebound.body.profiles,undefined);
});
