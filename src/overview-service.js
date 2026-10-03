'use strict';
// Main-owned structured metadata projection. No transcripts, provider chats,
// tokens, source session IDs, filesystem paths or authority objects cross IPC.
const crypto=require('node:crypto');
const Session=require('./session-overview');
const Machine=require('../hooks/session-machine');
const AgentReports=require('./agent-self-report');
const {clean}=require('./work-capture');
const Directory=require('./session-directory');
const PROVIDERS=Object.freeze({codex:'Codex',claude:'Claude Code','claude-code':'Claude Code',cursor:'Cursor',gemini:'Gemini',hermes:'Hermes',opencode:'OpenCode',copilot:'Copilot',ollama:'Ollama',lmstudio:'LM Studio','llama.cpp':'llama.cpp',local:'Local model'});
const LOCAL=new Set(['ollama','lmstudio','llama.cpp','local']);
const ID=/^[A-Za-z0-9_.:-]{1,128}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id=v=>typeof v==='string'&&ID.test(v),object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const response=(status)=>({ok:['opened','queued'].includes(status),status,error:status==='invalid'?'Check the selected item and message.':status==='stale'?'This work changed. Refresh and select it again.':status==='unavailable'?'This action is unavailable for this work.':''});
const closed=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const age=(v,now)=>{const t=typeof v==='string'?Date.parse(v):NaN;return Number.isFinite(t)&&t>=0&&t<=now?now-t:null;};
const freshness=n=>n===null?'unknown':n<=Session.RECENT_MS?'recent':'stale';
// Why a session Plexiform did not start cannot be messaged: the exact
// per-platform reason recorded in the capability matrix (board/PROVIDERS.md).
const MATRIX=require('./provider-capabilities.json');
const unmanaged=source=>{if(typeof source!=='string')return '';const s=source.toLowerCase();return MATRIX.platforms.find(p=>p.id===s||p.aliases.some(a=>a.toLowerCase()===s))?.reasons.existing??'';};
const capability=(enabled,label,reason)=>({enabled:enabled===true,label,reason:enabled?'':reason});
const task=card=>card&&typeof card.title==='string'?{status:'tracked',title:clean(card.title,200)||'Untitled task',key:typeof card.key==='string'?clean(card.key,80):null}:{status:'unknown',title:'Task not reported',key:null};
const provider=(source,model)=>{const known=typeof source==='string'&&Object.hasOwn(PROVIDERS,source);return{id:known?source:'unknown',label:(known?PROVIDERS[source]:'Local AI')+(typeof model==='string'&&/^[A-Za-z0-9._:/@+-]{1,80}$/.test(model)?` · ${clean(model,80)}`:''),kind:LOCAL.has(source)?'local':'integrated'};};
// Directory inputs (all main-side): owned() → [{state, leaf}] Plexiform-owned
// sessions of the current Overview document; shares() → {origin, list} this
// Mac's live session shares; hubTeams() → {origin, teams} the signed-in
// user's teams on the sharing hub; teamHub() → the team directory adapter
// (src/session-directory.js interface) or null.
function createOverviewService({sessions=()=>[],work=async()=>({sources:[],capture:[]}),managed=()=>({conn:{status:'offline'},tasks:[]}),openManaged=null,messageManaged=null,now=Date.now,current=()=>true,actionCurrent=current,navigationCurrent=()=>false,owned=()=>[],shares=()=>null,hubTeams=async()=>null,teamHub=()=>null}){
 let epoch=0,handles=new Map(),teamRefs=new Map();const secret=crypto.randomBytes(32);
 const directoryModel=Directory.createSessionDirectory({now});
 const stable=parts=>crypto.createHmac('sha256',secret).update(JSON.stringify(parts)).digest('hex');
 const teamKey=(origin,teamId)=>stable(['team',origin,teamId]).slice(0,32);
 const permitted=()=>{try{return current()===true;}catch{return false;}};
 const actionPermitted=()=>{try{return permitted()&&actionCurrent()===true;}catch{return false;}};
 const sourcesData=async()=>{const registered=await work();const list=Array.isArray(registered?.sources)?registered.sources.slice(0,9):[];
  const sources=await Promise.all(list.map(async source=>{let data;try{if(source.current())data=await source.read();}catch{}return{source,data};}));
  return{sources,capture:Array.isArray(registered?.capture)?registered.capture.slice(0,2000):[],partial:registered?.partial===true||registered?.sources?.length>9};};
 const validData=(source,data)=>source.current()&&data?.ok===true&&['complete','partial'].includes(data.status)&&object(data.principal)&&(!source.userId||data.principal.user_id===source.userId)&&Array.isArray(data.cards)&&data.cards.length<=500&&Array.isArray(data.agents)&&data.agents.length<=500;
 const actorOf=(data,row)=>[data.principal.user_id??null,data.principal.member_id??null,row.member_id,row.board_id,row.team_id??null];
 const cardIdentity=(source,data,row)=>stable(['card',source.key,actorOf(data,row),row.card.id]);
 const keyOf=row=>[row?.card?.id,row?.board_id,row?.member_id,row?.card?.run?.id??null,row?.card?.fence??null,row?.card?.version??null,row?.card?.title??null];
 const liveOwn=(data,row)=>data.agents.some(a=>a.card_id===row.card.id&&a.board_id===row.board_id&&a.member_id===row.member_id&&a.connection==='accepted'&&a.live?.green===true&&Number.isFinite(a.live.hb_age_ms)&&a.live.hb_age_ms>=0&&a.live.hb_age_ms<=Session.RECENT_MS);
 const managedStatus=(data,row)=>{
  const state=row.card.run_state,own=data.agents.find(a=>a.card_id===row.card.id&&a.board_id===row.board_id&&a.member_id===row.member_id);
  if(['running','quiet','blocked'].includes(state)&&own?.connection!=='accepted')return 'Connection unavailable';
  if(state==='running')return liveOwn(data,row)?'Working':'No recent activity';
  if(state==='blocked')return Array.isArray(data.decisions)&&data.decisions.some(d=>d.card_id===row.card.id&&d.board_id===row.board_id&&d.member_id===row.member_id&&['permission','question'].includes(d.kind))?'Waiting on you':'Blocked';
  const labels={quiet:'Quiet',claimed:'Starting',queued:'Queued',parked:'Parked',suspended:'Suspended',reconnecting:'Reconnecting',unresponsive:'No recent signal',orphaned:'Orphaned',handing_over:'Handing over',handed_over:'Handed over',in_review:'In review',done:'Done',failed:'Stopped'};
  return typeof state==='string'&&Object.hasOwn(labels,state)?labels[state]:'Unknown';
 };
 function register(row,entry,next){const handle=crypto.randomUUID();next.set(handle,{...entry,canOpen:row.capabilities.open.enabled===true,canMessage:row.capabilities.message.enabled===true,expires:now()+45000});row.handle=handle;return row;}
 async function snapshot(){
  const generation=++epoch;handles.clear();const time=now();if(!permitted())return{schema:1,status:'unavailable',observed_at:time,omitted:0,sessions:[]};
  const built=await build(time,()=>generation===epoch&&permitted());
  if(!built||generation!==epoch||!permitted())return{schema:1,status:'unavailable',observed_at:now(),omitted:0,sessions:[]};
  const {rows,next,partial,omitted}=built;
  // A passive projection is useful while another app has focus. The private
  // handle never supplies focus authority: actionPermitted fences each effect.
  if(!actionPermitted())for(const row of rows)for(const action of ['open','message'])if(row.capabilities[action].enabled)row.capabilities[action]=capability(false,row.capabilities[action].label,'Focus Plexiform and refresh before acting.');
  handles=next;
  return{schema:1,status:partial||omitted?'partial':'complete',observed_at:time,omitted,sessions:rows};
 }
 // Rows + main-only meta (kind, team) without touching action handles.
 async function build(time,alive){
  let all;try{all=await sourcesData();}catch{all={sources:[],capture:[],partial:true};}
  if(!alive())return null;
  const next=new Map(),rows=[],usedCards=new Set(),meta=new Map();let partial=all.partial,omitted=0;
  const teamMeta=(source,row)=>source.kind==='team'&&id(row.team_id)?{teamKey:teamKey(source.key,row.team_id),teamName:clean(row.team_name,80)||'Team'}:{};
  const good=all.sources.filter(({source,data})=>{try{const ok=validData(source,data);if(!ok||data.status!=='complete')partial=true;return ok;}catch{partial=true;return false;}});
  const binding=(raw)=>{if(raw.remote||raw.device)return null;const capture=all.capture.find(c=>c.provider===raw.source&&c.session_id===raw.sessionId&&c.task_id===(raw.taskId??'session')&&!c.untracked&&id(c.card_id));if(!capture)return null;
   for(const {source,data}of good){if(!source.matches?.(capture.destination))continue;const row=data.cards.find(r=>r.card?.id===capture.card_id&&(!capture.destination.board_id||r.board_id===capture.destination.board_id)&&(!capture.destination.team_id||r.team_id===capture.destination.team_id));if(row&&id(row.card.id)&&id(row.board_id)&&id(row.member_id)&&!row.card.archived)return{source,data,row};}return null;};
  const buildLocal=(raw,parentId=null)=>{
   if(!object(raw)||!id(raw.sessionId))return null;
   // Claude Code's own hook (set-status.js) writes no source field.
   if(raw.source==null)raw={...raw,source:'claude'};const elapsed=age(raw.source==='codex'&&raw.codexLifecycle===1?raw.codexHookAt:raw.updatedAt,time),fresh=freshness(elapsed),bound=binding(raw),card=bound?.row.card;
   const identity=stable(['reported',raw.device??'local',raw.source??'unknown',raw.sessionId??null,raw.taskId??'session',card?.id??null,bound?actorOf(bound.data,bound.row):null,bound?.source.key??null,parentId]);
   const projected=Session.snapshot({sessions:[{...raw,remote:false,device:null}],now:time}).sessions[0];
   let status=projected?.status??'Unknown';if(raw.source==='codex'&&Machine.codexInputPending?.(raw,time))status='Waiting on you';
   const dto={id:identity,handle:null,label:parentId?'Agent':'Session',provider:provider(raw.source,raw.model),device:{label:raw.remote||raw.device?clean(raw.deviceName||'Paired device',80):'This device',local:!raw.remote&&!raw.device},board:{label:bound?clean(bound.row.board_name,80)||'Board':raw.scope?.state==='personal'?'Personal':'Unassigned',kind:bound?bound.source.kind:raw.scope?.state==='personal'?'personal':'unknown'},project:Session.snapshot({sessions:[{cwd:raw.cwd}],now:time}).sessions[0]?.project??'Local project',status,freshness:fresh,age_ms:elapsed,task:task(card??(typeof raw.taskTitle==='string'?{title:raw.taskTitle}:null)),children:[],capabilities:{open:capability(!!bound,'Open card',bound?'':'No current tracked card is available.'),message:capability(!!bound&&liveOwn(bound.data,bound.row)&&fresh==='recent'&&!!card.repo?.id&&typeof bound.source.send==='function','Message',(!bound&&unmanaged(raw.source))||'A current owned runner with messaging is required.')}};
   if(bound){usedCards.add(cardIdentity(bound.source,bound.data,bound.row));register(dto,{kind:'board',bound,pin:keyOf(bound.row)},next);meta.set(identity,{kind:'board',...teamMeta(bound.source,bound.row)});}else{register(dto,{kind:'reported'},next);meta.set(identity,{kind:'reported'});}
   const children=Array.isArray(raw.source==='codex'?raw.codexAgents:raw.agents)?(raw.source==='codex'?raw.codexAgents:raw.agents):[];
   for(const child of children.slice(0,64)){
    if(!object(child)||typeof child.status!=='string'||!['working','waiting','done'].includes(child.status))continue;
    const reportedAges=[age(child.updatedAt??child.since,time),...(raw.source==='codex'?Machine.codexInputEntries({source:'codex',codexLifecycle:1,codexTurnId:child.turnId,codexInputRequests:child.codexInputRequests}).map(r=>age(r.askedAt,time)):[])].filter(n=>n!==null);
    const childAge=reportedAges.length?Math.min(...reportedAges):null,childFresh=freshness(childAge),childDto={id:stable([identity,'child',child.id??dto.children.length]),handle:null,label:clean(child.name??'Agent',80)||'Agent',status:child.status==='done'?'Stopped':child.status==='waiting'?'Waiting on you':'Working',freshness:childFresh,age_ms:childAge,task:task(typeof child.taskTitle==='string'?{title:child.taskTitle}:null),capabilities:{open:capability(false,'Open','This reported agent has no supported open target.'),message:capability(false,'Message','This reported agent has no supported message interface.')}};
    // A parent Stop does not end independently reported child work.
    if(raw.source==='codex'&&['working','waiting'].includes(child.status)&&Machine.codexInputPending({source:'codex',codexLifecycle:1,codexClosedTurn:false,codexTurnId:child.turnId,codexInputRequests:child.codexInputRequests},time))childDto.status='Waiting on you';
    if(!dto.children.some(c=>c.id===childDto.id))dto.children.push(childDto);
   }
   for(const child of AgentReports.project(raw,time)){
    if(dto.children.length>=64)break;
    dto.children.push({id:stable([identity,'self-report',child.id]),handle:null,label:child.name,status:child.status==='done'?'Done':child.status==='waiting'?'Waiting':'Working',freshness:child.freshness,age_ms:child.ageMs,task:task({title:child.taskTitle}),reporting:{source:'self-reported',observed_at:child.observedAt},capabilities:{open:capability(false,'Open','This self-reported agent has no supported open target.'),message:capability(false,'Message','This self-reported agent has no supported message interface.')}});
   }
   return dto;
  };
  const input=sessions(),reported=Array.isArray(input)?input:[];
  for(const raw of reported.slice(0,500)){if(rows.length>=200){omitted++;continue;}const row=buildLocal(raw);if(row&&!rows.some(r=>r.id===row.id))rows.push(row);}
  if(reported.length>500)omitted+=reported.length-500;
  for(const {source,data}of good){for(const row of data.cards){const card=row?.card;if(!object(card)||!id(card.id)||!id(row.board_id)||!id(row.member_id)||card.archived||!card.run||!id(card.run.id)||!data.agents.some(a=>a.card_id===card.id&&a.board_id===row.board_id&&a.member_id===row.member_id))continue;
   const identity=cardIdentity(source,data,row);if(usedCards.has(identity)||rows.some(r=>r.id===identity))continue;if(rows.length>=200){omitted++;continue;}
   const live=liveOwn(data,row),elapsed=Number.isFinite(card.live?.hb_age_ms)&&card.live.hb_age_ms>=0?card.live.hb_age_ms:null;
   const dto={id:identity,handle:null,label:'Managed session',provider:provider(card.run.ai,card.run.model),device:{label:clean(card.run.device_name,80)||'Runner device',local:source.kind==='personal'},board:{label:clean(row.board_name,80)||'Board',kind:source.kind},project:clean(card.repo?.short_name,100)||'Project not reported',status:managedStatus(data,row),freshness:freshness(elapsed),age_ms:elapsed,task:task(card),children:[],capabilities:{open:capability(true,'Open card',''),message:capability(live&&!!card.repo?.id&&typeof source.send==='function','Message','A current owned runner with messaging is required.')}};
   register(dto,{kind:'board',bound:{source,data,row},pin:keyOf(row)},next);rows.push(dto);meta.set(identity,{kind:'board',...teamMeta(source,row)});
  }}
  const local=managed();if(local?.conn?.status==='connected'&&Array.isArray(local.tasks))for(const t of local.tasks.slice(0,200)){
   if(!object(t)||!id(t.id)||t.hub)continue;if(rows.length>=200){omitted++;continue;}
   const connected=t.stale!==true,live=connected&&t.green===true;
   const dto={id:stable(['task',t.id]),handle:null,label:'Managed task',provider:provider(t.ai?.id,t.ai?.model),device:{label:'This device',local:true},board:{label:'Personal tasks',kind:'personal'},project:clean(t.repo?.name,100)||'Local project',status:clean(t.label,40)||'Unknown',freshness:live?'recent':connected?'unknown':'stale',age_ms:live?0:null,task:task(t),children:[],capabilities:{open:capability(typeof openManaged==='function','Open Tasks','The Tasks page is unavailable.'),message:capability(live&&Array.isArray(t.actions)&&t.actions.includes('message')&&typeof messageManaged==='function','Message','This task cannot receive messages in its current state.')}};
   if(rows.some(r=>r.id===dto.id))continue;
   register(dto,{kind:'managed',id:t.id,state:t.state,provider:t.ai?.id},next);rows.push(dto);meta.set(dto.id,{kind:'task'});
  }
  if(!alive())return null;
  rows.sort((a,b)=>(a.age_ms??Infinity)-(b.age_ms??Infinity));
  return{rows,next,partial,omitted,meta};
 }
 async function action(request,message=false){
  if(!closed(request,message?['handle','text']:['handle'])||typeof request.handle!=='string'||!UUID.test(request.handle)||message&&(typeof request.text!=='string'||!request.text.trim()||request.text.includes('\0')||request.text.trim().length>4000||Buffer.byteLength(request.text.trim())>8192))return response('invalid');
  const e=handles.get(request.handle),generation=epoch;if(!e||e.expires<now()||!actionPermitted())return response('stale');
  let navigating=false;const fresh=()=>generation===epoch&&e.expires>=now()&&(navigating?navigationCurrent()===true:actionPermitted());
  const beginNavigation=()=>{if(!fresh())return false;navigating=true;return true;};
  if(e.kind==='reported'||(message?!e.canMessage:!e.canOpen))return response('unavailable');
  // Explicit message is one-use before any external wait or effect.
  if(message)handles.delete(request.handle);
  try{
   if(e.kind==='managed'){
    const snap=managed(),row=snap?.tasks?.find(t=>t.id===e.id);if(snap?.conn?.status!=='connected'||!row||row.stale===true||row.state!==e.state||row.ai?.id!==e.provider||!fresh())return response('stale');
    if(message){if(row.green!==true||!row.actions?.includes('message')||!messageManaged)return response('unavailable');const out=await messageManaged(e.id,request.text.trim(),fresh);return fresh()&&out?.ok===true?response('queued'):response('unavailable');}
    return openManaged&&await openManaged(e.id,fresh)?response('opened'):response('unavailable');
   }
   const {source}=e.bound;if(!source.current())return response('stale');const data=await source.read();if(!fresh()||!validData(source,data))return response('stale');
   const row=data.cards.find(r=>JSON.stringify(keyOf(r))===JSON.stringify(e.pin)&&!r.card?.archived);if(!row)return response('stale');
   if(message){if(!liveOwn(data,row)||!row.card.repo?.id||typeof source.send!=='function')return response('unavailable');const out=await source.send(row,request.text.trim(),crypto.randomUUID(),fresh);return fresh()&&source.current()&&out?.ok===true?response('queued'):response('unavailable');}
   return typeof source.open==='function'&&await source.open(row,()=>fresh()&&source.current(),beginNavigation)?response('opened'):response('unavailable');
  }catch{return response('unavailable');}
 }
 const safe=(fn,fallback)=>{try{return fn()??fallback;}catch{return fallback;}};
 const viewerOf=hub=>{const v=safe(()=>hub?.viewer?.(),null);return object(v)&&typeof v.id==='string'&&v.id?{id:v.id,name:clean(v.name,80)||'You'}:null;};
 const unavailableDirectory=(view,time)=>({schema:1,view,status:'unavailable',observed_at:time,teams:[],team:null,notice:'',entries:[],counts:directoryModel.counts([])});
 // My sessions / Team sessions. Team privacy is filtered here, never in the page.
 async function directory(request){
  const time=now(),view=request?.view;
  if(!(closed(request,['view'])&&view==='mine'||closed(request,['view','team'])&&view==='team'&&(request.team===null||typeof request.team==='string'&&/^[0-9a-f]{32}$/.test(request.team))))return unavailableDirectory('mine',time);
  if(!permitted())return unavailableDirectory(view,time);
  const built=await build(time,permitted);
  if(!built||!permitted())return unavailableDirectory(view,time);
  const sh=safe(shares,null),origin=typeof sh?.origin==='string'?sh.origin:null;
  const shareList=(origin&&Array.isArray(sh.list)?sh.list:[]).filter(x=>object(x)&&typeof x.session==='string'&&object(x.team)&&typeof x.team.id==='string').map(x=>({session:x.session,scope:x.scope,teamKey:teamKey(origin,x.team.id),teamName:clean(x.team.name,80)||'Team'}));
  const ownedList=(()=>{const v=safe(owned,[]);return Array.isArray(v)?v.slice(0,50):[];})();
  const personal=directoryModel.mine({work:built.rows,meta:built.meta,owned:ownedList,shares:shareList});
  const teams=new Map(),add=(key,name,source)=>{if(!teams.has(key))teams.set(key,{key,name:clean(name,80)||'Team',source});};
  let real=null;try{real=await hubTeams();}catch{real=null;}
  if(typeof real?.origin==='string'&&Array.isArray(real.teams))for(const t of real.teams.slice(0,64))if(object(t)&&typeof t.id==='string')add(teamKey(real.origin,t.id),t.name,'hub');
  for(const e of personal)for(const b of e.teams)add(b.key,b.name,'hub');
  const hub=safe(teamHub,null),viewer=viewerOf(hub);let fakeTeams=[];
  const adapterOrigin=hub?.fake!==true&&typeof hub?.origin==='string'?hub.origin:'adapter:';
  if(hub&&viewer){try{fakeTeams=(await hub.teams(viewer)).filter(t=>object(t)&&typeof t.id==='string').slice(0,64);}catch{fakeTeams=[];}
   for(const t of fakeTeams)add(teamKey(adapterOrigin,t.id),t.name,hub.fake===true?'fake':'adapter');}
  if(!permitted())return unavailableDirectory(view,time);
  const teamList=[...teams.values()].map(t=>({...t,label:t.source==='fake'?clean(hub?.label,80)||'Fake team hub':''}));
  const status=built.partial||built.omitted?'partial':'complete';
  if(view==='mine')return{schema:1,view,status,observed_at:time,teams:teamList,team:null,notice:'',entries:personal,counts:directoryModel.counts(personal)};
  const selected=teams.get(request.team)??teams.values().next().value??null;
  if(!selected)return{schema:1,view,status,observed_at:time,teams:teamList,team:null,notice:'You are not in a team yet, or no team is connected.',entries:[],counts:directoryModel.counts([])};
  const adapterTeam=fakeTeams.find(t=>teamKey(adapterOrigin,t.id)===selected.key)??null;
  let hubEntries=[];
  if(adapterTeam){try{hubEntries=await hub.sessions(viewer,adapterTeam.id);}catch{hubEntries=[];}}
  if(!permitted())return unavailableDirectory(view,time);
  const model=directoryModel.team({team:{key:selected.key,name:selected.name,id:adapterTeam?.id??null},viewer:viewer??{id:''},member:!!adapterTeam,personal,hubEntries});
  for(const [entryId,ref] of model.refs)teamRefs.set(entryId,{...ref,team:adapterTeam.id,teamKey:selected.key,hub,expires:time+45000});
  while(teamRefs.size>500)teamRefs.delete(teamRefs.keys().next().value);
  const notice=adapterTeam?(hub.fake===true?`${clean(hub.label,80)||'Fake team hub'}: these teammates and sessions are test data, not a real team.`:''):'Your own sessions in this team are shown. Teammates\' shared sessions appear once your team hub\'s shared-session directory is connected.';
  return{schema:1,view,status,observed_at:time,teams:teamList,team:{key:selected.key,name:selected.name,source:selected.source},notice,entries:model.entries,counts:directoryModel.counts(model.entries)};
 }
 // Message a teammate's session shared with the selected team to send.
 async function teamMessage(request){
  if(!closed(request,['id','text'])||typeof request.id!=='string'||!/^[0-9a-f]{40}$/.test(request.id)||typeof request.text!=='string'||request.text.includes('\0')||!request.text.trim()||request.text.trim().length>4000||Buffer.byteLength(request.text.trim())>8192)return response('invalid');
  const e=teamRefs.get(request.id);if(!e||e.expires<now()||!actionPermitted())return response('stale');
  if(e.scope!=='interact')return{...response('unavailable'),error:'Shared with you to watch only.'};
  const hub=safe(teamHub,null),viewer=viewerOf(hub);if(!hub||hub!==e.hub||!viewer)return response('stale');
  // Re-check the share right before sending: revoked, expired or removed members refuse.
  let fresh;try{fresh=await hub.sessions(viewer,e.team);}catch{fresh=[];}
  if(!actionPermitted())return response('stale');
  const again=directoryModel.team({team:{key:e.teamKey,name:'',id:e.team},viewer,member:true,personal:[],hubEntries:fresh});
  const now2=again.refs.get(request.id);if(!now2||now2.ref!==e.ref||now2.scope!=='interact')return{ok:false,status:'stale',error:'This session is no longer shared with you to send.'};
  const target=again.entries.find(x=>x.id===request.id);if(target?.capabilities.receive.available!==true)return{ok:false,status:'unavailable',error:target?.capabilities.receive.reason||'Unavailable.'};
  let out;try{out=await hub.send(viewer,e.team,e.ref,request.text.trim(),crypto.randomUUID());}catch{out=null;}
  if(!actionPermitted())return response('stale');
  return out?.ok===true?response('queued'):{ok:false,status:['forbidden','stale','unavailable'].includes(out?.status)?out.status:'unavailable',error:clean(out?.error,300)||'The team hub did not accept the message.'};
 }
 return{snapshot,directory,teamMessage,open:r=>action(r),message:r=>action(r,true),invalidate(){epoch++;handles.clear();teamRefs.clear();}};
}
module.exports={createOverviewService,PROVIDERS,provider,response};
