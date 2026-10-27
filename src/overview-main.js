'use strict';
const {createOverviewService,response}=require('./overview-service');
// Exact visible main-app Overview document owns passive reads.
// Foreground focus remains required for every action and effect.
// Directory inputs (owned, shares, hubTeams, teamHub) are main-only; see overview-service.
function createOverviewMain({buddy,sessions,work,managed,openManaged,messageManaged,now,owned,shares,hubTeams,teamHub,followups,followupScope,followupLocal,shareView=null,presence,presenceView,looseEnds=null,chatPreview=false}){
 let authority=null,stopped=false;
 function owner(readOnly=false){const b=buddy(),c=readOnly?(b?.overviewReadContext?.()??b?.overviewContext?.()):b?.overviewContext?.();if(!c||!readOnly&&!c.foreground||!c.window||!c.contents||c.window.isDestroyed()||c.contents.isDestroyed()||!c.contents.mainFrame||!Number.isSafeInteger(c.generation))return null;return{buddy:b,window:c.window,contents:c.contents,frame:c.contents.mainFrame,generation:c.generation,document:c.document??null};}
 const equal=(a,b)=>!!a&&!!b&&a.buddy===b.buddy&&a.window===b.window&&a.contents===b.contents&&a.frame===b.frame&&a.generation===b.generation&&a.document===b.document;
 function same(a,readOnly=false){return!stopped&&equal(a,owner(readOnly));}
 const service=createOverviewService({sessions,work,managed,openManaged,messageManaged,now,owned,shares,hubTeams,teamHub,followups,followupScope,followupLocal,...(presence?{presence}:{}),...(presenceView?{presenceView}:{}),...(looseEnds?{looseEnds}:{}),current:()=>same(authority,true),actionCurrent:()=>same(authority),navigationCurrent:()=>!stopped&&!!authority&&buddy()===authority.buddy&&!authority.window.isDestroyed()&&!authority.contents.isDestroyed()&&authority.window.isVisible()&&!authority.window.isMinimized()&&authority.window.isFocused()});
 let pumping=false;
 const pump=followups?setInterval(()=>{if(pumping||stopped)return;pumping=true;Promise.resolve(service.pumpFollowups()).catch(()=>{}).finally(()=>{pumping=false;});},1500):null;
 pump?.unref?.();
 const allowed=(e,b)=>b&&e.sender===b.contents&&e.senderFrame===b.frame;
 // Chat-first preview only (redesign R1): the sidebar document reads the
 // session list, nothing else. Its own owner and generation, never owner():
 // owner() also authorises viewing, team-inspect and followup-list. A sidebar
 // read never adopts or invalidates the Overview authority, and it is served
 // by passiveRows(), which leaves the Overview page's handles and route alone.
 const SidebarRows=require('./overview-sidebar-rows');
 function sidebarOwner(){if(chatPreview!==true||stopped)return null;const b=buddy(),c=b?.sidebarReadContext?.();if(!c||!c.window||!c.contents||c.window.isDestroyed()||c.contents.isDestroyed()||!c.contents.mainFrame||!Number.isSafeInteger(c.generation))return null;return{buddy:b,window:c.window,contents:c.contents,frame:c.contents.mainFrame,generation:c.generation,document:c.document??null};}
 const sameSidebar=a=>!stopped&&equal(a,sidebarOwner());
 const fromSidebarDoc=e=>{const s=sidebarOwner();return allowed(e,s)?s:null;};
 // build() reads every registered board source, so sidebar reads are bounded to
 // Overview's own 5 s cadence: concurrent reads share one pass, and a finished
 // pass is reused by the same sidebar document until it is 5 s old.
 const SIDEBAR_MIN_MS=5000,clock=()=>typeof now==='function'?now():Date.now();
 let sidebarRead=null;
 async function sidebarState(before,args){
  if(args.length!==0)return null;
  const t=clock();
  if(!(sidebarRead&&equal(sidebarRead.owner,before)&&(sidebarRead.pending||t-sidebarRead.at<SIDEBAR_MIN_MS))){
   const read={owner:before,at:t,pending:true,result:null};
   read.result=service.passiveRows(()=>sameSidebar(before)).then(out=>out?SidebarRows.sidebarRows(out):null,()=>null).then(r=>{read.pending=false;read.at=clock();if(!r&&sidebarRead===read)sidebarRead=null;return r;});
   sidebarRead=read;
  }
  const r=await sidebarRead.result;
  return r&&sameSidebar(before)?structuredClone(r):null;
 }
 const adopt=before=>{if(authority&&!equal(authority,before))service.invalidate();authority=before;};
 return{
  register(ipc){
   ipc.handle('overview:state',async(e,...args)=>{const side=fromSidebarDoc(e);if(side)return sidebarState(side,args);const before=owner(true);if(!allowed(e,before)||!(args.length===0||args.length===1&&args[0]&&typeof args[0]==='object'&&!Array.isArray(args[0])&&Object.keys(args[0]).length===0))return null;
    adopt(before);const result=await service.snapshot();if(!same(before,true))return null;
    // Recompute focus after the final await; this changes only public controls.
    if(!same(before))for(const row of result.sessions)for(const action of ['open','message'])if(row.capabilities[action].enabled)row.capabilities[action]={...row.capabilities[action],enabled:false,reason:'Focus Plexiform and refresh before acting.'};
    return result;});
   ipc.handle('overview:directory',async(e,...args)=>{const before=owner(true);if(!allowed(e,before)||args.length!==1)return null;
    adopt(before);const result=await service.directory(args[0]);return same(before,true)?result:null;});
   ipc.handle('overview:viewing',async(e,...args)=>{const before=owner(true);if(!allowed(e,before)||args.length!==1)return response('unavailable');adopt(before);return service.viewing(args[0]);});
   ipc.handle('overview:team-inspect',async(e,...args)=>{const before=owner(true);if(!allowed(e,before)||args.length!==1)return response('unavailable');
    adopt(before);const result=await service.teamInspect(args[0]);return same(before,true)?result:response('stale');});
   ipc.handle('overview:team-action',async(e,...args)=>{const before=owner();if(!allowed(e,before)||!same(authority)||args.length!==1)return response('unavailable');
    const result=await service.teamAction(args[0]);return same(before)?result:{ok:false,status:'unconfirmed',error:'The view changed. Inspect the session receipt before sending again.'};});
   ipc.handle('overview:team-message',async(e,...args)=>{const before=owner();if(!allowed(e,before)||!same(authority)||args.length!==1)return response('unavailable');
    const result=await service.teamMessage(args[0]);return same(before)?result:response('stale');});
   ipc.handle('overview:followup-list',async(e,...args)=>{const before=owner(true);if(!allowed(e,before)||args.length)return response('unavailable');adopt(before);const result=await service.followupList();return same(before,true)?result:response('stale');});
   for(const [name,method]of [['review','followupReview'],['enqueue','followupEnqueue'],['cancel','followupCancel'],['discard','followupDiscard']])ipc.handle(`overview:followup-${name}`,async(e,...args)=>{const before=owner();if(!allowed(e,before)||!same(authority)||args.length!==1)return response('unavailable');const result=await service[method](args[0]);return same(before)?result:response('stale');});
   for(const [name,method]of [['inventory','coordinatorInventory'],['propose','coordinatorPropose'],['confirm','coordinatorConfirm'],['results','coordinatorResults'],['cancel','coordinatorCancel'],['request-owner','coordinatorRequestOwner'],['remote-list','coordinatorRemoteList'],['remote-send','coordinatorRemoteSend'],['remote-cancel','coordinatorRemoteCancel'],['remote-replace','coordinatorRemoteReplace']])ipc.handle(`overview:coordinator-${name}`,async(e,...args)=>{const passive=name==='inventory'||name==='results'||name==='remote-list',before=owner(passive);if(!allowed(e,before)||args.length!==1||!passive&&!same(authority))return response('unavailable');if(passive)adopt(before);const result=await service[method](args[0]);return same(before,passive)?result:{ok:false,status:name==='confirm'||name==='remote-send'?'unconfirmed':'stale',error:'The view changed. Check current receipts before acting again.'};});
   // Share a saved filter view with the team the page is showing: main posts it to that team's board with the person's own sign-in.
   ipc.handle('overview:share-view',async(e,...args)=>{const before=owner();if(!allowed(e,before)||!same(authority)||args.length!==1||!shareView)return{ok:false,error:'Focus Plexiform and try again.'};
    const r=args[0],team=service.teamIdentity(r?.team);if(!team)return{ok:false,error:'Open the team in Team sessions first.'};
    const result=await shareView({...team,name:r.name,values:r.values});return same(before)?result:{ok:false,error:'The view changed. Try again.'};});
   for(const action of ['open','message'])ipc.handle(`overview:${action}`,async(e,...args)=>{const before=owner();if(!allowed(e,before)||!same(authority)||args.length!==1)return response('unavailable');
    const result=await service[action](args[0]);return action==='open'?result:same(before)?result:response('stale');});
  },
  // A push carries no data: the page re-reads through its own fenced channel.
  directoryChanged(){if(stopped||!authority||!same(authority,true))return;try{authority.contents.send('overview:directory-changed');}catch{}},
  invalidate(){authority=null;sidebarRead=null;service.invalidate();},close(){stopped=true;authority=null;sidebarRead=null;if(pump)clearInterval(pump);service.invalidate();},
 };
}
module.exports={createOverviewMain};
