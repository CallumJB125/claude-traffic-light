'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../setups.js'),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
const OLD='Synthetic older account configuration';
const payload=text=>({files:[{id:'file1',source_id:'git',relative_path:'.gitconfig',content:text,note:''}],items:[],note:''});
const read=text=>({ok:true,version:1,versions:[],own:true,payload:payload(text)});
const draft=(handle='draft1',text=OLD)=>({ok:true,handle,content_hash:'hash1',file_hashes:[{file_id:'file1',hash:'file-hash1'}],approved_files:['file1'],payload:payload(text)});
const state={status:'complete',sources:[{id:'git',label:'Git'}],teams:[{name:'Synthetic team',handle:'team1',role:'owner',status:'complete',profiles:[{handle:'profile1',own:true,version:1,files:1,items:0},{handle:'profile2',own:true,version:2,files:1,items:0}]}]};
function fixture(t,overrides={}){
  let changed,stateCalls=0;const calls=[];
  const dom=new JSDOM('<div id="teams"></div><div id="review"></div><p id="status"></p><button id="refresh"></button>',{runScripts:'outside-only'});t.after(()=>dom.window.close());
  dom.window.HTMLElement.prototype.scrollIntoView=()=>{};dom.window.confirm=()=>true;
  const methods={state:async()=>state,read:async()=>read(OLD),draft:async()=>draft(),edit:async()=>draft(),approve:async()=>draft(),publish:async()=>({ok:true}),action:async()=>({ok:true,activity:[]}),export:async()=>({ok:true}),...overrides};
  dom.window.setupsApi=Object.fromEntries(Object.entries(methods).map(([name,fn])=>[name,(...args)=>{calls.push({name,args});if(name==='state')stateCalls++;return fn(...args);} ]));
  dom.window.setupsApi.changed=fn=>changed=fn;dom.window.eval(source);
  const button=text=>[...dom.window.document.querySelectorAll('button')].find(node=>node.textContent===text);
  return {dom,calls,button,changed:()=>changed(),stateCalls:()=>stateCalls,review:()=>dom.window.document.getElementById('review'),status:()=>dom.window.document.getElementById('status').textContent};
}
async function open(f){f.button('Review').click();await tick();}
async function inspect(f){f.button('Select files to share').click();const check=f.review().querySelector('input[value="git"]');check.checked=true;f.button('Inspect selected files').click();await tick();}
for(const operation of ['read','draft','edit','approve','publish','activity','baseline','receipt','export'])test(`native identity notification retires pending renderer ${operation} success and capabilities`,async t=>{
  let release;const method=['activity','baseline','receipt'].includes(operation)?'action':operation;
  const f=fixture(t,{[method]:()=>new Promise(r=>release=r),...(operation==='approve'?{draft:async()=>({...draft(),approved_files:[]})}:{})});await tick();
  if(['draft','edit','approve','publish'].includes(operation)){
    await inspect(f);
    if(operation==='edit')f.button('Save reviewed edits').click();
    if(operation==='approve'){const check=f.review().querySelector('input[type="checkbox"]');check.checked=true;check.dispatchEvent(new f.dom.window.Event('change'));}
    if(operation==='publish'){const check=[...f.review().querySelectorAll('input[type="checkbox"]')].at(-1);check.checked=true;check.dispatchEvent(new f.dom.window.Event('change'));f.button('Share reviewed setup').click();}
  }else{
    await open(f);
    if(operation==='activity')f.button('Show sharing activity').click();
    if(operation==='baseline')f.button('Set selected team baseline').click();
    if(operation==='receipt')f.button('Record selected entries as reviewed').click();
    if(operation==='export')f.button('Export your shared setup').click();
  }
  await tick();assert.ok(release,`${operation} reached its real pending API call`);f.changed();
  release(operation==='read'?read(OLD):['draft','edit','approve'].includes(operation)?draft():{ok:true,activity:[{created_at:'now',kind:OLD}]});await tick();
  assert.equal(f.review().textContent,'');assert.equal(f.dom.window.document.getElementById('teams').textContent,'');assert.equal(f.status(),'Your account changed. Refresh to load current team access.');assert.equal(f.stateCalls(),1);
});
test('native identity notification retires pending state success',async t=>{
  let release;const f=fixture(t,{state:()=>new Promise(r=>release=r)});f.changed();release(state);await tick();assert.equal(f.dom.window.document.getElementById('teams').textContent,'');assert.equal(f.status(),'Your account changed. Refresh to load current team access.');
});
test('later refresh wins over older state replies without resurrecting old handles',async t=>{
  const releases=[];const f=fixture(t,{state:()=>new Promise(r=>releases.push(r))});f.dom.window.document.getElementById('refresh').click();assert.equal(releases.length,2);
  releases[1]({...state,teams:[{...state.teams[0],name:'Current team'}]});await tick();releases[0]({...state,teams:[{...state.teams[0],name:'Retired team'}]});await tick();assert.ok(f.dom.window.document.body.textContent.includes('Current team'));assert.ok(!f.dom.window.document.body.textContent.includes('Retired team'));
});
test('later profile handle wins over a pending older read and its failure',async t=>{
  let release;const f=fixture(t,{read:handle=>handle==='profile1'?new Promise(r=>release=r):Promise.resolve(read('Current reviewed configuration'))});await tick();const buttons=[...f.dom.window.document.querySelectorAll('button')].filter(n=>n.textContent==='Review');buttons[0].click();await tick();buttons[1].click();await tick();release({ok:false,error:'Retired account error'});await tick();assert.ok(f.review().textContent.includes('Current reviewed configuration'));assert.ok(!f.status().includes('Retired account error'));
});
test('pending saved edit cannot overwrite a newer unsaved change to the same draft handle',async t=>{
  let release;const f=fixture(t,{edit:()=>new Promise(r=>release=r)});await tick();await inspect(f);const text=f.review().querySelector('.file-text');text.value='First saved edit';text.dispatchEvent(new f.dom.window.Event('input'));f.button('Save reviewed edits').click();await tick();text.value='Newer unsaved edit';text.dispatchEvent(new f.dom.window.Event('input'));release(draft('draft1','First saved edit'));await tick();assert.equal(f.review().querySelector('.file-text').value,'Newer unsaved edit');assert.equal(f.button('Share reviewed setup').disabled,true);
});
test('pending edit uses its captured draft and cannot replace a newer draft',async t=>{
  let release,n=0;const f=fixture(t,{draft:async()=>draft(`draft${++n}`,n===1?OLD:'Current draft text'),edit:()=>new Promise(r=>release=r)});await tick();await inspect(f);f.button('Save reviewed edits').click();await tick();await inspect(f);release(draft('draft1',OLD));await tick();assert.equal(f.review().querySelector('.file-text').value,'Current draft text');assert.equal(f.calls.find(c=>c.name==='edit').args[0],'draft1');
});
test('current action failure hides previous full reviewed text and disabled capabilities',async t=>{
  const f=fixture(t,{action:async()=>({ok:false,error:'Refresh current team access.'})});await tick();await open(f);assert.ok(f.review().textContent.includes(OLD));f.button('Show sharing activity').click();await tick();assert.equal(f.review().textContent,'');assert.equal(f.status(),'Refresh current team access.');
});
test('retired publish reply does not re-enable Share after a newer unsaved edit',async t=>{
  let release;const f=fixture(t,{publish:()=>new Promise(r=>release=r)});await tick();await inspect(f);
  const check=[...f.review().querySelectorAll('input[type="checkbox"]')].at(-1);check.checked=true;check.dispatchEvent(new f.dom.window.Event('change'));f.button('Share reviewed setup').click();await tick();
  const text=f.review().querySelector('.file-text');text.value='Newer unreviewed text';text.dispatchEvent(new f.dom.window.Event('input'));release({ok:true});await tick();
  assert.equal(f.button('Share reviewed setup').disabled,true);assert.equal(f.review().querySelector('.file-text').value,'Newer unreviewed text');assert.equal(f.stateCalls(),1);
});
