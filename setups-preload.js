'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const closed=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&keys.every(k=>Object.hasOwn(x,k))&&Object.keys(x).every(k=>keys.includes(k));
const refuse=()=>Promise.resolve({ok:false,status:'unavailable'});
const opaque=(channel,id)=>uuid(id)?ipcRenderer.invoke(channel,id):refuse();
function localPlan(handle,input){
  if(!uuid(handle)||!closed(input,['files','values'])||!Array.isArray(input.files)||!input.files.length||input.files.length>128||new Set(input.files.map(f=>f?.id)).size!==input.files.length||!input.values||typeof input.values!=='object'||Array.isArray(input.values))return refuse();
  if(input.files.some(f=>!closed(f,['id','mode','replace_keys','instructions','code'])||!uuid(f.id)||!['merge','replace'].includes(f.mode)||!Array.isArray(f.replace_keys)||f.replace_keys.length>1000||f.replace_keys.some(k=>typeof k!=='string'||k.length>200)||typeof f.instructions!=='boolean'||typeof f.code!=='boolean'))return refuse();
  const bytes=value=>new TextEncoder().encode(value).length;
  if(Object.keys(input.values).length>128||Object.entries(input.values).some(([k,v])=>!/^(USER|HOSTNAME|NAME|EMAIL(?::\d+)?|IP:\d+|HOST:\d+|PRIVATE:\d+|SSH_USER|SECRET:[\w.-]{1,64})$/.test(k)||typeof v!=='string'||v.includes('\0')||bytes(v)>4096)||Object.values(input.values).reduce((n,v)=>n+bytes(v),0)>16384)return refuse();
  return ipcRenderer.invoke('setups:plan',handle,JSON.parse(JSON.stringify(input)));
}
contextBridge.exposeInMainWorld('setupsApi',{
  state:()=>ipcRenderer.invoke('setups:state'),read:handle=>ipcRenderer.invoke('setups:read',handle),
  draft:(handle,input)=>ipcRenderer.invoke('setups:draft',handle,input),edit:(handle,input)=>ipcRenderer.invoke('setups:edit',handle,input),
  approve:(handle,file,hash)=>ipcRenderer.invoke('setups:approve',handle,file,hash),publish:(handle,hash)=>ipcRenderer.invoke('setups:publish',handle,hash),
  action:(handle,op,input)=>ipcRenderer.invoke('setups:action',handle,op,input),export:handle=>ipcRenderer.invoke('setups:export',handle),
  localState:()=>ipcRenderer.invoke('setups:local-state'),plan:localPlan,
  check:handle=>opaque('setups:check',handle),apply:(handle,hash)=>uuid(handle)&&typeof hash==='string'&&/^[0-9a-f]{64}$/.test(hash)?ipcRenderer.invoke('setups:apply',handle,hash):refuse(),
  listLocked:()=>ipcRenderer.invoke('setups:list-locked'),localStatus:id=>opaque('setups:local-status',id),
  recover:id=>opaque('setups:recover',id),confirmUndo:handle=>opaque('setups:confirm-undo',handle),
  changed:callback=>ipcRenderer.on('setups:changed',()=>callback()),
});
