'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createTeamSessionSharing}=require('../src/team-session-sharing');
function rig(){
 let enabled=true,associated=true,allowed=true,rows=[],calls=[],clock=1,sessionRows=null;
 const state={session:'one',ownership:'plexiform-owned',board:'bound-team-workspace',status:'ready'};
 const host={connected:()=>true,listShares:async()=>({ok:true,teams:allowed?[{id:'team'}]:[]}),shared:()=>rows,
  shareSession:async d=>{calls.push(d);const share={...d,id:'share-'+calls.length,team:{id:d.team}};rows.push(share);return {ok:true,share};},stopSharing:id=>{rows=rows.filter(x=>x.id!==id);}};
 const x=createTeamSessionSharing({host:()=>enabled?host:null,origin:()=> 'https://hub.example',sessions:()=>sessionRows??[{state}],association:b=>associated&&b==='bound-team-workspace'?{origin:'https://hub.example',team:'team'}:null,now:()=>clock});
 return {x,state,host,calls,get rows(){return rows;},off:()=>enabled=false,unassign:()=>associated=false,revoke:()=>rows=[],removeMember:()=>allowed=false,setSessions:x=>sessionRows=x,advance:()=>clock+=100000};
}
test('team workspace sessions auto-share once; personal and unrelated-provider sessions stay private',async()=>{
 const r=rig();await Promise.all([r.x.sync(),r.x.sync()]);assert.deepEqual(r.calls,[{session:'one',team:'team',scope:'interact'}]);await r.x.sync();assert.equal(r.calls.length,1);
 for(const mutate of [r=>r.state.board='personal',r=>r.state.ownership='existing-unmanaged']){const r=rig();mutate(r);await r.x.sync();assert.equal(r.calls.length,0);}
 const c=rig();c.state.ownership='existing-unmanaged';c.state.provider={id:'claude-channel'};await c.x.sync();assert.equal(c.calls.length,1);
});
test('association/account membership removal and disabling stop automatic shares',async()=>{
 for(const mutate of [r=>r.unassign(),r=>r.removeMember(),r=>r.off(),r=>r.state.status='ended']){const r=rig();await r.x.sync();mutate(r);await r.x.sync();assert.equal(r.rows.length,0);}
});
test('revocation is respected and manual watch grants are never upgraded',async()=>{
 const r=rig();await r.x.sync();r.revoke();await r.x.sync();r.advance();await r.x.sync();assert.equal(r.calls.length,1,'revoked share must not be recreated');
 const m=rig();m.host.shareSession({session:'one',team:'team',scope:'watch'});await m.x.sync();assert.equal(m.calls.length,1);assert.equal(m.rows[0].scope,'watch');m.x.stop();assert.equal(m.rows.length,1,'manual share not owned by reconciler');
});
test('an association lost during hub creation immediately revokes the returned grant',async()=>{
 const r=rig(),original=r.host.shareSession;r.host.shareSession=async d=>{const result=await original(d);r.unassign();return result;};await r.x.sync();assert.equal(r.rows.length,0);
});


test('share creation refuses a provider/generation/ownership replacement or stop while awaiting the hub',async()=>{
 for(const mutate of [r=>r.state.generation=2,r=>r.state.provider={id:'foreign'},r=>r.state.ownership='existing-unmanaged',r=>r.state.status='ended',r=>r.x.stop()]){
  const r=rig(),original=r.host.shareSession;r.host.shareSession=async d=>{const result=await original(d);mutate(r);return result;};await r.x.sync();assert.equal(r.rows.length,0);
 }
});
test('revoked active shares stay blocked across more than 256 historical sessions',async()=>{
 const r=rig();await r.x.sync();r.revoke();await r.x.sync();
 for(let i=0;i<300;i++){const extra={...r.state,session:'history-'+i};r.setSessions([{state:r.state},{state:extra}]);r.advance();await r.x.sync();}
 assert.equal(r.calls.filter(c=>c.session==='one').length,1);assert.equal(r.rows.some(s=>s.session==='one'),false);
});
