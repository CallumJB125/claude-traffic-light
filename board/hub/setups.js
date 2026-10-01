import { randomUUID } from 'node:crypto';
import { HubError } from './db.js';
import { can, isAdmin } from './permissions.js';
import { canonical, hash, validatePayload, validateReview, selection, SETUP_LIMITS, UUID } from '../shared/setups.js';
const kind = 'setups.profile.v1';
const invalid = message => { throw new HubError('VALIDATION', message); };
const closed = (body, fields) => { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k=>!fields.includes(k)) || fields.some(k=>!Object.hasOwn(body,k))) invalid('unknown or missing Setups field'); };
// Content is absent from journals, WS, search, MCP and all general caches.
export class Setups {
  constructor(api) { this.api=api; this.hub=api.hub; this.db=api.db; this.queues=new Map(); this.waiting=0; }
  scope(member, org, cred, action='setups.read') {
    if (!this.hub.accounts || !cred) throw new HubError('POLICY_DENIED','Setups needs a signed-in team account');
    const current=this.api.currentMember(member,cred);
    if(current.org_id!==org || !can(current,action)) throw new HubError('FORBIDDEN','Setups is for current team staff');
    return current;
  }
  profile(member,id,cred, { unpublished=false }={}) {
    const row=this.db.get('SELECT p.* FROM setup_profiles p JOIN orgs o ON o.id=p.org_id JOIN members m ON m.id=p.owner_member_id JOIN users u ON u.id=p.owner_user_id WHERE p.id=? AND o.deleted_at IS NULL AND m.removed_at IS NULL AND m.user_id=p.owner_user_id AND m.org_id=p.org_id AND u.deleted_at IS NULL',id);
    if(!row || (!unpublished && !row.published)) throw new HubError('NOT_FOUND','setup profile is not available');
    const current=this.scope(member,row.org_id,cred); return {row,current};
  }
  principal(member) { return {user_id:member.user_id, member_id:member.id, team_id:member.org_id,role:member.role}; }
  summary(row) {
    const version=row.current_version_id && this.db.get('SELECT * FROM setup_versions WHERE id=? AND profile_id=?',row.current_version_id,row.id);
    return {id:row.id,owner_user_id:row.owner_user_id,published:!!row.published,current_version:version?this.versionSummary(version):null};
  }
  versionSummary(v) { return {id:v.id,number:v.number,content_hash:v.content_hash,bytes:v.bytes,file_count:v.file_count,item_count:v.item_count,sources:JSON.parse(v.sources),created_at:v.created_at}; }
  aad(profile,v) { return `setups-v1:${profile.org_id}:${profile.id}:${v.id}:${v.content_hash}`; }
  open(profile,v) {
    try {
      const raw=this.hub.vault.open(this.aad(profile,v),kind,v);
      const checked=validatePayload(JSON.parse(raw));
      if(checked.content_hash!==v.content_hash || checked.bytes!==v.bytes) throw new Error('hash');
      return checked.payload;
    } catch { throw new HubError('POLICY_DENIED','this sealed setup is unavailable'); }
  }
  list(member,org,cred) {
    const current=this.scope(member,org,cred);
    if(!this.hub.vault.available) return {principal:this.principal(current),status:'unavailable',profiles:[],baseline:null};
    const rows=this.db.all('SELECT p.* FROM setup_profiles p JOIN members m ON m.id=p.owner_member_id JOIN users u ON u.id=p.owner_user_id WHERE p.org_id=? AND p.published=1 AND m.removed_at IS NULL AND m.user_id=p.owner_user_id AND m.org_id=p.org_id AND u.deleted_at IS NULL ORDER BY p.created_at LIMIT 501',org);
    const baseline=this.db.get('SELECT profile_id,version_id,selection,required,updated_at FROM setup_baselines WHERE org_id=?',org);
    return {principal:this.principal(current),status:rows.length>500?'partial':'complete',profiles:rows.slice(0,500).map(r=>this.summary(r)),baseline:baseline?{...baseline,selection:JSON.parse(baseline.selection),required:!!baseline.required,meaning:'reminder_only'}:null};
  }
  read(member,id,versionId,cred,own=false) {
    const {row,current}=this.profile(member,id,cred);
    if(own && row.owner_user_id!==current.user_id) throw new HubError('FORBIDDEN','export your own setup only');
    const v=this.db.get('SELECT * FROM setup_versions WHERE profile_id=? AND id=?',id,versionId??row.current_version_id);
    if(!v) throw new HubError('NOT_FOUND','setup version is no longer retained');
    return {principal:this.principal(current),profile:this.summary(row),version:this.versionSummary(v),payload:this.open(row,v),versions:this.db.all('SELECT * FROM setup_versions WHERE profile_id=? ORDER BY number DESC LIMIT 50',id).map(r=>this.versionSummary(r))};
  }
  async withTeam(org,fn) {
    if(this.waiting>=32) throw new HubError('RATE_LIMITED','Setups is busy; try again shortly',{retry_after_s:1});
    this.waiting++;
    const before=this.queues.get(org)??Promise.resolve(), pending=before.then(fn,fn);
    this.queues.set(org,pending);
    try { return await pending; } finally { this.waiting--; if(this.queues.get(org)===pending) this.queues.delete(org); }
  }
  request(member,body,op,scope,normalized,fn,{privacyErase=false}={}) {
    if(typeof body.request_id!=='string' || !UUID.test(body.request_id)) invalid('a UUID request_id is required');
    const binding=hash({op,scope,...normalized}), prior=this.db.get('SELECT * FROM setup_requests WHERE user_id=? AND org_id=? AND request_id=?',member.user_id,member.org_id,body.request_id);
    if(prior) {
      if(prior.member_id!==member.id)throw new HubError('CONFLICT','request_id belongs to an earlier membership');
      if(prior.operation!==op || prior.scope_id!==scope || prior.binding!==binding) throw new HubError('CONFLICT','request_id belongs to another Setups operation');
      return {prior};
    }
    // Ordinary writes stop at their history budget. Actual privacy erasure
    // retains its minimal retry tombstone even when that budget is exhausted.
    if(!privacyErase && this.db.get('SELECT COUNT(*) n FROM setup_requests WHERE user_id=? AND org_id=?',member.user_id,member.org_id).n>=SETUP_LIMITS.requests) throw new HubError('QUOTA_EXCEEDED','Setups retry history is full');
    const result=fn();
    this.db.insert('setup_requests',{user_id:member.user_id,org_id:member.org_id,member_id:member.id,request_id:body.request_id,operation:op,scope_id:scope,binding,result_profile_id:result.profile_id??null,result_version_id:result.version_id??null,created_at:this.hub.iso()});
    return result;
  }
  activityRow(profile,member,kind,version=null,count=null) {
    this.db.insert('setup_activity',{id:randomUUID(),profile_id:profile,actor_user_id:member.user_id,kind,version_number:version,selection_count:count,created_at:this.hub.iso()});
    this.db.run('DELETE FROM setup_activity WHERE profile_id=? AND rowid NOT IN(SELECT rowid FROM setup_activity WHERE profile_id=? ORDER BY rowid DESC LIMIT 500)',profile,profile);
  }
  async publish(member,org,body,cred) {
    this.scope(member,org,cred,'setups.publish');
    closed(body,['request_id','expected_version_id','payload','review']);
    if(body.expected_version_id!==null && (typeof body.expected_version_id!=='string' || !UUID.test(body.expected_version_id))) invalid('expected version must be a UUID or null');
    let checked; try { checked=validatePayload(body.payload); validateReview(body.review,checked); } catch { invalid('review every exact scrubbed file and profile before publishing'); }
    return this.withTeam(org,()=>this.db.tx(()=>{
      const current=this.scope(member,org,cred,'setups.publish');
      if(!this.hub.vault.available) throw new HubError('POLICY_DENIED','Setups needs the hub encryption key');
      let profile=this.db.get('SELECT * FROM setup_profiles WHERE org_id=? AND owner_user_id=?',org,current.user_id);
      const result=this.request(current,body,'publish',org,{expected:body.expected_version_id,hash:checked.content_hash},()=>{
        if((profile?.current_version_id??null)!==body.expected_version_id) throw new HubError('VERSION_CONFLICT','your published setup changed');
        if(profile && profile.owner_member_id!==current.id) { // A removed membership never resurrects bytes, even after rejoining.
          if(profile.published) throw new HubError('CONFLICT','setup membership changed');
          this.db.run('UPDATE setup_profiles SET owner_member_id=? WHERE id=?',current.id,profile.id);
          profile={...profile,owner_member_id:current.id};
        }
        if(!profile) { profile={id:randomUUID(),org_id:org,owner_user_id:current.user_id,owner_member_id:current.id,published:0,current_version_id:null,sequence:0,created_at:this.hub.iso()}; this.db.insert('setup_profiles',profile); }
        if(this.db.get('SELECT COUNT(*) n FROM setup_versions WHERE profile_id=?',profile.id).n>=SETUP_LIMITS.versions) throw new HubError('QUOTA_EXCEEDED','unpublish to remove retained versions before sharing a new profile');
        const sealedBytes=this.db.get('SELECT COALESCE(SUM(length(v.ciphertext)),0) n FROM setup_versions v JOIN setup_profiles p ON p.id=v.profile_id WHERE p.org_id=?',org).n;
        if(sealedBytes+checked.bytes+16>SETUP_LIMITS.teamBytes) throw new HubError('QUOTA_EXCEEDED','team Setups storage is full');
        const v={id:randomUUID(),profile_id:profile.id,number:profile.sequence+1,content_hash:checked.content_hash,bytes:checked.bytes,file_count:checked.payload.files.length,item_count:checked.payload.items.length,sources:canonical(checked.sources),created_by:current.id,created_at:this.hub.iso()};
        v.review_attestation=canonical(body.review);
        Object.assign(v,this.hub.vault.seal(this.aad(profile,v),kind,canonical(checked.payload)));
        this.db.insert('setup_versions',v);
        this.db.run('UPDATE setup_profiles SET published=1,current_version_id=?,sequence=? WHERE id=?',v.id,v.number,profile.id);
        this.activityRow(profile.id,current,'published',v.number);
        return {profile_id:profile.id,version_id:v.id};
      });
      const p=result.prior??result;
      const pid=p.result_profile_id??p.profile_id,vid=p.result_version_id??p.version_id;
      if(!vid) throw new HubError('CONFLICT','that shared version was removed; explicitly publish a new request');
      return {...this.read(current,pid,vid,cred),replayed:!!result.prior};
    }));
  }
  async unpublish(member,id,body,cred) {
    closed(body,['request_id','expected_version_id']);
    if(typeof body.expected_version_id!=='string'||!UUID.test(body.expected_version_id))invalid('choose the exact reviewed version to unpublish');
    this.profile(member,id,cred,{unpublished:true});
    return this.withTeam(member.org_id,()=>this.db.tx(()=>{
      const {row,current}=this.profile(member,id,cred,{unpublished:true});
      if(row.owner_user_id!==current.user_id && !isAdmin(current)) throw new HubError('FORBIDDEN','only the owner or a team admin may unpublish');
      const result=this.request(current,body,'unpublish',id,{expected:body.expected_version_id},()=>{
        if(!row.published || row.current_version_id!==body.expected_version_id)throw new HubError('VERSION_CONFLICT','the shared version changed or was already removed');
        this.db.run('UPDATE setup_profiles SET published=0 WHERE id=?',id);
        this.activityRow(id,current,'unpublished'); return {profile_id:id};
      },{privacyErase:true});
      if(result.prior && row.published) throw new HubError('CONFLICT','the profile was shared again; use a new unpublish request');
      return {principal:this.principal(current),profile_id:id,unpublished:true,replayed:!!result.prior};
    }));
  }
  activity(member,id,cred) {
    const {row,current}=this.profile(member,id,cred,{unpublished:true});
    if(row.owner_user_id!==current.user_id && !isAdmin(current)) throw new HubError('FORBIDDEN','activity is visible to the owner and team admins');
    return {principal:this.principal(current),profile_id:id,activity:this.db.all('SELECT kind,version_number,selection_count,created_at,actor_user_id FROM setup_activity WHERE profile_id=? ORDER BY rowid DESC LIMIT 500',id)};
  }
  async baseline(member,org,body,cred) {
    closed(body,['request_id','profile_id','version_id','selection','required']); this.scope(member,org,cred,'setups.baseline');
    if(typeof body.required!=='boolean') invalid('required is a reminder flag');
    return this.withTeam(org,()=>this.db.tx(()=>{
      const current=this.scope(member,org,cred,'setups.baseline'), {row}=this.profile(current,body.profile_id,cred);
      if(row.org_id!==org || row.current_version_id!==body.version_id) throw new HubError('CONFLICT','choose the current published team version');
      const read=this.read(current,row.id,body.version_id,cred); let selected; try { selected=selection(body.selection,read.payload); } catch { invalid('select current files or inventory'); }
      const result=this.request(current,body,'baseline',org,{profile:row.id,version:body.version_id,selection:selected,required:body.required},()=>{
        this.db.run('INSERT INTO setup_baselines VALUES(?,?,?,?,?,?) ON CONFLICT(org_id) DO UPDATE SET profile_id=excluded.profile_id,version_id=excluded.version_id,selection=excluded.selection,required=excluded.required,updated_at=excluded.updated_at',org,row.id,body.version_id,canonical(selected),body.required,this.hub.iso());
        this.activityRow(row.id,current,'baseline',read.version.number,selected.length); return {profile_id:row.id,version_id:body.version_id};
      });
      return {...this.list(current,org,cred),replayed:!!result.prior};
    }));
  }
  async receipt(member,id,body,cred) {
    closed(body,['request_id','version_id','selection','outcome']); this.profile(member,id,cred);
    if(!['reviewed','reported_applied','reported_undone'].includes(body.outcome)) invalid('unsupported client report');
    return this.withTeam(member.org_id,()=>this.db.tx(()=>{
      const {current}=this.profile(member,id,cred), read=this.read(current,id,body.version_id,cred); let selected; try { selected=selection(body.selection,read.payload); } catch { invalid('select current version entries'); }
      const result=this.request(current,body,'receipt',id,{version:body.version_id,selection:selected,outcome:body.outcome},()=>{
        this.db.insert('setup_receipts',{id:randomUUID(),profile_id:id,version_id:body.version_id,actor_user_id:current.user_id,selection:canonical(selected),outcome:body.outcome,created_at:this.hub.iso()});
        this.db.run('DELETE FROM setup_receipts WHERE profile_id=? AND rowid NOT IN(SELECT rowid FROM setup_receipts WHERE profile_id=? ORDER BY rowid DESC LIMIT 500)',id,id);
        this.activityRow(id,current,'client_reported_'+body.outcome,read.version.number,selected.length); return {profile_id:id,version_id:body.version_id};
      });
      if(result.prior && !result.prior.result_version_id) throw new HubError('CONFLICT','that version was removed');
      return {principal:this.principal(current),profile_id:id,version_id:body.version_id,client_reported:true,replayed:!!result.prior};
    }));
  }
  guard(member,params,out,cred,method) {
    const action=params.team_id&&method==='POST'?'setups.publish':params.team_id&&method==='PUT'?'setups.baseline':'setups.read';
    const current=this.scope(member,member.org_id,cred,action);
    if(out.principal?.user_id!==current.user_id || out.principal?.member_id!==current.id || out.principal?.team_id!==current.org_id) throw new HubError('UNAUTHENTICATED','Setups identity changed');
    if(out.principal.role!==current.role) throw new HubError('CONFLICT','your team role changed; refresh');
    if(out.payload) this.read(current,out.profile.id,out.version.id,cred);
    if(params.profile_id) {
      const {row}=this.profile(current,params.profile_id,cred,{unpublished:!out.payload});
      if(out.payload && !params.version_id && method==='GET' && row.current_version_id!==out.version.id) throw new HubError('CONFLICT','the current version changed; refresh');
      if((out.activity || method==='DELETE') && row.owner_user_id!==current.user_id && !isAdmin(current)) throw new HubError('FORBIDDEN','only the owner or a team admin may access sharing activity or unpublish');
      if(out.unpublished && row.published) throw new HubError('CONFLICT','the setup was shared again; refresh');
      if(out.version_id && !this.db.get('SELECT 1 x FROM setup_versions WHERE id=? AND profile_id=?',out.version_id,row.id)) throw new HubError('CONFLICT','the reported version was removed');
    }
    if(out.profiles) {
      if(out.status==='unavailable') {
        if(out.profiles.length || out.baseline)throw new HubError('POLICY_DENIED','Setups is unavailable');
        return;
      }
      if(!this.hub.vault.available) throw new HubError('POLICY_DENIED','Setups encryption is unavailable');
      for(const profile of out.profiles) { const {row}=this.profile(current,profile.id,cred); if(row.current_version_id!==profile.current_version?.id) throw new HubError('CONFLICT','Setups changed; refresh'); }
      const row=this.db.get('SELECT profile_id,version_id,selection,required,updated_at FROM setup_baselines WHERE org_id=?',current.org_id);
      const baseline=row?{...row,selection:JSON.parse(row.selection),required:!!row.required,meaning:'reminder_only'}:null;
      if(canonical(baseline)!==canonical(out.baseline??null))throw new HubError('CONFLICT','team baseline changed; refresh');
    }
  }
  // Private operator primitive: bounded rotation; the previous key stays needed
  // until remaining reaches zero. Does not publish bytes or populate a cache.
  resealBatch(limit=100) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100) invalid('invalid rotation batch');
    const vault=this.hub.vault; if(!vault.available) throw new HubError('POLICY_DENIED','Setups encryption is unavailable');
    let resealed=0,unopened=0;
    this.db.tx(()=>{ for(const v of this.db.all('SELECT * FROM setup_versions WHERE key_id!=? LIMIT ?',vault.keyId,limit)) {
      const profile=this.db.get('SELECT * FROM setup_profiles WHERE id=?',v.profile_id); let payload; try {payload=this.open(profile,v);}catch{unopened++;continue;}
      const s=vault.seal(this.aad(profile,v),kind,canonical(payload)); this.db.run('UPDATE setup_versions SET key_id=?,nonce=?,ciphertext=? WHERE id=?',s.key_id,s.nonce,s.ciphertext,v.id); resealed++;
    }});
    return {resealed,unopened,remaining:this.db.get('SELECT COUNT(*) n FROM setup_versions WHERE key_id!=?',vault.keyId).n};
  }
}
