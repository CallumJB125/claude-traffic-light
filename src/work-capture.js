// Main-only routing for reported AI work. No transcript reads, agent launch,
// credential exposure or verified execution identity.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { toolEnv } = require('./tool-path');
const { redactSecrets } = require('./secret-patterns');
const { withDeadline, GRACE_MS } = require('./bounded-io');
const PROVIDERS = new Set(['codex','cursor','gemini','hermes','claude']);
const ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const isId = value => typeof value==='string'&&ID.test(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const RETRY_MS = 15000;
const ACK_RESERVE_BYTES = 2048;
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
    if(e.untracked){task.untracked=true;task.reason=clean(e.reason,64);}
    else {
      for(const k of ['last_seen','attempt_at','sent_at','retry_at'])if(Number.isFinite(e[k])&&e[k]>=0)task[k]=e[k];
      for(const k of ['fingerprint','attempt_fingerprint'])if(HASH.test(e[k]??''))task[k]=e[k];
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
  const provider = PROVIDERS.has(s.source)?s.source:PROVIDERS.has(s.via)?s.via:s.source==null&&s.via==null?'claude':null;
  if(!provider)return null;
  const task = s.taskId==null?'session':s.taskId;if(!isId(task))return null;
  return {provider,session_id:s.sessionId,task_id:task,title:clean(s.taskTitle||`${provider[0].toUpperCase()+provider.slice(1)} · ${path.basename(s.cwd||'Work')}`,200),
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
const routeKey = r => crypto.createHash('sha256').update(JSON.stringify([r.hub,r.user_id,r.team_id,r.board_id,r.repo_id])).digest('hex');
function createWorkCapture({startEnabled=false,file,getRoutes,sendLocal,sendTeam,resolveRepo=repoFor,ownedRoots=[],host=null,now=Date.now,log=()=>{},onChange=()=>{}}) {
  let store;
  try {store=privateState(file,startEnabled);store.save(store.state);}
  catch {
    // Preserve unreadable identities for recovery. Resetting the install ID
    // would duplicate existing cards, and capture failure must not close Buddy.
    const notice='Automatic cards are paused because private capture storage is unavailable. Your saved identities have been kept.';
    log('automatic cards unavailable: private storage');
    return {observe:()=>Promise.resolve(),captureOnce:async()=>({ok:false,reason:'storage'}),routes:async()=>({routes:[],complete:false}),enabled:()=>false,setEnabled:()=>false,choose:async()=>false,choices:()=>[],snapshot:()=>[],notice:()=>notice,stop:async()=>{},idle:()=>Promise.resolve()};
  }
  const STALE_MS=7*24*3600*1000;
  for(const [key,e]of Object.entries(store.state.tasks)){
    const seen=Math.max(e.last_seen??0,e.sent_at??0);
    if((e.status==='ended'||e.status==='idle')&&seen&&now()-seen>STALE_MS)delete store.state.tasks[key];
  }
  try{store.save(store.state);}catch{/* pruning is best effort */}
  let state=store.state,latest=[],active=null,stopped=false,lastCatalogAt=0,catalog={routes:[],complete:true},notice=null;
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
    try {result=entry.destination.kind==='team'?await sendTeam(entry.destination,body):await sendLocal(body);}
    catch {log('automatic card update deferred');return;}
    if(!result?.ok){log('automatic card update deferred');return;}
    const before=JSON.stringify([state.tasks[key].card_id,state.tasks[key].status,state.tasks[key].title,state.tasks[key].untracked]);
    if(commit(next=>{
      const e=next.tasks[key];
      if(typeof result.card?.id==='string'&&ID.test(result.card.id))e.card_id=result.card.id;
      if(fingerprint)e.fingerprint=fingerprint;
      e.status=body.status;e.sent_at=now();e.title=title;delete e.retry_at;delete e.attempt_at;delete e.attempt_fingerprint;
      if(result.capture?.tracking&&result.capture.tracking!=='active'){e.untracked=true;e.reason=clean(result.capture.tracking,64);
        delete e.fingerprint;delete e.last_seen;delete e.sent_at;}
    })&&before!==JSON.stringify([state.tasks[key].card_id,state.tasks[key].status,state.tasks[key].title,state.tasks[key].untracked]))changed();
  }
  async function pass(sessions) {
    if(now()-lastCatalogAt>15000||!lastCatalogAt){catalog=await getRoutes();lastCatalogAt=now();}
    const routesByKey=new Map((catalog.routes??[]).map(r=>[routeKey(r),r]));
    const current=new Set();
    // Repeated sessions with the same provider/cwd/explicit title are one piece of work:
    // keep the newest report; the older ones go idle through the sweep below.
    const newest=new Map();
    for(const raw of sessions.slice(0,50)) {
      const o=observation(raw,{ownedRoots,host});if(!o)continue;
      const dup=JSON.stringify(raw.taskTitle?[o.provider,o.cwd??null,o.title]:[o.provider,o.session_id,o.task_id]),at=Date.parse(raw.updatedAt)||0;
      if(!newest.has(dup)||at>newest.get(dup).at)newest.set(dup,{at,raw});
    }
    const keep=new Set([...newest.values()].map(v=>v.raw));
    for(const raw of sessions.slice(0,50)) {
      if(stopped||state.enabled===false)return;
      if(!keep.has(raw))continue;
      const o=observation(raw,{ownedRoots,host});if(!o)continue;
      const key=crypto.createHash('sha256').update(JSON.stringify([o.provider,o.session_id,o.task_id])).digest('hex');current.add(key);
      let entry=state.tasks[key];
      if(entry?.untracked)continue;
      if(o.personal&&entry?.destination.kind==='team'){
        if(commit(next=>{next.tasks[key].untracked=true;next.tasks[key].reason='personal_override';}))changed();
        log('automatic team updates stopped for personal work');continue;
      }
      // Apply age on every activity request, including changed preferences and
      // retries. Source timestamps are reported change markers, never verified
      // agent liveness. A missing or invalid marker cannot renew activity.
      if(!fresh(raw))continue;
      if(!entry){if(Object.keys(state.tasks).length>=2000){log('automatic card limit reached');continue;}
        const repo=safeCanonical(await resolveRepo(o.cwd));
        if(stopped||state.enabled===false)return;
        if(!fresh(raw))continue;
        if(!o.personal&&!catalog.complete){log('automatic card routing awaits a current team catalog');continue;}
        const destination=compactDestination(o.personal?{kind:'local'}:routeFor(repo,catalog.routes??[],state.choices[repo]));
        if(!commit(next=>{next.tasks[key]={destination,repo,provider:o.provider,session_id:o.session_id,task_id:o.task_id,title:o.title,status:null,card_id:null,last_seen:now()};},ACK_RESERVE_BYTES))continue;
        entry=state.tasks[key];changed();}
      const currentRoute=routesByKey.get(routeKey(entry.destination));
      const summary=entry.destination.kind==='local'||currentRoute?.share_summaries===true?o.summary:null;
      const body={install_id:state.install_id,provider:o.provider,session_id:o.session_id,task_id:o.task_id,repo_id:entry.destination.repo_id??null,title:o.title,status:o.status,...(summary!==null?{summary}: {})};
      // A repeated UI poll is not a new activity report. The hook's bounded
      // change marker detects new observations, never verified liveness.
      const marker=typeof raw.updatedAt==='string'?raw.updatedAt.slice(0,100):null;
      const fingerprint=crypto.createHash('sha256').update(JSON.stringify([body,marker])).digest('hex');
      if(entry.fingerprint===fingerprint)continue;
      await send(key,body,{fingerprint,title:o.title,raw});
    }
    for(const [key,entry]of Object.entries(state.tasks)) {
      if(stopped||state.enabled===false)return;
      if(current.has(key)||entry.untracked||!entry.card_id||entry.status==='idle'||now()-entry.last_seen<30000)continue;
      const body={install_id:state.install_id,provider:entry.provider,session_id:entry.session_id,task_id:entry.task_id,repo_id:entry.destination.repo_id??null,title:entry.title,status:'idle'};
      await send(key,body);
    }
  }
  async function drain() {while(latest&&!stopped){const next=latest;latest=null;await pass(next);}}
  return {observe(sessions){if(stopped||state.enabled===false)return;latest=Array.isArray(sessions)?sessions:[];
      if(!active){active=drain().catch(()=>log('automatic cards unavailable')).finally(()=>{active=null;if(latest&&!stopped)this.observe(latest);});}return active;},
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
      const summary=entry.destination.kind==='local'||route?.share_summaries===true?o.summary:null;
      await send(key,{install_id:state.install_id,provider:o.provider,session_id:o.session_id,task_id:o.task_id,repo_id:entry.destination.repo_id??null,title:o.title,status:o.status,...(summary!==null?{summary}:{})},{title:o.title,force:true});
      const done=state.tasks[key];
      return done?.card_id?{ok:true,card_id:done.card_id,destination:{...done.destination}}:{ok:false,reason:done?.untracked?(done.reason||'untracked'):'send_failed'};
    },
    routes:()=>getRoutes(),
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
    overviewSnapshot(){return Object.values(state.tasks).map(e=>({provider:e.provider,session_id:e.session_id,task_id:e.task_id,card_id:e.card_id,untracked:!!e.untracked,destination:{...e.destination}}));},
    // Main-only: the listed sessions a local handover is kept for (src/session-handover-main.js).
    handoverRows(){return Object.values(state.tasks).filter(e=>!BACKGROUND_TITLE.test(String(e.title??'').trim())).map(e=>({provider:e.provider,session_id:e.session_id,title:e.title,last_seen:e.last_seen??null}));},
    // The This Mac list: background entries saved before capture filtered them are hidden,
    // and repeats of one piece of work collapse to a single row with a count.
    snapshot(){
      const rows=new Map();
      for(const [key,e]of Object.entries(state.tasks)){
        if(BACKGROUND_TITLE.test(String(e.title??'').trim()))continue;
        const row={key,repo:e.repo,provider:e.provider,title:e.title,status:e.status,card_id:e.card_id,untracked:!!e.untracked,reason:e.reason??null,destination:{...e.destination},count:1};
        const group=JSON.stringify([e.provider,e.title,e.destination]);
        const prev=rows.get(group);
        if(prev){row.count=prev.count+1;}
        rows.set(group,row);
      }
      return [...rows.values()].map(r=>r.count>1?{...r,title:`${r.title} (${r.count})`}:r);
    },
    async stop(){stopped=true;latest=null;await active;},idle:()=>active??Promise.resolve()};
}
module.exports={createWorkCapture,observation,isBackgroundSession,BACKGROUND_TITLE,routeFor,repoFor,clean,phase,routeKey};
