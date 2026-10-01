'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('setupsApi',{
  state:()=>ipcRenderer.invoke('setups:state'),read:handle=>ipcRenderer.invoke('setups:read',handle),
  draft:(handle,input)=>ipcRenderer.invoke('setups:draft',handle,input),edit:(handle,input)=>ipcRenderer.invoke('setups:edit',handle,input),
  approve:(handle,file,hash)=>ipcRenderer.invoke('setups:approve',handle,file,hash),publish:(handle,hash)=>ipcRenderer.invoke('setups:publish',handle,hash),
  action:(handle,op,input)=>ipcRenderer.invoke('setups:action',handle,op,input),export:handle=>ipcRenderer.invoke('setups:export',handle),
  changed:callback=>ipcRenderer.on('setups:changed',()=>callback()),
});
