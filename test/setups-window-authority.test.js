'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const source=fs.readFileSync(path.join(__dirname,'..','buddy-window','index.js'),'utf8');
// Execute the shipped source factory and main-only methods; no renderer or
// private profile is opened by these hostile identity/window probes.
function fixture(){
 const marker={user:{id:'account-a'},device_id:'device-a',token:'not-a-real-token'},state={marker,hubs:['https://synthetic.example'],response:null,hold:null};
 const team={id:'team-a',member_id:'member-a',role:'member',name:'Synthetic'},principal={account:'account-a',team:'team-a',member:'member-a',device:'device-a'};
 const wc={getURL:()=>state.url,mainFrame:{},isDestroyed:()=>false,isLoading:()=>state.loading},win={isDestroyed:()=>state.destroyed,isVisible:()=>state.visible,isMinimized:()=>state.minimized,isFocused:()=>state.focused};
 const dir='/synthetic/app/buddy-window',expected=pathToFileURL(path.join(dir,'..','setups.html')).href;
 Object.assign(state,{url:expected,focused:true,visible:true,minimized:false,destroyed:false,loading:false});wc.mainFrame.url=expected;
 const context={path,pathToFileURL,DIR:dir,Promise,store:{hubs:()=>state.hubs},vault:()=>({load:()=>state.marker}),userOf:()=>state.marker?.user,hostOf:()=> 'Synthetic',clientFor:()=>({me:async()=>{if(state.hold)await state.hold();return state.response??{ok:true,user:{id:'account-a'},teams:[team]};},setups:async()=>({ok:true})}),win,selected:'setups',content:null,localViews:new Map(),state,wc};
 context.content={webContents:wc};context.localViews.set('setups',context.content);win.contentView={children:[context.content]};
 const factory=source.slice(source.indexOf('  async function setupSources()'),source.indexOf('  const myDayBroker'));
 const methods=source.slice(source.indexOf('    setupsActorCurrent(actor)'),source.indexOf('    onSetupsIdentityChange(listener)'));
 const retire=source.slice(source.indexOf('  function retireSetupDocument()'),source.indexOf('  // Before anything that can call forgetHub.'));
 const code='let setupSourcesGeneration=0,setupLocalGeneration=0,setupCurrentSources=[],setupModalTicket=null;const setupIdentityListeners=new Set();'+retire+factory+'const api={setupSources,'+methods+'};globalThis.api=api;globalThis.retireDocument=retireSetupDocument;globalThis.blur=()=>{if(!setupModalTicket)setupLocalGeneration++;};globalThis.navigate=()=>{setupLocalGeneration++;selected="other";};';
 vm.runInNewContext(code,context);return {api:context.api,context,state,marker,principal,wc,win};
}
test('actual sealed device and marker bind setup actor; token/identity never appear in sharing row',async()=>{
 const f=fixture(),rows=await f.api.setupSources();assert.equal(rows[0].deviceId,'device-a');assert.equal(f.api.setupsActorCurrent(f.principal),true);assert.equal(JSON.stringify(rows).includes(f.marker.token),false);
 f.state.marker={...f.marker};assert.equal(rows[0].current(),false);assert.equal(f.api.setupsActorCurrent(f.principal),false);
});
test('in-place device change, removed hub and refreshed source retire old grants',async()=>{
 for(const mutate of [f=>f.marker.device_id='device-b',f=>f.state.hubs=[],async f=>f.api.setupSources()]){const f=fixture(),rows=await f.api.setupSources();await mutate(f);assert.equal(rows[0].current(),false);}
 const f=fixture();await f.api.setupSources();assert.equal(f.api.setupsActorCurrent({...f.principal,member:'other'}),false);assert.equal(f.api.setupsActorCurrent({...f.principal,device:'other'}),false);
});
test('late source result cannot supersede current refreshed identity',async()=>{
 const f=fixture();let release;f.state.hold=()=>new Promise(r=>release=r);const old=f.api.setupSources();await new Promise(r=>setImmediate(r));f.state.hold=null;await f.api.setupSources();release();const oldRows=await old;assert.equal(oldRows.length,0);assert.equal(f.api.setupsActorCurrent(f.principal),true);
});
test('owned context requires exact current top page, attachment, visible active window',()=>{
 for(const mutate of [f=>f.state.url+='?path=foreign',f=>f.wc.mainFrame.url='https://synthetic.example',f=>f.state.visible=false,f=>f.state.minimized=true,f=>f.state.loading=true,f=>f.context.selected='other',f=>f.context.content=null,f=>f.win.contentView.children=[]]){const f=fixture();assert.equal(f.api.setupsContext().foreground,true);mutate(f);assert.equal(f.api.setupsContext(),null);}
 const f=fixture();f.state.focused=false;assert.equal(f.api.setupsContext().foreground,false);const g=f.api.setupsContext().generation;f.context.blur();f.state.focused=true;assert.ok(f.api.setupsContext().generation>g);
});
test('only one owned native modal and actual foreground/current view can return approval',async()=>{
 const f=fixture();let release;const pending=f.api.setupsConfirm(w=>{assert.equal(w,f.win);return new Promise(r=>release=r);});assert.equal(await f.api.setupsConfirm(()=>true),null);f.context.blur();release({approved:true});assert.equal((await pending).approved,true);
 for(const mutate of [g=>g.state.focused=false,g=>g.context.navigate(),g=>g.state.visible=false,g=>g.wc.mainFrame.url='https://synthetic.example']){const g=fixture(),pending=g.api.setupsConfirm(()=>new Promise(r=>release=r));mutate(g);release({approved:true});assert.equal(await pending,null);}
});
test('same-URL document retirement invalidates pending native approval even with retained mainFrame',async()=>{
 const f=fixture(),frame=f.wc.mainFrame;let release;const before=f.api.setupsContext().generation,pending=f.api.setupsConfirm(()=>new Promise(r=>release=r));f.context.retireDocument();assert.equal(f.wc.mainFrame,frame);assert.ok(f.api.setupsContext().generation>before);release({approved:true});assert.equal(await pending,null);
 assert.match(source,/v\.webContents\.on\('did-start-navigation',d=>\{if\(d\.isMainFrame\)retireSetupDocument\(\);\}\)/);
});
