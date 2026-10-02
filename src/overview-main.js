'use strict';
const {createOverviewService,response}=require('./overview-service');
// Exact visible main-app Overview document owns all action authority.
function createOverviewMain({buddy,sessions,work,managed,openManaged,messageManaged,now}){
 let authority=null,stopped=false;
 function owner(){const b=buddy(),c=b?.overviewContext?.();if(!c?.foreground||!c.window||!c.contents||c.window.isDestroyed()||c.contents.isDestroyed()||!c.contents.mainFrame||!Number.isSafeInteger(c.generation))return null;return{buddy:b,window:c.window,contents:c.contents,frame:c.contents.mainFrame,generation:c.generation};}
 function same(a){const b=owner();return!stopped&&!!a&&!!b&&a.buddy===b.buddy&&a.window===b.window&&a.contents===b.contents&&a.frame===b.frame&&a.generation===b.generation;}
 const service=createOverviewService({sessions,work,managed,openManaged,messageManaged,now,current:()=>same(authority),navigationCurrent:()=>!stopped&&!!authority&&buddy()===authority.buddy&&!authority.window.isDestroyed()&&!authority.contents.isDestroyed()&&authority.window.isVisible()&&!authority.window.isMinimized()&&authority.window.isFocused()});
 const allowed=(e,b)=>b&&e.sender===b.contents&&e.senderFrame===b.frame;
 return{
  register(ipc){
   ipc.handle('overview:state',async(e,...args)=>{const before=owner();if(!allowed(e,before)||!(args.length===0||args.length===1&&args[0]&&typeof args[0]==='object'&&!Array.isArray(args[0])&&Object.keys(args[0]).length===0))return null;
    authority=before;const result=await service.snapshot();return same(before)?result:null;});
   for(const action of ['open','message'])ipc.handle(`overview:${action}`,async(e,...args)=>{const before=owner();if(!allowed(e,before)||!same(authority)||args.length!==1)return response('unavailable');
    const result=await service[action](args[0]);return action==='open'?result:same(before)?result:response('stale');});
  },
  invalidate(){authority=null;service.invalidate();},close(){stopped=true;authority=null;service.invalidate();},
 };
}
module.exports={createOverviewMain};
