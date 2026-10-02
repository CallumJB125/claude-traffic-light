'use strict';
// Main-owned structured metadata projection. No transcripts, provider chats,
// tokens, source session IDs, filesystem paths or authority objects cross IPC.
const crypto=require('node:crypto');
const Session=require('./session-overview');
const Machine=require('../hooks/session-machine');
const {clean}=require('./work-capture');
const PROVIDERS=Object.freeze({codex:'Codex',claude:'Claude Code','claude-code':'Claude Code',cursor:'Cursor',gemini:'Gemini',hermes:'Hermes',opencode:'OpenCode',copilot:'Copilot',ollama:'Ollama',lmstudio:'LM Studio','llama.cpp':'llama.cpp',local:'Local model'});
const LOCAL=new Set(['ollama','lmstudio','llama.cpp','local']);
const ID=/^[A-Za-z0-9_.:-]{1,128}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id=v=>typeof v==='string'&&ID.test(v),object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const response=(status)=>({ok:['opened','queued'].includes(status),status,error:status==='invalid'?'Check the selected item and message.':status==='stale'?'This work changed. Refresh and select it again.':status==='unavailable'?'This action is unavailable for this work.':''});
const closed=(v,keys)=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const age=(v,now)=>{const t=typeof v==='string'?Date.parse(v):NaN;return Number.isFinite(t)&&t>=0&&t<=now?now-t:null;};
const freshness=n=>n===null?'unknown':n<=Session.RECENT_MS?'recent':'stale';
const capability=(enabled,label,reason)=>({enabled:enabled===true,label,reason:enabled?'':reason});
const task=card=>card&&typeof card.title==='string'?{status:'tracked',title:clean(card.title,200)||'Untitled task',key:typeof card.key==='string'?clean(card.key,80):null}:{status:'unknown',title:'Task not reported',key:null};
const provider=(source,model)=>{const known=typeof source==='string'&&Object.hasOwn(PROVIDERS,source);return{id:known?source:'unknown',label:(known?PROVIDERS[source]:'Local AI')+(typeof model==='string'&&/^[A-Za-z0-9._:/@+-]{1,80}$/.test(model)?` · ${clean(model,80)}`:''),kind:LOCAL.has(source)?'local':'integrated'};};
function createOverviewService({sessions=()=>[],work=async()=>({sources:[],capture:[]}),managed=()=>({conn:{status:'offline'},tasks:[]}),openManaged=null,messageManaged=null,now=Date.now,current=()=>true,navigationCurrent=()=>false}){
 let epoch=0,handles=new Map();const secret=crypto.randomBytes(32);
 const stable=parts=>crypto.createHmac('sha256',secret).update(JSON.stringify(parts)).digest('hex');
 const permitted=()=>{try{return current()===true;}catch{return false;}};
 const sourcesData=async()=>{const registered=await work();const list=Array.isArray(registered?.sources)?registered.sources.slice(0,9):[];
  const sources=await Promise.all(list.map(async source=>{let data;try{if(source.current())data=await source.read();}catch{}return{source,data};}));
  return{sources,capture:Array.isArray(registered?.capture)?registered.capture.slice(0,2000):[],partial:registered?.partial===true||registered?.sources?.length>9};};
 const validData=(source,data)=>source.current()&&data?.ok===true&&['complete','partial'].includes(data.status)&&object(data.principal)&&(!source.userId||data.principal.user_id===source.userId)&&Array.isArray(data.cards)&&data.cards.length<=500&&Array.isArray(data.agents)&&data.agents.length<=500;
 const keyOf=row=>[row?.card?.id,row?.board_id,row?.member_id,row?.card?.run?.id??null,row?.card?.fence??null,row?.card?.version??null,row?.card?.title??null];
 const liveOwn=(data,row)=>data.agents.some(a=>a.card_id===row.card.id&&a.board_id===row.board_id&&a.member_id===row.member_id&&a.connection==='accepted'&&a.live?.green===true&&Number.isFinite(a.live.hb_age_ms)&&a.live.hb_age_ms>=0&&a.live.hb_age_ms<=Session.RECENT_MS);
 function register(row,entry,next){const handle=crypto.randomUUID();next.set(handle,{...entry,canOpen:row.capabilities.open.enabled===true,canMessage:row.capabilities.message.enabled===true,expires:now()+45000});row.handle=handle;return row;}
 async function snapshot(){
  const generation=++epoch;handles.clear();const time=now();if(!permitted())return{schema:1,status:'unavailable',observed_at:time,omitted:0,sessions:[]};
  let all;try{all=await sourcesData();}catch{all={sources:[],capture:[],partial:true};}
  if(generation!==epoch||!permitted())return{schema:1,status:'unavailable',observed_at:now(),omitted:0,sessions:[]};
  const next=new Map(),rows=[],usedCards=new Set();let partial=all.partial,omitted=0;
  const good=all.sources.filter(({source,data})=>{try{const ok=validData(source,data);if(!ok||data.status!=='complete')partial=true;return ok;}catch{partial=true;return false;}});
  const binding=(raw)=>{if(raw.remote||raw.device)return null;const capture=all.capture.find(c=>c.provider===raw.source&&c.session_id===raw.sessionId&&c.task_id===(raw.taskId??'session')&&!c.untracked&&id(c.card_id));if(!capture)return null;
   for(const {source,data}of good){if(!source.matches?.(capture.destination))continue;const row=data.cards.find(r=>r.card?.id===capture.card_id&&(!capture.destination.board_id||r.board_id===capture.destination.board_id)&&(!capture.destination.team_id||r.team_id===capture.destination.team_id));if(row&&id(row.card.id)&&id(row.board_id)&&id(row.member_id)&&!row.card.archived)return{source,data,row};}return null;};
  const buildLocal=(raw,parentId=null)=>{
   if(!object(raw)||!id(raw.sessionId))return null;const elapsed=age(raw.source==='codex'&&raw.codexLifecycle===1?raw.codexHookAt:raw.updatedAt,time),fresh=freshness(elapsed),bound=binding(raw),card=bound?.row.card;
   const identity=stable(['reported',raw.device??'local',raw.source??'unknown',raw.sessionId??null,raw.taskId??'session',card?.id??null,parentId]);
   const projected=Session.snapshot({sessions:[{...raw,remote:false,device:null}],now:time}).sessions[0];
   let status=projected?.status??'Unknown';if(raw.source==='codex'&&Machine.codexInputPending?.(raw,time))status='Waiting on you';
   const dto={id:identity,handle:null,label:parentId?'Agent':'Session',provider:provider(raw.source,raw.model),device:{label:raw.remote||raw.device?clean(raw.deviceName||'Paired device',80):'This device',local:!raw.remote&&!raw.device},board:{label:bound?clean(bound.row.board_name,80)||'Board':raw.scope?.state==='personal'?'Personal':'Unassigned',kind:bound?bound.source.kind:raw.scope?.state==='personal'?'personal':'unknown'},project:Session.snapshot({sessions:[{cwd:raw.cwd}],now:time}).sessions[0]?.project??'Local project',status,freshness:fresh,age_ms:elapsed,task:task(card??(typeof raw.taskTitle==='string'?{title:raw.taskTitle}:null)),children:[],capabilities:{open:capability(!!bound,'Open card',bound?'':'No current tracked card is available.'),message:capability(!!bound&&liveOwn(bound.data,bound.row)&&fresh==='recent'&&!!card.repo?.id&&typeof bound.source.send==='function','Message','A current owned runner with messaging is required.')}};
   if(bound){usedCards.add(stable(['card',bound.source.key,card.id]));register(dto,{kind:'board',bound,pin:keyOf(bound.row)},next);}else register(dto,{kind:'reported'},next);
   const children=Array.isArray(raw.source==='codex'?raw.codexAgents:raw.agents)?(raw.source==='codex'?raw.codexAgents:raw.agents):[];
   for(const child of children.slice(0,64)){
    if(!object(child)||typeof child.status!=='string'||!['working','waiting','done'].includes(child.status))continue;
    const reportedAges=[age(child.updatedAt??child.since,time),...(raw.source==='codex'?Machine.codexInputEntries({source:'codex',codexLifecycle:1,codexTurnId:child.turnId,codexInputRequests:child.codexInputRequests}).map(r=>age(r.askedAt,time)):[])].filter(n=>n!==null);
    const childAge=reportedAges.length?Math.min(...reportedAges):null,childFresh=freshness(childAge),childDto={id:stable([identity,'child',child.id??dto.children.length]),handle:null,label:clean(child.name??'Agent',80)||'Agent',status:child.status==='done'?'Stopped':child.status==='waiting'?'Waiting on you':'Working',freshness:childFresh,age_ms:childAge,task:task(typeof child.taskTitle==='string'?{title:child.taskTitle}:null),capabilities:{open:capability(false,'Open','This reported agent has no supported open target.'),message:capability(false,'Message','This reported agent has no supported message interface.')}};
    // A parent Stop does not end independently reported child work.
    if(raw.source==='codex'&&['working','waiting'].includes(child.status)&&Machine.codexInputPending({source:'codex',codexLifecycle:1,codexClosedTurn:false,codexTurnId:child.turnId,codexInputRequests:child.codexInputRequests},time))childDto.status='Waiting on you';
    if(!dto.children.some(c=>c.id===childDto.id))dto.children.push(childDto);
   }
   return dto;
  };
  const input=sessions(),reported=Array.isArray(input)?input:[];
  for(const raw of reported.slice(0,500)){if(rows.length>=200){omitted++;continue;}const row=buildLocal(raw);if(row&&!rows.some(r=>r.id===row.id))rows.push(row);}
  if(reported.length>500)omitted+=reported.length-500;
  for(const {source,data}of good){for(const row of data.cards){const card=row?.card;if(!object(card)||!id(card.id)||!id(row.board_id)||!id(row.member_id)||card.archived||!card.run||!id(card.run.id)||!data.agents.some(a=>a.card_id===card.id&&a.board_id===row.board_id&&a.member_id===row.member_id))continue;
   const identity=stable(['card',source.key,card.id]);if(usedCards.has(identity)||rows.some(r=>r.id===identity))continue;if(rows.length>=200){omitted++;continue;}
   const live=liveOwn(data,row),elapsed=Number.isFinite(card.live?.hb_age_ms)&&card.live.hb_age_ms>=0?card.live.hb_age_ms:null;
   const dto={id:identity,handle:null,label:'Managed session',provider:provider(card.run.ai,card.run.model),device:{label:clean(card.run.device_name,80)||'Runner device',local:source.kind==='personal'},board:{label:clean(row.board_name,80)||'Board',kind:source.kind},project:clean(card.repo?.short_name,100)||'Project not reported',status:clean(card.run_state,40)||'Unknown',freshness:freshness(elapsed),age_ms:elapsed,task:task(card),children:[],capabilities:{open:capability(true,'Open card',''),message:capability(live&&!!card.repo?.id&&typeof source.send==='function','Message','A current owned runner with messaging is required.')}};
   register(dto,{kind:'board',bound:{source,data,row},pin:keyOf(row)},next);rows.push(dto);
  }}
  const local=managed();if(local?.conn?.status==='connected'&&Array.isArray(local.tasks))for(const t of local.tasks.slice(0,200)){
   if(!object(t)||!id(t.id)||t.hub)continue;if(rows.length>=200){omitted++;continue;}
   const connected=t.stale!==true,live=connected&&t.green===true;
   const dto={id:stable(['task',t.id]),handle:null,label:'Managed task',provider:provider(t.ai?.id,t.ai?.model),device:{label:'This device',local:true},board:{label:'Personal tasks',kind:'personal'},project:clean(t.repo?.name,100)||'Local project',status:clean(t.label,40)||'Unknown',freshness:live?'recent':connected?'unknown':'stale',age_ms:live?0:null,task:task(t),children:[],capabilities:{open:capability(typeof openManaged==='function','Open Tasks','The Tasks page is unavailable.'),message:capability(live&&Array.isArray(t.actions)&&t.actions.includes('message')&&typeof messageManaged==='function','Message','This task cannot receive messages in its current state.')}};
   if(rows.some(r=>r.id===dto.id))continue;
   register(dto,{kind:'managed',id:t.id,state:t.state,provider:t.ai?.id},next);rows.push(dto);
  }
  if(generation!==epoch||!permitted())return{schema:1,status:'unavailable',observed_at:now(),omitted:0,sessions:[]};
  rows.sort((a,b)=>(a.age_ms??Infinity)-(b.age_ms??Infinity));handles=next;
  return{schema:1,status:partial||omitted?'partial':'complete',observed_at:time,omitted,sessions:rows};
 }
 async function action(request,message=false){
  if(!closed(request,message?['handle','text']:['handle'])||typeof request.handle!=='string'||!UUID.test(request.handle)||message&&(typeof request.text!=='string'||!request.text.trim()||request.text.includes('\0')||request.text.trim().length>4000||Buffer.byteLength(request.text.trim())>8192))return response('invalid');
  const e=handles.get(request.handle),generation=epoch;if(!e||e.expires<now()||!permitted())return response('stale');
  let navigating=false;const fresh=()=>generation===epoch&&e.expires>=now()&&(navigating?navigationCurrent()===true:permitted());
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
 return{snapshot,open:r=>action(r),message:r=>action(r,true),invalidate(){epoch++;handles.clear();}};
}
module.exports={createOverviewService,PROVIDERS,provider,response};
