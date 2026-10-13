// A bounded structured picture from existing board records, capture reports and
// enrolled-run ownership. No private conversation, machine path or log reader.
import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import tools from '../shared/collaboration-tools.cjs';
import {HubError} from './db.js';
import {TeamCommunication} from './communication.js';
import {Api} from './api.js';
import {AI_LABELS} from '../shared/ai.js';
import {cleanPacketText} from '../shared/packet-text.js';
import {runnerConnectionProblem} from './runner-authority.js';
import {TTL_MS} from '../shared/liveness.js';
import {workCaptureView} from './work-capture-view.js';

export const WORK_CONTEXT_BYTES=20*1024;
const cursorKeys=new WeakMap(),deliveries=new WeakMap();
const missing=()=>new HubError('NOT_FOUND','Work context is unavailable to this connection.');
const changed=()=>new HubError('CONFLICT','Work context changed. Start again without a cursor.');
// Redact the complete bounded source before shortening a summary; a token
// crossing the summary boundary must not escape redaction.
const text=(s,n=200)=>cleanPacketText(String(s??''),64*1024).slice(0,n);
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const bytes=v=>Buffer.byteLength(JSON.stringify(v),'utf8');
function mac(hub,value){if(!cursorKeys.has(hub))cursorKeys.set(hub,randomBytes(32));return createHmac('sha256',cursorKeys.get(hub)).update(value).digest('hex');}
const binding=(hub,member,boardIds,args,tag)=>mac(hub,canonical({member:member.id,user:member.user_id,team:member.org_id,boards:[...boardIds].sort(),board:args.board_id,repo:args.repo_id??null,epoch:hub.epoch,tag}));
function cursorAfter(hub,value,scope){
  if(value==null)return '';
  if(typeof value!=='string'||value.length>1200||!/^[-_A-Za-z0-9]+\.[0-9a-f]{64}$/.test(value))throw changed();
  const [raw,sig]=value.split('.');if(!timingSafeEqual(Buffer.from(mac(hub,raw)),Buffer.from(sig)))throw changed();
  let decoded;try{const data=Buffer.from(raw,'base64url');if(data.toString('base64url')!==raw)throw changed();decoded=JSON.parse(data.toString('utf8'));}catch{throw changed();}
  if(!decoded||Object.keys(decoded).sort().join(',')!=='after,binding,expires,version'||decoded.version!==1||decoded.binding!==scope
    ||!Number.isSafeInteger(decoded.expires)||decoded.expires<=hub.wallMs()||typeof decoded.after!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(decoded.after))throw changed();
  return decoded.after;
}
function cursor(hub,after,scope){const raw=Buffer.from(JSON.stringify({version:1,after,binding:scope,expires:hub.wallMs()+600000})).toString('base64url');return `${raw}.${mac(hub,raw)}`;}
function boardScope(hub,member,boardIds,args){
  try{tools.validate('plexiform_get_work_context',args);}catch{throw new HubError('VALIDATION','Choose a board, optional repository, limit 1–20 and a current cursor.');}
  if(!Array.isArray(boardIds)||!boardIds.length||boardIds.length>32||boardIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(id))||!boardIds.includes(args.board_id))throw missing();
  if(boardIds.some(id=>{const b=hub.board(id);return !b||b.org_id!==member.org_id||b.archived_at;}))throw missing();
  const board=hub.board(args.board_id);if(!board||board.org_id!==member.org_id||board.archived_at)throw missing();
  if(args.repo_id&&!hub.db.get('SELECT 1 x FROM board_repos br JOIN repos r ON r.id=br.repo_id WHERE br.board_id=? AND br.repo_id=? AND r.org_id=?',board.id,args.repo_id,member.org_id))throw missing();
  return board;
}
function person(hub,id){const m=hub.activeMember(id);if(!m||!['owner','admin','member','viewer'].includes(m.role)||m.user_id&&!hub.accounts?.liveUser(m.user_id))return null;return {member_id:m.id,name:text(m.display_name),identity_source:'team_member'};}
function task(hub,communication,member,boardIds,row){
  const scope={member,row,boardIds},repo=row.repo_id&&hub.repo(row.repo_id);
  let peer=null;try{if(row.active_run_id)peer=communication.recipient(scope,row.active_run_id);}catch{/* Former or revoked run is unavailable. */}
  const run=peer?.run,connection=run&&hub.runners.get(run.device_id),lease=run&&hub.lease(run.id);
  const observed=!!connection&&!runnerConnectionProblem(hub,connection)&&connection.member_id===peer.member.id&&connection.repos.has(row.repo_id)
    &&lease?.hb_connection_generation===connection.generation&&lease.hb_mono!=null;
  const captureRow=hub.db.get(`SELECT w.id,w.member_id FROM work_capture_cards w JOIN members m ON m.id=w.member_id LEFT JOIN users u ON u.id=w.user_id
    WHERE w.card_id=? AND w.board_id=? AND w.repo_id IS ? AND w.tracking='active' AND m.org_id=? AND m.user_id IS w.user_id AND m.removed_at IS NULL AND (w.user_id IS NULL OR u.deleted_at IS NULL)`,row.id,row.board_id,row.repo_id,member.org_id);
  const capture=captureRow&&workCaptureView(hub,row.id);
  const participants=hub.db.all(`SELECT m.id FROM card_assignees a JOIN members m ON m.id=a.member_id WHERE a.card_id=? AND m.org_id=? AND m.removed_at IS NULL
    AND (m.user_id IS NULL OR EXISTS(SELECT 1 x FROM users u WHERE u.id=m.user_id AND u.deleted_at IS NULL)) ORDER BY m.id LIMIT 9`,row.id,member.org_id).map(m=>person(hub,m.id)).filter(Boolean);
  const own=hub.ownership.snapshotFor({...scope,run:run??null},{boardIds});
  const declaration=own.ownership?{source:'runner_reported_declaration',run_id:own.ownership.run_id,state:own.ownership.state,reason:own.ownership.reason,
    paths:own.ownership.paths.slice(0,4),paths_truncated:own.ownership.paths_truncated||own.ownership.paths.length>4,
    expires_in_ms:own.ownership.state==='editing'?Math.max(0,(hub.ownership.live.get(run?.id)?.deadline??hub.mono())-hub.mono()):null,advisory:true}:null;
  const overlaps=own.ownership_overlaps.slice(0,2).flatMap(o=>{try{const peer=communication.recipient(scope,o.run_id),c=peer.row;if(c.id!==o.card_id)return [];return [{card_id:c.id,board_id:c.board_id,key:text(c.key,100),run_id:o.run_id,state:o.state,paths:o.paths.slice(0,2),paths_truncated:o.paths_truncated||o.paths.length>2,advisory:true}];}catch{return [];}});
  const dependencyRows=hub.db.all(`SELECT c.* FROM card_dependencies d JOIN cards c ON c.id=d.depends_on_card_id JOIN boards b ON b.id=c.board_id
    WHERE d.card_id=? AND c.column_name<>? AND c.archived_at IS NULL AND b.archived_at IS NULL AND b.org_id=?
    AND c.board_id IN (${boardIds.map(()=>'?').join(',')})
    AND (c.repo_id IS NULL OR EXISTS(SELECT 1 FROM board_repos br JOIN repos r ON r.id=br.repo_id WHERE br.board_id=c.board_id AND br.repo_id=c.repo_id AND r.org_id=?)) ORDER BY c.id LIMIT 6`,row.id,'done',member.org_id,...boardIds,member.org_id);
  const blockers=dependencyRows.slice(0,5).flatMap(c=>{try{communication.card(c.id,member);return boardIds.includes(c.board_id)?[{kind:'dependency',card_id:c.id,board_id:c.board_id,key:text(c.key,100)}]:[];}catch{return [];}});
  let blockersTruncated=dependencyRows.length>5;
  if(run){for(const [kind,table]of[['permission','permission_requests'],['question','asks']]){
    const refs=hub.db.all(`SELECT id FROM ${table} WHERE card_id=? AND run_id=? AND state='open' ORDER BY id LIMIT 4`,row.id,run.id);
    if(refs.length>3)blockersTruncated=true;
    for(const ref of refs.slice(0,3)){if(blockers.length<7)blockers.push({kind,id:ref.id,card_id:row.id});else blockersTruncated=true;}
  }}
  let nextAction=null;try{const packet=communication.readPacket(scope,{}).packet;if(packet)nextAction={source:'participant_reported',kind:'task_packet',card_id:row.id,packet_id:packet.id,version:packet.version,available:!!packet.data.nextAction};}catch{/* Invalid/former packet cannot supply a reference. */}
  return {card:{id:row.id,board_id:row.board_id,key:text(row.key,100),title:text(row.title),version:row.version,fence:row.fence,column:row.column_name,
      run_state:row.run_state??'todo',blocked_kind:row.blocked_kind??null,start_date:row.start_date??null,due_date:row.due_date??null,source:'hub_record'},
    repository:repo?{id:repo.id,name:text(repo.short_name)}:null,participants:participants.slice(0,8),participants_truncated:participants.length>8,
    run:run?{id:run.id,participant:person(hub,peer.member.id),provider:peer.provider,provider_label:AI_LABELS[peer.provider]??'Agent',identity_source:'hub_run',
      observation_source:observed?'host_heartbeat':'unavailable',last_seen_age_ms:observed?Math.max(0,Math.round(hub.mono()-lease.hb_mono)):null,
      fresh:observed&&hub.mono()-lease.hb_mono<TTL_MS}:null,
    reported_activity:capture?{source:'participant_local_observation',participant:person(hub,captureRow.member_id),provider:capture.provider,provider_label:AI_LABELS[capture.provider]??text(capture.provider),status:capture.status,reported_status:capture.reported_status,fresh:capture.fresh,last_seen_age_ms:capture.age_ms,verified_run_identity:false}:null,
    ownership:declaration,overlaps,overlaps_truncated:own.ownership_truncated||own.ownership_overlaps.length>2,blockers,blockers_truncated:blockersTruncated,next_action:nextAction};
}
// Called only after an ordinary captured credential or fresh private remote
// authority has been checked by the importing adapter. It never trusts JSON as
// an identity, grant, run or credential.
export function projectWorkContext(hub,member,boardIds,args,{authorityTag='staff'}={}){
  const communication=new TeamCommunication(hub);member=communication.staff(member,null,false);const board=boardScope(hub,member,boardIds,args);
  const scope=binding(hub,member,boardIds,args,authorityTag),after=cursorAfter(hub,args.cursor,scope),limit=args.limit??10;
  const rows=hub.db.all(`SELECT c.* FROM cards c WHERE c.board_id=? AND c.archived_at IS NULL AND c.id>?
    AND (c.repo_id IS NULL OR EXISTS(SELECT 1 x FROM board_repos br JOIN repos r ON r.id=br.repo_id WHERE br.board_id=c.board_id AND br.repo_id=c.repo_id AND r.org_id=?))
    ${args.repo_id?'AND c.repo_id=?':''} ORDER BY c.id LIMIT ?`,board.id,after,member.org_id,...(args.repo_id?[args.repo_id]:[]),limit+1);
  const result={schema:1,source:'current_hub_records',board:{id:board.id,name:text(board.name),key_prefix:text(board.key_prefix,100)},repository_filter:args.repo_id??null,
    tasks:[],status:'complete',next_cursor:null,advisory:true,grants_execution:false,limitations:['Each page is a current observation, not a consistent historical snapshot.','Declarations and local activity reports do not prove execution or completion.','Messages, approval and starting work are separate actions.']};
  let last=after;
  for(const row of rows.slice(0,limit)){
    communication.card(row.id,member);const item=task(hub,communication,member,boardIds,row);
    const candidate={...result,tasks:[...result.tasks,item],status:'partial',next_cursor:cursor(hub,row.id,scope)};
    if(bytes(candidate)>WORK_CONTEXT_BYTES){if(!result.tasks.length)throw new HubError('PAYLOAD_TOO_LARGE','Work context is too large. Open this task in Plexiform.');break;}
    result.tasks.push(item);last=row.id;
  }
  if(rows.length>result.tasks.length){result.status='partial';result.next_cursor=cursor(hub,last,scope);}
  if(bytes(result)>WORK_CONTEXT_BYTES)throw new HubError('PAYLOAD_TOO_LARGE','Work context is too large. Reduce the page limit.');return result;
}
export async function readWorkContext(hub,member,cred,boardIds,args){
  const actor=Object.freeze({id:member.id,user_id:member.user_id,org_id:member.org_id}),credential=cred?Object.freeze({kind:cred.kind,id:cred.id}):null,
    selection=Object.freeze([...boardIds]),choice=Object.freeze({...args}),api=new Api(hub);
  boardScope(hub,api.currentMember(actor,credential),selection,choice);
  const out=await hub.withBoard(choice.board_id,()=>projectWorkContext(hub,api.currentMember(actor,credential),selection,choice));
  deliveries.set(out,{hub,actor,credential,selection,choice});return out;
}
export function guardWorkContext(hub,out){const proof=deliveries.get(out);if(!proof||proof.hub!==hub)throw missing();deliveries.delete(out);
  const member=new Api(hub).currentMember(proof.actor,proof.credential),current=projectWorkContext(hub,member,proof.selection,proof.choice);
  for(const key of Object.keys(out))delete out[key];Object.assign(out,current);}
export function workContextArgs(boardId,query){
  const args={board_id:boardId},seen=new Set();
  for(const [key,value]of query){if(key==='board_id')continue;if(!['repo_id','limit','cursor'].includes(key)||seen.has(key))throw new HubError('VALIDATION','Invalid work context query.');seen.add(key);args[key]=key==='limit'&&/^[1-9]\d?$/.test(value)?Number(value):value;}
  return args;
}
