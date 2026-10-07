import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {tenancy} from './tenancy/fixture.js';
const require=createRequire(import.meta.url);
const {createAccountClient}=require('../../../buddy-window/accounts.js');
const {createSetupsService}=require('../../../src/setups-service.js');
test('actual main service/client→HTTP device-owner rebind during the share dialog never publishes under another account',async t=>{
  const fx=await tenancy();t.after(()=>fx.h.close());fx.db.run("UPDATE orgs SET plan='pro' WHERE id=?",fx.A.team);
  const home=mkdtempSync(join(tmpdir(),'setups-owner-http-'));t.after(()=>rmSync(home,{recursive:true,force:true}));writeFileSync(join(home,'.gitconfig'),'[alias]\n st = status\n');
  const marker={hub:fx.h.base,token:fx.users.ua.token,user:{id:fx.users.ua.id}};let saved=marker;
  const client=createAccountClient({origin:fx.h.base,store:{load:()=>saved,clear:()=>saved=null}});
  const source={name:'Alpha fixture',userId:fx.users.ua.id,teamId:fx.A.team,memberId:fx.A.owner,role:'owner',current:()=>saved===marker,call:(op,args)=>client.setups(op,fx.A.team,args,fx.users.ua.id,fx.A.owner)};
  const service=createSetupsService({home,sources:async()=>[source],confirm:async()=>{fx.db.run('UPDATE user_devices SET user_id=? WHERE id=?',fx.users.amember.id,fx.users.ua.device_id);return true;}});
  const state=await service.snapshot();assert.equal(state.status,'complete');
  let draft=await service.draft(state.teams[0].handle,{sources:['git'],inventory:false,ssh:false});assert.equal(draft.ok,true,JSON.stringify(draft));
  for(const file of draft.file_hashes)draft=service.approve(draft.handle,file.file_id,file.hash);
  const result=await service.publish(draft.handle,draft.content_hash);assert.equal(result.ok,false);assert.equal(fx.db.get('SELECT COUNT(*) n FROM setup_profiles').n,0);assert.equal(fx.db.get('SELECT COUNT(*) n FROM setup_versions').n,0);assert.equal(saved,null);
});
test('Setups requires the captured owner assertion before authenticated bodies are read',async t=>{
  const fx=await tenancy();t.after(()=>fx.h.close());
  const path=`/api/teams/${fx.A.team}/setups`;
  const missing=await fx.as(fx.users.ua,'GET',path);assert.equal(missing.status,401);
  const wrong=await fx.as(fx.users.ua,'POST',path,{unexpected:'must not parse'},{'x-plexiform-account':fx.users.amember.id});assert.equal(wrong.status,401);
  assert.equal(fx.db.get('SELECT COUNT(*) n FROM setup_profiles').n,0);
});
