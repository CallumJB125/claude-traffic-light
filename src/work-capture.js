// Main-only routing for reported AI work. No transcript reads, agent launch,
// credential exposure or verified execution identity.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { toolEnv } = require('./tool-path');
const { redactSecrets } = require('./secret-patterns');
const { scrubTitle } = require('./scrub');
const { withDeadline, GRACE_MS } = require('./bounded-io');
const WorkRecord = require('./work-record');
const { untag } = require('../hooks/handover-tap.js');
const { neutral, label } = require('../board/shared/untrusted-frame.cjs');
const PROVIDERS = new Set(['codex','cursor','gemini','hermes','claude','copilot','goose','cline','opencode','aider']);
const ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const isId = value => typeof value==='string'&&ID.test(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const RETRY_MS = 15000;
const REPO_TTL_MS = 60000, REPO_CACHE_MAX = 200;
const ACK_RESERVE_BYTES = 2048;
const BACKFILL_LIMIT = 25;
const BACKFILL_BUDGET_MS = 2000;
const BACKFILL_DELAY_MS = 20000;
const BACKFILL_EVERY_MS = 60000;
// The title capture used before WorkRecords: the AI's name and the folder's.
const FALLBACK_TITLE = /^(?:Claude(?: Code)?|Codex|Cursor|Gemini|Hermes) · /;
// Every title bound for a team hub, whatever made it (review L2): clean() only removes
// secrets, so IPs, emails, host names and phone numbers went to the whole team.
const hubHostOf = hub => {try{return new URL(String(hub)).hostname;}catch{return null;}};
const hubTitle = (text,hub=null) => scrubTitle(text,{hubHost:hubHostOf(hub)}).trim().slice(0,200);
// The one way a body reaches a team hub (#55 review M1): the title through hubTitle and every summary line through
// scrubTitle, so a new call site cannot skip the scrub. A local (My board) body is never passed through it.
const teamBody = (destination,body) => {
  const hubHost=hubHostOf(destination.hub);
  return {...body,title:hubTitle(body.title,destination.hub),...(typeof body.summary==='string'?{summary:body.summary.split('\n').map(l=>scrubTitle(l,{hubHost})).join('\n')}:{})};
};
const clean = (text,max) => redactSecrets(String(text??'').slice(0,max*2),{docExamples:false})
  .replace(/\b(?:bdt|brt|btk|btr|inv|clinv|pfi|pfm|pfr|pfc|pfcode)_[A-Za-z0-9_-]{43}\b/g,'<redacted:token>')
  .replace(/\b(?:brt1|bmr1)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'<redacted:token>')
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ')
  .replace(/(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\/Users\/|\/home\/|\/private\/|\/tmp\/)[^\s]+/g,'<path>')
  .replace(/\bfile:\/\/[^\s<>"'`]+|(?<![\w.:/-])\/(?!\/)[^\s"'`<>),;\]}]+/g,'<path>')
  .replace(/https?:\/\/[^\s<>"']+/g,v=>{try{const u=new URL(v);u.username='';u.password='';u.search='';u.hash='';return u.href;}catch{return '<url>';}}).trim().slice(0,max);
// A subagent finishing is not the session finishing: the parent AI keeps
// working, so only the main turn's stop or session-end leaves 'working'.
const phase = signal => ['permission-ask','permission-denied','limit-hit','tool-failed','turn-failed'].includes(signal)?'waiting'
  : signal==='stop'?'review':signal==='session-end'?'ended':signal==='idle-nudge'?'idle':'working';
// The shared remote normalizer deliberately accepts broad Git syntax. Capture
// persists and renders this name, so use a closed identity at this boundary.
function safeCanonical(value) {
  if(typeof value!=='string'||value.length>300||!/^([a-z0-9.-]+)\/([A-Za-z0-9._~-]+\/)+[A-Za-z0-9._~-]+$/.test(value))return null;
  return value.split('/').some(s=>s==='.'||s==='..')?null:value;
}
function compactDestination(d) {
  if(!d||!['local','team'].includes(d.kind))throw new Error('invalid capture destination');
  if(d.kind==='local')return {kind:'local',...(d.needs_routing?{needs_routing:true}:{}),...(d.reason?{reason:clean(d.reason,64)}:{})};
  const u=new URL(d.hub);
  if(!['http:','https:'].includes(u.protocol)||u.origin!==d.hub||u.username||u.password)throw new Error('invalid capture destination');
  const out={kind:'team',hub:d.hub};
  for(const k of ['user_id','team_id','board_id','repo_id']) {
    if(!isId(d[k]))throw new Error('invalid capture destination');out[k]=d[k];
  }
  for(const k of ['team_name','board_name'])if(typeof d[k]==='string')out[k]=clean(d[k],60);
  return out;
}
function compactState(v) {
  const out={v:1,install_id:v.install_id,tasks:{},choices:{}};
  if(typeof v.enabled==='boolean')out.enabled=v.enabled;
  for(const [key,e]of Object.entries(v.tasks)) {
    const task={destination:compactDestination(e.destination),repo:safeCanonical(e.repo),provider:e.provider,session_id:e.session_id,task_id:e.task_id,
      title:clean(e.title,200),status:['working','waiting','review','ended','idle'].includes(e.status)?e.status:null,card_id:typeof e.card_id==='string'&&ID.test(e.card_id)?e.card_id:null};
    if(e.agent===true){task.agent=true;if(typeof e.summary==='string')task.summary=e.summary.slice(0,1200);}
    if(e.untracked){task.untracked=true;task.reason=clean(e.reason,64);}
    else {
      for(const k of ['last_seen','attempt_at','sent_at','retry_at'])if(Number.isFinite(e[k])&&e[k]>=0)task[k]=e[k];
      for(const k of ['fingerprint','attempt_fingerprint'])if(HASH.test(e[k]??''))task[k]=e[k];
      if(e.backfilled===1)task.backfilled=1;
      if(isId(e.run_id))task.run_id=e.run_id;
      const pr=prOf(e.pr);if(pr)task.pr=pr;
    }
    out.tasks[key]=task;
  }
  for(const [repo,d]of Object.entries(v.choices))if(safeCanonical(repo)) {
    const pin=compactDestination({...d,kind:'team'});delete pin.kind;out.choices[repo]=pin;
  }
  return out;
}
function privateState(file,startEnabled=false) {
  // A fresh install starts OFF: capture turns on only after the user opts in.
  // An existing file without the key keeps its historical ON behaviour.
  let state={v:1,install_id:crypto.randomUUID(),tasks:{},choices:{},enabled:startEnabled};
  try {const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_STATE_BYTES||(process.platform!=='win32'&&(st.mode&0o077)))throw new Error('private capture state unavailable');
    const v=JSON.parse(fs.readFileSync(file,'utf8'));const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
    if(v.v!==1||!UUID.test(v.install_id)||!record(v.tasks)||!record(v.choices)||Object.keys(v.tasks).length>2000||Object.keys(v.choices).length>2000)throw new Error('invalid capture state');
    for(const [key,e]of Object.entries(v.tasks))if(!HASH.test(key)||!record(e)||!record(e.destination)||!['local','team'].includes(e.destination.kind)||!PROVIDERS.has(e.provider)||!isId(e.session_id)||!isId(e.task_id))throw new Error('invalid capture state');state=v;
  }catch(e){if(e.code!=='ENOENT')throw e;}
  state=compactState(state);
  const save=(candidate,reserve=0)=>{
    const bytes=JSON.stringify(candidate);
    if(Buffer.byteLength(bytes,'utf8')+reserve>MAX_STATE_BYTES){const e=new Error('capture state limit');e.code='CAPTURE_LIMIT';throw e;}
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temp=`${file}.${crypto.randomUUID()}.tmp`;
    try {fs.writeFileSync(temp,bytes,{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}
    finally {try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
  };
  return {state,save};
}
async function repoFor(cwd) {
  if(typeof cwd!=='string'||!path.isAbsolute(cwd)||cwd.length>2000||cwd.includes('\0'))return null;
  const raw=await withDeadline(done=>execFile('git',['-C',cwd,'config','--local','--get','remote.origin.url'],
    {timeout:2000,maxBuffer:4096,env:toolEnv({GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'})},(err,out)=>done(err?null:String(out).trim())),2000+GRACE_MS);
  if(!raw||/[?#\u0000-\u001f\u007f]/.test(raw))return null;
  if(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    // Do not let the permissive shared normalizer reinterpret malformed URL
    // userinfo/ports as repository path segments containing credential bytes.
    try {const u=new URL(raw);if(!u.hostname||u.search||u.hash)return null;}catch{return null;}
  }
  const {normalizeRemoteUrl}=await import('../board/shared/scope.js'); // privacy-flow: work-capture-repository
  return safeCanonical(normalizeRemoteUrl(raw));
}
// Background/internal AI sessions (memory generation, summaries, subagents) are
// not user work and must never get a card.
const BACKGROUND_TITLE=/^(?:\w+ · )?(?:memor(?:y|ies)|summar(?:y|ies)|title generation|session summary)$/i;
const BACKGROUND_DIR=/(?:^|[\\/])\.(?:codex|claude|cursor|gemini|hermes)[\\/](?:memories|memory|summaries)(?:[\\/]|$)/;
function isBackgroundSession(s) {
  if(s.subagent||s.isSubagent||s.isSidechain||s.parentSessionId||s.parent_session_id||s.parentId||s.kind==='subagent'||s.kind==='background'||s.background===true)return true;
  if(typeof s.cwd==='string'&&(BACKGROUND_DIR.test(s.cwd)||/^memor(?:y|ies)$/i.test(path.basename(s.cwd))))return true;
  return typeof s.taskTitle==='string'&&BACKGROUND_TITLE.test(s.taskTitle.trim());
}
function observation(s,{ownedRoots=[],host=null}={}) {
  if(!s||isBackgroundSession(s)||s.remote||s.demo||s.boardRunId||s.board_run_id||s.owned?.launcher==='board'||s.capture===false||!isId(s.sessionId)||host&&s.host!==host)return null;
  if(ownedRoots.some(root=>typeof s.cwd==='string'&&(s.cwd===root||s.cwd.startsWith(root+path.sep))))return null;
  // Claude Code's hook reports no source; its `via` is the hook event (tool-use, session-start), not a provider.
  const provider = PROVIDERS.has(s.source)?s.source:PROVIDERS.has(s.via)?s.via:s.source==null?'claude':null;
  if(!provider)return null;
  const task = s.taskId==null?'session':s.taskId;if(!isId(task))return null;
  // Each Hermes cron run is a new session (cron_<job>_<date>_<time>); one card per job, updated by every run.
  const cron = provider==='hermes'&&/^(cron_[A-Za-z0-9]+)_\d{8}_\d{6}$/.exec(s.sessionId);
  return {provider,session_id:cron?cron[1]:s.sessionId,...(cron?{run_id:s.sessionId}:{}),task_id:task,title:clean(untag(s.taskTitle)||`${provider[0].toUpperCase()+provider.slice(1)} · ${path.basename(s.cwd||'Work')}`,200),
    status:phase(s.signal),summary:typeof s.taskSummary==='string'?clean(s.taskSummary,2000):null,cwd:s.cwd,personal:s.scope?.state==='personal'};
}
function routeFor(repo,routes,choice) {
  const matches=repo?routes.filter(r=>r.canonical_url===repo):[];
  if(!matches.length)return {kind:'local'};
  const current=choice&&matches.find(r=>r.hub===choice.hub&&r.user_id===choice.user_id&&r.team_id===choice.team_id&&r.board_id===choice.board_id&&r.repo_id===choice.repo_id);
  if(current)return current.role==='viewer'?{kind:'local',needs_routing:true,reason:'team_read_only'}:{kind:'team',...current};
  if(matches.length===1)return matches[0].role==='viewer'?{kind:'local',needs_routing:true,reason:'team_read_only'}:{kind:'team',...matches[0]};
  return {kind:'local',needs_routing:true};
}
// Cards an AI session adds with bus_card_add (PR B). The text is the AI's, so it is folded first (the same fold the
// note frame uses), then scrubbed, and Plexiform's own provenance is appended where the AI cannot reach it: any
// "added by" wording and every middot are taken out of its title first, and the title is cut to leave room, so no
// cap downstream can drop the suffix. The summary's first line is Plexiform's; the AI's details follow it.
const AGENT_NAMES = Object.freeze({claude:'Claude Code',codex:'Codex',gemini:'Gemini CLI',cursor:'Cursor',hermes:'Hermes',copilot:'Copilot',goose:'Goose',cline:'Cline',opencode:'OpenCode',aider:'Aider'});
const AGENT_TITLE_MAX = 120, AGENT_DETAILS_MAX = 800;
const AGENT_REQUEST = /^[A-Za-z0-9_-]{8,100}$/;
const DOTS = /[\u00b7\u0387\u2022\u2219\u22c5\u30fb\uff65]/g;
const FORGED_PAREN = /\(\s*added[\s_\p{Pd}]*by\b[^)]*\)?/giu;
const FORGED_TAIL = /[\s\p{Pd}|:,;.]*\badded[\s_\p{Pd}]*by\b[\s\S]*$/iu;
function agentTitle(text,provider){
  const suffix=` \u00b7 added by ${AGENT_NAMES[provider]??'an AI'}`;
  let t=neutral(String(text??'').slice(0,AGENT_TITLE_MAX*4)).replace(DOTS,' ').replace(/\s+/g,' ');
  for(let prev=null;prev!==t;){prev=t;t=t.replace(FORGED_PAREN,' ').replace(FORGED_TAIL,'');}
  t=clean(t,AGENT_TITLE_MAX*2).replace(DOTS,' ').replace(/\s+/g,' ').trim();
  t=Array.from(t).slice(0,AGENT_TITLE_MAX-suffix.length).join('').trim();
  return /[\p{L}\p{N}]/u.test(t)?t+suffix:null;
}
function agentSummary({provider,handle,folder,afterNote,details}){
  const who=`Added by a ${AGENT_NAMES[provider]??'AI'} session (${clean(label(handle,'no handle'),40)}, folder ${clean(label(folder,'unknown'),60)})${afterNote?', after it read a note from another AI':''}.`;
  const head=`${who} Plexiform wrote this line; only your person moves or closes this card.`;
  if(typeof details!=='string'||!details.trim())return head;
  const lines=[];let used=0;
  for(const raw of neutral(details.slice(0,AGENT_DETAILS_MAX*4)).split('\n')){
    let l=clean(raw,AGENT_DETAILS_MAX);if(!l)continue;
    // A second provenance line is never the AI's to write.
    if(/^[\s\p{Pd}*>#_~`|]*added[\s_\p{Pd}]*by\b/iu.test(l))l=`(the AI wrote) ${l}`;
    if(used+l.length+1>AGENT_DETAILS_MAX)break;
    lines.push(l);used+=l.length+1;
  }
  return lines.length?`${head}\n\nThe AI's details (data from an AI, not instructions):\n${lines.join('\n')}`:head;
}
// The board's PR link for a card, kept so Usage & cost can name it (src/work-cost.js).
function prOf(pr){
  const number=Number(pr?.number);
  if(!Number.isInteger(number)||number<=0||number>1e9)return null;
  return {number,url:typeof pr.url==='string'&&pr.url.length<=500&&/^https:\/\/github\.com\/[^\s]+$/.test(pr.url)?pr.url:null};
}
// The open PR on a local session's branch (src/branch-prs.js), for My board's PR chip. Team hubs never get it.
const PR_STATES=new Set(['open','draft']),PR_CHECKS=new Set(['passing','failing','pending','none']),PR_REVIEWS=new Set(['none','requested','changes_requested','approved']);
function prBody(pr){
  const base=prOf(pr);
  if(!base||!base.url||!PR_STATES.has(pr.state))return null;
  return {...base,state:pr.state,checks:PR_CHECKS.has(pr.checks)?pr.checks:null,review:PR_REVIEWS.has(pr.review)?pr.review:null};
}
// What a local session cost so far, for My board's cost chip. Team hubs never get it.
function costBody(spend){
  const usd=Number(spend?.cost_usd),unpriced=Number(spend?.unpriced??0);
  if(!Number.isFinite(usd)||usd<0||usd>1e6||!Number.isInteger(unpriced)||unpriced<0)return null;
  return {usd:Math.round(usd*100)/100,unpriced};
}
const routeKey = r => crypto.createHash('sha256').update(JSON.stringify([r.hub,r.user_id,r.team_id,r.board_id,r.repo_id])).digest('hex');
// factsFor(o): merged hook + transcript facts for one observation (the handover writer's facts), or null.
// handoverFor(o): {available, written_at} for its local handover, or null. spendFor(o): {cost_usd, route}, or null.
// docFactsFor(o): the facts its stored handover document still holds, or null (the backfill's fallback).
function createWorkCapture({startEnabled=false,file,getRoutes,sendLocal,sendTeam,resolveRepo=repoFor,ownedRoots=[],host=null,now=Date.now,log=()=>{},onChange=()=>{},
  factsFor=null,handoverFor=null,spendFor=null,prFor=null,docFactsFor=null,home=null,recordsFile=path.join(path.dirname(file),'work-records.json')}) {
  let store;
  try {store=privateState(file,startEnabled);store.save(store.state);}
  catch {
    // Preserve unreadable identities for recovery. Resetting the install ID
    // would duplicate existing cards, and capture failure must not close Buddy.
    const notice='Automatic cards are paused because private capture storage is unavailable. Your saved identities have been kept.';
    log('automatic cards unavailable: private storage');
    return {observe:()=>Promise.resolve(),boardFor:()=>({kind:'unknown'}),addAgentCard:async()=>({reason:'UNAVAILABLE',message:'Plexiform cannot save cards right now.'}),sessionFacts:()=>null,backfill:async()=>({updated:0,pending:0}),startBackfill:()=>{},captureOnce:async()=>({ok:false,reason:'storage'}),routes:async()=>({routes:[],complete:false}),enabled:()=>false,setEnabled:()=>false,choose:async()=>false,choices:()=>[],snapshot:()=>[],notice:()=>notice,stop:async()=>{},idle:()=>Promise.resolve()};
  }
  const STALE_MS=7*24*3600*1000;
  for(const [key,e]of Object.entries(store.state.tasks)){
    const seen=Math.max(e.last_seen??0,e.sent_at??0);
    if((e.status==='ended'||e.status==='idle')&&seen&&now()-seen>STALE_MS)delete store.state.tasks[key];
  }
  try{store.save(store.state);}catch{/* pruning is best effort */}
  let state=store.state,latest=null,active=null,stopped=false,lastCatalogAt=0,catalog={routes:[],complete:true},notice=null;
  const records=WorkRecord.createWorkRecords({file:recordsFile,now,log});
  const factsOf=WorkRecord.factsCache(factsFor,now);
  // Facts, handover, spend and PR are kept per run: a folded Hermes cron card looks them up by its latest run.
  const run=o=>o.run_id?{...o,session_id:o.run_id}:o;
  const shareSalt=()=>crypto.createHash('sha256').update(`work-record:${state.install_id}`).digest('hex').slice(0,16);
  const call=(fn,o)=>{try{return typeof fn==='function'?fn(o)??null:null;}catch{return null;}};
  // A wrapped task's localTitle (its prompt's first line) titles a My board card only; a team record never sees it.
  const localOnly=(raw,entry)=>entry?.destination.kind==='local'&&typeof raw?.localTitle==='string'&&!untag(raw.taskTitle)?{...raw,taskTitle:raw.localTitle}:raw;
  const recordFor=(o,raw,entry=null)=>WorkRecord.build({install_id:state.install_id,o,raw:localOnly(raw,entry),facts:factsOf(run(o)),repo_id:entry?.destination.kind==='team'?entry.destination.repo_id:null,
    handover:entry?call(handoverFor,run(o)):null,spend:entry?call(spendFor,run(o)):null,home});
  const shows=rec=>!!(rec&&(rec.goal||rec.summary||rec.files.edited.length));
  const placeless=cwd=>typeof cwd!=='string'||!path.isAbsolute(cwd)||path.resolve(cwd)===path.parse(path.resolve(cwd)).root||typeof home==='string'&&home!==''&&path.resolve(cwd)===path.resolve(home);
  const changed=()=>{try{onChange();}catch{/* UI updates do not affect capture */}};
  function commit(mutate,reserve=0) {
    // Publish memory only after the bounded private file commits. In particular
    // a new source's destination must be durable before its first HTTP request.
    try {
      const next=structuredClone(state);mutate(next);store.save(next,reserve);state=next;
      if(notice){notice=null;changed();}return true;
    }catch(e){
      const next=e.code==='CAPTURE_LIMIT'?'Automatic card storage is full. Existing cards keep their saved identities; new reports are paused.':'Automatic cards could not save private storage. Existing cards keep their saved identities.';
      if(notice!==next){notice=next;log('automatic cards deferred: private storage');changed();}return false;
    }
  }
  const fresh=raw=>typeof raw.updatedAt==='string'&&Number.isFinite(Date.parse(raw.updatedAt))&&Math.abs(now()-Date.parse(raw.updatedAt))<=60000;
  async function send(key,body,{fingerprint=null,title=body.title,raw=null,force=false}={}) {
    const entry=state.tasks[key];
    // force: a person's one-off "Make a card" works with the automatic toggle off and for a quiet session.
    const live=()=>!stopped&&(force||state.enabled!==false);
    if(!entry||entry.untracked||!force&&now()<(entry.retry_at??0)||!force&&raw&&!fresh(raw)||!live())return;
    if(!commit(next=>{const e=next.tasks[key];e.retry_at=now()+RETRY_MS;e.attempt_at=now();
      if(fingerprint){e.attempt_fingerprint=fingerprint;e.last_seen=now();}},ACK_RESERVE_BYTES))return;
    if(!live()||!force&&raw&&!fresh(raw))return;
    let result;
    try {result=entry.destination.kind==='team'?await sendTeam(entry.destination,teamBody(entry.destination,body)):await sendLocal(body);}
    catch {log('automatic card update deferred');return;}
    if(!result?.ok){log('automatic card update deferred');return;}
    const before=JSON.stringify([state.tasks[key].card_id,state.tasks[key].status,state.tasks[key].title,state.tasks[key].untracked]);
    if(commit(next=>{
      const e=next.tasks[key];
      if(typeof result.card?.id==='string'&&ID.test(result.card.id))e.card_id=result.card.id;
      const pr=prOf(result.card?.pr);if(pr)e.pr=pr;else if(result.card)delete e.pr;
      if(fingerprint)e.fingerprint=fingerprint;
      e.status=body.status;e.sent_at=now();e.title=title;delete e.retry_at;delete e.attempt_at;delete e.attempt_fingerprint;
      if(result.capture?.tracking&&result.capture.tracking!=='active'){e.untracked=true;e.reason=clean(result.capture.tracking,64);
        delete e.fingerprint;delete e.last_seen;delete e.sent_at;}
    })&&before!==JSON.stringify([state.tasks[key].card_id,state.tasks[key].status,state.tasks[key].title,state.tasks[key].untracked]))changed();
  }
  // O3: wrapped (person-started Tasks) records come after at most 50 sessions, at most 20 of them, through the same
  // loop; each is one piece of work by its task id, never folded into a session with the same title.
  async function pass({sessions,wrapped}) {
    if(now()-lastCatalogAt>15000||!lastCatalogAt){catalog=await getRoutes();lastCatalogAt=now();}
    const routesByKey=new Map((catalog.routes??[]).map(r=>[routeKey(r),r]));
    const current=new Set();
    // Repeated sessions with the same provider/cwd/explicit title are one piece of work:
    // keep the newest report; the older ones go idle through the sweep below.
    const newest=new Map();
    const all=[...sessions.slice(0,50),...wrapped.slice(0,20)],isWrapped=new Set(wrapped.slice(0,20));
    for(const raw of all) {
      const o=observation(raw,{ownedRoots,host});if(!o)continue;
      // Background work seen only through its facts (a memories run titled by its prompt) gets no card,
      // and a session restarted on the same request (resume, retry) is the same work.
      const draft=fresh(raw)?recordFor(o,raw):null;if(draft&&BACKGROUND_TITLE.test(draft.title))continue;
      const goal=draft?.goal??'';
      const dup=JSON.stringify(isWrapped.has(raw)?['task',o.provider,o.session_id,o.task_id]:untag(raw.taskTitle)?[o.provider,o.cwd??null,o.title]:goal.length>=20?[o.provider,o.cwd??null,goal]:[o.provider,o.session_id,o.task_id]),at=Date.parse(raw.updatedAt)||0;
      if(!newest.has(dup)||at>newest.get(dup).at)newest.set(dup,{at,raw});
    }
    const keep=new Set([...newest.values()].map(v=>v.raw));
    for(const raw of all) {
      if(stopped||state.enabled===false)return;
      if(!keep.has(raw))continue;
      const o=observation(raw,{ownedRoots,host});if(!o)continue;
      const key=crypto.createHash('sha256').update(JSON.stringify([o.provider,o.session_id,o.task_id])).digest('hex');current.add(key);
      let entry=state.tasks[key];
      if(entry?.untracked||entry?.agent)continue;
      if(o.personal&&entry?.destination.kind==='team'){
        if(commit(next=>{next.tasks[key].untracked=true;next.tasks[key].reason='personal_override';}))changed();
        log('automatic team updates stopped for personal work');continue;
      }
      // Apply age on every activity request, including changed preferences and
      // retries. Source timestamps are reported change markers, never verified
      // agent liveness. A missing or invalid marker cannot renew activity.
      if(!fresh(raw))continue;
      // A session with nothing to show in the home folder (or none) would be titled after the user's
      // account: it waits for a prompt, a summary or an edit before it gets a card.
      if(!entry&&!untag(raw.taskTitle)&&placeless(o.cwd)&&!shows(recordFor(o,raw)))continue;
      if(!entry){if(Object.keys(state.tasks).length>=2000){log('automatic card limit reached');continue;}
        const repo=safeCanonical(await resolveRepo(o.cwd));
        if(typeof o.cwd==='string')remember(o.cwd,repo);
        if(stopped||state.enabled===false)return;
        if(!fresh(raw))continue;
        if(!o.personal&&!catalog.complete){log('automatic card routing awaits a current team catalog');continue;}
        const destination=compactDestination(o.personal?{kind:'local'}:routeFor(repo,catalog.routes??[],state.choices[repo]));
        if(!commit(next=>{next.tasks[key]={destination,repo,provider:o.provider,session_id:o.session_id,task_id:o.task_id,title:o.title,status:null,card_id:null,last_seen:now()};},ACK_RESERVE_BYTES))continue;
        entry=state.tasks[key];changed();}
      const currentRoute=routesByKey.get(routeKey(entry.destination));
      const {title,summary}=cardText(o,raw,entry,currentRoute);
      const local=entry.destination.kind==='local';
      if(o.run_id&&entry.run_id!==o.run_id&&commit(next=>{next.tasks[key].run_id=o.run_id;}))entry=state.tasks[key];
      const cost=local?costBody(call(spendFor,run(o))):null;
      const body={install_id:state.install_id,provider:o.provider,session_id:o.session_id,task_id:o.task_id,repo_id:entry.destination.repo_id??null,title,status:o.status,...(summary!==null?{summary}: {}),...(cost?{cost}:{}),...(local&&typeof prFor==='function'?{pr:prBody(call(prFor,run(o)))}:{})};
      // A repeated UI poll is not a new activity report. The hook's bounded
      // change marker detects new observations, never verified liveness.
      const marker=typeof raw.updatedAt==='string'?raw.updatedAt.slice(0,100):null;
      const fingerprint=crypto.createHash('sha256').update(JSON.stringify([body,marker])).digest('hex');
      if(entry.fingerprint===fingerprint)continue;
      await send(key,body,{fingerprint,title,raw});
    }
    for(const [key,entry]of Object.entries(state.tasks)) {
      if(stopped||state.enabled===false)return;
      // A card an AI added stays where the board put it until the person moves it: never swept.
      if(current.has(key)||entry.agent||entry.untracked||!entry.card_id||entry.status==='idle'||now()-entry.last_seen<30000)continue;
      const body={install_id:state.install_id,provider:entry.provider,session_id:entry.session_id,task_id:entry.task_id,repo_id:entry.destination.repo_id??null,title:entry.title,status:'idle'};
      records.setStatus(`${state.install_id}:${entry.provider}:${entry.session_id}`,'idle');
      await send(key,body);
    }
  }
  // Title and card body from the WorkRecord. Local cards always get the body
  // (it stays on this Mac); a team card only with share_summaries, scrubbed,
  // with file paths only when the route also has share_files.
  function cardText(o,raw,entry,route){
    const stored=records.upsert(recordFor(o,raw,entry));
    if(entry.destination.kind==='local')return {title:stored.title,summary:WorkRecord.cardBody(stored)};
    const shared=WorkRecord.forShare(stored,route,{salt:shareSalt(),home});
    // Without share_summaries a team title stays the reported task title or provider · folder: a prompt never leaves.
    return {title:raw.taskTitle||!shared?o.title:shared.title,summary:shared?WorkRecord.cardBody(shared):null};
  }
  // One time per card: cards made before WorkRecords carried a body (an empty
  // body, the AI's name and folder as title) get the title and body their
  // session's handover facts give. My board cards only, in place: update_only
  // never makes a card, and re-sending the card's own last status never moves
  // it (an Idle card stays Idle). Bounded per pass, yielding between cards.
  let backfilling=false,backfillTimer=null,backfillFailures=0;const tried=new Set();
  const pendingBackfill=()=>Object.entries(state.tasks).filter(([key,e])=>!e.backfilled&&!e.untracked&&!e.agent&&e.card_id&&e.status&&e.destination.kind==='local'&&!tried.has(key));
  async function backfill({limit=BACKFILL_LIMIT,budgetMs=BACKFILL_BUDGET_MS}={}){
    if(backfilling||stopped||state.enabled===false)return {updated:0,pending:pendingBackfill().length};
    backfilling=true;const began=Date.now();let updated=0,seen=0;
    const mark=(key,title=null)=>commit(next=>{const e=next.tasks[key];if(!e)return;e.backfilled=1;if(title)e.title=title;});
    try{
      for(const [key,e]of pendingBackfill()){
        if(stopped||state.enabled===false||seen>=limit||Date.now()-began>budgetMs)break;
        seen++;tried.add(key);
        const recordId=`${state.install_id}:${e.provider}:${e.session_id}`;
        // Reported since the change: the live path already wrote this card.
        if(records.get(recordId)||BACKGROUND_TITLE.test(String(e.title??'').trim())){mark(key);continue;}
        const o={provider:e.provider,session_id:e.session_id,...(e.run_id?{run_id:e.run_id}:{}),task_id:e.task_id,title:e.title,status:e.status,summary:null,cwd:null,personal:false};
        const facts=call(factsFor,run(o))??call(docFactsFor,run(o));
        const told=facts&&(facts.firstPrompt||facts.lastPrompt||facts.lastAssistant||Object.keys(facts.files??{}).length);
        if(!told){mark(key);continue;}
        const spend=call(spendFor,run(o)),cost=costBody(spend);
        const rec=WorkRecord.build({install_id:state.install_id,o,raw:{taskTitle:FALLBACK_TITLE.test(e.title??'')?null:e.title},facts,handover:call(handoverFor,run(o)),spend,home});
        if(!rec){mark(key);continue;}
        const stored=records.upsert(rec)??rec;
        const title=stored.title||e.title,summary=WorkRecord.cardBody(stored);
        let result=null;
        try{result=await sendLocal({install_id:state.install_id,provider:e.provider,session_id:e.session_id,task_id:e.task_id,repo_id:null,title,status:e.status,summary,...(cost?{cost}:{}),update_only:true});}
        catch{result=null;}
        if(stopped)break;
        // The board is not answering: leave this card for a later pass.
        if(!result?.ok){tried.delete(key);backfillFailures++;log('card backfill deferred');break;}
        if(mark(key,result.card?title:null)&&result.card)updated++;
        if(result.capture?.tracking&&result.capture.tracking!=='active')commit(next=>{const x=next.tasks[key];if(x){x.untracked=true;x.reason=clean(result.capture.tracking,64);}});
        await new Promise(r=>setImmediate(r));
      }
    }finally{backfilling=false;}
    if(updated)changed();
    return {updated,pending:pendingBackfill().length};
  }
  function startBackfill({delayMs=BACKFILL_DELAY_MS,everyMs=BACKFILL_EVERY_MS}={}){
    if(backfillTimer||stopped)return;
    const run=async()=>{backfillTimer=null;if(stopped)return;
      const r=await backfill().catch(()=>({pending:0}));
      if(r.pending&&!stopped&&backfillFailures<3){backfillTimer=setTimeout(run,everyMs);backfillTimer.unref?.();}};
    backfillTimer=setTimeout(run,delayMs);backfillTimer.unref?.();
  }
  // Where a session's work goes, for its Plexiform line (hooks/awareness.js) and bus_peers: the destination its
  // card already has, else the route a first card would take now. Synchronous over what capture already holds:
  // the repo comes from a per-folder cache filled in the background, and until it is known the answer is 'unknown'.
  const repoCache=new Map();
  function remember(cwd,repo){
    if(!repoCache.has(cwd)&&repoCache.size>=REPO_CACHE_MAX)repoCache.delete(repoCache.keys().next().value);
    repoCache.set(cwd,{at:now(),known:true,repo,pending:false});
  }
  function repoOf(cwd){
    let hit=repoCache.get(cwd);
    if(!hit){if(repoCache.size>=REPO_CACHE_MAX)repoCache.delete(repoCache.keys().next().value);hit={at:0,known:false,repo:null,pending:false};repoCache.set(cwd,hit);}
    if(!hit.pending&&(!hit.known||now()-hit.at>=REPO_TTL_MS)){
      hit.pending=true;
      Promise.resolve().then(()=>resolveRepo(cwd)).then(r=>{hit.repo=safeCanonical(r);hit.known=true;},()=>{}).finally(()=>{hit.pending=false;hit.at=now();});
    }
    return hit.known?{repo:hit.repo}:null;
  }
  function boardFor(raw){
    const unknown={kind:'unknown'};
    if(stopped)return unknown;
    if(state.enabled===false)return {kind:'off'};
    const o=observation(raw,{ownedRoots,host});if(!o)return unknown;
    if(o.personal)return {kind:'untracked'};
    const entry=state.tasks[crypto.createHash('sha256').update(JSON.stringify([o.provider,o.session_id,o.task_id])).digest('hex')];
    if(entry?.untracked)return {kind:'untracked'};
    let d=entry?.destination;
    // A card kept on My board while the repo had no default board stays there once one is picked.
    if(d&&d.kind==='local'&&d.needs_routing&&!d.reason&&entry.repo&&Object.hasOwn(state.choices,entry.repo))return {kind:'personal'};
    if(!d||d.kind==='team'){
      if(!lastCatalogAt||!catalog.complete)return unknown;
      if(!d){
        if(typeof o.cwd!=='string'||!path.isAbsolute(o.cwd))return unknown;
        const r=repoOf(o.cwd);if(!r)return unknown;
        d=routeFor(r.repo,catalog.routes??[],r.repo?state.choices[r.repo]:null);
      }
    }
    if(d.kind==='team'){const route=(catalog.routes??[]).find(x=>routeKey(x)===routeKey(d));return {kind:'team',name:typeof route?.board_name==='string'?route.board_name.slice(0,200):''};}
    return {kind:d.reason==='team_read_only'?'readonly':d.needs_routing?'choose':'personal'};
  }
  // The session's own hook facts (files it edited, when it started), for main's soft real-work check.
  function sessionFacts(raw){const o=observation(raw,{ownedRoots,host});return o?factsOf(run(o)):null;}
  // bus_card_add (PR B). raw is the bound session main verified, never anything the request said: its cwd, scope
  // and provider decide where the card goes (review point 7). handle and folder are main's labels for it. The route
  // comes from a catalog fetched now, and an incomplete one refuses rather than falling back to My board (point 8).
  // One card per request_id: a retry, whatever its text, gets the card already made and never changes it (point 12).
  const AGENT_REFUSALS=Object.freeze({
    CARDS_OFF:'Automatic cards are off in Plexiform, so AI sessions cannot add cards.',
    PERSONAL:'Your person marked this work personal, so it gets no cards.',
    CHOOSE_BOARD:'This repo is linked to more than one team board and none is the default yet.',
    READ_ONLY:'Your person\'s role on the team board for this repo is read-only.',
    UNAVAILABLE:'Plexiform could not reach the boards just now. Retry later with the same request_id.',
  });
  const AGENT_FIX=Object.freeze({CHOOSE_BOARD:'Your person can pick a default board for this repo in Plexiform (This Mac).',READ_ONLY:'A team admin can change the role, or the work can stay on My board.'});
  const refuse=reason=>({reason,message:AGENT_REFUSALS[reason],...(AGENT_FIX[reason]?{fix:AGENT_FIX[reason]}:{})});
  const boardOfDestination=d=>{
    if(d.kind!=='team')return {kind:'personal'};
    const route=(catalog.routes??[]).find(x=>routeKey(x)===routeKey(d));
    return {kind:'team',name:typeof route?.board_name==='string'?route.board_name.slice(0,200):''};
  };
  async function addAgentCard(raw,a={}){
    if(stopped)return refuse('UNAVAILABLE');
    if(state.enabled===false)return refuse('CARDS_OFF');
    const o=observation(raw,{ownedRoots,host});
    if(!o||typeof o.cwd!=='string'||!path.isAbsolute(o.cwd))return refuse('UNAVAILABLE');
    if(typeof a.request_id!=='string'||!AGENT_REQUEST.test(a.request_id))return {reason:'VALIDATION',message:'request_id: 8 to 100 letters, digits, _ or -.'};
    const task_id=`agent-${crypto.createHash('sha256').update(`${state.install_id}|${o.provider}|${o.session_id}|${a.request_id}`).digest('hex').slice(0,24)}`;
    const key=crypto.createHash('sha256').update(JSON.stringify([o.provider,o.session_id,task_id])).digest('hex');
    const prior=state.tasks[key];
    if(prior?.agent&&prior.card_id)return {card_id:prior.card_id,title:prior.title,board:boardOfDestination(prior.destination),duplicate:true};
    const title=agentTitle(a.title,o.provider);
    if(!title)return {reason:'VALIDATION',message:'title: nothing is left once it is cleaned.'};
    if(o.personal)return refuse('PERSONAL');
    const own=state.tasks[crypto.createHash('sha256').update(JSON.stringify([o.provider,o.session_id,o.task_id])).digest('hex')];
    if(own?.untracked)return refuse('PERSONAL');
    let fresh=null;
    try{fresh=await getRoutes();}catch{fresh=null;}
    if(stopped||!fresh||fresh.complete!==true)return refuse('UNAVAILABLE');
    catalog=fresh;lastCatalogAt=now();
    const repo=safeCanonical(await resolveRepo(o.cwd));
    remember(o.cwd,repo);
    if(stopped)return refuse('UNAVAILABLE');
    if(state.enabled===false)return refuse('CARDS_OFF');
    // A retry of a request whose answer was lost (the hub may already hold that card) resends exactly what was sent
    // first, to the same board, so it can never rewrite the card; that board must still be one this person can write to.
    let destination,cardTitle=title,summary;
    if(prior?.agent){
      if(prior.destination.kind==='team'&&!(fresh.routes??[]).some(x=>routeKey(x)===routeKey(prior.destination)&&['owner','admin','member'].includes(x.role)))return refuse('UNAVAILABLE');
      destination=prior.destination;cardTitle=prior.title;summary=typeof prior.summary==='string'?prior.summary:null;
    } else {
      const d=routeFor(repo,fresh.routes??[],repo?state.choices[repo]:null);
      if(d.kind==='local'&&d.reason==='team_read_only')return refuse('READ_ONLY');
      if(d.kind==='local'&&d.needs_routing)return refuse('CHOOSE_BOARD');
      if(Object.keys(state.tasks).length>=2000)return refuse('UNAVAILABLE');
      destination=compactDestination(d);
      summary=agentSummary({provider:o.provider,handle:a.handle,folder:a.folder,afterNote:a.after_note===true,details:a.details});
      // Scrubbed for a team board before it is saved, so what is stored is what is sent, and a retry sends it byte for byte.
      if(destination.kind==='team')({title:cardTitle,summary}=teamBody(destination,{title:cardTitle,summary}));
      if(!commit(next=>{next.tasks[key]={destination,repo,provider:o.provider,session_id:o.session_id,task_id,title:cardTitle,summary,status:null,card_id:null,agent:true,last_seen:now()};},ACK_RESERVE_BYTES))return refuse('UNAVAILABLE');
      changed();
    }
    // The board's to-do state, never "Needs you": 'idle' is a status no hub moves to its own column, and the sweep and
    // backfill never touch an agent entry, so the card stays put until the person moves or closes it.
    const body={install_id:state.install_id,provider:o.provider,session_id:o.session_id,task_id,repo_id:destination.repo_id??null,title:cardTitle,status:'idle',...(summary!==null?{summary}:{})};
    let result;
    try{result=destination.kind==='team'?await sendTeam(destination,body):await sendLocal(body);}catch{result=null;}
    const id=typeof result?.card?.id==='string'&&ID.test(result.card.id)?result.card.id:null;
    if(!result?.ok||!id){log('agent card deferred');return refuse('UNAVAILABLE');}
    if(commit(next=>{const e=next.tasks[key];if(e){e.card_id=id;e.status='idle';e.sent_at=now();}}))changed();
    log('agent card added');
    return {card_id:id,title:cardTitle,board:boardOfDestination(destination)};
  }
  async function drain() {while(latest&&!stopped){const next=latest;latest=null;await pass(next);}}
  function kick(){if(stopped||state.enabled===false)return;
    if(!active){active=drain().catch(()=>log('automatic cards unavailable')).finally(()=>{active=null;if(latest&&!stopped)kick();});}return active;}
  return {observe(sessions,{wrapped=[]}={}){if(stopped||state.enabled===false)return;
      latest={sessions:Array.isArray(sessions)?sessions:[],wrapped:Array.isArray(wrapped)?wrapped:[]};return kick();},
    // One-off card for one session, whatever the automatic toggle says. Same identity and
    // routing as the automatic path, so a session that already has a card never gets a second.
    async captureOnce(raw,boardKey=null){
      if(stopped)return {ok:false,reason:'stopped'};
      const o=observation(raw,{ownedRoots,host});if(!o)return {ok:false,reason:'not_trackable'};
      const key=crypto.createHash('sha256').update(JSON.stringify([o.provider,o.session_id,o.task_id])).digest('hex');
      let entry=state.tasks[key];
      if(entry?.card_id)return {ok:true,existing:true,card_id:entry.card_id,destination:{...entry.destination}};
      if(entry?.untracked)return {ok:false,reason:entry.reason||'untracked'};
      if(!entry){
        const repo=safeCanonical(await resolveRepo(o.cwd));
        let destination={kind:'local'};
        if(boardKey&&boardKey!=='local'){
          const fresh=await getRoutes();
          const route=fresh.complete&&(fresh.routes??[]).find(r=>r.canonical_url===repo&&routeKey(r)===boardKey&&['owner','admin','member'].includes(r.role));
          if(!route)return {ok:false,reason:'repo_not_linked'};
          destination={kind:'team',...route};
        }
        if(!commit(next=>{next.tasks[key]={destination:compactDestination(destination),repo,provider:o.provider,session_id:o.session_id,task_id:o.task_id,title:o.title,status:null,card_id:null,last_seen:now()};},ACK_RESERVE_BYTES))return {ok:false,reason:'storage'};
        entry=state.tasks[key];changed();
      }
      const route=entry.destination.kind==='team'?(catalog.routes??[]).find(r=>routeKey(r)===routeKey(entry.destination)):null;
      const {title,summary}=cardText(o,raw,entry,route);
      if(o.run_id&&entry.run_id!==o.run_id&&commit(next=>{next.tasks[key].run_id=o.run_id;}))entry=state.tasks[key];
      const cost=entry.destination.kind==='local'?costBody(call(spendFor,run(o))):null;
      await send(key,{install_id:state.install_id,provider:o.provider,session_id:o.session_id,task_id:o.task_id,repo_id:entry.destination.repo_id??null,title,status:o.status,...(summary!==null?{summary}:{}),...(cost?{cost}:{})},{title,force:true});
      const done=state.tasks[key];
      return done?.card_id?{ok:true,card_id:done.card_id,destination:{...done.destination}}:{ok:false,reason:done?.untracked?(done.reason||'untracked'):'send_failed'};
    },
    routes:()=>getRoutes(),
    boardFor,addAgentCard,sessionFacts,
    // For the team publisher: WorkRecords that may leave this Mac, each with its team destination.
    // Only repos whose current route has share_summaries (files only with share_files), never
    // personal, local, read-only or stopped work; text fully scrubbed (WorkRecord.forShare).
    async shareableRecords(){
      if(stopped)return [];
      if(now()-lastCatalogAt>15000||!lastCatalogAt){catalog=await getRoutes();lastCatalogAt=now();}
      const routesByKey=new Map((catalog.routes??[]).map(r=>[routeKey(r),r]));
      const out=[];
      for(const e of Object.values(state.tasks)){
        // An AI-added card is never an activity record: the team brief and memory are built from those (PR B review point 10).
        if(e.untracked||e.agent||e.destination.kind!=='team')continue;
        const route=routesByKey.get(routeKey(e.destination));
        if(!route||!['owner','admin','member'].includes(route.role))continue;
        const record=WorkRecord.forShare(records.get(`${state.install_id}:${e.provider}:${e.session_id}`),route,{salt:shareSalt(),home});
        if(record)out.push({destination:{hub:e.destination.hub,user_id:e.destination.user_id,team_id:e.destination.team_id,board_id:e.destination.board_id,repo_id:e.destination.repo_id},record});
      }
      return out;
    },
    // Main-only: this Mac's own WorkRecords (local data, never sent by this call).
    localRecords:()=>records.list(),
    // Main-only: each captured session's card and PR, for cost per card (src/work-cost.js).
    costRows(){return Object.values(state.tasks).filter(e=>!e.agent&&!BACKGROUND_TITLE.test(String(e.title??'').trim())).map(e=>({provider:e.provider,session_id:e.session_id,task_id:e.task_id,card_id:e.card_id,title:e.title,repo:e.repo,pr:e.pr??null,last_seen:e.last_seen??e.sent_at??null}));},
    enabled:()=>state.enabled!==false,
    notice:()=>notice,
    setEnabled(on){if(!commit(next=>{next.enabled=!!on;}))return false;if(!on)latest=null;changed();return true;},
    async choose(repo,key){
      if(stopped||!safeCanonical(repo)||typeof key!=='string'||!HASH.test(key))return false;
      const fresh=await getRoutes();if(!fresh.complete||stopped)return false;
      const destination=(fresh.routes??[]).find(r=>r.canonical_url===repo&&routeKey(r)===key&&['owner','admin','member'].includes(r.role));
      if(!destination||!Object.hasOwn(state.choices,repo)&&Object.keys(state.choices).length>=2000)return false;
      const pin=compactDestination({kind:'team',hub:destination.hub,user_id:destination.user_id,team_id:destination.team_id,board_id:destination.board_id,repo_id:destination.repo_id});delete pin.kind;
      if(!commit(next=>{next.choices[repo]=pin;}))return false;
      catalog=fresh;lastCatalogAt=now();changed();return true;
    },
    choices(){return !catalog.complete?[]:(catalog.routes??[]).filter(r=>safeCanonical(r.canonical_url)&&['owner','admin','member'].includes(r.role)).map(r=>({key:routeKey(r),repo:r.canonical_url,team_name:clean(r.team_name??'Team',60),board_name:clean(r.board_name??'Board',60)}));},
    // Main-only identity join for Overview; never forwarded to a renderer.
    overviewSnapshot(){return Object.values(state.tasks).filter(e=>!e.agent).map(e=>({provider:e.provider,session_id:e.run_id??e.session_id,task_id:e.task_id,card_id:e.card_id,untracked:!!e.untracked,destination:{...e.destination}}));},
    // Main-only: the listed sessions a local handover is kept for (src/session-handover-main.js).
    handoverRows(){return Object.values(state.tasks).filter(e=>!e.agent&&!BACKGROUND_TITLE.test(String(e.title??'').trim())).map(e=>({provider:e.provider,session_id:e.run_id??e.session_id,title:e.title,last_seen:e.last_seen??null}));},
    // The This Mac list: background entries saved before capture filtered them are hidden,
    // and repeats of one piece of work collapse to a single row with a count.
    snapshot(){
      const rows=new Map();
      for(const [key,e]of Object.entries(state.tasks)){
        if(BACKGROUND_TITLE.test(String(e.title??'').trim()))continue;
        const row={key,repo:e.repo,provider:e.provider,title:e.title,status:e.status,card_id:e.card_id,untracked:!!e.untracked,reason:e.reason??null,destination:{...e.destination},count:1,...(e.agent?{agent:true}:{})};
        const group=JSON.stringify([e.provider,e.title,e.destination]);
        const prev=rows.get(group);
        if(prev){row.count=prev.count+1;}
        rows.set(group,row);
      }
      return [...rows.values()].map(r=>r.count>1?{...r,title:`${r.title} (${r.count})`}:r);
    },
    backfill,startBackfill,
    async stop(){stopped=true;latest=null;if(backfillTimer){clearTimeout(backfillTimer);backfillTimer=null;}await active;},idle:()=>active??Promise.resolve()};
}
module.exports={createWorkCapture,agentTitle,agentSummary,AGENT_TITLE_MAX,observation,isBackgroundSession,BACKGROUND_TITLE,routeFor,repoFor,clean,hubTitle,phase,routeKey,prBody};
