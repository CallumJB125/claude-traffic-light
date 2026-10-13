const test=require('node:test');
const assert=require('node:assert/strict');
const token='pfi_'+'a'.repeat(43),origin='https://synthetic.invalid';
const sdk=()=>import('../sdk/remote-client.mjs');
const result=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});

test('SDK keeps the integration token private, uses only its fixed audience endpoint, omits cookies and refuses redirects without retries',async()=>{
 const {createPlexiformClient,requestId}=await sdk();let count=0;
 const client=createPlexiformClient({origin,token,fetchImpl:async(url,init)=>{count++;assert.equal(url,origin+'/api/integration/v1');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer '+token);
   assert.deepEqual(JSON.parse(init.body),{tool:'plexiform_add_comment',arguments:{card_id:'task',request_id:'fixed-choice',body:'Reported'}});throw new Error('Untrusted failure '+token);}});
 assert.equal(Object.isFrozen(client),true);assert.equal(Object.values(client).includes(token),false);assert.match(requestId(),/^[0-9a-f-]{36}$/);
 await assert.rejects(client.addComment({card_id:'task',request_id:'fixed-choice',body:'Reported'}),error=>error.code==='NETWORK'&&!error.message.includes(token));assert.equal(count,1);
 assert.equal(client.dispatch,undefined);assert.equal(client.approve,undefined);assert.equal(client.call,undefined);
});

test('SDK refuses unsafe origins, token audiences, closed options and oversized UTF8 requests before a network call',async()=>{
 const {createPlexiformClient}=await sdk();let calls=0;const fetchImpl=async()=>{calls++;return result({});};
 for(const bad of['http://localhost:9999','http://private.invalid','https://user:pass@synthetic.invalid','https://synthetic.invalid/other','https://synthetic.invalid/?token=secret','https://synthetic.invalid/#private','file:///private'])assert.throws(()=>createPlexiformClient({origin:bad,token,fetchImpl}),error=>error.code==='VALIDATION');
 for(const bad of['pfm_'+'a'.repeat(43),'btk_'+'a'.repeat(43),token+' '])assert.throws(()=>createPlexiformClient({origin,token:bad,fetchImpl}),error=>error.code==='VALIDATION');
 const client=createPlexiformClient({origin,token,fetchImpl});
 await assert.rejects(client.createCard({board_id:'board',request_id:'fixed',title:'é'.repeat(40000)}),error=>error.code==='PAYLOAD_TOO_LARGE');
 await assert.rejects(client.getCard({card_id:'task'},{headers:{authorization:'other'}}),error=>error.code==='VALIDATION');
 const cyclic={card_id:'task'};cyclic.self=cyclic;await assert.rejects(client.getCard(cyclic),error=>error.code==='VALIDATION');assert.equal(calls,0);
});

test('SDK enforces its exact 64KiB encoded response boundary and streamed overrun before decoding',async()=>{
 const {createPlexiformClient,MAX_BYTES}=await sdk();
 const exact={value:'x'.repeat(MAX_BYTES-12)};assert.equal(Buffer.byteLength(JSON.stringify(exact)),MAX_BYTES);
 const client=createPlexiformClient({origin,token,fetchImpl:async()=>result(exact)});assert.deepEqual(await client.listBoards(),exact);
 let canceled=false;const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('x'.repeat(MAX_BYTES+1)));},cancel(){canceled=true;}});
 const oversized=createPlexiformClient({origin,token,fetchImpl:async()=>new Response(stream,{headers:{'content-type':'application/json'}})});
 await assert.rejects(oversized.listBoards(),error=>error.code==='PAYLOAD_TOO_LARGE');assert.equal(canceled,true);
});

test('SDK rejects declared oversize, invalid JSON/UTF8/type and never echoes server-private errors',async()=>{
 const {createPlexiformClient,MAX_BYTES}=await sdk();
 for(const response of[new Response('{}',{headers:{'content-type':'text/html'}}),new Response('[1]',{headers:{'content-type':'application/json'}}),new Response('{bad',{headers:{'content-type':'application/json'}}),new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}})]){
  const client=createPlexiformClient({origin,token,fetchImpl:async()=>response});await assert.rejects(client.listBoards(),error=>error.code==='REMOTE_ERROR');
 }
 const huge=createPlexiformClient({origin,token,fetchImpl:async()=>new Response('{}',{headers:{'content-type':'application/json','content-length':String(MAX_BYTES+1)}})});
 await assert.rejects(huge.listBoards(),error=>error.code==='PAYLOAD_TOO_LARGE');
 const failing=createPlexiformClient({origin,token,fetchImpl:async()=>new Response(JSON.stringify({error:{code:'FORBIDDEN',message:'PRIVATE-ERROR '+token}}),{status:403,headers:{'content-type':'application/json','retry-after':'5'}})});
 await assert.rejects(failing.listBoards(),error=>error.code==='FORBIDDEN'&&error.status===403&&error.retryAfter===5&&!error.message.includes('PRIVATE-ERROR')&&!error.message.includes(token));
});

test('SDK honors cancellation before a request and bounds a real fetch wait without automatic retries',async t=>{
 const {createPlexiformClient}=await sdk(),http=require('node:http');let count=0;
 const server=http.createServer((req,res)=>{count++;req.resume();});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const client=createPlexiformClient({origin:`http://127.0.0.1:${server.address().port}`,token,timeoutMs:50});
 const canceled=new AbortController();canceled.abort();await assert.rejects(client.listBoards({signal:canceled.signal}),error=>error.code==='TIMEOUT');assert.equal(count,0);
 const began=performance.now();await assert.rejects(client.addComment({card_id:'task',request_id:'same-uncertain-choice',body:'Reported'}),error=>error.code==='TIMEOUT');assert.ok(performance.now()-began<1000);for(let i=0;i<100&&count<1;i++)await new Promise(r=>setTimeout(r,20));assert.equal(count,1);
});

// Run stalled injected fetch/standard stream cases in bounded children. The
// keeper makes an unresolved SDK promise fail the process deadline, rather than
// passing because Node has no remaining handles. No real request is made.
function deadlineProbe(body){
 const source=require('node:url').pathToFileURL(require('node:path').resolve(__dirname,'../sdk/remote-client.mjs')).href;
 const code=`import assert from 'node:assert/strict';import {createPlexiformClient,MAX_BYTES} from ${JSON.stringify(source)};const token='pfi_'+'a'.repeat(43),origin='https://synthetic.invalid';const keep=setInterval(()=>{},10000);process.on('unhandledRejection',()=>{process.exitCode=19;});try{${body}}finally{clearInterval(keep);}`;
 const child=require('node:child_process').spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:2000});
 assert.equal(child.status,0,JSON.stringify({status:child.status,signal:child.signal,error:child.error?.code,stderr:child.stderr}));
}

test('SDK deadline rejects a supplied fetch that never returns or honors AbortSignal',()=>deadlineProbe(`
 let calls=0,signal;const client=createPlexiformClient({origin,token,timeoutMs:30,fetchImpl:async(u,o)=>{calls++;signal=o.signal;return new Promise(()=>{});}});
 await assert.rejects(client.listBoards(),e=>e.code==='TIMEOUT');assert.equal(signal.aborted,true);assert.equal(calls,1);
`));

test('SDK deadline rejects a pending standard reader even if cancellation never settles',()=>deadlineProbe(`
 let canceled=0;const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){canceled++;return new Promise(()=>{});}});
 const client=createPlexiformClient({origin,token,timeoutMs:30,fetchImpl:async()=>new Response(stream,{headers:{'content-type':'application/json'}})});
 await assert.rejects(client.listBoards(),e=>e.code==='TIMEOUT');assert.equal(canceled,1);assert.equal(stream.locked,false);
`));

test('SDK caller cancellation rejects a pending reader without waiting for stream cleanup',()=>deadlineProbe(`
 let entered;const ready=new Promise(r=>entered=r);let canceled=0;const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){canceled++;return new Promise(()=>{});}});
 const controller=new AbortController(),client=createPlexiformClient({origin,token,timeoutMs:500,fetchImpl:async()=>{entered();return new Response(stream,{headers:{'content-type':'application/json'}});}});
 const pending=client.listBoards({signal:controller.signal});await ready;await new Promise(r=>setTimeout(r,10));controller.abort();
 await assert.rejects(pending,e=>e.code==='TIMEOUT');assert.equal(canceled,1);assert.equal(stream.locked,false);
`));

test('SDK declared size refusal does not await a stalled body cancellation',()=>deadlineProbe(`
 let canceled=0;const stream=new ReadableStream({cancel(){canceled++;return new Promise(()=>{});}});
 const client=createPlexiformClient({origin,token,timeoutMs:30,fetchImpl:async()=>new Response(stream,{headers:{'content-type':'application/json','content-length':String(MAX_BYTES+1)}})});
 await assert.rejects(client.listBoards(),e=>e.code==='PAYLOAD_TOO_LARGE');assert.equal(canceled,1);
`));

test('SDK streamed size refusal does not await a stalled reader cancellation',()=>deadlineProbe(`
 let canceled=0;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(MAX_BYTES+1));},cancel(){canceled++;return new Promise(()=>{});}});
 const client=createPlexiformClient({origin,token,timeoutMs:30,fetchImpl:async()=>new Response(stream,{headers:{'content-type':'application/json'}})});
 await assert.rejects(client.listBoards(),e=>e.code==='PAYLOAD_TOO_LARGE');assert.equal(canceled,1);assert.equal(stream.locked,false);
`));

test('SDK cancels a late supplied response without retry or leaking cleanup rejection',()=>deadlineProbe(`
 let finish,canceled=0,calls=0;const client=createPlexiformClient({origin,token,timeoutMs:30,fetchImpl:()=>{calls++;return new Promise(r=>finish=r);}});
 await assert.rejects(client.listBoards(),e=>e.code==='TIMEOUT');assert.equal(calls,1);
 finish(new Response(new ReadableStream({cancel(){canceled++;return Promise.reject(new Error('synthetic cleanup refusal'));}}),{headers:{'content-type':'application/json'}}));
 await new Promise(r=>setTimeout(r,25));assert.equal(canceled,1);assert.equal(calls,1);
`));
