'use strict';
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { scan } = require('./borrow/scan.js');
const { scrubFile } = require('./borrow/scrub.js');
const { SOURCES } = require('./borrow/registry.js');
const schema = require('./borrow/payload.js');
const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const clean = value => typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,200):'';
const unavailable = () => ({ok:false,status:'unavailable',error:'This setup or account is no longer available. Refresh to review current team access.'});
// The renderer gets no origin, credential, filesystem path or general request
// capability. Every handle binds a registered team and captured sealed identity.
function createSetupsService({ sources, home, machine=()=>({home}), fsApi=fs, scanImpl=scan, now=Date.now, confirm=async()=>false, chooseExport=async()=>null }) {
  let generation=0, handles=new Map(), drafts=new Map();
  const current = source => {try{return source?.current?.()===true;}catch{return false;}};
  const valid = (entry,token) => token===generation && entry && entry.expires>now() && current(entry.source);
  const entryFor = handle => typeof handle==='string' && handle.length<=100?handles.get(handle):null;
  const checkedPrincipal = (source,data) => data?.ok===true && data.principal?.user_id===source.userId && data.principal?.member_id===source.memberId && data.principal?.team_id===source.teamId;
  async function call(entry,op,args={}) {
    const token=generation; if(!valid(entry,token)) return null;
    let result; try {result=await entry.source.call(op,args);}catch{return null;}
    if(!valid(entry,token))return null;
    if(result?.ok===false) {
      const messages={QUOTA_EXCEEDED:['limit','This setup or team reached its sharing limit. Remove retained shared versions or ask a team owner to review storage.'],FORBIDDEN:['permission','Your current team role does not permit this action. Refresh team access.'],POLICY_DENIED:['unavailable','This sealed setup is unavailable on the hub.'],CONFLICT:['changed','The setup changed. Refresh and review the current version.'],VERSION_CONFLICT:['changed','The setup changed. Refresh and review the current version.'],VALIDATION:['invalid','Choose valid reviewed entries within the sharing limits.']};
      const message=messages[result.code];return message?{ok:false,status:message[0],error:message[1]}:unavailable();
    }
    return checkedPrincipal(entry.source,result)?result:null;
  }
  const put = (source,profile=null,version=null) => { if(handles.size>=1000)handles.delete(handles.keys().next().value);const handle=randomUUID(); handles.set(handle,{source,profile,version,expires:now()+10*60_000}); return handle; };
  const view = draft => ({ok:true,handle:draft.handle,payload:JSON.parse(schema.canonical(draft.payload)),content_hash:draft.checked?.content_hash??null,file_hashes:draft.checked?.file_hashes??[],approved_files:[...draft.approved],error:draft.error??null,expires_at:draft.expires,scan_summary:draft.scanSummary});
  return {
    invalidate() { generation++; handles.clear(); drafts.clear(); },
    async snapshot() {
      const token=++generation; handles.clear(); drafts.clear();
      let registered; try {registered=await sources();}catch{return {status:'unavailable',teams:[],sources:schema.sources()};}
      if(token!==generation || !Array.isArray(registered)) return {status:'changed',teams:[],sources:schema.sources()};
      const teams=[]; let count=0,partial=registered.length>32 || registered.partial===true;
      for(const source of registered.slice(0,32)) {
        if(!source || typeof source.call!=='function' || ![source.userId,source.teamId,source.memberId].every(id=>typeof id==='string'&&ID.test(id)) || !['owner','admin','member','viewer'].includes(source.role) || !current(source)) {partial=true;continue;}
        const entry={source,expires:now()+10*60_000};
        const data=await call(entry,'list');
        if(token!==generation || !current(source)) return {status:'changed',teams:[],sources:schema.sources()};
        if(!data || !Array.isArray(data.profiles) || data.profiles.length>500 || !['complete','partial','unavailable'].includes(data.status)) {teams.push({name:clean(source.name),status:'unavailable',profiles:[]});partial=true;continue;}
        const profiles=[];
        for(const profile of data.profiles) {
          const v=profile?.current_version;
          if(count>=500) {partial=true;break;}
          if(typeof profile?.id!=='string' || !schema.UUID.test(profile.id) || typeof v?.id!=='string' || !schema.UUID.test(v.id) || typeof v.content_hash!=='string' || !schema.SHA.test(v.content_hash) || !Number.isSafeInteger(v.number)||v.number<1 || !Array.isArray(v.sources)||v.sources.some(id=>!SOURCES.some(s=>s.id===id)) || !Number.isSafeInteger(v.file_count)||v.file_count<0||v.file_count>schema.SETUP_LIMITS.files||!Number.isSafeInteger(v.item_count)||v.item_count<0||v.item_count>schema.SETUP_LIMITS.items) {partial=true;continue;}
          profiles.push({handle:put(source,profile.id,v.id),own:profile.owner_user_id===source.userId,version:v.number,files:v.file_count,items:v.item_count,sources:v.sources,created_at:clean(v.created_at)});count++;
        }
        teams.push({handle:put(source),name:clean(source.name),role:data.principal.role??source.role,status:data.status,profiles,baseline:data.baseline?{required:data.baseline.required===true,meaning:'reminder_only'}:null});
        partial ||= data.status!=='complete';
      }
      if(token!==generation || registered.slice(0,32).some(source=>!current(source))) return {status:'changed',teams:[],sources:schema.sources()};
      return {status:partial?'partial':'complete',teams,sources:schema.sources()};
    },
    async read(handle) {
      const entry=entryFor(handle); if(!entry?.profile) return unavailable();
      const data=await call(entry,'read',{profile:entry.profile,version:entry.version});
      if(!data?.ok)return data??unavailable();
      try {
        const checked=schema.validatePayload(data?.payload);
        if(data.profile.id!==entry.profile || data.version.id!==entry.version || checked.content_hash!==data.version.content_hash) return unavailable();
        const versions=(data.versions??[]).slice(0,50).filter(v=>schema.UUID.test(v.id??'')&&Number.isSafeInteger(v.number)&&v.number>0).map(v=>({handle:put(entry.source,entry.profile,v.id),number:v.number}));
        return {ok:true,handle,payload:checked.payload,version:data.version.number,versions,own:data.profile.owner_user_id===entry.source.userId};
      }catch{return unavailable();}
    },
    async draft(handle,request) {
      const entry=entryFor(handle),token=generation;
      if(!valid(entry,token) || entry.profile || entry.source.role==='viewer' || !request || Object.keys(request).some(k=>!['sources','inventory','ssh'].includes(k)) || !Array.isArray(request.sources) || !request.sources.length || request.sources.length>SOURCES.length || new Set(request.sources).size!==request.sources.length || request.sources.some(id=>!SOURCES.some(s=>s.id===id)) || typeof request.inventory!=='boolean' || typeof request.ssh!=='boolean' || (request.sources.includes('ssh-config')&&!request.ssh)) return unavailable();
      const fresh=await call(entry,'list'); if(!fresh?.ok)return fresh??unavailable();if(!valid(entry,token) || fresh.status==='unavailable' || !['owner','admin','member'].includes(fresh.principal.role??entry.source.role)) return unavailable();
      // Listing commands remain off in this slice. Saved inventory files are
      // also excluded unless the separate inventory choice was made.
      const excluded=new Set(SOURCES.flatMap(s=>(s.items??[]).filter(i=>i.from==='file').map(i=>path.resolve(home,i.path.slice(2)))));
      let rawFiles=0,rawBytes=0,limited=false;
      const guardedFs=new Proxy(fsApi,{get(target,key){ const value=target[key]; if(typeof value!=='function') return value; return (...args)=>{
        if(!request.inventory&&typeof args[0]==='string'&&excluded.has(path.resolve(args[0]))) {const err=new Error('inventory not selected');err.code='ENOENT';throw err;}
        if(key==='fstatSync') {const stat=value.apply(target,args);if(rawFiles>=128 || !Number.isSafeInteger(stat.size) || rawBytes+stat.size>32*1024*1024) {limited=true;const err=new Error('scan limit reached');err.code='EFBIG';throw err;}rawFiles++;rawBytes+=stat.size;return stat;}
        return value.apply(target,args);
      }; }});
      let result; try {result=scanImpl({home,fsApi:guardedFs,exec:null,only:request.sources,optIn:request.ssh?['ssh-config']:[]});}catch{return unavailable();}
      if(!valid(entry,token)) return unavailable();
      const payload={schema:1,files:[],items:[],note:''}, withheld=[];
      for(const source of result.sources??[]) {
        for(const file of source.files??[]) {
          const scrubbed=scrubFile({...file,machine:{...machine(),...entry.source.machine,home}});
          if(scrubbed.status!=='ok') {withheld.push({source:source.id,reason:'file was blocked by the privacy engine'});continue;}
          payload.files.push({id:randomUUID(),source_id:source.id,relative_path:file.path.slice(2),format:file.format,content:scrubbed.content,note:''});
        }
        if(request.inventory) for(const item of source.items??[]) payload.items.push({id:randomUUID(),source_id:source.id,kind:item.kind,name:item.name,version:item.version??null});
      }
      let checked; try {checked=schema.validatePayload(payload);}catch{return {ok:false,status:'empty',error:'No valid shareable content was found within the selected limits.'};}
      const own=fresh.profiles.find(p=>p.owner_user_id===entry.source.userId), id=randomUUID();
      const scanSummary={read:(result.lookedAt??[]).filter(e=>e.result==='read').length,skipped:(result.lookedAt??[]).filter(e=>e.result==='skipped').length+withheld.length,limited};
      const draft={handle:id,entry,payload:checked.payload,checked,approved:new Set(),expected:own?.current_version?.id??null,expires:now()+10*60_000,revision:0,requestId:randomUUID(),busy:false,scanSummary};
      drafts.clear(); drafts.set(id,draft);
      return {...view(draft),withheld,inventory_commands:'not_run'};
    },
    edit(handle,input) {
      const draft=drafts.get(handle);
      if(!draft || !valid(draft.entry,generation) || draft.expires<=now() || draft.busy || !input || Object.keys(input).some(k=>!['file_id','item_id','remove','content','note','profile_note'].includes(k))) return unavailable();
      let next=JSON.parse(schema.canonical(draft.payload));
      if(input.remove===true) {
        if(Object.keys(input).some(k=>!['remove','file_id','item_id'].includes(k)) || (!next.files.some(f=>f.id===input.file_id) && !next.items.some(i=>i.id===input.item_id)))return unavailable();
        next.files=next.files.filter(file=>file.id!==input.file_id);next.items=next.items.filter(item=>item.id!==input.item_id);
      } else if(Object.hasOwn(input,'profile_note')) {if(typeof input.profile_note!=='string'||Buffer.byteLength(input.profile_note)>schema.SETUP_LIMITS.noteBytes) return unavailable();next.note=input.profile_note;}
      else {
        const file=next.files.find(file=>file.id===input.file_id);
        if(!file || typeof input.content!=='string' || typeof input.note!=='string' || Buffer.byteLength(input.content)>schema.SETUP_LIMITS.fileBytes || Buffer.byteLength(input.note)>schema.SETUP_LIMITS.noteBytes) return unavailable();
        Object.assign(file,{content:input.content,note:input.note});
      }
      if(Buffer.byteLength(schema.canonical(next))>schema.SETUP_LIMITS.profileBytes) return unavailable();
      draft.payload=next; draft.approved.clear(); draft.revision++; draft.requestId=randomUUID();
      try {draft.checked=schema.validatePayload(next);draft.error=null;}catch{draft.checked=null;draft.error='Remove secrets and machine paths before sharing. This text cannot be published.';}
      return view(draft);
    },
    approve(handle,fileId,expectedHash) {
      const draft=drafts.get(handle);
      if(!draft || !valid(draft.entry,generation) || draft.expires<=now() || draft.busy || !draft.checked || !draft.checked.file_hashes.some(f=>f.file_id===fileId&&f.hash===expectedHash)) return unavailable();
      draft.approved.add(fileId); return view(draft);
    },
    async publish(handle,expectedHash) {
      const draft=drafts.get(handle),token=generation;
      if(!draft || !valid(draft.entry,token) || draft.expires<=now() || draft.busy || !draft.checked || draft.checked.content_hash!==expectedHash || draft.approved.size!==draft.payload.files.length) return unavailable();
      draft.busy=true; const revision=draft.revision, checked=draft.checked;
      try {
        const fresh=await call(draft.entry,'list'); if(!fresh?.ok)return fresh??unavailable();if(drafts.get(handle)!==draft || fresh.status==='unavailable' || !valid(draft.entry,token) || !['owner','admin','member'].includes(fresh.principal.role??draft.entry.source.role)) return unavailable();
        const approved=await confirm({team:clean(draft.entry.source.name),files:checked.payload.files.length,items:checked.payload.items.length,sources:checked.sources,content_hash:checked.content_hash});
        if(approved!==true || drafts.get(handle)!==draft || !valid(draft.entry,token) || revision!==draft.revision || draft.expires<=now()) return unavailable();
        const result=await call(draft.entry,'publish',{body:{request_id:draft.requestId,expected_version_id:draft.expected,payload:checked.payload,review:{schema:1,approved:true,content_hash:checked.content_hash,file_hashes:checked.file_hashes}}});
        if(!result?.ok)return result??unavailable();
        if(!result || result.version?.content_hash!==checked.content_hash || !valid(draft.entry,token)) return unavailable();
        drafts.delete(handle); return {ok:true,shared:true,version:result.version.number};
      }finally{draft.busy=false;}
    },
    async action(handle,op,input={}) {
      const entry=entryFor(handle); if(!entry?.profile || !['unpublish','activity','baseline','receipt'].includes(op) || !input || Object.keys(input).some(k=>!['selection','required','outcome'].includes(k))) return unavailable();
      if(['baseline','receipt'].includes(op) && (!Array.isArray(input.selection)||!input.selection.length||input.selection.length>schema.SETUP_LIMITS.files+schema.SETUP_LIMITS.items||input.selection.some(id=>typeof id!=='string'||!schema.UUID.test(id))))return unavailable();
      if(op==='baseline'&&typeof input.required!=='boolean')return unavailable();
      if(op==='receipt'&&!['reviewed','reported_applied','reported_undone'].includes(input.outcome))return unavailable();
      const data=await call(entry,op,{profile:entry.profile,body:{request_id:randomUUID(),...(op==='baseline'?{profile_id:entry.profile,version_id:entry.version,selection:input.selection,required:input.required}:op==='receipt'?{version_id:entry.version,selection:input.selection,outcome:input.outcome}:op==='unpublish'?{expected_version_id:entry.version}:{})}});
      if(!data?.ok) return data??unavailable();
      if(op==='activity') return {ok:true,activity:Array.isArray(data.activity)?data.activity.slice(0,500).map(a=>({kind:clean(a.kind),version:a.version_number,selection_count:a.selection_count,created_at:clean(a.created_at)})):[]};
      return {ok:true,client_reported:op==='receipt',unpublished:op==='unpublish'};
    },
    async export(handle) {
      const entry=entryFor(handle),token=generation;if(!entry?.profile) return unavailable();
      const first=await call(entry,'export',{profile:entry.profile});
      let checked;try{checked=schema.validatePayload(first?.payload);}catch{return unavailable();}
      if(first.profile?.id!==entry.profile || first.profile.owner_user_id!==entry.source.userId || typeof first.version?.id!=='string' || !schema.UUID.test(first.version.id) || first.version.content_hash!==checked.content_hash) return unavailable();
      const commit=await chooseExport();
      if(typeof commit!=='function' || !valid(entry,token)) return unavailable();
      const fresh=await call(entry,'export',{profile:entry.profile});
      if(!fresh || fresh.profile?.id!==entry.profile || fresh.profile.owner_user_id!==entry.source.userId || fresh.version?.id!==first.version.id || fresh.version.content_hash!==checked.content_hash || !valid(entry,token)) return unavailable();
      try {commit(schema.canonical(checked.payload));return {ok:true,exported:true};}catch{return {ok:false,error:'Choose a new filename that can be saved securely.'};}
    },
  };
}
module.exports={createSetupsService};
