'use strict';
const LooseEnds=require('./burst-loose-ends-view');
// Main-owned structured metadata projection. No transcripts, provider chats,
// tokens, source session IDs, filesystem paths or authority objects cross IPC.
const crypto=require('node:crypto');
const Session=require('./session-overview');
const Organise=require('./work-organise');
const Machine=require('../hooks/session-machine');
const AgentReports=require('./agent-self-report');
const {clean}=require('./work-capture');
const Directory=require('./session-directory');
const Ids=require('./focus/ids');
const Surface=require('./session-surface');
const {sessionRow}=require('./session-row');
const {createTeamSessionControls}=require('./team-session-controls');
const {createTeamCoordinator}=require('./team-coordinator');
const SharedThread=require('./shared-thread-view');
const {personHandoffs}=require('./handoff-people');
const FollowupSchedules=require('./recipe-schedules');
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
function createOverviewService({presence=()=>null,presenceView=()=>0,presenceOwner=null,sessions=()=>[],work=async()=>({sources:[],capture:[]}),managed=()=>({conn:{status:'offline'},tasks:[]}),openManaged=null,messageManaged=null,now=Date.now,current=()=>true,actionCurrent=current,navigationCurrent=()=>false,owned=()=>[],shares=()=>null,hubTeams=async()=>null,teamHub=()=>null,followups=null,followupScope=()=>null,followupLocal=null,looseEnds=()=>null,accountName=()=>null}){
 // Burst's loose ends (src/burst-loose-ends-view.js) matched to a session's working directory here in main: the page gets counts, never a path.
 const looseBadge=cwd=>{let v=null;try{v=looseEnds();}catch{v=null;}const m=v?LooseEnds.forPath(v,cwd):null;return m?{uncommitted:m.uncommitted,unpushed:m.unpushed,stashes:m.stashes,stale:m.stale===true,text:LooseEnds.badgeText(m)}:null;};
 let epoch=0,directoryEpoch=0,routeEpoch=0,teamView=null,handles=new Map(),teamRefs=new Map();const secret=crypto.randomBytes(32);
 // Chat-first preview (redesign R2a): row id → what a thread may show, main-only,
 // from the latest build. Temporary: replaced by SessionRowVM.ref in R2b.
 // Redesign R2b-1: each row's SessionRef (PR 0s), main-only, beside the cwd the
 // activity loader needs (a ref is path-free by contract). Replaces R2a's
 // temporary targets map. Never sent to a renderer; projections drop it.
 let lastRefs=new Map();
 // A SessionRef for this computer's own terminal session, or null (an id the
 // contract refuses gets no ref, so no thread).
 const localRef=(raw,label)=>{try{const tab=label==='Plexiform Terminal';return Surface.sessionRef({provider:raw.source,sessionId:raw.sessionId,taskId:null,origin:tab?'plexiform-tab':'external',driver:tab?'terminal':'external',hostApp:Surface.HOST_APPS.includes(label)?label:null});}catch{return null;}};
 // A managed task's ref. The tasks snapshot carries no session id, so the
 // chat's session is named by its task id (the engine's own fallback, engine.js:497).
 const taskRef=(t)=>{try{return Surface.sessionRef({provider:t.ai?.id||'unknown',sessionId:t.id,taskId:t.id,origin:'chat',driver:Surface.driverOfTaskState(t.state)});}catch{return null;}};
 const directoryModel=Directory.createSessionDirectory({now});
 const stable=parts=>crypto.createHmac('sha256',secret).update(JSON.stringify(parts)).digest('hex');
 const teamKey=(origin,teamId)=>stable(['team',origin,teamId]).slice(0,32);
 // Opaque team key → the hub team it stands for, for the team the page is showing only (share view).
 const teamIds=new Map();
 const teamIdentity=key=>typeof key==='string'&&teamView===key&&teamIds.has(key)?{...teamIds.get(key)}:null;
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
  const labels={quiet:'Quiet',claimed:'Starting',queued:'Queued',parked:'Parked',suspended:'Suspended',reconnecting:'Reconnecting',unresponsive:'No recent signal',orphaned:'Orphaned',handing_over:'Moving to another AI',handed_over:'Moved to another AI',in_review:'In review',done:'Done',failed:'Stopped'};
  return typeof state==='string'&&Object.hasOwn(labels,state)?labels[state]:'Unknown';
 };
 // Board and managed rows name their bucket so no view has to guess it from these labels.
 const RUN_BUCKET={running:'working',quiet:'working',claimed:'working',queued:'working',reconnecting:'working',handing_over:'working',blocked:'needs',in_review:'check',orphaned:'stuck',failed:'stuck',stalled:'stuck',parked:'idle',suspended:'idle',unresponsive:'idle',handed_over:'idle',done:'idle'};
 const PLAIN_LABELS=new Set(['Working','Running','Waiting on you','Needs you','Unknown']);
 const placed=(status,bucket)=>({status,bucket,...(PLAIN_LABELS.has(status)||status===Organise.headingOf(bucket)?{}:{detail:status})});
 // A managed task waiting on the person needs them whatever its run state: an open ask or a
 // confirm to approve (its actions say so), or parked until they log in or their limit resets.
 // A run that stopped at a usage limit or its budget waits on the person too (work-organise's rule).
 const PERSON_FAIL=['limit','budget'];
 const managedBucket=t=>{
  const actions=Array.isArray(t.actions)?t.actions:[];
  if(t.state==='failed'&&PERSON_FAIL.includes(t.failKind))return 'needs';
  if(actions.includes('answer')||actions.includes('approve')||(t.state==='queued'&&t.awaitingConfirm===true)||(t.state==='parked'&&['limit','auth'].includes(t.parkReason)))return 'needs';
  return typeof t.state==='string'&&Object.hasOwn(RUN_BUCKET,t.state)?RUN_BUCKET[t.state]:'idle';
 };
 const boardPlaced=(data,row)=>{
  const status=managedStatus(data,row);
  // Blocked with no decision for this person is stuck on something else, not waiting on them.
  const bucket=status==='Waiting on you'||(row.card.run_state==='failed'&&PERSON_FAIL.includes(row.card.fail_kind))?'needs':status==='Blocked'?'stuck':['Connection unavailable','No recent activity','Unknown'].includes(status)?'idle':RUN_BUCKET[row.card.run_state]??'idle';
  return placed(status,bucket);
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
  const next=new Map(),rows=[],usedCards=new Set(),meta=new Map(),origins=new Map(),refs=new Map();let partial=all.partial,omitted=0;
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
   let status=projected?.status??Organise.headingOf(null),bucket=projected?.bucket??'idle',detail=projected?.detail??null;if(raw.source==='codex'&&Machine.codexInputPending?.(raw,time)){bucket='needs';status=Organise.headingOf(bucket);detail=null;}
   const dto={id:identity,handle:null,label:parentId?'Agent':'Session',provider:provider(raw.source,raw.model),device:{label:raw.remote||raw.device?clean(raw.deviceName||'Paired device',80):'This device',local:!raw.remote&&!raw.device},board:{label:bound?clean(bound.row.board_name,80)||'Board':raw.scope?.state==='personal'?'Personal':'Unassigned',kind:bound?bound.source.kind:raw.scope?.state==='personal'?'personal':'unknown'},project:Session.snapshot({sessions:[{cwd:raw.cwd}],now:time}).sessions[0]?.project??Organise.FALLBACK,looseEnds:parentId?null:looseBadge(raw.cwd),status,bucket,...(detail?{detail}:{}),freshness:fresh,age_ms:elapsed,task:task(card??(typeof raw.taskTitle==='string'?{title:raw.taskTitle}:null)),children:[],handoffs:personHandoffs(card,bound?.data.principal?.member_id??null),capabilities:{open:capability(!!bound,'Open card',bound?'':'No current tracked card is available.'),message:capability(!!bound&&liveOwn(bound.data,bound.row)&&fresh==='recent'&&!!card.repo?.id&&typeof bound.source.send==='function','Message',(!bound&&unmanaged(raw.source))||'A current owned runner with messaging is required.')}};
   // The terminal it runs in, for the chat-first sidebar only: main-side, a closed label set (focus/ids originOf).
   // Only this computer's own sessions: a paired device's session is not "in a terminal" here.
   if(!raw.remote&&!raw.device)origins.set(identity,Ids.originOf(raw));
   if(!raw.remote&&!raw.device&&!parentId){const ref=localRef(raw,origins.get(identity));if(ref)refs.set(identity,{ref,cwd:typeof raw.cwd==='string'?raw.cwd:''});}
   if(bound){usedCards.add(cardIdentity(bound.source,bound.data,bound.row));register(dto,{kind:'board',bound,pin:keyOf(bound.row)},next);meta.set(identity,{kind:'board',boardRunId:card.run?.id,...teamMeta(bound.source,bound.row)});}else{register(dto,{kind:'reported'},next);meta.set(identity,{kind:'reported',nativeSessionId:raw.sessionId,nativeTurnId:raw.codexTurnId??null});}
   const children=Array.isArray(raw.source==='codex'?raw.codexAgents:raw.agents)?(raw.source==='codex'?raw.codexAgents:raw.agents):[];
   for(const child of children.slice(0,64)){
    if(!object(child)||typeof child.status!=='string'||!['working','waiting','done'].includes(child.status))continue;
    const reportedAges=[age(child.updatedAt??child.since,time),...(raw.source==='codex'?Machine.codexInputEntries({source:'codex',codexLifecycle:1,codexTurnId:child.turnId,codexInputRequests:child.codexInputRequests}).map(r=>age(r.askedAt,time)):[])].filter(n=>n!==null);
    const childAge=reportedAges.length?Math.min(...reportedAges):null,childFresh=freshness(childAge),childDto={id:stable([identity,'child',child.id??dto.children.length]),handle:null,label:clean(child.name??'Agent',80)||'Agent',status:Organise.headingOf(child.status==='done'?'idle':child.status==='waiting'?'needs':'working'),freshness:childFresh,age_ms:childAge,task:task(typeof child.taskTitle==='string'?{title:child.taskTitle}:null),capabilities:{open:capability(false,'Open','This reported agent has no supported open target.'),message:capability(false,'Message','This reported agent has no supported message interface.')}};
    // A parent Stop does not end independently reported child work.
    if(raw.source==='codex'&&['working','waiting'].includes(child.status)&&Machine.codexInputPending({source:'codex',codexLifecycle:1,codexClosedTurn:false,codexTurnId:child.turnId,codexInputRequests:child.codexInputRequests},time))childDto.status=Organise.headingOf('needs');
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
   const dto={id:identity,handle:null,label:'Managed session',provider:provider(card.run.ai,card.run.model),device:{label:clean(card.run.device_name,80)||'Runner device',local:source.kind==='personal'},board:{label:clean(row.board_name,80)||'Board',kind:source.kind},project:clean(card.repo?.short_name,100)||'Project not reported',...boardPlaced(data,row),freshness:freshness(elapsed),age_ms:elapsed,task:task(card),children:[],handoffs:personHandoffs(card,data.principal?.member_id??null),capabilities:{open:capability(true,'Open card',''),message:capability(live&&!!card.repo?.id&&typeof source.send==='function','Message','A current owned runner with messaging is required.')}};
   register(dto,{kind:'board',bound:{source,data,row},pin:keyOf(row)},next);rows.push(dto);meta.set(identity,{kind:'board',boardRunId:card.run.id,...teamMeta(source,row)});
  }}
  const local=managed();if(local?.conn?.status==='connected'&&Array.isArray(local.tasks))for(const t of local.tasks.slice(0,200)){
   if(!object(t)||!id(t.id)||t.hub)continue;if(rows.length>=200){omitted++;continue;}
   const connected=t.stale!==true,live=connected&&t.green===true;
   const dto={id:stable(['task',t.id]),handle:null,label:'Managed task',provider:provider(t.ai?.id,t.ai?.model),device:{label:'This device',local:true},board:{label:'Personal tasks',kind:'personal'},project:clean(t.repo?.name,100)||'Local project',...placed(clean(t.label,40)||'Unknown',managedBucket(t)),freshness:live?'recent':connected?'unknown':'stale',age_ms:live?0:null,task:task(t),children:[],capabilities:{open:capability(typeof openManaged==='function','Open Tasks','The Tasks page is unavailable.'),message:capability(live&&Array.isArray(t.actions)&&t.actions.includes('message')&&typeof messageManaged==='function','Message','This task cannot receive messages in its current state.')}};
   if(rows.some(r=>r.id===dto.id))continue;
   register(dto,{kind:'managed',id:t.id,state:t.state,provider:t.ai?.id},next);rows.push(dto);meta.set(dto.id,{kind:'task'});const ref=taskRef(t);if(ref)refs.set(dto.id,{ref,task:t});
  }
  if(!alive())return null;
  rows.sort((a,b)=>(a.age_ms??Infinity)-(b.age_ms??Infinity));
  // One SessionRowVM per row (PR 0s). A vm with a ref stays in main.
  const vms=new Map();for(const row of rows){const r=refs.get(row.id);const vm=sessionRow(row,{origin:origins.get(row.id)??null,task:r?.task??null,ref:r?.ref??null});if(vm){vms.set(row.id,vm);if(r)r.vm=vm;}}
  lastRefs=refs;
  return{rows,next,partial,omitted,meta,origins,refs,vms};
 }
 // A thread's target, resolved without a build: the latest build's ref names
 // the candidate, and it is re-checked against the in-memory tasks snapshot or
 // reported sessions on every call. A managed task's id is also recomputed
 // from the snapshot when no build has seen it yet (a link). Only this
 // computer's own work: a paired device's session has no ref, so no target.
 // The returned vm is main-side (it carries the ref); headerOf picks from it.
 function threadTarget(rowId){
  if(typeof rowId!=='string'||!/^[0-9a-f]{64}$/.test(rowId))return null;
  const known=lastRefs.get(rowId)??null;
  if(!known&&sharedRoutes.has(rowId))return sharedTargetOf(rowId);
  if(!known||known.ref.origin==='chat'){
   let snap=null;try{snap=managed();}catch{snap=null;}
   if(snap?.conn?.status==='connected'&&Array.isArray(snap.tasks)){
    const t=known?snap.tasks.find(x=>object(x)&&x.id===known.ref.taskId):snap.tasks.slice(0,200).find(x=>object(x)&&id(x.id)&&stable(['task',x.id])===rowId);
    if(t&&!t.hub&&stable(['task',t.id])===rowId&&taskRef(t))return{kind:'task',taskId:t.id,vm:known?.vm??null};
   }
   return null;
  }
  let input=[];try{input=sessions();}catch{input=[];}
  const {ref}=known;
  const raw=(Array.isArray(input)?input:[]).find(x=>object(x)&&!x.remote&&!x.device&&(x.source??'claude')===ref.provider&&x.sessionId===ref.sessionId);
  return raw?{kind:'session',source:ref.provider,sessionId:raw.sessionId,cwd:typeof raw.cwd==='string'?raw.cwd:'',origin:Ids.originOf(raw),vm:known.vm??null}:null;
 }
 // R2b-2 (S3): the thread row of a task this Mac just started, or null while the
 // tasks snapshot doesn't list it yet. Resolved through threadTarget, never guessed.
 function threadForTask(taskId){
  if(!id(taskId))return null;
  const rowId=stable(['task',taskId]);
  return threadTarget(rowId)?.taskId===taskId?rowId:null;
 }
 // Read-only rows for another document (the chat-first sidebar). The same
 // build, but it never touches this service's epochs, action handles, team
 // route or caches, so it cannot disturb the Overview page; its liveness is the
 // caller's, not the Overview page's. The rows carry no handles.
 async function passiveRows(alive){
  if(typeof alive!=='function'||!alive())return null;
  const time=now(),built=await build(time,alive);
  if(!built||!alive())return null;
  for(const row of built.rows)row.handle=null;
  return{status:built.partial||built.omitted?'partial':'complete',observed_at:time,omitted:built.omitted,rows:built.rows,origins:built.origins,vms:built.vms};
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
 const controls=createTeamSessionControls({resolve:resolveTeam,current:permitted,actionCurrent:actionPermitted,now});
 let coordinator=null;
 coordinator=createTeamCoordinator({inventory:request=>directory({view:'team',team:request.team}),inspect:controls.inspect,action:controls.action,resolve:resolveTeam,current:permitted,actionCurrent:actionPermitted,now});
 const personalRefs=new Map(),followupSelections=new Map();
 const followupUnavailable=()=>({ok:false,status:'unavailable',error:'Encrypted local follow-ups are unavailable for this account or session.'});
 const pinned=raw=>({...raw,key:crypto.createHash('sha256').update(JSON.stringify([raw.kind,raw.route,raw.generation,raw.provider])).digest('hex')});
 const exactTarget=t=>object(t)&&pinned(t).key===t.key;
 async function followupReview(request){
  if(!followups||!(closed(request,['id','text'])||closed(request,['id','text','when']))||typeof request.id!=='string'||!/^[0-9a-f]{40}$/.test(request.id)||typeof request.text!=='string'||!request.text.trim()||request.text.includes('\0')||request.text.trim().length>4000||Buffer.byteLength(request.text.trim())>8192||!actionPermitted())return followupUnavailable();
  if(Object.hasOwn(request,'when')&&!object(request.when))return response('invalid');
  const text=request.text.trim();
  const epoch=routeEpoch,owner=followupScope();
  const fresh=()=>actionPermitted()&&epoch===routeEpoch&&owner===followupScope();
  let target,label;
  const own=personalRefs.get(request.id);
  if(own?.interact?.kind==='owned'){
   const raw=followupLocal?.target?.(own.interact.ref);
   if(raw){target=pinned(raw);label=`Your ${own.provider.label} session: ${own.task.title}`;}
  }else{
   const r=await resolveTeam(request.id,false);
   if(!fresh()||!r?.hub||r.scope!=='interact'||typeof r.hub.inspect!=='function'||typeof r.hub.act!=='function'||typeof r.hub.origin!=='string')return followupUnavailable();
   let out;try{out=await r.hub.inspect(r.viewer,r.team,r.ref);}catch{return followupUnavailable();}
   const s=out?.state;
   if(!fresh()||r.isCurrent()!==true||!out?.ok||!s||s.status==='ended'||s.capabilities?.newTurn!==true||!Number.isSafeInteger(s.generation)||typeof s.provider?.id!=='string')return followupUnavailable();
   target=pinned({kind:'team',route:{origin:r.hub.origin,viewer:r.viewer.id,team:r.team,ref:r.ref},generation:s.generation,provider:s.provider.id});
   label=`Shared ${s.provider.label||s.provider.id} session in the selected team`;
  }
  if(!target||!fresh()||typeof owner!=='string')return followupUnavailable();
  const when=request.when??{kind:'ready'};
  let reset=null;
  if(when?.kind==='provider-reset'){
   const resolved=await resolveFollowup(target);
   if(!fresh()||!resolved?.ok||resolved.current?.()!==true)return followupUnavailable();
   reset=resolved.reset?.()??null;
  }
  const schedule=FollowupSchedules.followupSchedule(when,now(),reset);
  if(!schedule)return{ok:false,status:'unavailable',error:when?.kind==='provider-reset'?'This exact session has no future provider-reported reset time. Choose a time yourself or wait for a provider limit report.':'Choose a future time within seven days.'};
  const scheduleLabel=FollowupSchedules.describeFollowup(schedule);
  const selection=crypto.randomUUID();followupSelections.set(selection,{target,label:label.slice(0,240),epoch,owner,expires:now()+45000,schedule,text});
  for(const[k,v]of followupSelections)if(v.expires<now())followupSelections.delete(k);
  while(followupSelections.size>64)followupSelections.delete(followupSelections.keys().next().value);
  return{ok:true,status:'review',selection,label:label.slice(0,240),schedule:{kind:schedule.kind,atMs:schedule.atMs??null,label:scheduleLabel},notice:`${scheduleLabel}. One attempt only, in queue order. Keep Plexiform open and Overview focused on this account and board; a missed time waits for that view and the original session to be ready. A provider reset report predicts availability, not successful completion. May use AI credits. Saved encrypted for at most seven days; restart cannot restore an ended session. Requires OS encryption and durable filesystem sync.`};
 }
 async function followupEnqueue(request){
  if(!followups||!closed(request,['selection','requestId','text'])||!UUID.test(request.selection)||!UUID.test(request.requestId)||typeof request.text!=='string')return followupUnavailable();
  const chosen=followupSelections.get(request.selection);followupSelections.delete(request.selection);
  const fresh=()=>!!chosen&&actionPermitted()&&chosen.epoch===routeEpoch&&chosen.owner===followupScope()&&chosen.expires>=now();
  if(!fresh()||request.text!==chosen.text)return response('stale');
  const still=await resolveFollowup(chosen.target);
  if(!fresh()||!still?.ok||still.current()!==true)return{ok:false,status:'stale',error:still?.error||'The original session changed. Review it again.'};
  const scheduledCurrent=()=>fresh()&&still.current()===true&&(!chosen.schedule?.atMs||chosen.schedule.atMs>now())&&(chosen.schedule?.kind!=='provider-reset'||still.reset?.()?.id===chosen.schedule.evidence);
  if(!scheduledCurrent())return{ok:false,status:'stale',error:'The reviewed time or provider reset report changed. Review the follow-up again.'};
  return followups.enqueue({id:request.requestId,target:chosen.target,label:chosen.label,text:chosen.text,schedule:chosen.schedule,current:scheduledCurrent});
 }
 async function resolveFollowup(t){
  if(!exactTarget(t)||!actionPermitted())return{ok:false,error:'Focus this account and board in Overview to continue.'};
  const owner=followupScope(),epoch=routeEpoch;
  const fresh=()=>actionPermitted()&&owner===followupScope()&&epoch===routeEpoch;
  if(t.kind==='owned')return followupLocal?.resolve?.(t,fresh)??{ok:false,terminal:true,error:'The original session is no longer held by Plexiform.'};
  const hub=safe(teamHub,null),viewer=viewerOf(hub),r=t.route;
  if(!hub||hub.origin!==r.origin||viewer?.id!==r.viewer)return{ok:false,error:'Return to the original signed-in hub account.'};
  if(teamView!==teamKey(r.origin,r.team))return{ok:false,error:'Open the original team in Team sessions to continue.'};
  const current=()=>fresh()&&safe(teamHub,null)===hub&&viewerOf(hub)?.id===r.viewer;
  let out;try{out=await hub.inspect(viewer,r.team,r.ref);}catch{return{ok:false,error:'The shared session is temporarily unavailable.'};}
  if(!current())return{ok:false,error:'The view or account changed.'};
  if(!out?.ok)return{ok:false,terminal:['forbidden','stale'].includes(out?.status),error:clean(out?.error,400)||'The original share is unavailable.'};
  const s=out.state;
  if(!s||s.generation!==t.generation||s.provider?.id!==t.provider||s.status==='ended')return{ok:false,terminal:true,error:'The original shared session ended or changed. Nothing will be sent.'};
  // The client/host reauthorize interact scope for every act. inspect alone
  // does not confer sending rights; no cached share grant is resurrected.
  if(s.capabilities?.newTurn!==true||typeof hub.act!=='function')return{ok:false,terminal:true,error:'This connection does not support a new-turn follow-up.'};
  return{ok:true,ready:s.status==='ready'&&s.activeTurn===null,current,
   send:(text,id,keep)=>hub.act(viewer,r.team,r.ref,{operation:'send',generation:t.generation,turn:null,text},id,()=>current()&&keep())};
 }
 async function resolveTeam(entryId,effect=false){
  const e=teamRefs.get(entryId),generation=routeEpoch;
  const fresh=()=>permitted()&&(!effect||actionPermitted())&&generation===routeEpoch&&teamView===e?.teamKey;
  if(!e||e.expires<now()||!fresh())return response('stale');
  const hub=safe(teamHub,null),viewer=viewerOf(hub);
  if(!hub||hub!==e.hub||!viewer||viewer.id!==e.viewerId)return response('stale');
  // Board-run task inboxes keep their own durable contract; they never acquire
  // provider-turn controls merely by appearing alongside live session shares.
  if(e.messageContract==='task-inbox')return{ok:false,status:'unsupported',error:'This board run uses its task inbox. Open its card or use Message.'};
  // inspect/act freshly authorize the exact share. Re-reading every teammate's
  // state here would fan out N relay calls for each selected-session read.
  return{hub,viewer,team:e.team,ref:e.ref,scope:e.scope,isCurrent:()=>fresh()&&e.expires>=now()&&safe(teamHub,null)===hub&&viewerOf(hub)?.id===viewer.id};
 }
 // My sessions / Team sessions. Team privacy is filtered here, never in the page.
 // Team depth lane C: team entry id → the hub card id of its session (for presence.view), and the team they belong to.
 const viewCards=new Map();let viewTeam=null;
 // Presence goes through one owner (ledger 31); a private one around presenceView keeps callers that inject only presenceView working.
 const holder=presenceOwner??require('./presence-owner').createPresenceOwner({presenceView});
 const clearViewing=()=>{try{holder.set('overview',null);}catch{}};
 // The person opened (id) or closed (null) a shared session's details: the team's boards hear which card is being looked at.
 function viewing(request){if(!closed(request,['id'])||!(request.id===null||typeof request.id==='string'&&/^[0-9a-f]{40}$/.test(request.id)))return{ok:false,status:'invalid'};
  if(!permitted()||!viewTeam)return{ok:false,status:'unavailable'};
  const card=request.id?viewCards.get(request.id)??null:null;let changed=false;
  try{changed=holder.set('overview',card?{team:viewTeam,card}:null);}catch{}
  return{ok:true,status:changed?(card?'viewing':'cleared'):'unchanged'};}
 async function directory(request){
  const time=now(),view=request?.view;
  if(!(closed(request,['view'])&&view==='mine'||closed(request,['view','team'])&&view==='team'&&(request.team===null||typeof request.team==='string'&&/^[0-9a-f]{32}$/.test(request.team))))return unavailableDirectory('mine',time);
  const readGeneration=++directoryEpoch,reading=()=>readGeneration===directoryEpoch&&permitted();
  if(view==='mine'&&teamView!==null||view==='team'&&request.team!==null&&teamView!==request.team){routeEpoch++;teamView=view==='mine'?null:request.team;clearViewing();teamRefs.clear();controls.invalidate();coordinator?.invalidate();}
  if(!permitted())return unavailableDirectory(view,time);
  const built=await build(time,reading);
  if(!built||!reading())return unavailableDirectory(view,time);
  const sh=safe(shares,null),origin=typeof sh?.origin==='string'?sh.origin:null;
  const shareList=(origin&&Array.isArray(sh.list)?sh.list:[]).filter(x=>object(x)&&typeof x.session==='string'&&object(x.team)&&typeof x.team.id==='string').map(x=>({session:x.session,scope:x.scope,teamKey:teamKey(origin,x.team.id),teamName:clean(x.team.name,80)||'Team'}));
  const ownedList=(()=>{const v=safe(owned,[]);return Array.isArray(v)?v.slice(0,50):[];})();
  const personal=directoryModel.mine({work:built.rows,meta:built.meta,owned:ownedList,shares:shareList});
  personalRefs.clear();for(const e of personal)personalRefs.set(e.id,e);
  const teams=new Map(),add=(key,name,source)=>{if(!teams.has(key))teams.set(key,{key,name:clean(name,80)||'Team',source});};
  let real=null;try{real=await hubTeams();}catch{real=null;}
  teamIds.clear();
  if(typeof real?.origin==='string'&&Array.isArray(real.teams))for(const t of real.teams.slice(0,64))if(object(t)&&typeof t.id==='string'){add(teamKey(real.origin,t.id),t.name,'hub');teamIds.set(teamKey(real.origin,t.id),{origin:real.origin,teamId:t.id});}
  for(const e of personal)for(const b of e.teams)add(b.key,b.name,'hub');
  const hub=safe(teamHub,null),viewer=viewerOf(hub);let fakeTeams=[];
  const adapterOrigin=hub?.fake!==true&&typeof hub?.origin==='string'?hub.origin:'adapter:';
  if(hub&&viewer){try{fakeTeams=(await hub.teams(viewer)).filter(t=>object(t)&&typeof t.id==='string').slice(0,64);}catch{fakeTeams=[];}
   for(const t of fakeTeams)add(teamKey(adapterOrigin,t.id),t.name,hub.fake===true?'fake':'adapter');}
  if(!reading())return unavailableDirectory(view,time);
  const teamList=[...teams.values()].map(t=>({...t,label:t.source==='fake'?clean(hub?.label,80)||'Fake team hub':''}));
  let status=built.partial||built.omitted?'partial':'complete';
  if(view==='mine')return{schema:1,view,status,observed_at:time,teams:teamList,team:null,notice:'',entries:personal,counts:directoryModel.counts(personal)};
  const selected=teams.get(request.team)??teams.values().next().value??null;
  if(teamView!==(selected?.key??null)){routeEpoch++;teamView=selected?.key??null;clearViewing();teamRefs.clear();controls.invalidate();coordinator?.invalidate();}
  if(!selected)return{schema:1,view,status,observed_at:time,teams:teamList,team:null,notice:'You are not in a team yet, or no team is connected.',entries:[],counts:directoryModel.counts([])};
  const adapterTeam=fakeTeams.find(t=>teamKey(adapterOrigin,t.id)===selected.key)??null;
  let hubEntries=[];
  if(adapterTeam){try{hubEntries=await hub.sessions(viewer,adapterTeam.id);}catch{hubEntries=[];}}
  if(!reading())return unavailableDirectory(view,time);
  if(hubEntries?.partial===true)status='partial';
  const model=directoryModel.team({team:{key:selected.key,name:selected.name,id:adapterTeam?.id??null},viewer:viewer??{id:''},member:!!adapterTeam,personal,hubEntries});
  // Team depth lane C: the latest board.presence for this team (main-only link), folded onto the people shown.
  viewCards.clear();viewTeam=adapterTeam?.id??null;
  if(adapterTeam){let live=null;try{live=presence(adapterTeam.id);}catch{live=null;}
   if(live&&typeof live==='object'){const members=Array.isArray(live.members)?live.members:[],viewers=Array.isArray(live.viewers)?live.viewers:[];
    for(const e of model.entries){if(!e.owner||e.owner.self)continue;const m=members.find(p=>p&&p.name===e.owner.name),v=viewers.find(p=>p&&p.name===e.owner.name);if(!m&&!v)continue;
     const running=[...new Set((Array.isArray(m?.sessions)?m.sessions:[]).map(s=>clean(s?.repo_short,80)).filter(Boolean))].slice(0,5);
     e.presence={viewing:v?{key:clean(v.key,80)||null,title:clean(v.title,120)||'a card'}:null,running};}}
   for(const [entryId,ref] of model.refs){const x=(Array.isArray(hubEntries)?hubEntries:[]).find(h=>h&&h.ref===ref.ref);const cardId=x&&x.card&&typeof x.card==='object'&&typeof x.card.id==='string'&&x.card.id&&x.card.id.length<=128?x.card.id:null;if(cardId)viewCards.set(entryId,cardId);}}
  teamRefs.clear();
  for(const [entryId,ref] of model.refs)teamRefs.set(entryId,{...ref,messageContract:model.entries.find(x=>x.id===entryId)?.messageContract,team:adapterTeam.id,teamKey:selected.key,hub,viewerId:viewer?.id,expires:time+45000});
  while(teamRefs.size>500)teamRefs.delete(teamRefs.keys().next().value);
  const notice=adapterTeam?(hub.fake===true?`${clean(hub.label,80)||'Fake team hub'}: these teammates and sessions are test data, not a real team.`:''):'Your own sessions in this team are shown. Teammates\' shared sessions appear once your team hub\'s shared-session directory is connected.';
  return{schema:1,view,status,observed_at:time,teams:teamList,team:{key:selected.key,name:selected.name,source:selected.source},notice,entries:model.entries,counts:directoryModel.counts(model.entries)};
 }
 // T1: the chat-first sidebar's teammate rows. Read-only for Overview: no build(), no routeEpoch,
 // teamView, teamRefs, viewCards/viewTeam, controls or coordinator write, and no presence read
 // or presenceView. The viewer token is opaque (an HMAC of hub origin and viewer id).
 const passiveOrigin=hub=>hub?.fake!==true&&typeof hub?.origin==='string'?hub.origin:'adapter:';
 function viewerScope(){const hub=safe(teamHub,null),viewer=viewerOf(hub);return hub&&viewer?stable(['viewer',passiveOrigin(hub),viewer.id]):null;}
 async function passiveTeamRows(alive){
  const ok=()=>{try{return alive()===true;}catch{return false;}};
  const hub=safe(teamHub,null),viewer=viewerOf(hub);
  if(!ok())return null;
  if(!hub||!viewer)return{viewerScope:null,teams:[],teamsTotal:0,entries:[],partial:false};
  const scope=viewerScope(),origin=passiveOrigin(hub),still=()=>ok()&&safe(teamHub,null)===hub&&viewerOf(hub)?.id===viewer.id;
  if(typeof hub.passiveSessions!=='function')return null;
  let got;try{got=await hub.passiveSessions(viewer);}catch{got=null;}
  if(!still()||!object(got)||!Array.isArray(got.teams))return null;
  const entries=[],teams=[];
  for(const t of got.teams.filter(t=>object(t)&&typeof t.id==='string').slice(0,4)){
   const key=teamKey(origin,t.id),name=clean(t.name,80)||'Team',fake=hub.fake===true;
   teams.push({key,name,fake,label:fake?clean(hub.label,80)||'Fake team hub':''});
   const hubEntries=Array.isArray(t.entries)?t.entries:[];
   const model=directoryModel.team({team:{key,name,id:t.id},viewer,member:true,personal:[],hubEntries});
   // Main-only beside each entry (never projected; SidebarRows.teamRows takes a fixed shape): the hub ref, team id and
   // card id, so a later step (T2) re-resolves a row through this same read rather than a second path.
   for(const e of model.entries){if(entries.length>=200)break;if(e.owner?.self)continue;const ref=model.refs.get(e.id);if(!ref)continue;
    const x=hubEntries.find(h=>object(h)&&h.ref===ref.ref),cardId=typeof x?.card?.id==='string'&&x.card.id&&x.card.id.length<=128?x.card.id:null;
    entries.push({rowId:stable(['shared',e.id]),entryId:e.id,teamKey:key,teamId:t.id,teamName:name,fake,label:fake?clean(hub.label,80)||'Fake team hub':'',scope:ref.scope,ref:ref.ref,cardId,entry:e});}
  }
  return{viewerScope:scope,teams,teamsTotal:Number.isSafeInteger(got.teamsTotal)&&got.teamsTotal>=teams.length?got.teamsTotal:teams.length,entries,partial:got.partial===true};
 }

 // T2: a teammate's shared session opened as a read-only thread. The route (hub, ref, team, card) stays in main and
 // never reaches a renderer. A thread reads through hub.inspect only: no selection, token, controls or route state, so
 // Overview's epochs, handles and presence are untouched. Every use re-checks the hub and the signed-in viewer.
 const sharedRoutes=new Map();
 const sharedLive=r=>{const hub=safe(teamHub,null);return!!r&&hub===r.hub&&viewerOf(hub)?.id===r.viewerId;};
 function sharedTargetOf(rowId){
  const r=sharedRoutes.get(rowId);
  if(!sharedLive(r)){sharedRoutes.delete(rowId);return null;}
  return{kind:'shared',teamId:r.team,cardId:r.cardId,fake:r.fake,vm:null};
 }
 async function sharedThreadBind(rowId,alive=()=>true){
  if(typeof rowId!=='string'||!/^[0-9a-f]{64}$/.test(rowId))return false;
  const hub=safe(teamHub,null),viewer=viewerOf(hub);
  if(!hub||!viewer||typeof hub.sharedEntries!=='function'||typeof hub.inspect!=='function')return false;
  const ok=()=>{try{return alive()===true;}catch{return false;}},still=()=>ok()&&safe(teamHub,null)===hub&&viewerOf(hub)?.id===viewer.id;
  let got;try{got=await hub.sharedEntries(viewer);}catch{got=null;}
  if(!still()||!object(got)||!Array.isArray(got.teams))return false;
  const origin=passiveOrigin(hub);
  for(const t of got.teams.filter(t=>object(t)&&typeof t.id==='string').slice(0,64)){
   const hubEntries=Array.isArray(t.entries)?t.entries:[];
   const model=directoryModel.team({team:{key:teamKey(origin,t.id),name:clean(t.name,80)||'Team',id:t.id},viewer,member:true,personal:[],hubEntries});
   for(const e of model.entries){
    if(stable(['shared',e.id])!==rowId)continue;
    const ref=model.refs.get(e.id);
    if(!ref||typeof ref.ref!=='string'||!UUID.test(ref.ref))return false;
    const x=hubEntries.find(h=>object(h)&&h.ref===ref.ref),cardId=typeof x?.card?.id==='string'&&x.card.id&&x.card.id.length<=128?x.card.id:null;
    sharedRoutes.delete(rowId);
    sharedRoutes.set(rowId,{hub,viewerId:viewer.id,team:t.id,teamName:clean(t.name,80)||'Team',entryId:e.id,ref:ref.ref,cardId,scope:ref.scope,ownerName:clean(e.owner?.name,80)||'Teammate',fake:hub.fake===true,seen:null});
    while(sharedRoutes.size>20)sharedRoutes.delete(sharedRoutes.keys().next().value);
    return true;
   }
  }
  return false;
 }
 // → the fixed projection, {gone,reason} when the share is over, {unavailable} for a failed read, null when this read is stale.
 async function sharedThreadRead(rowId,alive=()=>true){
  const r=sharedRoutes.get(rowId);
  if(!sharedLive(r)){sharedRoutes.delete(rowId);return{gone:true,reason:'unavailable'};}
  const hub=r.hub,viewer=viewerOf(hub);
  const ok=()=>{try{return alive()===true;}catch{return false;}},still=()=>ok()&&sharedRoutes.get(rowId)===r&&sharedLive(r);
  let out;try{out=await hub.inspect(viewer,r.team,r.ref);}catch{out=null;}
  if(!still())return null;
  if(!object(out))return{unavailable:true};
  if(out.ok!==true){
   if(out.status==='forbidden'||out.status==='stale'){sharedRoutes.delete(rowId);return{gone:true,reason:'removed'};}
   return out.offline===true?{unavailable:true,offline:true,owner:clean(r.ownerName,80)||'The owner'}:out.signIn===true?{unavailable:true,signIn:true}:{unavailable:true};
  }
  if(!object(out.state))return{unavailable:true};
  if(out.state.status==='ended'){sharedRoutes.delete(rowId);return{gone:true,reason:'ended'};}
  // T3: what this read saw, main-only, so a thread's review card retires when the session moves on (plan-t3 §2.5).
  r.seen={generation:out.state.generation,turn:out.state.activeTurn??null,scope:out.share?.scope==='interact'?'interact':'watch'};
  return SharedThread.project({state:out.state,share:object(out.share)?out.share:null,route:r,now:now()});
 }
 // T3 (plan-t3 §2.1): a thread document's effect authority for exactly its bound teammate share. Its own
 // session controls and coordinator, so its tokens, proposals and remote selections never mix with Overview's,
 // and an inventory of one entry (oneEntry) that never reads Overview's directory or moves its route, view or
 // refs. Shared with Overview: the hub's per-target dispatch lock (team-session-controls) and the directory
 // model's monotonic report clock. `read`/`effect` are the thread document's Guard T liveness.
 const NAME_CONTROL=/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
 const plainName=v=>typeof v==='string'?v.replace(NAME_CONTROL,'').replace(/\s+/g,' ').trim().slice(0,75):'';
 const usableName=n=>!!n&&!n.includes('@')&&n.toLowerCase()!=='you';
 // "From ‹my name›" (plan-t3 §2.4): the signed-in hub account's display name, main-held and for this viewer only.
 // Not viewerOf(), whose fallback is 'You'. An email-like or missing name reads "a teammate".
 function proposerName(hub,viewerId){
  let a=null;try{a=accountName();}catch{a=null;}
  const fromAccount=object(a)&&a.userId===viewerId?plainName(a.name):'';
  if(usableName(fromAccount))return fromAccount;
  const raw=plainName(safe(()=>hub?.viewer?.(),null)?.name);
  return usableName(raw)?raw:'a teammate';
 }
 function sharedThreadAuthority(rowId,{read,effect}={}){
  const r=typeof rowId==='string'?sharedRoutes.get(rowId):null;
  if(!sharedLive(r)||typeof r.entryId!=='string'||typeof read!=='function'||typeof effect!=='function')return null;
  const hub=r.hub,key=teamKey(passiveOrigin(hub),r.team);
  const ok=f=>{try{return f()===true;}catch{return false;}};
  const live=()=>ok(read)&&sharedRoutes.get(rowId)===r&&sharedLive(r);
  const acting=()=>live()&&ok(effect);
  // The same target shape resolveTeam gives Overview, for the bound entry only. The scope is read fresh from the
  // shared list every time, never from the bind. isCurrent is always present: the read fence.
  async function threadResolve(id,eff=false){
   const fresh=()=>eff?acting():live();
   if(id!==r.entryId||!fresh())return response('stale');
   const viewer=viewerOf(hub);
   let got;try{got=await hub.sharedEntries(viewer);}catch{got=null;}
   if(!fresh())return response('stale');
   if(!object(got)||!Array.isArray(got.teams))return{ok:false,status:'unavailable',error:'The shared session could not be checked.'};
   const x=got.teams.find(t=>object(t)&&t.id===r.team)?.entries?.find?.(h=>object(h)&&h.ref===r.ref);
   if(!x)return{ok:false,status:'stale',error:'This session is no longer shared with you.'};
   return{hub,viewer,team:r.team,ref:r.ref,scope:x.share?.scope==='interact'?'interact':'watch',isCurrent:live};
  }
  // One inspect of the bound ref writes its state slot; sharedEntry projects the listed row with it; the same
  // directory model makes the entry Overview would (equal id). Nothing else is read or written.
  let offlineSeen=null;
  async function oneEntry({team}){
   if(team!==key||!live())return null;
   const viewer=viewerOf(hub);
   let out;try{out=await hub.inspect(viewer,r.team,r.ref);}catch{out=null;}
   offlineSeen=out?.offline===true?clean(out.error,300):null;
   if(!live()||out?.ok!==true||typeof hub.sharedEntry!=='function')return null;
   let x;try{x=hub.sharedEntry(viewer,r.team,r.ref);}catch{x=null;}
   if(!object(x))return null;
   const model=directoryModel.team({team:{key,name:r.teamName,id:r.team},viewer,member:true,personal:[],hubEntries:[x]});
   const e=model.entries.find(e=>e.id===r.entryId);
   return e?{schema:1,view:'team',status:'complete',observed_at:now(),team:{key,name:r.teamName},entries:[e]}:null;
  }
  const controls=createTeamSessionControls({resolve:threadResolve,current:live,actionCurrent:acting,now});
  const coordinator=createTeamCoordinator({inventory:oneEntry,inspect:controls.inspect,action:controls.action,resolve:threadResolve,current:live,actionCurrent:acting,now});
  return Object.freeze({
   live,owner:r.ownerName,seen:()=>r.seen?{...r.seen}:null,
   resolve:()=>threadResolve(r.entryId,true),
   inspect:()=>controls.inspect({id:r.entryId}),
   act:(selection,operation,text)=>controls.action({selection,operation,text},{current:acting}),
   // An offline owner (L35) reads as offline, not as a stale directory.
   propose:async text=>{offlineSeen=null;const p=await coordinator.propose({team:key,title:'Thread proposal',assignments:[{id:r.entryId,name:`From ${proposerName(hub,r.viewerId)}`,text}]});return p?.ok!==true&&offlineSeen?{ok:false,status:'unavailable',error:offlineSeen}:p;},
   requestOwner:proposal=>coordinator.requestOwner({proposal}),
   remoteList:()=>coordinator.remoteList({id:r.entryId}),
   remoteSend:selection=>coordinator.remoteSend({selection}),
   remoteCancel:selection=>coordinator.remoteCancel({selection}),
   invalidate(){controls.invalidate();coordinator.invalidate();},
  });
 }
 // Message a teammate's session shared with the selected team to send.
 async function teamMessage(request){
  if(!closed(request,['id','text'])||typeof request.id!=='string'||!/^[0-9a-f]{40}$/.test(request.id)||typeof request.text!=='string'||request.text.includes('\0')||!request.text.trim()||request.text.trim().length>4000||Buffer.byteLength(request.text.trim())>8192)return response('invalid');
  const e=teamRefs.get(request.id),generation=routeEpoch;if(!e||e.expires<now()||!actionPermitted())return response('stale');
  if(e.scope!=='interact')return{...response('unavailable'),error:'Shared with you to watch only.'};
  const hub=safe(teamHub,null),viewer=viewerOf(hub);if(!hub||hub!==e.hub||!viewer||viewer.id!==e.viewerId||teamView!==e.teamKey)return response('stale');
  const alive=()=>actionPermitted()&&generation===routeEpoch&&teamView===e.teamKey&&safe(teamHub,null)===hub&&viewerOf(hub)?.id===viewer.id&&e.expires>=now();
  // Re-check the share right before sending: revoked, expired or removed members refuse.
  let fresh;try{fresh=await hub.sessions(viewer,e.team);}catch{fresh=[];}
  if(!alive())return response('stale');
  const again=directoryModel.team({team:{key:e.teamKey,name:'',id:e.team},viewer,member:true,personal:[],hubEntries:fresh});
  const now2=again.refs.get(request.id);if(!now2||now2.ref!==e.ref||now2.scope!=='interact')return{ok:false,status:'stale',error:'This session is no longer shared with you to send.'};
  const target=again.entries.find(x=>x.id===request.id);if(target?.capabilities.receive.available!==true)return{ok:false,status:'unavailable',error:target?.capabilities.receive.reason||'Unavailable.'};
  let out;try{out=await hub.send(viewer,e.team,e.ref,request.text.trim(),crypto.randomUUID(),alive);}catch{return{ok:false,status:'unconfirmed',error:'No receipt yet. Inspect the task inbox before sending again.'};}
  if(!alive())return{ok:false,status:'unconfirmed',error:'The view changed. Inspect the receipt before sending again.'};
  return out?.ok===true?out:{ok:false,status:['forbidden','stale','busy','unavailable','unconfirmed'].includes(out?.status)?out.status:'unavailable',error:clean(out?.error,300)||'The team hub did not accept the message.'};
 }
 return{snapshot,passiveRows,clearViewing,sharedThreadBind,sharedThreadRead,sharedThreadAuthority,passiveTeamRows,viewerScope,threadTarget,threadForTask,viewing,directory:async request=>{const out=await directory(request);return{...out,followupScope:followupScope()};},teamMessage,teamInspect:controls.inspect,teamAction:controls.action,teamIdentity,
  followupReview,followupEnqueue,
  coordinatorRequestOwner:coordinator.requestOwner,coordinatorRemoteList:coordinator.remoteList,coordinatorRemoteSend:coordinator.remoteSend,coordinatorRemoteCancel:coordinator.remoteCancel,coordinatorRemoteReplace:coordinator.remoteReplace,
  coordinatorInventory:coordinator.inventory,coordinatorPropose:coordinator.propose,coordinatorConfirm:coordinator.confirm,coordinatorResults:coordinator.results,coordinatorCancel:coordinator.cancel,
  followupList:()=>{const owner=followupScope(),epoch=routeEpoch;return permitted()&&followups?followups.list(()=>permitted()&&owner===followupScope()&&epoch===routeEpoch):followupUnavailable();},
  followupCancel:r=>{const owner=followupScope(),epoch=routeEpoch;return actionPermitted()&&closed(r,['id'])&&followups?followups.cancel(r.id,()=>actionPermitted()&&owner===followupScope()&&epoch===routeEpoch):followupUnavailable();},
  followupDiscard:r=>{const owner=followupScope(),epoch=routeEpoch;return actionPermitted()&&closed(r,['id'])&&followups?followups.discard(r.id,()=>actionPermitted()&&owner===followupScope()&&epoch===routeEpoch):followupUnavailable();},
  pumpFollowups:()=>actionPermitted()&&followups?followups.advance(resolveFollowup):Promise.resolve(),
  open:r=>action(r),message:r=>action(r,true),invalidate(){clearViewing();sharedRoutes.clear();epoch++;directoryEpoch++;routeEpoch++;teamView=null;handles.clear();teamRefs.clear();personalRefs.clear();followupSelections.clear();controls.invalidate();coordinator?.invalidate();}};
}
module.exports={createOverviewService,PROVIDERS,provider,response};
