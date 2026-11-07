// Main-only routing for reported AI work. No transcript reads, agent launch,
// credential exposure or verified execution identity.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { toolEnv } = require('./tool-path');
const { scrubTitle, redactSecretsPass } = require('./scrub');
const { withDeadline, GRACE_MS } = require('./bounded-io');
const WorkRecord = require('./work-record');
const { untag } = require('../hooks/handover-tap.js');
const { neutral, label } = require('../board/shared/untrusted-frame.cjs');
const RepoScope = require('../hooks/repo-scope.js');
const { BOARD_WHY } = require('./bus-contract.js');
const WHYS = new Set(Object.values(BOARD_WHY));
const PROVIDERS = new Set(['codex','cursor','gemini','hermes','claude','copilot','goose','cline','opencode','aider']);
const ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const isId = value => typeof value==='string'&&ID.test(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const RETRY_MS = 15000;
const REPO_TTL_MS = 60000, REPO_CACHE_MAX = 200, EXCLUDE_MS = 5000;
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
// Every card's text, My board or team, passes the one secret scrubber (src/scrub.js redactSecretsPass): the shared
// patterns, prose passwords and PINs, long base64, personal numbers. A team body is scrubbed again by teamBody.
const clean = (text,max) => redactSecretsPass(String(text??'').slice(0,max*2))
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
    // Where it went and why survive a restart: a pending card is still re-routed, and the UI can still say why.
    if(WHYS.has(e.why))task.why=e.why;
    if(e.pending_route===true)task.pending_route=true;
    if(originOf(e.inherited))task.inherited=e.inherited;
    if(e.pointer===true)task.pointer=true;
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
  // "Keep on My board" (PR 7) is kept apart from team pins: an older build rebuilds every choices[] entry as a
  // team destination and would pause automatic cards on any other shape, while it ignores (and drops) this key.
  const local=v.local_choices!==null&&typeof v.local_choices==='object'&&!Array.isArray(v.local_choices)?Object.keys(v.local_choices).filter(r=>v.local_choices[r]===true&&safeCanonical(r)&&!out.choices[r]).slice(0,2000):[];
  if(local.length)out.local_choices=Object.fromEntries(local.map(r=>[r,true]));
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
  if(choice?.kind==='local')return {kind:'local'};
  const current=choice&&matches.find(r=>r.hub===choice.hub&&r.user_id===choice.user_id&&r.team_id===choice.team_id&&r.board_id===choice.board_id&&r.repo_id===choice.repo_id);
  if(current)return current.role==='viewer'?{kind:'local',needs_routing:true,reason:'team_read_only'}:{kind:'team',...current};
  if(matches.length===1)return matches[0].role==='viewer'?{kind:'local',needs_routing:true,reason:'team_read_only'}:{kind:'team',...matches[0]};
  return {kind:'local',needs_routing:true};
}
// Which board a piece of work goes to (BACKBONE plan §3.5, G8): the first rule that matches wins, and the answer
// always says why (src/bus-contract.js BOARD_WHY). An agent never picks; Plexiform decides with this alone.
//  0 excluded folder ($HOME, a root, a dot-folder, the person's exclude list) → no card · 1 personal mark → My board
//  only · 2 inherited (a hand-off carries the asker's board: a team route key, or 'local' for My board), withheld when
//  the work's repo is linked to another team's board · 3 linked to one team board · 4 several: the person's default,
//  else My board with a "pick board" chip · 5 not linked: My board, with a link suggestion when its GitHub org matches
//  a linked team repo's · 6 no repo → My board · 7 catalog unknown (hub offline) → My board marked pending_route,
//  re-routed when the catalog arrives.
// destination is work capture's own form (routeFor); kind is bus_peers' (none, personal, team, choose).
const WRITABLE=['owner','admin','member'];
const ORIGIN_BOARD=/^(?:[a-f0-9]{64}|local)$/;
const originOf=v=>typeof v==='string'&&ORIGIN_BOARD.test(v)?v:null;
const orgOf=u=>typeof u==='string'?(/^([^/]+\/[^/]+)\//.exec(u)||[])[1]??null:null;
function routeBoard({excluded=false,personal=false,inherited=null,repo=null,routes=[],choice=null,catalogComplete=true}={}){
  if(excluded)return {kind:'none',why:'excluded',destination:null};
  // A personal session's automatic card stays on this Mac (My board); it never reaches a team.
  if(personal)return {kind:'personal',why:'personal_mark',destination:{kind:'local'}};
  inherited=originOf(inherited);
  if(inherited==='local')return {kind:'personal',why:'inherited',destination:{kind:'local'}};
  // The asker's team board can't be checked yet: My board for now, re-routed (with the asker's board) later.
  if(inherited&&!catalogComplete)return {kind:'personal',why:'deferred',pending_route:true,destination:{kind:'local'}};
  if(inherited){
    const r=routes.find(x=>routeKey(x)===inherited&&WRITABLE.includes(x.role));
    if(r){
      // Never leak one team's repo onto another team's board: work in a repo linked to a team the asker's board is not
      // in stays on My board, and the asker's board gets a pointer with no title, folder or repo.
      // No repo (no remote, a git timeout, a rejected remote, $HOME) can't be proven to be outside another team: withheld too.
      const linked=repo?routes.filter(x=>x.canonical_url===repo):[];
      if(!repo||linked.length&&!linked.some(x=>x.hub===r.hub&&x.team_id===r.team_id))return {kind:'personal',why:'withheld',destination:{kind:'local'},pointer:{kind:'team',...r}};
      return {kind:'team',why:'inherited',destination:{kind:'team',...r}};
    }
  }
  if(!repo)return {kind:'personal',why:'no_repo',destination:{kind:'local'}};
  if(!catalogComplete)return {kind:'personal',why:'deferred',pending_route:true,destination:{kind:'local'}};
  const d=routeFor(repo,routes,choice);
  const linked=routes.filter(r=>r.canonical_url===repo);
  if(d.kind==='team')return {kind:'team',why:linked.length>1?'repo_default':'linked_repo',destination:d};
  if(d.reason==='team_read_only')return {kind:'personal',why:'read_only',destination:d};
  if(d.needs_routing)return {kind:'choose',why:'choose',destination:d};
  if(linked.length)return {kind:'personal',why:'repo_default',destination:d};
  const org=orgOf(repo);
  const suggest=!!org&&routes.some(r=>WRITABLE.includes(r.role)&&orgOf(r.canonical_url)===org);
  return {kind:'personal',why:suggest?'no_link_suggested':'no_link',destination:d};
}
// The public, deterministic resolver: context → {board, reason}. board is {kind, name?}; reason is a BOARD_WHY value.
// cardsOn false (automatic cards off) is 'cards_off'. pointer, when set, is the asker's team board for a withheld hand-off.
function resolveBoard({cardsOn=true,...context}={}){
  if(!cardsOn)return {board:{kind:'none'},reason:'cards_off',destination:null};
  const r=routeBoard(context);
  const name=r.destination?.kind==='team'&&typeof r.destination.board_name==='string'?clean(r.destination.board_name,60):null;
  return {board:{kind:r.kind,...(name?{name}:{})},reason:r.why,destination:r.destination,...(r.pending_route?{pending_route:true}:{}),...(r.pointer?{pointer:r.pointer}:{})};
}
// A filesystem root, a folder holding $HOME, or a dot-folder or ~/Library under it (hooks/repo-scope.js isProtected):
// never a card, whatever the session did there. $HOME itself is not excluded: a session there with a real prompt
// (Hermes runs there) gets a My board card, and never a team card (homeFolder).
const homeFolder=(cwd,home)=>typeof cwd==='string'&&typeof home==='string'&&!!home&&path.isAbsolute(cwd)&&path.resolve(cwd)===path.resolve(home);
function protectedFolder(cwd,home){
  if(typeof cwd!=='string'||!path.isAbsolute(cwd))return false;
  const dir=path.resolve(cwd);
  if(dir===path.parse(dir).root)return true;
  if(typeof home!=='string'||!home||!path.isAbsolute(home)||homeFolder(dir,home))return false;
  return RepoScope.isProtected(dir,path.resolve(home));
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
  factsFor=null,handoverFor=null,spendFor=null,prFor=null,docFactsFor=null,home=null,excluded=null,excludeMs=EXCLUDE_MS,recordsFile=path.join(path.dirname(file),'work-records.json')}) {
  let store;
  try {store=privateState(file,startEnabled);store.save(store.state);}
  catch {
    // Preserve unreadable identities for recovery. Resetting the install ID
    // would duplicate existing cards, and capture failure must not close Buddy.
    const notice='Automatic cards are paused because private capture storage is unavailable. Your saved identities have been kept.';
    log('automatic cards unavailable: private storage');
    return {observe:()=>Promise.resolve(),boardFor:()=>({kind:'unknown'}),addAgentCard:async()=>({reason:'UNAVAILABLE',message:'Plexiform cannot save cards right now.'}),sessionFacts:()=>null,backfill:async()=>({updated:0,pending:0}),startBackfill:()=>{},captureOnce:async()=>({ok:false,reason:'storage'}),routes:async()=>({routes:[],complete:false}),routing:async()=>[],clearLocal:async()=>false,enabled:()=>false,setEnabled:()=>false,choose:async()=>false,choices:()=>[],snapshot:()=>[],notice:()=>notice,stop:async()=>{},idle:()=>Promise.resolve()};
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
  // Rule 0: never a card for a protected folder, or one the person excluded (excluded(cwd): main's agentBus.exclude
  // check, async). Cached per folder for a minute; until the person's list answers, the protected rule alone holds.
  const exclusionCache=new Map();
  // A folder check can stall for good (a macOS privacy prompt nobody answers): past the deadline it counts as excluded,
  // for that folder only, so one stuck folder never holds up every session's cards or quitting.
  const checkExcluded=cwd=>withDeadline(done=>{Promise.resolve().then(()=>excluded(cwd)).then(v=>done(!!v),()=>done(true));},excludeMs,true)
    .then(v=>{if(v===true&&!protectedFolder(cwd,home))log('automatic cards: a folder is excluded');return v;});
  function excludedNow(cwd){
    if(protectedFolder(cwd,home))return true;
    if(typeof excluded!=='function'||typeof cwd!=='string')return false;
    let hit=exclusionCache.get(cwd);
    if(!hit||now()-hit.at>=REPO_TTL_MS&&!hit.pending){
      if(!hit&&exclusionCache.size>=REPO_CACHE_MAX)exclusionCache.delete(exclusionCache.keys().next().value);
      hit={at:hit?.at??0,known:hit?.known??false,value:hit?.value??false,pending:true};exclusionCache.set(cwd,hit);
      const h=hit;checkExcluded(cwd).then(v=>{h.value=v;h.known=true;}).finally(()=>{h.pending=false;h.at=now();});
    }
    return hit.known?hit.value:null;
  }
  async function isExcluded(cwd){
    if(protectedFolder(cwd,home))return true;
    if(typeof excluded!=='function'||typeof cwd!=='string')return false;
    const hit=exclusionCache.get(cwd);
    if(hit?.known&&now()-hit.at<REPO_TTL_MS)return hit.value;
    // A check that fails is an exclusion: never a card for a folder Plexiform could not clear.
    const value=await checkExcluded(cwd);
    if(!exclusionCache.has(cwd)&&exclusionCache.size>=REPO_CACHE_MAX)exclusionCache.delete(exclusionCache.keys().next().value);
    exclusionCache.set(cwd,{at:now(),known:true,value,pending:false});
    return value;
  }
  const keyOf=(provider,session_id,task_id)=>crypto.createHash('sha256').update(JSON.stringify([provider,session_id,task_id])).digest('hex');
  // A withheld hand-off's pointer on the asker's team board: Plexiform's fixed words, no title, folder, repo or summary.
  const pointerKey=key=>crypto.createHash('sha256').update(JSON.stringify(['pointer',key])).digest('hex');
  const pointerTitle=provider=>`${AGENT_NAMES[provider]??'An AI'} \u00b7 hand-off running in another team's repo`;
  function addPointer(next,key,e,pointer){
    const pk=pointerKey(key);
    if(next.tasks[pk]||!pointer)return;
    next.tasks[pk]={destination:compactDestination(pointer),repo:null,provider:e.provider,session_id:`ptr-${pk.slice(0,32)}`,task_id:`${e.task_id}.pointer`.slice(0,120),
      title:pointerTitle(e.provider),status:null,card_id:null,pointer:true,why:'withheld',last_seen:now()};
  }
  // The remembered board for a repo: a team pin, an explicit "Keep on My board", or none.
  const choiceOf=repo=>!repo?null:Object.hasOwn(state.choices,repo)?state.choices[repo]:state.local_choices?.[repo]===true?{kind:'local'}:null;
  const pinCount=()=>Object.keys(state.choices).length+Object.keys(state.local_choices??{}).length;
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
    if(now()-lastCatalogAt>15000||!lastCatalogAt){catalog=await getRoutes();lastCatalogAt=now();if(catalog.complete===true)void reroutePending(catalog);}
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
      if(state.tasks[pointerKey(key)])current.add(pointerKey(key));
      if(entry?.untracked||entry?.agent)continue;
      if(o.personal&&entry?.destination.kind==='team'){
        if(commit(next=>{next.tasks[key].untracked=true;next.tasks[key].reason='personal_override';}))changed();
        log('automatic team updates stopped for personal work');continue;
      }
      // A folder excluded after its card was made: the card stops updating (the pointer too), like a personal mark.
      if(entry&&await isExcluded(o.cwd)){
        const pk=pointerKey(key);
        if(commit(next=>{for(const k of [key,pk])if(next.tasks[k]){next.tasks[k].untracked=true;next.tasks[k].reason='excluded';}}))changed();
        log('automatic updates stopped for an excluded folder');continue;
      }
      // Apply age on every activity request, including changed preferences and
      // retries. Source timestamps are reported change markers, never verified
      // agent liveness. A missing or invalid marker cannot renew activity.
      if(!fresh(raw))continue;
      // A session with nothing to show in the home folder (or none) would be titled after the user's
      // account: it waits for a prompt, a summary or an edit before it gets a card.
      if(!entry&&!untag(raw.taskTitle)&&placeless(o.cwd)&&!shows(recordFor(o,raw)))continue;
      if(!entry){if(Object.keys(state.tasks).length>=2000){log('automatic card limit reached');continue;}
        // Rule 0: an excluded or protected folder ($HOME included) never gets a card.
        if(await isExcluded(o.cwd))continue;
        // $HOME is never a team's repo, even when it is a dotfiles checkout: My board only.
        const repo=homeFolder(o.cwd,home)?null:safeCanonical(await resolveRepo(o.cwd));
        if(typeof o.cwd==='string')remember(o.cwd,repo);
        if(stopped||state.enabled===false)return;
        if(!fresh(raw))continue;
        // Hub offline: an automatic card waits rather than land on a board it may have to leave. The session keeps
        // reporting, so its one card is made on the right board as soon as the catalog arrives (an AI-added card,
        // made once, waits on My board instead: addAgentCard).
        if(!o.personal&&!catalog.complete){log('automatic card routing awaits a current team catalog');continue;}
        // One resolver for every path (routeBoard): a hand-off run carries its asker's board (originBoard, rule 2).
        const inherited=originOf(raw.originBoard);
        const route=routeBoard({personal:o.personal,inherited,repo,routes:catalog.complete===true?catalog.routes??[]:[],choice:choiceOf(repo),catalogComplete:catalog.complete===true});
        if(route.kind==='none')continue;
        const destination=compactDestination(route.destination);
        if(!commit(next=>{next.tasks[key]={destination,repo,provider:o.provider,session_id:o.session_id,task_id:o.task_id,title:o.title,status:null,card_id:null,last_seen:now(),why:route.why,
          ...(route.pending_route?{pending_route:true}:{}),...(inherited?{inherited}:{})};addPointer(next,key,next.tasks[key],route.pointer);},ACK_RESERVE_BYTES))continue;
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
      const pk=pointerKey(key),pointer=state.tasks[pk];
      if(entry.fingerprint!==fingerprint)await send(key,body,{fingerprint,title,raw});
      // The pointer follows the work's state only: working, needs you, done.
      if(pointer&&!pointer.untracked){
        const pbody={install_id:state.install_id,provider:pointer.provider,session_id:pointer.session_id,task_id:pointer.task_id,repo_id:pointer.destination.repo_id??null,title:pointer.title,status:o.status};
        const pfp=crypto.createHash('sha256').update(JSON.stringify([pbody,marker])).digest('hex');
        if(pointer.fingerprint!==pfp)await send(pk,pbody,{fingerprint:pfp,title:pointer.title,raw});
      }
    }
    for(const [key,entry]of Object.entries(state.tasks)) {
      if(stopped||state.enabled===false)return;
      // A card an AI added stays where the board put it until the person moves it: never swept.
      if(current.has(key)||entry.agent||entry.untracked||!entry.card_id||entry.status==='idle'||now()-entry.last_seen<30000)continue;
      const body={install_id:state.install_id,provider:entry.provider,session_id:entry.session_id,task_id:entry.task_id,repo_id:entry.destination.repo_id??null,title:entry.title,status:'idle'};
      if(!entry.pointer)records.setStatus(`${state.install_id}:${entry.provider}:${entry.session_id}`,'idle');
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
    if(state.enabled===false)return {kind:'off',why:'cards_off'};
    const o=observation(raw,{ownedRoots,host});if(!o)return unknown;
    const entry=state.tasks[keyOf(o.provider,o.session_id,o.task_id)];
    // Rule 0: an excluded folder gets no card at all; until the person's list has answered, say nothing yet.
    const ex=excludedNow(o.cwd);
    if(ex===true)return {kind:'untracked',why:'excluded'};
    // A personal session that already had a team card stops updating it; one without keeps its card on My board.
    if(entry?.untracked||o.personal&&entry?.destination.kind==='team')return {kind:'untracked',why:'personal_mark'};
    if(o.personal)return {kind:'personal',why:'personal_mark'};
    if(ex===null&&!entry)return unknown;
    let d=entry?.destination,why=entry?.why??null;
    // A card kept on My board while the repo had no default board stays there once one is picked.
    if(d&&d.kind==='local'&&d.needs_routing&&!d.reason&&entry.repo&&choiceOf(entry.repo))return {kind:'personal',why:'repo_default'};
    if(!d||d.kind==='team'){
      if(!d){
        if(typeof o.cwd!=='string'||!path.isAbsolute(o.cwd))return unknown;
        const r=homeFolder(o.cwd,home)?{repo:null}:repoOf(o.cwd);if(!r)return unknown;
        // Not fetched yet: unknown (ask again soon). Fetched but incomplete (hub offline), rule 7: My board for now.
        if(!lastCatalogAt)return unknown;
        const route=routeBoard({repo:r.repo,routes:catalog.routes??[],choice:choiceOf(r.repo),catalogComplete:catalog.complete===true});
        if(route.kind==='none')return {kind:'untracked',why:route.why};
        d=route.destination;why=route.why;
        if(route.pending_route)return {kind:'personal',why,pending_route:true};
      } else if(!lastCatalogAt||!catalog.complete)return unknown;
    }
    if(d.kind==='team'){const route=(catalog.routes??[]).find(x=>routeKey(x)===routeKey(d));return {kind:'team',name:typeof route?.board_name==='string'?route.board_name.slice(0,200):'',why:why??'linked_repo',key:routeKey(d)};}
    if(entry?.pending_route)return {kind:'personal',why:'deferred',pending_route:true};
    if(why==='withheld'||why==='inherited'&&d.kind==='local')return {kind:'personal',why};
    return {kind:d.reason==='team_read_only'?'readonly':d.needs_routing?'choose':'personal',why:why??(d.reason==='team_read_only'?'read_only':d.needs_routing?'choose':'no_link')};
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
  // bus_card_add's board answer: kind and name as before, the rule that decided (why), and pending_route (rule 7).
  const agentBoard=(destination,why,pending)=>({...(destination.kind==='local'&&destination.needs_routing&&!destination.reason?{kind:'choose'}:boardOfDestination(destination)),
    ...(why?{why}:{}),...(pending?{pending_route:true}:{})});
  async function addAgentCard(raw,a={}){
    if(stopped)return refuse('UNAVAILABLE');
    if(state.enabled===false)return refuse('CARDS_OFF');
    const o=observation(raw,{ownedRoots,host});
    if(!o||typeof o.cwd!=='string'||!path.isAbsolute(o.cwd))return refuse('UNAVAILABLE');
    if(typeof a.request_id!=='string'||!AGENT_REQUEST.test(a.request_id))return {reason:'VALIDATION',message:'request_id: 8 to 100 letters, digits, _ or -.'};
    const task_id=`agent-${crypto.createHash('sha256').update(`${state.install_id}|${o.provider}|${o.session_id}|${a.request_id}`).digest('hex').slice(0,24)}`;
    const key=crypto.createHash('sha256').update(JSON.stringify([o.provider,o.session_id,task_id])).digest('hex');
    const prior=state.tasks[key];
    if(prior?.agent&&prior.card_id)return {card_id:prior.card_id,title:prior.title,board:agentBoard(prior.destination,prior.why??null,prior.pending_route===true),duplicate:true};
    const title=agentTitle(a.title,o.provider);
    if(!title)return {reason:'VALIDATION',message:'title: nothing is left once it is cleaned.'};
    if(o.personal)return refuse('PERSONAL');
    const own=state.tasks[crypto.createHash('sha256').update(JSON.stringify([o.provider,o.session_id,o.task_id])).digest('hex')];
    if(own?.untracked)return refuse('PERSONAL');
    let fresh=null;
    try{fresh=await getRoutes();}catch{fresh=null;}
    if(stopped)return refuse('UNAVAILABLE');
    // Rule 7 (G8): an incomplete catalog (hub offline) no longer refuses: the card waits on My board, pending_route.
    const complete=!!fresh&&fresh.complete===true;
    if(complete){catalog=fresh;lastCatalogAt=now();}
    const repo=safeCanonical(await resolveRepo(o.cwd));
    remember(o.cwd,repo);
    if(await isExcluded(o.cwd))return {reason:'EXCLUDED',message:'Plexiform does not add cards for this folder.'};
    if(stopped)return refuse('UNAVAILABLE');
    if(state.enabled===false)return refuse('CARDS_OFF');
    // A retry of a request whose answer was lost (the hub may already hold that card) resends exactly what was sent
    // first, to the same board, so it can never rewrite the card; that board must still be one this person can write to.
    let destination,cardTitle=title,summary,why,pending=false;
    if(prior?.agent){
      if(prior.destination.kind==='team'&&(!complete||!(fresh.routes??[]).some(x=>routeKey(x)===routeKey(prior.destination)&&WRITABLE.includes(x.role))))return refuse('UNAVAILABLE');
      destination=prior.destination;cardTitle=prior.title;summary=typeof prior.summary==='string'?prior.summary:null;why=prior.why??null;pending=prior.pending_route===true;
    } else {
      // Rule 2: a hand-off carries the originator's board (a route key main took from boardFor); else rules 3 to 7.
      const inherited=originOf(a.origin_board);
      const route=routeBoard({inherited,repo,routes:complete?fresh.routes??[]:[],choice:choiceOf(repo),catalogComplete:complete});
      if(route.why==='read_only')return refuse('READ_ONLY');
      if(Object.keys(state.tasks).length>=2000)return refuse('UNAVAILABLE');
      // Rule 4 with no default: My board with the "pick board" chip (needs_routing), never a refusal.
      destination=compactDestination(route.destination);why=route.why;pending=route.pending_route===true;
      summary=agentSummary({provider:o.provider,handle:a.handle,folder:a.folder,afterNote:a.after_note===true,details:a.details});
      // Scrubbed for a team board before it is saved, so what is stored is what is sent, and a retry sends it byte for byte.
      if(destination.kind==='team')({title:cardTitle,summary}=teamBody(destination,{title:cardTitle,summary}));
      if(!commit(next=>{next.tasks[key]={destination,repo,provider:o.provider,session_id:o.session_id,task_id,title:cardTitle,summary,status:null,card_id:null,agent:true,last_seen:now(),why,...(pending?{pending_route:true}:{}),...(inherited?{inherited}:{})};},ACK_RESERVE_BYTES))return refuse('UNAVAILABLE');
      changed();
    }
    // The board's to-do state, never "Needs you": 'idle' is a status no hub moves to its own column, and the sweep and
    // backfill never touch an agent entry, so the card stays put until the person moves or closes it.
    const body={install_id:state.install_id,provider:o.provider,session_id:o.session_id,task_id,repo_id:destination.repo_id??null,title:cardTitle,status:'idle',...(summary!==null?{summary}:{})};
    let result;
    try{result=destination.kind==='team'?await sendTeam(destination,teamBody(destination,body)):await sendLocal(body);}catch{result=null;}
    const id=typeof result?.card?.id==='string'&&ID.test(result.card.id)?result.card.id:null;
    if(!result?.ok||!id){log('agent card deferred');return refuse('UNAVAILABLE');}
    if(commit(next=>{const e=next.tasks[key];if(e){e.card_id=id;e.status='idle';e.sent_at=now();}}))changed();
    log('agent card added');
    if(complete)void reroutePending(fresh);
    return {card_id:id,title:cardTitle,board:agentBoard(destination,why,pending)};
  }
  // Rule 7's second half: AI-added cards written to My board while the hub was offline go to the board the catalog now
  // gives. A team board gets the card (team-scrubbed); the My board copy is closed with one line saying it moved.
  // A send that fails leaves it pending for the next catalog. One pass at a time.
  let rerouting=null;
  function reroutePending(fresh){
    if(rerouting||!fresh||fresh.complete!==true)return rerouting;
    rerouting=(async()=>{
      for(const [key,e] of Object.entries(state.tasks)){
        if(stopped||state.enabled===false)return;
        if(!e.agent||!e.pending_route||!e.card_id)continue;
        // The asker's board it was carrying (rule 2) still decides, now that it can be checked.
        const route=routeBoard({inherited:e.inherited??null,repo:e.repo,routes:fresh.routes??[],choice:choiceOf(e.repo),catalogComplete:true});
        if(route.kind!=='team'){
          if(commit(next=>{const x=next.tasks[key];if(x){delete x.pending_route;x.why=route.why;if(route.destination)x.destination=compactDestination(route.destination);}}))changed();
          continue;
        }
        const destination=compactDestination(route.destination);
        const scrubbed=teamBody(destination,{title:e.title,summary:typeof e.summary==='string'?e.summary:null});
        const body={install_id:state.install_id,provider:e.provider,session_id:e.session_id,task_id:e.task_id,repo_id:destination.repo_id??null,title:scrubbed.title,status:'idle',...(scrubbed.summary!=null?{summary:scrubbed.summary}:{})};
        let result;
        try{result=await sendTeam(destination,teamBody(destination,body));}catch{result=null;}
        const id=typeof result?.card?.id==='string'&&ID.test(result.card.id)?result.card.id:null;
        if(!result?.ok||!id){log('agent card re-route deferred');continue;}
        try{await sendLocal({install_id:state.install_id,provider:e.provider,session_id:e.session_id,task_id:e.task_id,repo_id:null,title:e.title,status:'ended',summary:'Moved to the team board once Plexiform could reach it.'});}catch{/* the team card is what counts */}
        if(commit(next=>{const x=next.tasks[key];if(x){x.destination=destination;x.card_id=id;x.title=scrubbed.title;x.summary=scrubbed.summary??null;x.why=route.why;delete x.pending_route;}}))changed();
        log('agent card re-routed');
      }
    })().catch(()=>{}).finally(()=>{rerouting=null;});
    return rerouting;
  }
  async function drain() {while(latest&&!stopped){const next=latest;latest=null;await pass(next);}}
  function kick(){if(stopped||state.enabled===false)return;
    if(!active){active=drain().catch(()=>log('automatic cards unavailable')).finally(()=>{active=null;if(latest&&!stopped)kick();});}return active;}
  return {forgetExclusions(){exclusionCache.clear();},
    observe(sessions,{wrapped=[]}={}){if(stopped||state.enabled===false)return;
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
        // A withheld hand-off's pointer must never carry the work's record to the asker's team.
        if(e.untracked||e.agent||e.pointer||e.destination.kind!=='team')continue;
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
    costRows(){return Object.values(state.tasks).filter(e=>!e.agent&&!e.pointer&&!BACKGROUND_TITLE.test(String(e.title??'').trim())).map(e=>({provider:e.provider,session_id:e.session_id,task_id:e.task_id,card_id:e.card_id,title:e.title,repo:e.repo,pr:e.pr??null,last_seen:e.last_seen??e.sent_at??null}));},
    enabled:()=>state.enabled!==false,
    notice:()=>notice,
    setEnabled(on){if(!commit(next=>{next.enabled=!!on;}))return false;if(!on)latest=null;changed();return true;},
    // key: a route key from routing()/choices(), or 'local' for "Keep on My board". Either replaces the other.
    async choose(repo,key){
      if(stopped||!safeCanonical(repo)||typeof key!=='string'||key!=='local'&&!HASH.test(key))return false;
      if(!choiceOf(repo)&&pinCount()>=2000)return false;
      if(key==='local'){
        if(!commit(next=>{delete next.choices[repo];next.local_choices={...(next.local_choices??{}),[repo]:true};}))return false;
        changed();return true;
      }
      const fresh=await getRoutes();if(!fresh.complete||stopped)return false;
      const destination=(fresh.routes??[]).find(r=>r.canonical_url===repo&&routeKey(r)===key&&['owner','admin','member'].includes(r.role));
      if(!destination)return false;
      const pin=compactDestination({kind:'team',hub:destination.hub,user_id:destination.user_id,team_id:destination.team_id,board_id:destination.board_id,repo_id:destination.repo_id});delete pin.kind;
      if(!commit(next=>{next.choices[repo]=pin;if(next.local_choices){delete next.local_choices[repo];if(!Object.keys(next.local_choices).length)delete next.local_choices;}}))return false;
      catalog=fresh;lastCatalogAt=now();changed();return true;
    },
    // After an admin links the repo to a team board, "Keep on My board" would still win over the new route: drop it,
    // and the cached catalog with it, so the next routing() and observe() see the linked board (#62 review B1).
    async clearLocal(repo){
      if(stopped||!safeCanonical(repo))return false;
      if(state.local_choices?.[repo]===true&&!commit(next=>{delete next.local_choices[repo];if(!Object.keys(next.local_choices).length)delete next.local_choices;}))return false;
      lastCatalogAt=0;changed();return true;
    },
    // Where each project's new work goes (PR 7), for the Sessions strip and the This Mac table: names and opaque
    // route keys only. repos: canonical names (the caller's live sessions); default, every repo this Mac remembers.
    // state: set (a remembered pick), single (one team board, used without asking), ask (several, none picked yet),
    // unlinked (no team board), read_only (the only board is read-only). An incomplete catalog gives no rows.
    async routing(repos=null){
      if(stopped)return [];
      if(now()-lastCatalogAt>15000||!lastCatalogAt){try{catalog=await getRoutes();lastCatalogAt=now();}catch{return [];}}
      if(!catalog.complete)return [];
      // The default list (the This Mac table) is only projects with a team board or a pin, filtered before the cut so
      // a run of unlinked task repos can't push a linked one out (#62 review S1).
      const known=repos??[...Object.values(state.tasks).map(e=>e.repo),...Object.keys(state.choices),...Object.keys(state.local_choices??{})];
      const linked=r=>!!choiceOf(r)||(catalog.routes??[]).some(x=>x.canonical_url===r);
      const list=[...new Set((Array.isArray(known)?known:[]).filter(r=>safeCanonical(r)&&(repos||linked(r))))].slice(0,50);
      const named=r=>({key:routeKey(r),team:clean(r.team_name??'Team',60),board:clean(r.board_name??'Board',60)});
      return list.map(repo=>{
        const matches=(catalog.routes??[]).filter(r=>r.canonical_url===repo);
        const choice=choiceOf(repo);
        const d=routeFor(repo,catalog.routes??[],choice);
        const state=choice&&(choice.kind==='local'||d.kind==='team')?'set':!matches.length?'unlinked':d.reason==='team_read_only'?'read_only':d.kind==='team'?'single':'ask';
        const route=d.kind==='team'?matches.find(r=>routeKey(r)===routeKey(d)):null;
        return {repo,short:repo.split('/').pop().slice(0,80),state,destination:route?{kind:'team',...named(route)}:{kind:'local'},
          matches:matches.map(r=>({...named(r),read_only:!['owner','admin','member'].includes(r.role)}))};
      });
    },
    choices(){return !catalog.complete?[]:(catalog.routes??[]).filter(r=>safeCanonical(r.canonical_url)&&['owner','admin','member'].includes(r.role)).map(r=>({key:routeKey(r),repo:r.canonical_url,team_name:clean(r.team_name??'Team',60),board_name:clean(r.board_name??'Board',60)}));},
    // Main-only identity join for Overview; never forwarded to a renderer.
    overviewSnapshot(){return Object.values(state.tasks).filter(e=>!e.agent&&!e.pointer).map(e=>({provider:e.provider,session_id:e.run_id??e.session_id,task_id:e.task_id,card_id:e.card_id,untracked:!!e.untracked,destination:{...e.destination},why:e.why??null}));},
    // Main-only: the listed sessions a local handover is kept for (src/session-handover-main.js).
    handoverRows(){return Object.values(state.tasks).filter(e=>!e.agent&&!e.pointer&&!BACKGROUND_TITLE.test(String(e.title??'').trim())).map(e=>({provider:e.provider,session_id:e.run_id??e.session_id,title:e.title,last_seen:e.last_seen??null}));},
    // The This Mac list: background entries saved before capture filtered them are hidden,
    // and repeats of one piece of work collapse to a single row with a count.
    snapshot(){
      const rows=new Map();
      for(const [key,e]of Object.entries(state.tasks)){
        if(BACKGROUND_TITLE.test(String(e.title??'').trim()))continue;
        // why: the routing rule that put it there (BOARD_WHY), so the UI can say "On <board> because this repo is linked".
        const row={key,repo:e.repo,provider:e.provider,title:e.title,status:e.status,card_id:e.card_id,untracked:!!e.untracked,reason:e.reason??null,destination:{...e.destination},count:1,
          why:e.why??null,...(e.pending_route?{pending_route:true}:{}),...(e.agent?{agent:true}:{}),...(e.pointer?{pointer:true}:{})};
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
module.exports={createWorkCapture,agentTitle,agentSummary,AGENT_TITLE_MAX,observation,isBackgroundSession,BACKGROUND_TITLE,routeFor,routeBoard,resolveBoard,protectedFolder,repoFor,clean,hubTitle,phase,routeKey,prBody};
