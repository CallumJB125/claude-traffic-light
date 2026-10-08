'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {fromPage}=require('../src/utility-pages');
const root=path.join(__dirname,'..');
const contents=()=>({mainFrame:{},isDestroyed:()=>false});
const event=sender=>({sender,senderFrame:sender.mainFrame});
function wiring(){
  const registered=new Map(),opened=[],pages={help:contents()};
  const source=fs.readFileSync(path.join(root,'main.js'),'utf8');
  const start=source.indexOf("ipcMain.handle('help:navigate',");
  const end=source.indexOf('\n// ── First-run setup (onboarding.html)',start);
  assert.ok(start>=0&&end>start,'exercise the actual complete Help navigation registration');
  vm.runInNewContext(source.slice(start,end),{
    ipcMain:{handle:(name,handler)=>registered.set(name,handler)},
    fromUtilityPage:(e,id)=>fromPage(e,pages[id]),openBuddy:id=>opened.push(id),createOnboardingWindow:()=>opened.push('setup window'),
  });
  return {handler:registered.get('help:navigate'),opened,pages};
}
test('Help navigation opens only the existing destinations (and setup) with one closed argument',()=>{
  const f=wiring(),e=event(f.pages.help);
  for(const destination of ['overview','board','join','settings','aitools','aitools:codex','aitools:all','onboarding'])assert.equal(f.handler(e,destination),true);
  assert.deepEqual(f.opened,['overview','board','join','settings','aitools','aitools','aitools','setup window']);f.opened.length=0;
  for(const args of [[],['overview','extra'],[null],[{}],[['overview']],[new String('overview')],['https://example.com'],['file:///private/data'],['command'],['setups'],['aitools:../x'],['aitools:'],['aitoolsx'],['team'],['signin'],['Overview'],['onboarding','x'],['Onboarding']])assert.equal(f.handler(e,...args),false);
  assert.deepEqual(f.opened,[]);
});
test('Help navigation rejects foreign, subframe, retired, destroyed and missing owners',()=>{
  const f=wiring(),old=f.pages.help;
  for(const e of [{},null,event(contents()),{sender:old,senderFrame:{}}])assert.equal(f.handler(e,'overview'),false);
  f.pages.help=contents();assert.equal(f.handler(event(old),'overview'),false);
  f.pages.help.isDestroyed=()=>true;assert.equal(f.handler(event(f.pages.help),'overview'),false);
  f.pages.help=null;assert.equal(f.handler(event(old),'overview'),false);
  assert.deepEqual(f.opened,[]);
});
test('real Help preload and welcome buttons reach restricted main navigation while status remains usable',async()=>{
  const f=wiring(),els=new Map(),calls=[];let api;
  const html=fs.readFileSync(path.join(root,'help.html'),'utf8');
  for(const id of [...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]))els.set(id,{listeners:{},children:[],textContent:'',hidden:false,addEventListener(type,fn){this.listeners[type]=fn;},replaceChildren(...children){this.children=children;},append(child){this.children.push(child);}});
  const state={lamp:'green',headline:'Fixture status',lampText:'Idle',sessions:0,meaning:'Current status',why:[],also:[],busy:null,away:null,agents:null};
  vm.runInNewContext(fs.readFileSync(path.join(root,'help-preload.js'),'utf8'),{require:name=>{
    assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(name,value)=>{assert.equal(name,'helpApi');api=value;}},ipcRenderer:{on(){},invoke:async(channel,...args)=>{calls.push([channel,...args]);if(channel==='get-help')return state;if(channel==='help:navigate')return f.handler(event(f.pages.help),...args);throw Error('unexpected channel');}}};
  }});
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script,{document:{getElementById:id=>els.get(id),createElement:()=>({})},window:{helpApi:api,addEventListener(){},close(){}},location:{search:'?embedded=1'},URLSearchParams,console});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(els.get('headline').textContent,'Fixture status');
  assert.ok(html.indexOf('id="welcome-title"')<html.indexOf('id="headline"'));
  for(const id of ['start-setup','start-privacy'])await els.get(id).listeners.click();
  assert.deepEqual(f.opened,['setup window','settings']);
  assert.deepEqual(calls.filter(c=>c[0]==='help:navigate'),[['help:navigate','onboarding'],['help:navigate','settings']]);
  assert.doesNotMatch(html,/Plexiform Terminal setup steps|release checks/,'no internal copy in the welcome');
  f.pages.help=null;await els.get('start-setup').listeners.click();
  assert.match(els.get('start-notice').textContent,/Reopen Help/);
  assert.equal(els.get('headline').textContent,'Fixture status');
});
