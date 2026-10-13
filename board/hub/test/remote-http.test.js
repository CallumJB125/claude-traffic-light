import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { remoteRig, session, grant, business, spareBoard } from './remote-helpers.js';
import { until } from './helpers.js';

async function request(f, path, { method = 'GET', body, cookie, csrf, token, headers = {} } = {}) {
  const res = await fetch(f.h.base + path, { method, redirect: 'manual', headers: {
    ...(body == null ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}),
    ...(csrf ? { origin: f.h.base, 'x-csrf-token': csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers,
  }, body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch {}
  return { res, status: res.status, data, text };
}
async function flow(f, mode = 'collaborate', boardIds = [f.A.board]) {
  const identity = await session(f), redirect = 'http://127.0.0.1:31337/callback?fixed=1';
  const registered = await request(f, '/oauth/register', { method: 'POST', body: { client_name: 'HTTP synthetic unverified app', redirect_uris: [redirect] } });
  assert.equal(registered.status, 201, registered.text);
  const verifier = randomBytes(32).toString('base64url'), state = randomUUID();
  const params = { client_id: registered.data.client_id, redirect_uri: redirect, response_type: 'code', state,
    resource: f.authority.audience('mcp'), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: mode === 'collaborate' ? 'boards:read boards:collaborate' : 'boards:read' };
  const started = await request(f, '/oauth/authorize?' + new URLSearchParams(params));
  assert.equal(started.status, 303, started.text); assert.equal(started.res.headers.get('referrer-policy'), 'no-referrer');
  const intent = new URL(started.res.headers.get('location'), f.h.base).hash.slice('#intent='.length);
  const browser = started.res.headers.get('set-cookie').split(';')[0], cookie = `${identity.cookie}; ${browser}`;
  const preview = await request(f, '/oauth/consent?intent=' + intent, { cookie });
  assert.equal(preview.status, 200, preview.text); assert.equal(preview.data.signed_in, true);
  const body = { intent_id: intent, team_id: f.A.team, approve: true, board_ids: boardIds, mode };
  return { identity, params, verifier, intent, browser, cookie, body };
}
async function issue(f, mode = 'collaborate', boardIds = [f.A.board]) {
  const q = await flow(f, mode, boardIds);
  const approved = await request(f, '/oauth/consent', { method: 'POST', cookie: q.cookie, csrf: q.identity.csrf, body: q.body });
  assert.equal(approved.status, 200, approved.text);
  const target = new URL(approved.data.redirect_uri); assert.equal(target.searchParams.get('state'), q.params.state); assert.equal(target.searchParams.get('iss'), f.h.base);
  const form = { grant_type: 'authorization_code', code: target.searchParams.get('code'), client_id: q.params.client_id,
    redirect_uri: q.params.redirect_uri, code_verifier: q.verifier, resource: q.params.resource };
  const result = await request(f, '/oauth/token', { method: 'POST', body: new URLSearchParams(form).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(result.status, 200, result.text); assert.equal(result.res.headers.get('pragma'), 'no-cache'); return { ...q, ...result.data, form };
}
const rpc = (f, token, method, params, opts = {}) => request(f, '/api/mcp', { method: 'POST', token, body: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
  ...opts, headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', ...opts.headers } });
function raw(f, { path = '/api/mcp', method = 'POST', headers, body = '{}' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(f.h.base + path, { method, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), headers: res.headers }));
    }); req.on('error', reject); req.end(body);
  });
}

test('actual HTTP OAuth and shipped SDK initialize/list/read/write use stateless selected-board grants', async t => {
  const f = await remoteRig(t), q = await issue(f);
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-authorization-server']) {
    const r = await request(f, path); assert.equal(r.status, 200, r.text); assert.equal(r.res.headers.get('cache-control'), 'no-store');
  }
  const client = new Client({ name: 'synthetic SDK client', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(f.h.base + '/api/mcp'), { requestInit: { headers: { authorization: `Bearer ${q.access_token}` } } });
  t.after(() => client.close()); await client.connect(transport);
  assert.equal(transport.sessionId, undefined);
  const tools = await client.listTools(); assert.equal(tools.tools.length, 12); assert.equal(tools.tools.some(tool => /execute|approve|evidence/.test(tool.name)), false);
  assert.ok(tools.tools.some(tool=>tool.name==='plexiform_get_work_context'&&tool.annotations.readOnlyHint));
  const picture=await client.callTool({name:'plexiform_get_work_context',arguments:{board_id:f.A.board,limit:1}});assert.equal(picture.structuredContent.grants_execution,false);assert.equal(picture.structuredContent.tasks.length,1);
  const read = await client.callTool({ name: 'plexiform_get_card', arguments: { card_id: f.A.card } }); assert.equal(read.structuredContent.card.id, f.A.card);
  const input = { request_id: randomUUID(), board_id: f.A.board, title: 'Actual SDK task' };
  const created = await client.callTool({ name: 'plexiform_create_card', arguments: input });
  const replay = await client.callTool({ name: 'plexiform_create_card', arguments: input }); assert.equal(created.structuredContent.card.id, replay.structuredContent.card.id);
  await assert.rejects(client.callTool({ name: 'plexiform_get_card', arguments: { card_id: f.B.card } }), error => error.code === 404 && !error.message.includes('B-SECRET'));
  assert.equal(f.db.get('SELECT count(*) n FROM dispatches WHERE card_id=?', created.structuredContent.card.id).n, 0);
  await until(() => f.h.app.remoteState.inFlight === 0); assert.equal(f.h.app.remoteState.transports.size, 0);
});

test('actual SDK OAuth discovery and DCR through exact HTTPS Claude callback obtain selected-board MCP tokens',async t=>{
  const f=await remoteRig(t),ident=await session(f);let clientInfo,verifier,tokens,target;
  const callback='https://claude.ai/api/mcp/auth_callback';
  const provider={redirectUrl:callback,clientMetadata:{client_name:'Synthetic Claude-compatible client (unverified)',redirect_uris:[callback],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']},
    clientInformation:()=>clientInfo,saveClientInformation:value=>{clientInfo=value;},saveCodeVerifier:value=>{verifier=value;},codeVerifier:()=>verifier,tokens:()=>tokens,saveTokens:value=>{tokens=value;},state:()=>randomUUID(),redirectToAuthorization:value=>{target=value;}};
  assert.equal(await auth(provider,{serverUrl:new URL(f.h.base+'/api/mcp')}),'REDIRECT');
  const started=await request(f,target.pathname+target.search),browser=started.res.headers.get('set-cookie').split(';')[0],cookie=ident.cookie+'; '+browser;
  assert.equal(started.status,303,started.text);const intent=new URL(started.res.headers.get('location'),f.h.base).hash.slice('#intent='.length);
  assert.equal((await request(f,'/oauth/consent?intent='+intent,{cookie})).status,200);
  const approved=await request(f,'/oauth/consent',{method:'POST',cookie,csrf:ident.csrf,body:{intent_id:intent,team_id:f.A.team,approve:true,board_ids:[f.A.board],mode:'read'}});assert.equal(approved.status,200,approved.text);
  const result=new URL(approved.data.redirect_uri);assert.equal(result.origin+result.pathname,callback);assert.equal(result.searchParams.get('iss'),f.h.base);
  assert.equal(await auth(provider,{serverUrl:new URL(f.h.base+'/api/mcp'),authorizationCode:result.searchParams.get('code')}),'AUTHORIZED');
  assert.match(tokens.access_token,/^pfm_/);assert.deepEqual(f.authority.authenticate(tokens.access_token,'mcp').boardIds,[f.A.board]);assert.equal(f.authority.authenticate(tokens.access_token,'mcp').mode,'read');
  assert.equal((await rpc(f,tokens.access_token,'tools/list')).data.result.tools.length,7);
  const oldAccess=tokens.access_token;assert.equal(await auth(provider,{serverUrl:new URL(f.h.base+'/api/mcp')}),'AUTHORIZED');assert.notEqual(tokens.access_token,oldAccess);assert.equal(f.authority.authenticate(tokens.access_token,'mcp').mode,'read');
  const changed=await request(f,'/oauth/authorize?'+new URLSearchParams({...Object.fromEntries(target.searchParams),redirect_uri:'https://claude.ai/api/mcp/auth_callback/other'}));assert.equal(changed.status,400,changed.text);
});

test('consent requires current browser cookie, CSRF session, bound identity, exact selected scope and single approval', async t => {
  const f = await remoteRig(t), q = await flow(f); const before = f.db.get('SELECT count(*) n FROM remote_grants').n;
  for (const opts of [ { cookie: q.cookie }, { cookie: q.identity.cookie, csrf: q.identity.csrf },
    { cookie: q.cookie, csrf: q.identity.csrf, headers: { origin: 'https://foreign.test' } } ]) {
    const r = await request(f, '/oauth/consent', { method: 'POST', body: q.body, ...opts }); assert.equal(r.status, 403, r.text);
  }
  const other = await session(f, f.users.ua);
  const replacement = await request(f, '/oauth/consent', { method: 'POST', body: q.body, cookie: `${other.cookie}; ${q.browser}`, csrf: other.csrf }); assert.equal(replacement.status, 401, replacement.text);
  const wrongBoard = await request(f, '/oauth/consent', { method: 'POST', body: { ...q.body, board_ids: [f.B.board] }, cookie: q.cookie, csrf: q.identity.csrf }); assert.equal(wrongBoard.status, 404, wrongBoard.text);
  assert.equal(f.db.get('SELECT count(*) n FROM remote_grants').n, before);
  const approved = await request(f, '/oauth/consent', { method: 'POST', body: q.body, cookie: q.cookie, csrf: q.identity.csrf }); assert.equal(approved.status, 200, approved.text);
  const duplicate = await request(f, '/oauth/consent', { method: 'POST', body: q.body, cookie: q.cookie, csrf: q.identity.csrf }); assert.equal(duplicate.status, 403, duplicate.text);
  assert.equal(f.db.get('SELECT count(*) n FROM remote_grants').n, before + 1);
});

test('MCP challenges reject ordinary and wrong-audience credentials, Host/Origin, session headers and malformed protocol', async t => {
  const f = await remoteRig(t), q = await issue(f), g = await grant(f); const before = business(f);
  for (const token of [null, f.users.amember.token, g.token, q.refresh_token]) {
    const r = await rpc(f, token, 'tools/list'); assert.equal(r.status, 401, r.text); assert.match(r.res.headers.get('www-authenticate'), /oauth-protected-resource\/api\/mcp/);
  }
  const foreignHost = await raw(f, { headers: { host:'foreign.test', authorization:`Bearer ${q.access_token}`, 'content-type':'application/json' } }); assert.equal(foreignHost.status,403,foreignHost.text);
  for (const [headers, status] of [[{ origin:'https://foreign.test' },403],[{ 'mcp-session-id':'forged' },400],[{ 'mcp-protocol-version':'1900-01-01' },400]]) {
    const r = await rpc(f,q.access_token,'tools/list',null,{headers}); assert.equal(r.status,status,r.text);
  }
  for (const method of ['GET','DELETE']) { const r = await request(f,'/api/mcp',{method,token:q.access_token}); assert.equal(r.status,405); assert.equal(r.res.headers.get('allow'),'POST'); }
  const missing = await request(f,'/api/mcp',{method:'POST',token:q.access_token,body:{jsonrpc:'2.0',id:1,method:'tools/list'},headers:{accept:'application/json, text/event-stream'}});assert.equal(missing.status,400);
  const exec = await rpc(f,q.access_token,'tools/call',{name:'plexiform_execute',arguments:{card_id:f.A.card}}); assert.equal(exec.status,400,exec.text);
  assert.equal(business(f),before);
});

test('duplicate headers, JSON/form security fields, invalid UTF8 and oversized bodies fail before authority changes', async t => {
  const f = await remoteRig(t), q = await issue(f), before = business(f);
  const dup = await raw(f,{headers:['Host',new URL(f.h.base).host,'Authorization',`Bearer ${q.access_token}`,'Authorization',`Bearer ${q.access_token}`,'Content-Type','application/json']}); assert.equal(dup.status,400,dup.text);
  const json = await request(f,'/api/mcp',{method:'POST',token:q.access_token,body:'{"jsonrpc":"2.0","id":1,"method":"tools/list","method":"tools/call"}',headers:{accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'}});assert.equal(json.status,400,json.text);
  const form = await request(f,'/oauth/token',{method:'POST',body:new URLSearchParams(q.form).toString()+'&resource='+encodeURIComponent(q.form.resource),headers:{'content-type':'application/x-www-form-urlencoded'}});assert.equal(form.status,400,form.text);
  const utf8 = await raw(f,{path:'/oauth/register',headers:{'content-type':'application/json'},body:Buffer.from([0xff])});assert.equal(utf8.status,400,utf8.text);
  const huge = await request(f,'/oauth/register',{method:'POST',body:'x'.repeat(8193)});assert.equal(huge.status,413,huge.text);
  assert.equal(business(f),before); await until(()=>f.h.app.remoteState.inFlight===0);assert.equal(f.h.app.remoteState.transports.size,0);
});

test('HTTP code concurrency, refresh reuse and revocation use the durable family with no revived access',async t=>{
  const f=await remoteRig(t),q=await issue(f);
  const oldCode=await request(f,'/oauth/token',{method:'POST',body:new URLSearchParams(q.form).toString(),headers:{'content-type':'application/x-www-form-urlencoded'}});assert.equal(oldCode.status,400);
  const refresh={grant_type:'refresh_token',client_id:q.params.client_id,resource:q.params.resource,refresh_token:q.refresh_token};
  const results=await Promise.all([1,2].map(()=>request(f,'/oauth/token',{method:'POST',body:new URLSearchParams(refresh).toString(),headers:{'content-type':'application/x-www-form-urlencoded'}})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
  const newToken=results.find(r=>r.status===200).data.access_token;
  for(const token of[q.access_token,newToken])assert.equal((await rpc(f,token,'tools/list')).status,401);
  const revoke=await request(f,'/oauth/revoke',{method:'POST',body:new URLSearchParams({client_id:q.params.client_id,token:newToken}).toString(),headers:{'content-type':'application/x-www-form-urlencoded'}});assert.equal(revoke.status,200);
});

test('read-only grant advertises seven tools and HTTP write refusal carries scope guidance without effects',async t=>{
  const f=await remoteRig(t),q=await issue(f,'read'),before=business(f);
  const listed=await rpc(f,q.access_token,'tools/list');assert.equal(listed.status,200,listed.text);assert.equal(listed.data.result.tools.length,7);
  const write=await rpc(f,q.access_token,'tools/call',{name:'plexiform_create_card',arguments:{board_id:f.A.board,title:'Denied',request_id:randomUUID()}});assert.equal(write.status,403,write.text);assert.match(write.res.headers.get('www-authenticate'),/insufficient_scope/);
  assert.equal(business(f),before);
});

test('browser grant management refuses device credentials, duplicate bodies and old gestures; shows a token only once',async t=>{
  const f=await remoteRig(t),ident=await session(f),path=`/api/teams/${f.A.team}/remote-grants`;
  const device=await request(f,path+'/gesture',{method:'POST',token:f.users.amember.token,body:{purpose:'create'},headers:{origin:f.h.base,'x-csrf-token':ident.csrf}});assert.equal(device.status,403,device.text);
  const missing=await request(f,path+'/gesture',{method:'POST',cookie:ident.cookie,body:{purpose:'create'}});assert.equal(missing.status,403,missing.text);
  const wrongType=await request(f,path+'/gesture',{method:'POST',cookie:ident.cookie,csrf:ident.csrf,body:{purpose:'create'},headers:{'content-type':'text/plain'}});assert.equal(wrongType.status,400,wrongType.text);assert.equal(f.db.get('SELECT count(*) n FROM remote_gestures').n,0);
  const duplicate=await request(f,path+'/gesture',{method:'POST',cookie:ident.cookie,csrf:ident.csrf,body:'{"purpose":"create","purpose":"revoke"}'});assert.equal(duplicate.status,400,duplicate.text);
  const gesture=await request(f,path+'/gesture',{method:'POST',cookie:ident.cookie,csrf:ident.csrf,body:{purpose:'create'}});assert.equal(gesture.status,200,gesture.text);
  const input={gesture_id:gesture.data.gesture_id,name:'Show once HTTP app',board_ids:[f.A.board],mode:'read',expires_days:1};
  const created=await request(f,path,{method:'POST',cookie:ident.cookie,csrf:ident.csrf,body:input});assert.equal(created.status,200,created.text);assert.match(created.data.token,/^pfi_/);
  const replay=await request(f,path,{method:'POST',cookie:ident.cookie,csrf:ident.csrf,body:input});assert.equal(replay.status,403,replay.text);assert.equal(replay.text.includes(created.data.token),false);
  const list=await request(f,path,{cookie:ident.cookie});assert.equal(list.status,200,list.text);assert.equal(list.text.includes(created.data.token),false);assert.equal(list.data.grants.length,1);
  const revoke=await request(f,path+'/gesture',{method:'POST',cookie:ident.cookie,csrf:ident.csrf,body:{purpose:'revoke'}});
  const removed=await request(f,path+'/'+created.data.grant.id,{method:'DELETE',cookie:ident.cookie,csrf:ident.csrf,body:{gesture_id:revoke.data.gesture_id}});assert.equal(removed.status,200,removed.text);
  assert.throws(()=>f.authority.authenticate(created.data.token,'integration'),error=>error.code==='UNAUTHENTICATED');
});

for(const scenario of ['grant revoked','board narrowed','member replacement'])test(`HTTP queued write rechecks ${scenario} without effects`,async t=>{
  const f=await remoteRig(t),spare=scenario==='board narrowed'?await spareBoard(f):null,q=await issue(f,'collaborate',spare?[f.A.board,spare]:[f.A.board]),row=f.authority.authenticate(q.access_token,'mcp').grant;
  const original=f.h.hub.withBoard.bind(f.h.hub);let release,entered=false;
  const held=original(f.A.board,()=>new Promise(resolve=>{release=resolve;}));await new Promise(resolve=>setImmediate(resolve));
  f.h.hub.withBoard=(id,fn)=>{if(id===f.A.board)entered=true;return original(id,fn);};
  try{
    const pending=rpc(f,q.access_token,'tools/call',{name:'plexiform_add_comment',arguments:{card_id:f.A.card,body:'Must not commit',request_id:randomUUID()}});await until(()=>entered);
    if(scenario==='grant revoked')f.authority.revokeFamily(row.id);
    else if(scenario==='board narrowed')f.db.run('UPDATE remote_grants SET board_ids=? WHERE id=?',JSON.stringify([spare]),row.id);
    else f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.member);
    const before=business(f);release();await held;const result=await pending;
    assert.equal(result.status,200,result.text);assert.equal(result.data.result.isError,true);assert.equal(result.text.includes('Must not commit'),false);assert.equal(business(f),before);
    await until(()=>f.h.app.remoteState.inFlight===0);assert.equal(f.h.app.remoteState.transports.size,0);
  }finally{release?.();await held;f.h.hub.withBoard=original;}
});

for(const end of ['disconnect','deadline'])test(`actual HTTP ${end} closes transport and prevents a late queued mutation`,async t=>{
  const f=await remoteRig(t,{remoteLimits:{httpDeadlineMs:300}}),q=await issue(f);
  const original=f.h.hub.withBoard.bind(f.h.hub);let release,entered=false;
  const held=original(f.A.board,()=>new Promise(resolve=>{release=resolve;}));await new Promise(resolve=>setImmediate(resolve));
  f.h.hub.withBoard=(id,fn)=>{if(id===f.A.board)entered=true;return original(id,fn);};
  try{
    let req;
    const pending=new Promise(resolve=>{
      req=http.request(f.h.base+'/api/mcp',{method:'POST',headers:{authorization:`Bearer ${q.access_token}`,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString()}));
      });req.on('error',()=>resolve({disconnected:true}));req.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'plexiform_add_comment',arguments:{card_id:f.A.card,body:'Cancelled write',request_id:randomUUID()}}}));
    });
    await until(()=>entered);assert.equal(f.h.app.remoteState.transports.size,1);
    if(end==='disconnect')req.destroy();
    const result=await pending;if(end==='deadline')assert.equal(result.status,408,result.text);
    await until(()=>f.h.app.remoteState.inFlight===0);assert.equal(f.h.app.remoteState.transports.size,0);assert.equal(f.h.app.remoteState.ips.size,0);assert.equal(f.h.app.remoteState.grants.size,0);
    const before=business(f);release();await held;await new Promise(resolve=>setImmediate(resolve));assert.equal(business(f),before);
  }finally{release?.();await held;f.h.hub.withBoard=original;}
});

test('bounded in-flight HTTP admission refuses a second held request and recovers its slots',async t=>{
  const f=await remoteRig(t,{remoteLimits:{httpInFlight:1}}),q=await issue(f);
  const original=f.h.hub.withBoard.bind(f.h.hub);let release,entered=false;
  const held=original(f.A.board,()=>new Promise(resolve=>{release=resolve;}));await new Promise(resolve=>setImmediate(resolve));
  f.h.hub.withBoard=(id,fn)=>{if(id===f.A.board)entered=true;return original(id,fn);};
  try{
    const pending=rpc(f,q.access_token,'tools/call',{name:'plexiform_add_comment',arguments:{card_id:f.A.card,body:'Admitted once',request_id:randomUUID()}});await until(()=>entered);
    const second=await rpc(f,q.access_token,'tools/list');assert.equal(second.status,429,second.text);assert.equal(f.h.app.remoteState.inFlight,1);
    release();await held;assert.equal((await pending).status,200);await until(()=>f.h.app.remoteState.inFlight===0);assert.equal((await rpc(f,q.access_token,'tools/list')).status,200);
  }finally{release?.();await held;f.h.hub.withBoard=original;}
});

test('current SESSION cannot list or revoke another account/team grant through management routes',async t=>{
  const f=await remoteRig(t),a=await grant(f),b=await grant(f,{user:f.users.ub,memberId:f.B.owner,boardIds:[f.B.board],name:'B-SECRET grant label'}),before=business(f);
  for(const path of[`/api/teams/${f.B.team}/remote-grants`,`/api/teams/${f.A.team}/remote-grants/${b.grant.id}`]){
    const r=await request(f,path,{method:path.endsWith(b.grant.id)?'DELETE':'GET',cookie:a.identity.cookie,csrf:a.identity.csrf,...(path.endsWith(b.grant.id)?{body:{gesture_id:randomUUID()}}:{})});assert.equal(r.status,404,r.text);assert.equal(r.text.includes('B-SECRET'),false);
  }
  assert.equal(f.authority.authenticate(b.token).member.id,f.B.owner);assert.equal(business(f),before);
});

test('browser cookie duplication and explicit cancellation cannot grant or silently follow a callback',async t=>{
  const f=await remoteRig(t,{webDir:fileURLToPath(new URL('../../web',import.meta.url))}),q=await flow(f),before=f.db.get('SELECT count(*) n FROM remote_grants').n;
  const duplicated=await request(f,'/oauth/consent?intent='+q.intent,{cookie:q.cookie+'; '+q.browser});assert.equal(duplicated.status,403,duplicated.text);
  const cancelled=await request(f,'/oauth/consent',{method:'POST',cookie:q.cookie,csrf:q.identity.csrf,body:{...q.body,approve:false,board_ids:[],mode:'read'}});assert.equal(cancelled.status,200,cancelled.text);
  const callback=new URL(cancelled.data.redirect_uri);assert.equal(callback.searchParams.get('error'),'access_denied');assert.equal(callback.searchParams.get('iss'),f.h.base);assert.equal(callback.searchParams.has('code'),false);
  assert.equal(f.db.get('SELECT count(*) n FROM remote_grants').n,before);
  for(const path of['/connections','/remote-consent']){const page=await request(f,path);assert.equal(page.status,200,page.text);assert.equal(page.res.headers.get('referrer-policy'),'no-referrer');assert.match(page.res.headers.get('content-security-policy'),/script-src 'self'/);}
});

test('DCR stores no arbitrary metadata URLs, quotas registration and slow body deadlines release admission',async t=>{
  const f=await remoteRig(t,{remoteLimits:{registeredClients:1,httpDeadlineMs:100}});
  const arbitrary=await request(f,'/oauth/register',{method:'POST',body:{client_name:'Synthetic',redirect_uris:['https://client.test/callback'],logo_uri:'http://127.0.0.1/private'}});assert.equal(arbitrary.status,400,arbitrary.text);assert.equal(f.db.get('SELECT count(*) n FROM remote_clients').n,0);
  const body={client_name:'Synthetic',redirect_uris:['https://client.test/callback']};assert.equal((await request(f,'/oauth/register',{method:'POST',body})).status,201);
  const full=await request(f,'/oauth/register',{method:'POST',body});assert.equal(full.status,403,full.text);assert.equal(f.db.get('SELECT count(*) n FROM remote_clients').n,1);
  let req;const pending=new Promise(resolve=>{req=http.request(f.h.base+'/oauth/register',{method:'POST',headers:{'content-type':'application/json','content-length':'100'}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString()}));});req.on('error',()=>{});req.write('{');});
  const timed=await pending;assert.equal(timed.status,408,timed.text);req.destroy();await until(()=>f.h.app.remoteState.inFlight===0);assert.equal(f.h.app.remoteState.ips.size,0);
});
