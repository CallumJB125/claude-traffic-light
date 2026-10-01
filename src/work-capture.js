// Main-only routing for reported AI work. No transcript reads, agent launch,
// credential exposure or verified execution identity.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { toolEnv } = require('./tool-path');
const { redactSecrets } = require('./secret-patterns');
const PROVIDERS = new Set(['codex','cursor','gemini','hermes','claude']);
const ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const clean = (text,max) => redactSecrets(String(text??'').slice(0,max*2),{docExamples:false})
  .replace(/\b(?:bdt|brt|btk|btr|inv|clinv|pfi|pfm|pfr|pfc|pfcode)_[A-Za-z0-9_-]{43}\b/g,'<redacted:token>')
  .replace(/\b(?:brt1|bmr1)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'<redacted:token>')
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ')
  .replace(/(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\/Users\/|\/home\/|\/private\/|\/tmp\/)[^\s]+/g,'<path>')
  .replace(/\bfile:\/\/[^\s<>"'`]+|(?<![\w.:/-])\/(?!\/)[^\s"'`<>),;\]}]+/g,'<path>')
  .replace(/https?:\/\/[^\s<>"']+/g,v=>{try{const u=new URL(v);u.username='';u.password='';u.search='';u.hash='';return u.href;}catch{return '<url>';}}).trim().slice(0,max);
const phase = signal => ['permission-ask','permission-denied','limit-hit','tool-failed','turn-failed'].includes(signal)?'waiting'
  : ['stop','subagent-done'].includes(signal)?'review':signal==='session-end'?'ended':signal==='idle-nudge'?'idle':'working';
function privateState(file) {
  let state={v:1,install_id:crypto.randomUUID(),tasks:{},choices:{}};
  try {const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>2*1024*1024||(process.platform!=='win32'&&(st.mode&0o077)))throw new Error('private capture state unavailable');
    const v=JSON.parse(fs.readFileSync(file,'utf8'));const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
    if(v.v!==1||!UUID.test(v.install_id)||!record(v.tasks)||!record(v.choices)||Object.keys(v.tasks).length>2000||Object.keys(v.choices).length>2000)throw new Error('invalid capture state');
    for(const [key,e]of Object.entries(v.tasks))if(!/^[a-f0-9]{64}$/.test(key)||!record(e)||!record(e.destination)||!['local','team'].includes(e.destination.kind)||!PROVIDERS.has(e.provider)||!ID.test(e.session_id)||!ID.test(e.task_id))throw new Error('invalid capture state');state=v;
  }catch(e){if(e.code!=='ENOENT')throw e;}
  const save=()=>{fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temp=`${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp,JSON.stringify(state),{mode:0o600,flag:'wx'});fs.renameSync(temp,file);};
  return {state,save};
}
async function repoFor(cwd) {
  if(typeof cwd!=='string'||!path.isAbsolute(cwd)||cwd.length>2000||cwd.includes('\0'))return null;
  const raw=await new Promise(resolve=>execFile('git',['-C',cwd,'config','--local','--get','remote.origin.url'],
    {timeout:2000,maxBuffer:4096,env:toolEnv({GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'})},(err,out)=>resolve(err?null:String(out).trim())));
  if(!raw)return null;
  const {normalizeRemoteUrl}=await import('../board/shared/scope.js'); // privacy-flow: work-capture-repository
  return normalizeRemoteUrl(raw);
}
function observation(s,{ownedRoots=[],host=null}={}) {
  if(!s||s.remote||s.demo||s.boardRunId||s.board_run_id||s.owned?.launcher==='board'||s.capture===false||!ID.test(s.sessionId??'')||host&&s.host!==host)return null;
  if(ownedRoots.some(root=>typeof s.cwd==='string'&&(s.cwd===root||s.cwd.startsWith(root+path.sep))))return null;
  const provider = PROVIDERS.has(s.source)?s.source:PROVIDERS.has(s.via)?s.via:s.source==null&&s.via==null?'claude':null;
  if(!provider)return null;
  const task = s.taskId==null?'session':s.taskId;if(!ID.test(task))return null;
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
function createWorkCapture({file,getRoutes,sendLocal,sendTeam,resolveRepo=repoFor,ownedRoots=[],host=null,now=Date.now,log=()=>{},onChange=()=>{}}) {
  const {state,save}=privateState(file);let latest=[],active=null,stopped=false,lastCatalogAt=0,catalog={routes:[],complete:true};
  const changed=()=>{try{onChange();}catch{/* UI updates do not affect capture */}};
  save();
  async function pass(sessions) {
    if(now()-lastCatalogAt>15000||!lastCatalogAt){catalog=await getRoutes();lastCatalogAt=now();}
    const routesByKey=new Map((catalog.routes??[]).map(r=>[routeKey(r),r]));
    const current=new Set();
    for(const raw of sessions.slice(0,50)) {
      if(stopped||state.enabled===false)return;
      const o=observation(raw,{ownedRoots,host});if(!o)continue;
      const key=crypto.createHash('sha256').update(JSON.stringify([o.provider,o.session_id,o.task_id])).digest('hex');current.add(key);
      let entry=state.tasks[key];
      if(!entry){if(Object.keys(state.tasks).length>=2000){log('automatic card limit reached');continue;}
        const reportedAt=typeof raw.updatedAt==='string'?Date.parse(raw.updatedAt):NaN;
        if(Number.isFinite(reportedAt)&&Math.abs(now()-reportedAt)>60000)continue;
        const repo=await resolveRepo(o.cwd);
        if(stopped||state.enabled===false)return;
        if(!o.personal&&!catalog.complete){log('automatic card routing awaits a current team catalog');continue;}
        const destination=o.personal?{kind:'local'}:routeFor(repo,catalog.routes??[],state.choices[repo]);
        entry=state.tasks[key]={destination,repo,provider:o.provider,session_id:o.session_id,task_id:o.task_id,title:o.title,status:null,card_id:null,last_seen:now()};save();changed();}
      if(entry.untracked)continue;
      if(o.personal&&entry.destination.kind==='team'){entry.untracked=true;entry.reason='personal_override';save();changed();log('automatic team updates stopped for personal work');continue;}
      const currentRoute=routesByKey.get(routeKey(entry.destination));
      const summary=entry.destination.kind==='local'||currentRoute?.share_summaries===true?o.summary:null;
      const body={install_id:state.install_id,provider:o.provider,session_id:o.session_id,task_id:o.task_id,repo_id:entry.destination.repo_id??null,title:o.title,status:o.status,...(summary!==null?{summary}: {})};
      // A repeated UI poll is not a new activity report. The hook's bounded
      // change marker detects new observations, never verified liveness.
      const marker=typeof raw.updatedAt==='string'?raw.updatedAt.slice(0,100):null;
      const fingerprint=crypto.createHash('sha256').update(JSON.stringify([body,marker])).digest('hex');
      if(entry.fingerprint===fingerprint)continue;
      if(entry.attempt_fingerprint===fingerprint&&now()-(entry.attempt_at??0)<15000)continue;
      entry.last_seen=now();entry.attempt_fingerprint=fingerprint;entry.attempt_at=now();
      let result;
      if(stopped||state.enabled===false)return;
      try {result=entry.destination.kind==='team'?await sendTeam(entry.destination,body):await sendLocal(body);}
      catch {log('automatic card update deferred');continue;}
      if(result?.ok){const before=JSON.stringify([entry.card_id,entry.status,entry.title,entry.untracked]);entry.card_id=result.card?.id??entry.card_id;entry.fingerprint=fingerprint;entry.status=o.status;entry.sent_at=now();entry.title=o.title;
        if(result.capture?.tracking&&result.capture.tracking!=='active'){entry.untracked=true;entry.reason=result.capture.tracking;}
        save();if(before!==JSON.stringify([entry.card_id,entry.status,entry.title,entry.untracked]))changed();}
      else log('automatic card update deferred');
    }
    for(const [key,entry]of Object.entries(state.tasks)) {
      if(stopped||state.enabled===false)return;
      if(current.has(key)||entry.untracked||!entry.card_id||entry.status==='idle'||now()-entry.last_seen<30000)continue;
      const body={install_id:state.install_id,provider:entry.provider,session_id:entry.session_id,task_id:entry.task_id,repo_id:entry.destination.repo_id??null,title:entry.title,status:'idle'};
      try {const result=entry.destination.kind==='team'?await sendTeam(entry.destination,body):await sendLocal(body);if(result?.ok){entry.status='idle';save();changed();}}catch{log('automatic card update deferred');}
    }
  }
  async function drain() {while(latest&&!stopped){const next=latest;latest=null;await pass(next);}}
  return {observe(sessions){if(stopped||state.enabled===false)return;latest=Array.isArray(sessions)?sessions:[];
      if(!active){active=drain().catch(()=>log('automatic cards unavailable')).finally(()=>{active=null;if(latest&&!stopped)this.observe(latest);});}return active;},
    enabled:()=>state.enabled!==false,
    setEnabled(on){state.enabled=!!on;if(!on)latest=null;save();changed();},
    async choose(repo,key){
      if(stopped||typeof repo!=='string'||repo.length>300||typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))return false;
      const fresh=await getRoutes();if(!fresh.complete||stopped)return false;
      const destination=(fresh.routes??[]).find(r=>r.canonical_url===repo&&routeKey(r)===key&&['owner','admin','member'].includes(r.role));
      if(!destination||!Object.hasOwn(state.choices,repo)&&Object.keys(state.choices).length>=2000)return false;
      state.choices[repo]={hub:destination.hub,user_id:destination.user_id,team_id:destination.team_id,board_id:destination.board_id,repo_id:destination.repo_id};save();catalog=fresh;lastCatalogAt=now();changed();return true;
    },
    choices(){return !catalog.complete?[]:(catalog.routes??[]).filter(r=>['owner','admin','member'].includes(r.role)).map(r=>({key:routeKey(r),repo:r.canonical_url,team_name:r.team_name??'Team',board_name:r.board_name??'Board'}));},
    snapshot(){return Object.entries(state.tasks).map(([key,e])=>({key,repo:e.repo,provider:e.provider,title:e.title,status:e.status,card_id:e.card_id,untracked:!!e.untracked,reason:e.reason??null,destination:{...e.destination}}));},
    async stop(){stopped=true;latest=null;await active;},idle:()=>active??Promise.resolve()};
}
module.exports={createWorkCapture,observation,routeFor,repoFor,clean,phase,routeKey};
