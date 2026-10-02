import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startAccounts, dumpDb } from './accounts-helpers.js';
import { fakeClients, fakeProviders } from './fake-oauth.js';
import { fakeClock } from './helpers.js';
import { createLogger } from '../log.js';
import { WEB_OAUTH_COOKIE } from '../identity/oauth-web.js';
import { WebOAuth } from '../identity/oauth-web.js';

const ORIGIN = 'https://plexiform.test';
const RANDOM = 'A'.repeat(43);
const roomy = Object.fromEntries(['oauth_start_ip','oauth_exchange_ip','signup_ip','mutate_ip','login_ip','auth_methods_ip'].map(k => [k,{capacity:10000,per_ms:60000}]));
const gUser = (n = randomUUID()) => ({ sub: `web-${n}`, email: `${n}@gmail.com`, name: 'Web user' });
const ghUser = (id = 8123, email = `octo${id}@example.test`) => ({ id, email, name: 'Octo', login: `octo${id}` });
const ck = (cookies, name = WEB_OAUTH_COOKIE) => cookies.find(c => c.startsWith(name + '='))?.split(';')[0];

async function webRig(config = {}) {
  const desktop = fakeClients(); const web = fakeClients();
  const clients = {...desktop,googleWebClientId:web.googleClientId,googleWebClientSecret:web.googleClientSecret,githubWebClientId:web.githubClientId,githubWebClientSecret:web.githubClientSecret};
  const clock = fakeClock(); const p = fakeProviders({clock,clients}); const logs = [];
  const h = await startAccounts({clock,fetchImpl:p.fetch,mailer:null,log:createLogger({level:'debug',sink:l=>logs.push(l),clock:clock.wall}),config:{...clients,publicUrl:ORIGIN,trustCfIp:true,rateLimits:roomy,...config}});
  const start = (provider = 'google', body = {}, opts = {}) => h.call('POST','/api/auth/oauth/web/start',{headers:{Origin:ORIGIN,...opts.headers},...opts,body:{provider,...body}});
  const callback = async (s,who=gUser(),{provider='google',cookie=ck(s.cookies),query=null,over={}}={}) => {
    const a = p.authorize(s.body.url,who,over); const q = query ?? new URLSearchParams({state:a.state,code:a.code});
    const res = await fetch(`${h.base}/api/auth/oauth/web/${provider}/callback?${q}`,{redirect:'manual',headers:cookie?{cookie}:{}});
    return {status:res.status,location:res.headers.get('location'),cookies:res.headers.getSetCookie(),a};
  };
  const finish = async (cb,over={}) => {
    const cookie = cb.cookies.map(c=>c.split(';')[0]).join('; ');
    const account = await h.call('GET','/api/account',{cookie});
    const result = await h.call('POST','/api/auth/oauth/web/result',{cookie,headers:{Origin:ORIGIN,'X-CSRF-Token':account.body?.csrf_token ?? '',...over.headers},body:{},...over});
    return {cookie,account,result};
  };
  return {h,p,clock,clients,logs,start,callback,finish};
}

test('web providers are distinct; native methods/endpoints do not use web credentials',async()=>{
  const r=await webRig({googleClientId:null,googleClientSecret:null,githubClientId:null,githubClientSecret:null});try{
    assert.deepEqual((await r.h.call('GET','/api/auth/methods')).body,{google:false,github:false,email:false,web:{google:true,github:true}});
    const x=await r.h.call('POST','/api/auth/oauth/start',{body:{provider:'google',client:'buddy_desktop',redirect_uri:'http://127.0.0.1:5555/callback',code_challenge:RANDOM}});
    assert.equal(x.body.error.code,'METHOD_DISABLED');
  }finally{await r.h.close();}
});

for(const provider of ['google','github'])test(`${provider} browser callback issues only a cookie session; one-use bound CSRF continuation`,async()=>{
  const r=await webRig();try{
    const before=r.h.db.get('SELECT COUNT(*) n FROM user_devices').n;
    const s=await r.start(provider);assert.equal(s.status,200,s.text);
    assert.deepEqual(Object.keys(s.body).sort(),['expires_in','url']);
    assert.match(s.cookies[0],/HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600/);
    const cb=await r.callback(s,provider==='google'?gUser():ghUser(),{provider});
    assert.equal(cb.status,303);assert.equal(cb.location,'/signin#oauth=web');
    const f=await r.finish(cb);assert.equal(f.account.status,200,f.account.text);assert.deepEqual(f.result.body,{ok:true,invitation:null});
    assert.equal(r.h.db.get('SELECT COUNT(*) n FROM user_devices').n,before);
    assert.equal(r.h.db.get('SELECT auth_method FROM sessions').auth_method,provider);
    assert.equal(cb.a.params.client_id,r.clients[`${provider}WebClientId`]);
    assert.equal(cb.a.params.code_challenge_method,'S256');assert.equal(cb.a.params.redirect_uri,`${ORIGIN}/api/auth/oauth/web/${provider}/callback`);
    assert.equal(cb.a.params.access_type,undefined);
    const repeat=await r.h.call('POST','/api/auth/oauth/web/result',{cookie:f.cookie,headers:{Origin:ORIGIN,'X-CSRF-Token':f.account.body.csrf_token},body:{}});assert.equal(repeat.body.error.code,'INVALID_TOKEN');
    assert.equal(r.h.db.get('SELECT COUNT(*) n FROM orgs').n,1,'sign-in does not create workspace');
  }finally{await r.h.close();}
});

test('start is mandatory strict-origin JSON, closed input and fixed callback despite hostile Host/team',async()=>{
 const r=await webRig();try{
  for(const headers of [{},{Origin:'https://evil.test'},{Origin:ORIGIN,'Sec-Fetch-Site':'same-site'}]){
   const x=await r.h.call('POST','/api/auth/oauth/web/start',{headers,body:{provider:'google'}});assert.equal(x.status,403);
  }
  for(const body of [{redirect_uri:'https://evil.test'},{return_url:'https://evil.test'},{user_id:r.h.ids.alice},{invitation:{kind:'team',token:'bad'}}])assert.equal((await r.start('google',body)).status,400);
  const x=await r.start('google',{}, {headers:{Origin:ORIGIN,Host:'evil.test','X-Board-Team':randomUUID()}});assert.equal(x.status,200,x.text);
  assert.equal(new URL(x.body.url).searchParams.get('redirect_uri'),`${ORIGIN}/api/auth/oauth/web/google/callback`);
 }finally{await r.h.close();}
});

test('stolen state/code without the initiating cookie cannot burn or create a session',async()=>{
 const r=await webRig();try{
  const s=await r.start();const a=r.p.authorize(s.body.url,gUser());
  const stolen=await r.callback(s,gUser(),{cookie:null,query:new URLSearchParams({code:a.code,state:a.state})});
  assert.equal(stolen.location,'/signin#oauth=invalid');assert.equal(r.h.db.get('SELECT used FROM oauth_web_flows').used,0);
  const valid=await r.callback(s,gUser(),{query:new URLSearchParams({code:a.code,state:a.state})});assert.equal((await r.finish(valid)).result.body.ok,true);
 }finally{await r.h.close();}
});

for(const provider of ['google','github'])test(`${provider} bound wrong-state/provider and malformed callbacks leave the legitimate flow usable exactly once`,async()=>{
 const r=await webRig();try{
  const s=await r.start(provider),a=r.p.authorize(s.body.url,provider==='google'?gUser():ghUser());
  const good={state:a.state,code:a.code};
  const service=new WebOAuth(r.h.hub),p=service.cookie({headers:{cookie:ck(s.cookies)}});
  const wrongPkce=`${WEB_OAUTH_COOKIE}=${service.seal({...p,verifier:RANDOM})}`;
  const invalidCallbacks=[
   {query:new URLSearchParams({...good,state:RANDOM})},
   {provider:provider==='google'?'github':'google'},
   {query:new URLSearchParams([['state',a.state],['state',a.state],['code',a.code]])},
   {query:new URLSearchParams([['state',a.state],['code',a.code],['code',a.code]])},
   {query:new URLSearchParams([['state',a.state],['error','access_denied'],['error','access_denied']])},
   {query:new URLSearchParams({...good,error:'access_denied'})},
   {query:new URLSearchParams({...good,code:''})},
   {query:new URLSearchParams({...good,code:'x'.repeat(2049)})},
   {query:new URLSearchParams({...good,code:'malformed\ncode'})},
   {query:new URLSearchParams({state:a.state,error:''})},
   {query:new URLSearchParams({state:a.state,error:'x'.repeat(129)})},
   {cookie:wrongPkce},
  ];
  for(const over of invalidCallbacks){
   const cb=await r.callback(s,gUser(),{provider,query:new URLSearchParams(good),...over});
   assert.equal(cb.location,'/signin#oauth=invalid'); assert.deepEqual(cb.cookies,[]);
   assert.equal(r.h.db.get('SELECT used FROM oauth_web_flows').used,0);
   assert.equal(r.h.db.get('SELECT COUNT(*) n FROM sessions').n,0);
  }
  assert.equal(r.p.requests.length,0,'unbound callbacks never contact a provider');
  const valid=await r.callback(s,gUser(),{provider,query:new URLSearchParams(good)});
  assert.equal((await r.finish(valid)).result.body.ok,true);
  const replay=await r.callback(s,gUser(),{provider,query:new URLSearchParams(good)});
  assert.equal(replay.location,'/signin#oauth=invalid');assert.equal(r.h.db.get('SELECT COUNT(*) n FROM sessions').n,1);
 }finally{await r.h.close();}
});

test('cookie tampering, wrong state/provider, duplicate code, Google nonce/audience and replay fail closed',async()=>{
 const r=await webRig();try{
  for(const options of [s=>({cookie:ck(s.cookies)+'x'}),s=>({query:new URLSearchParams({state:RANDOM,code:'bad'})}),s=>({provider:'github'}),s=>({query:new URLSearchParams(`state=${new URL(s.body.url).searchParams.get('state')}&code=a&code=b`)}),()=>({over:{claims:{nonce:'wrong'}}}),()=>({over:{claims:{aud:r.clients.googleClientId}}})]){
   const s=await r.start();const cb=await r.callback(s,gUser(),options(s));
   assert.equal(r.h.db.get('SELECT COUNT(*) n FROM sessions').n,0);
   if(cb.cookies.length)assert.equal((await r.finish(cb)).result.body.ok,false);
  }
  const s=await r.start();const cb=await r.callback(s);assert.equal((await r.finish(cb)).result.body.ok,true);
  const replay=await r.callback(s);assert.equal(replay.location,'/signin#oauth=invalid');assert.equal(r.h.db.get('SELECT COUNT(*) n FROM sessions').n,1);
 }finally{await r.h.close();}
});

test('concurrent callback burns before provider network and issues one session',async()=>{
 const r=await webRig();try{
  const s=await r.start();const a=r.p.authorize(s.body.url,gUser());let release;r.p.gate=new Promise(resolve=>{release=resolve;});
  const q=new URLSearchParams({state:a.state,code:a.code});const first=r.callback(s,gUser(),{query:q});
  while(!r.p.requests.some(v=>v.url.includes('/token')))await new Promise(resolve=>setImmediate(resolve));
  const second=await r.callback(s,gUser(),{query:q});assert.equal(second.location,'/signin#oauth=invalid');release();
  const cb=await first;assert.equal((await r.finish(cb)).result.body.ok,true);assert.equal(r.h.db.get('SELECT COUNT(*) n FROM sessions').n,1);
 }finally{await r.h.close();}
});

test('result requires exact live session and CSRF, refuses cross-origin, revoke, deletion and restore',async()=>{
 const r=await webRig();try{
  const s=await r.start();const cb=await r.callback(s);const cookie=cb.cookies.map(c=>c.split(';')[0]).join('; ');
  const account=await r.h.call('GET','/api/account',{cookie});
  for(const headers of [{Origin:ORIGIN},{Origin:'https://evil.test','X-CSRF-Token':account.body.csrf_token}]){
   const x=await r.h.call('POST','/api/auth/oauth/web/result',{cookie,headers,body:{}});assert.ok(x.status>=400);
  }
  const otherCb=await r.callback(await r.start(),gUser());
  const other=await r.finish(otherCb);
  const wrong=await r.h.call('POST','/api/auth/oauth/web/result',{cookie:ck(cb.cookies)+'; '+ck(otherCb.cookies,'__Host-buddy_session'),headers:{Origin:ORIGIN,'X-CSRF-Token':other.account.body.csrf_token},body:{}});
  assert.equal(wrong.body.error.code,'INVALID_TOKEN');
  r.h.db.run("UPDATE sessions SET revoked_at = ?",r.h.hub.iso());assert.equal((await r.finish(cb)).result.body.error.code,'INVALID_TOKEN');
  r.h.db.setMeta('session_epoch',2);assert.equal((await r.finish(cb)).result.body.error.code,'INVALID_TOKEN');
  r.h.db.run('UPDATE users SET deleted_at = ? WHERE id = ?',r.h.hub.iso(),account.body.user.id);assert.equal((await r.finish(cb)).result.body.error.code,'INVALID_TOKEN');
 }finally{await r.h.close();}
});

test('failed sign-in retains only bound encrypted invite context and no secret dumps/logs',async()=>{
 const r=await webRig({signup:'allowlist',signupAllow:''});try{
  const token=`clinv_${RANDOM}`;const s=await r.start('google',{invitation:{kind:'client',token}});const cb=await r.callback(s);
  const f=await r.finish(cb);assert.equal(f.result.body.error.code,'SIGNUP_CLOSED');assert.deepEqual(f.result.body.invitation,{kind:'client',token});
  const all=JSON.stringify(dumpDb(r.h.db))+r.logs.join('\n');assert.ok(!all.includes(token));
  for(const v of r.p.issued)assert.ok(!all.includes(v));
  assert.ok(!s.body.url.includes(token));assert.ok(!s.cookies.join('').includes(token));assert.ok(!cb.location.includes(token));
  assert.equal(r.h.db.get('SELECT COUNT(*) n FROM sessions').n,0);
  const refusal=r.h.db.get("SELECT detail FROM audit WHERE action = 'auth.signup.refused'");
  assert.match(JSON.parse(refusal.detail).subject_ref,/^[a-f0-9]{16}$/);
 }finally{await r.h.close();}
});

test('expiry/epoch and provider denial/unavailability spend the flow without session or external redirect',async()=>{
 for(const cause of ['expire','epoch','deny','unavailable']){
  const r=await webRig();try{
   const s=await r.start();let opts={};
   if(cause==='expire')r.h.db.run("UPDATE oauth_web_flows SET expires_at = '2000-01-01T00:00:00.000Z'");
   if(cause==='epoch')r.h.db.setMeta('session_epoch',2);
   if(cause==='deny')opts={query:new URLSearchParams({state:new URL(s.body.url).searchParams.get('state'),error:'access_denied',error_description:'<script>secret</script>',return_url:'https://evil.test'})};
   if(cause==='unavailable')r.p.tokenStatus=503;
   const cb=await r.callback(s,gUser(),opts);assert.equal(cb.location,'/signin#oauth=web');assert.equal(r.h.db.get('SELECT used FROM oauth_web_flows').used,1);
   assert.equal(r.h.db.get('SELECT COUNT(*) n FROM sessions').n,0);assert.ok(!r.logs.join('').includes('<script>secret'));
  }finally{await r.h.close();}
 }
});

test('browser identity resolution preserves authoritative Google linking and GitHub separation/admission rules',async()=>{
 const r=await webRig();try{
  const first=await r.finish(await r.callback(await r.start(),{sub:'authoritative-one',email:'same@gmail.com',name:'One'}));
  const linked=await r.finish(await r.callback(await r.start(),{sub:'authoritative-two',email:'same@gmail.com',name:'Two'}));
  assert.equal(linked.account.body.user.id,first.account.body.user.id,'only authoritative Google links by mailbox');
  const github=await r.finish(await r.callback(await r.start('github'),ghUser(83721,'same@gmail.com'),{provider:'github'}));
  assert.notEqual(github.account.body.user.id,first.account.body.user.id);
  assert.equal(github.account.body.user.email,null,'weaker identity does not take authoritative primary email');
 }finally{await r.h.close();}
 for(const [provider,who,signupAllow] of [['github',ghUser(99112),'domain:example.test'],['google',{sub:'weak-google',email:'weak@example.test',name:'Weak'},'email:weak@example.test']]){
  const r=await webRig({signup:'allowlist',signupAllow});try{
   const x=await r.finish(await r.callback(await r.start(provider),who,{provider}));
   assert.equal(x.result.body.error.code,'SIGNUP_CLOSED');
  }finally{await r.h.close();}
 }
});

test('flow erasure, reaper and bounded per-IP open starts cover the additive table',async()=>{
 const r=await webRig();try{
  const signed=await r.finish(await r.callback(await r.start()));
  r.h.hub.accounts.eraseUser(r.h.hub.accounts.liveUser(signed.account.body.user.id));
  assert.equal(r.h.db.get('SELECT COUNT(*) n FROM oauth_web_flows WHERE user_id IS NOT NULL').n,0);
  assert.equal(r.h.db.get('SELECT COUNT(*) n FROM sessions').n,0);
  for(let i=0;i<10;i++)assert.equal((await r.start()).status,200);
  assert.equal((await r.start()).status,429);
  r.clock.advance(86_400_000+11*60_000);r.h.hub.oauth.sweep();
  assert.equal(r.h.db.get('SELECT COUNT(*) n FROM oauth_web_flows').n,0);
 }finally{await r.h.close();}
});

test('restore during provider network wait refuses credential issuance and same-prefix binding is enforced',async()=>{
 const r=await webRig();try{
  const s=await r.start();let release;r.p.gate=new Promise(resolve=>{release=resolve;});
  const pending=r.callback(s);
  while(!r.p.requests.some(v=>v.url.includes('/token')))await new Promise(resolve=>setImmediate(resolve));
  r.h.db.setMeta('session_epoch',2);release();const cb=await pending;
  assert.equal(r.h.db.get('SELECT COUNT(*) n FROM sessions').n,0);
  assert.equal((await r.finish(cb)).result.body.error.code,'INVALID_TOKEN');
 }finally{await r.h.close();}
 const ip=await webRig();try{
  const s=await ip.start('google',{}, {headers:{Origin:ORIGIN,'CF-Connecting-IP':'203.0.113.9'}});
  const cb=await ip.callback(s);assert.equal(ip.h.db.get('SELECT COUNT(*) n FROM sessions').n,0);
  assert.equal(ip.h.db.get('SELECT outcome FROM oauth_web_flows').outcome,'INVALID_TOKEN');
 }finally{await ip.h.close();}
});
