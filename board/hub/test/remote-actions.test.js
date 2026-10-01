import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { remoteRig, grant, oauth, queued, refused, business, spareBoard } from './remote-helpers.js';
import { communicationRig, taskMessage } from './communication-helpers.js';
import { RemoteActions } from '../remote/actions.js';
import { Api } from '../api.js';
import { TeamCommunication } from '../communication.js';
import { createRemoteContext } from '../remote/context.js';
const denied=e=>['UNAUTHENTICATED','FORBIDDEN','NOT_FOUND','CONFLICT','RATE_LIMITED'].includes(e.code);
const packet=f=>({card_id:f.A.card,request_id:randomUUID(),expected_version:0,expected_fence:f.h.hub.card(f.A.card).fence,
 data:{brief:'Synthetic context',decisions:[],progress:'Reported only',nextAction:'Human review',artifacts:[],reportedChecks:[]}});
const tokenHash=token=>createHash('sha256').update(token).digest('hex');

test('the shared closed catalog exposes exactly collaboration tools and no execution, human approval or evidence writes',async t=>{
 const f=await remoteRig(t),g=await grant(f),tools=f.actions.catalog(g.token);
 assert.equal(tools.length,12);assert.equal(tools.filter(tool=>tool.annotations.readOnlyHint).length,7);
 assert.ok(tools.some(tool=>tool.name==='plexiform_get_work_context'&&tool.annotations.readOnlyHint));
 for(const tool of tools)assert.equal(tool.inputSchema.additionalProperties,false);
 for(const [name,args] of [['plexiform_dispatch',{card_id:f.A.card}],['plexiform_create_card',{board_id:f.A.board,title:'No',request_id:randomUUID(),repo_id:f.A.repo}],['plexiform_add_comment',{card_id:f.A.card,body:'No',request_id:randomUUID(),for_agent:true}],['plexiform_get_card',{card_id:f.A.card,token:g.token}]]){
  const before=business(f);await assert.rejects(f.actions.call(g.token,'integration',name,args),e=>e.code==='VALIDATION');assert.equal(business(f),before);
 }
});

test('durable create/text/comment retries reuse IDs, recompute current views and reject changed choices across operations',async t=>{
 const f=await remoteRig(t),g=await grant(f),id=randomUUID(),args={request_id:id,board_id:f.A.board,title:'Original text'};
 const [one,two]=await Promise.all([1,2].map(()=>f.actions.call(g.token,'integration','plexiform_create_card',args)));
 assert.equal(one.card.id,two.card.id);assert.equal(f.db.get('SELECT count(*) n FROM remote_actions').n,1);assert.equal(f.db.get('SELECT count(*) n FROM cards WHERE title=?','Original text').n,1);
 assert.equal(f.db.get('SELECT active_run_id,run_state,repo_id FROM cards WHERE id=?',one.card.id).active_run_id,null);
 assert.equal(f.db.get('SELECT count(*) n FROM dispatches WHERE card_id=?',one.card.id).n,0);
 const update={request_id:randomUUID(),card_id:one.card.id,version:one.card.version,title:'Human-readable changed text'};
 const changed=await f.actions.call(g.token,'integration','plexiform_update_card',update);assert.equal(changed.card.version,one.card.version+1);
 assert.equal((await f.actions.call(g.token,'integration','plexiform_update_card',update)).card.version,changed.card.version,'receipt checked before stale version validation');
 const replay=await f.actions.call(g.token,'integration','plexiform_create_card',args);assert.equal(replay.card.title,'Human-readable changed text');
 for(const [name,input] of [['plexiform_create_card',{...args,title:'Different choice'}],['plexiform_add_comment',{request_id:id,card_id:one.card.id,body:'Another operation'}]]){
  const before=business(f);await assert.rejects(f.actions.call(g.token,'integration',name,input),e=>e.code==='CONFLICT');assert.equal(business(f),before);
 }
 const comment={request_id:randomUUID(),card_id:one.card.id,body:'A reported comment'},a=await f.actions.call(g.token,'integration','plexiform_add_comment',comment),b=await f.actions.call(g.token,'integration','plexiform_add_comment',comment);
 assert.equal(a.comment.id,b.comment.id);assert.equal(a.comment.for_agent,false);assert.equal(a.comment.application_verified,false);assert.equal(a.comment.account_id,f.users.amember.id);
 assert.equal(f.db.get('SELECT count(*) n FROM comments WHERE card_id=?',one.card.id).n,1);
 const receipts=f.db.all('SELECT response FROM remote_actions');for(const row of receipts){assert.equal(row.response.includes('Original text'),false);assert.equal(row.response.includes('reported comment'),false);}
});

for(const dimension of ['grant-revoke','token-revoke','epoch','member-remove','member-owner','user-delete','team-delete','viewer','grant-read','board-archive','board-narrow','repo-remove','card-archive','card-move','repo-move'])test(`ordinary queue rechecks ${dimension} before remote comment and durable effects`,async t=>{
 const f=await remoteRig(t),other=await spareBoard(f),g=await grant(f,{boardIds:[f.A.board,other]}),args={request_id:randomUUID(),card_id:f.A.card,body:'Must remain uncommitted'};
 const change=()=>{
  switch(dimension){
   case 'grant-revoke':f.authority.revokeFamily(g.grant.id);break;
   case 'token-revoke':f.db.run('UPDATE remote_tokens SET revoked_at=? WHERE token_hash=?',f.h.hub.iso(),tokenHash(g.token));break;
   case 'epoch':f.db.setMeta('session_epoch',String(f.authority.epoch()+1));break;
   case 'member-remove':f.db.run('UPDATE members SET removed_at=? WHERE id=?',f.h.hub.iso(),f.A.member);break;
   case 'member-owner':f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.member);break;
   case 'user-delete':f.db.run('UPDATE users SET deleted_at=? WHERE id=?',f.h.hub.iso(),f.users.amember.id);break;
   case 'team-delete':f.db.run('UPDATE orgs SET deleted_at=? WHERE id=?',f.h.hub.iso(),f.A.team);break;
   case 'viewer':f.db.run("UPDATE members SET role='viewer' WHERE id=?",f.A.member);break;
   case 'grant-read':f.db.run("UPDATE remote_grants SET mode='read' WHERE id=?",g.grant.id);break;
   case 'board-archive':f.db.run('UPDATE boards SET archived_at=? WHERE id=?',f.h.hub.iso(),f.A.board);break;
   case 'board-narrow':f.db.run('UPDATE remote_grants SET board_ids=? WHERE id=?',JSON.stringify([other]),g.grant.id);break;
   case 'repo-remove':f.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?',f.A.board,f.A.repo);break;
   case 'card-archive':f.db.run('UPDATE cards SET archived_at=? WHERE id=?',f.h.hub.iso(),f.A.card);break;
   case 'card-move':f.db.run('UPDATE cards SET board_id=? WHERE id=?',other,f.A.card);break;
   case 'repo-move':f.db.run('UPDATE cards SET repo_id=NULL WHERE id=?',f.A.card);break;
  }
 };
 refused(await queued(f,f.A.board,()=>f.actions.call(g.token,'integration','plexiform_add_comment',args),change));
});

test('both member and credential replacement cannot transfer the captured remote principal',async t=>{
 const f=await remoteRig(t),g=await grant(f),args={request_id:randomUUID(),card_id:f.A.card,body:'No transferred account'};
 refused(await queued(f,f.A.board,()=>f.actions.call(g.token,'integration','plexiform_add_comment',args),()=>{
  f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.member);
  f.db.run('UPDATE sessions SET user_id=? WHERE id=?',f.users.n.id,g.identity.cred.id);
 }));
});

for(const name of ['plexiform_create_card','plexiform_update_card','plexiform_write_packet'])test(`${name} uses its ordinary queue and private authority, with no effects after revocation`,async t=>{
 const f=await remoteRig(t),g=await grant(f),args=name==='plexiform_create_card'?{request_id:randomUUID(),board_id:f.A.board,title:'No created card'}:name==='plexiform_update_card'?{request_id:randomUUID(),card_id:f.A.card,version:f.h.hub.card(f.A.card).version,title:'No patch'}:packet(f);
 refused(await queued(f,f.A.board,()=>f.actions.call(g.token,'integration',name,args),()=>f.authority.revokeFamily(g.grant.id)));
});

for(const name of ['plexiform_create_card','plexiform_update_card','plexiform_add_comment','plexiform_write_packet'])test(`${name} rolls back business rows and broadcasts when durable receipt insertion fails`,async t=>{
 const f=await remoteRig(t),g=await grant(f),args=name==='plexiform_create_card'?{request_id:randomUUID(),board_id:f.A.board,title:'Uncommitted'}:name==='plexiform_update_card'?{request_id:randomUUID(),card_id:f.A.card,version:f.h.hub.card(f.A.card).version,title:'Uncommitted'}:name==='plexiform_add_comment'?{request_id:randomUUID(),card_id:f.A.card,body:'Uncommitted'}:packet(f);
 const before=business(f),insert=f.db.insert.bind(f.db);let broadcasts=0;const broadcast=f.h.hub.broadcastCard.bind(f.h.hub);
 f.h.hub.broadcastCard=(...args)=>{broadcasts++;return broadcast(...args);};
 f.db.insert=(table,row)=>{if(table==='remote_actions')throw new Error('synthetic receipt failure');return insert(table,row);};
 await assert.rejects(f.actions.call(g.token,'integration',name,args),/synthetic receipt failure/);assert.equal(business(f),before);assert.equal(broadcasts,0);
 f.db.insert=insert;await f.actions.call(g.token,'integration',name,args);assert.equal(f.db.get('SELECT count(*) n FROM remote_actions').n,1);
});

test('queued durable retry and waiting same-ID retry both reject revoked authority instead of disclosing a stored response',async t=>{
 const f=await remoteRig(t),g=await grant(f),args={request_id:randomUUID(),card_id:f.A.card,body:'One durable comment'};
 await f.actions.call(g.token,'integration','plexiform_add_comment',args);
 let second;const check=await queued(f,f.A.board,()=>{
  const first=f.actions.call(g.token,'integration','plexiform_add_comment',args);
  second=f.actions.call(g.token,'integration','plexiform_add_comment',args).then(result=>({result}),error=>({error}));return first;
 },()=>f.authority.revokeFamily(g.grant.id));refused(check);assert.ok((await second).error);assert.equal(f.db.get('SELECT count(*) n FROM remote_actions').n,1);
});

test('durable replay and fresh reads remove real overlap peers after exact board narrowing',async t=>{
 const f=await communicationRig(t);f.h.hub.config.publicUrl=f.h.base;f.authority=f.h.hub.remoteAuthority;f.actions=new RemoteActions(f.h.hub);
 const other=await spareBoard(f),hidden=await f.participant(f.users.s,f.A,{board:other,title:'PRIVATE-UNGRANTED-OVERLAP'});
 for(const peer of [f.sender,hidden]){const response=await peer.client.rpc(peer.run,'board_declare_plan',{paths:['src/shared-remote.js'],summary:'Synthetic shared route'});assert.equal(response.ok,true,JSON.stringify(response.error));}
 const g=await grant(f,{boardIds:[f.A.board,other]}),args={request_id:randomUUID(),card_id:f.sender.run.card_id,version:f.h.hub.card(f.sender.run.card_id).version,title:'Selected edit'};
 const first=await f.actions.call(g.token,'integration','plexiform_update_card',args);
 assert.ok(JSON.stringify(first).includes(hidden.run.card_id),'real persisted cross-board overlap is visible under broad explicit grant');
 f.db.run('UPDATE remote_grants SET board_ids=? WHERE id=?',JSON.stringify([f.A.board]),g.grant.id);
 const results=[await f.actions.call(g.token,'integration','plexiform_update_card',args),await f.actions.call(g.token,'integration','plexiform_get_card',{card_id:args.card_id}),await f.actions.call(g.token,'integration','plexiform_list_cards',{board_id:f.A.board})];
 for(const result of results){assert.equal(JSON.stringify(result).includes(hidden.run.card_id),false);assert.equal(JSON.stringify(result).includes(hidden.run.key),false);}
 f.db.run('UPDATE cards SET archived_at=? WHERE id=?',f.h.hub.iso(),args.card_id);const before=business(f);
 await assert.rejects(f.actions.call(g.token,'integration','plexiform_update_card',args),denied);assert.equal(business(f),before);
});

test('foreign boards, guest membership and unauthenticated JSON/function contexts cannot acquire remote authority',async t=>{
 const f=await remoteRig(t),g=await grant(f),api=new Api(f.h.hub),communication=new TeamCommunication(f.h.hub);
 for(const args of [{board_id:f.B.board},{board_id:randomUUID()}])await assert.rejects(f.actions.call(g.token,'integration','plexiform_list_cards',args),denied);
 await assert.rejects(f.actions.call(g.token,'integration','plexiform_get_card',{card_id:f.B.card}),denied);
 const before=business(f);
 for(const remote of [{},JSON.parse('{}'),()=>f.authority.authenticate(g.token),{authorize:()=>f.authority.authenticate(g.token)}]){
  await assert.rejects(api.createCard(g.member,f.A.board,{title:'Forbidden fabricated context'},{remote}),denied);
  assert.throws(()=>communication.human(g.member,f.A.card,null,true,{remote}),denied);
 }
 const context=createRemoteContext({authorize:()=>f.authority.authenticate(g.token),replay:()=>null,record:()=>{},project:result=>result});
 await assert.rejects(api.createCard(g.member,f.A.board,{title:'JSON cannot preserve WeakMap identity'},{remote:JSON.parse(JSON.stringify(context))}),denied);
 assert.equal(business(f),before);
 await assert.rejects(grant(f,{user:f.users.bguest,memberId:f.B.clientGuest,boardIds:[f.B.board]}),denied);
 assert.throws(()=>f.authority.authenticate(f.users.bguest.token),denied);
});

test('remote token material is scrubbed from task text, responses, public application names and receipts',async t=>{
 const f=await remoteRig(t),g=await grant(f),text='Never echo '+g.token;
 const made=await f.actions.call(g.token,'integration','plexiform_create_card',{request_id:randomUUID(),board_id:f.A.board,title:text,body:text});
 const result=await f.actions.call(g.token,'integration','plexiform_add_comment',{request_id:randomUUID(),card_id:made.card.id,body:text});
 assert.equal(JSON.stringify(result).includes(g.token),false);assert.equal(f.db.get('SELECT body FROM cards WHERE id=?',made.card.id).body.includes(g.token),false);
 assert.equal(f.db.get('SELECT body FROM comments WHERE id=?',result.comment.id).body.includes(g.token),false);
 assert.equal(f.db.all('SELECT response FROM remote_actions').some(row=>row.response.includes(g.token)),false);
 assert.match(result.comment.body,/<redacted:integration_token>/);
});

test('packet retry preserves explicit unverified remote attribution without runner provenance',async t=>{
 const f=await remoteRig(t),g=await grant(f),args=packet(f),first=await f.actions.call(g.token,'integration','plexiform_write_packet',args),second=await f.actions.call(g.token,'integration','plexiform_write_packet',args);
 assert.equal(first.packet.id,second.packet.id);assert.equal(first.packet.author.account_id,f.users.amember.id);assert.equal(first.packet.author.identity_source,'remote_grant');assert.equal(first.packet.author.application_verified,false);
 assert.equal(first.packet.author.provider,null);assert.equal(first.packet.author.run_id,null);assert.equal(first.packet.reports_verified,false);assert.equal(first.packet.grants_execution,false);
 assert.equal(f.db.get('SELECT count(*) n FROM task_packets').n,1);
});

test('remote messaging narrows peers, sources, recipients, replies and delivery metadata to exact boards',async t=>{
 const f=await communicationRig(t);f.h.hub.config.publicUrl=f.h.base;f.authority=f.h.hub.remoteAuthority;f.actions=new RemoteActions(f.h.hub);
 const other=await spareBoard(f),foreign=await f.participant(f.users.aadmin,f.A,{board:other,title:'PRIVATE-UNGRANTED-PEER'});
 const ordinary=await f.as(f.users.amember,'POST',`/api/cards/${f.sender.run.card_id}/messages`,{...taskMessage(foreign),expected_fence:f.sender.run.fence});assert.equal(ordinary.status,200,ordinary.text);
 const granted=await grant(f),args={...taskMessage(f.recipient),card_id:f.sender.run.card_id,expected_fence:f.sender.run.fence};
 const first=await f.actions.call(granted.token,'integration','plexiform_send_message',args);assert.equal(first.message.author.application_verified,false);assert.equal(first.message.auto_resume,false);
 const replay=await f.actions.call(granted.token,'integration','plexiform_send_message',args);assert.equal(replay.message.id,first.message.id);
 const view=await f.actions.call(granted.token,'integration','plexiform_list_messages',{card_id:f.sender.run.card_id});
 assert.equal(view.peers.some(peer=>peer.run_id===foreign.run.run_id),false);assert.equal(JSON.stringify(view).includes(foreign.run.run_id),false);assert.equal(JSON.stringify(view).includes('PRIVATE-UNGRANTED-PEER'),false);
 const before=business(f);await assert.rejects(f.actions.call(granted.token,'integration','plexiform_send_message',{...args,request_id:randomUUID(),recipient_run_ids:[foreign.run.run_id]}),denied);assert.equal(business(f),before);
 refused(await queued(f,f.A.board,()=>f.actions.call(granted.token,'integration','plexiform_send_message',{...args,request_id:randomUUID()}),()=>f.authority.revokeFamily(granted.grant.id)));
});

for (const dimension of ['client-revoke', 'access-expiry']) test(`queued MCP mutation refuses ${dimension} without durable effects`, async t => {
 const f=await remoteRig(t),x=await oauth(f),tokens=f.authority.token(x.body);
 refused(await queued(f,f.A.board,()=>f.actions.call(tokens.access_token,'mcp','plexiform_add_comment',{request_id:randomUUID(),card_id:f.A.card,body:'No expired or revoked client action'}),()=>{
  if(dimension==='client-revoke')f.db.run('UPDATE remote_clients SET revoked_at=? WHERE id=?',f.h.hub.iso(),x.client.client_id);
  else f.h.clock.advance(900001);
 }));
});

for (const name of ['plexiform_read_packet','plexiform_list_messages']) test(`queued ${name} denies revoked read authority`, async t => {
 const f=await remoteRig(t),g=await grant(f);
 if(name==='plexiform_read_packet')await f.actions.call(g.token,'integration','plexiform_write_packet',packet(f));
 refused(await queued(f,f.A.board,()=>f.actions.call(g.token,'integration',name,{card_id:f.A.card}),()=>f.authority.revokeFamily(g.grant.id)));
});

test('same-ID retry waiters count toward the pending bound and cannot grow a hidden retry chain',async t=>{
 const f=await remoteRig(t),g=await grant(f),args={request_id:randomUUID(),card_id:f.A.card,body:'One bounded retry'};
 const original=f.h.hub.withBoard.bind(f.h.hub);let release,entered=false;
 const held=original(f.A.board,()=>new Promise(resolve=>{release=resolve;}));await new Promise(resolve=>setImmediate(resolve));
 f.h.hub.withBoard=(id,fn)=>{entered=true;return original(id,fn);};
 try{
  const pending=Array.from({length:128},()=>f.actions.call(g.token,'integration','plexiform_add_comment',args).then(result=>({result}),error=>({error})));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(entered,true);
  await assert.rejects(f.actions.call(g.token,'integration','plexiform_add_comment',args),e=>e.code==='RATE_LIMITED');
  assert.equal(f.db.get('SELECT count(*) n FROM remote_actions').n,0);
  f.authority.revokeFamily(g.grant.id);const before=business(f);release();await held;
  for(const result of await Promise.all(pending))assert.ok(result.error&&denied(result.error));
  assert.equal(business(f),before);assert.equal(f.actions.pendingCount,0);assert.equal(f.actions.pending.size,0);
 }finally{release?.();await held;f.h.hub.withBoard=original;}
});

test('receipt quota rejection rolls back the ordinary action instead of leaving an unrepeatable mutation',async t=>{
 const f=await remoteRig(t,{remoteLimits:{familyActions:1}}),g=await grant(f);
 await f.actions.call(g.token,'integration','plexiform_add_comment',{request_id:randomUUID(),card_id:f.A.card,body:'One admitted receipt'});
 const before=business(f);await assert.rejects(f.actions.call(g.token,'integration','plexiform_create_card',{request_id:randomUUID(),board_id:f.A.board,title:'Must not survive receipt cap'}),e=>e.code==='QUOTA_EXCEEDED');
 assert.equal(business(f),before);
});

test('selected reads and replay omit current hidden predecessor and parent-card references',async t=>{
 const f=await remoteRig(t),other=await spareBoard(f),g=await grant(f);
 const created=await f.as(f.users.ua,'POST',`/api/boards/${other}/cards`,{title:'PRIVATE-REFERENCE',repo_id:f.A.repo});assert.equal(created.status,200,created.text);
 const hidden=created.body.card.id;
 f.db.run('UPDATE cards SET parent_card_id=? WHERE id=?',hidden,f.A.card);
 f.db.insert('card_dependencies',{card_id:f.A.card,depends_on_card_id:hidden,created_by:f.A.owner,created_at:f.h.hub.iso()});
 const update={request_id:randomUUID(),card_id:f.A.card,version:f.h.hub.card(f.A.card).version,title:'Selected visible title'};
 for(const result of [await f.actions.call(g.token,'integration','plexiform_get_card',{card_id:f.A.card}),await f.actions.call(g.token,'integration','plexiform_list_cards',{board_id:f.A.board}),await f.actions.call(g.token,'integration','plexiform_update_card',update),await f.actions.call(g.token,'integration','plexiform_update_card',update)]){
  assert.equal(JSON.stringify(result).includes(hidden),false,'foreign selected-board references must not leak');
 }
});

test('current repository projections omit a former run across detail, lists, mutation and durable replay',async t=>{
 const f=await communicationRig(t);f.h.hub.config.publicUrl=f.h.base;f.authority=f.h.hub.remoteAuthority;f.actions=new RemoteActions(f.h.hub);
 const g=await grant(f),id=f.sender.run.card_id;
 const args={request_id:randomUUID(),card_id:id,version:f.h.hub.card(id).version,title:'Same card after repository move'};
 const currentRepo=randomUUID();f.db.insert('repos',{id:currentRepo,org_id:f.A.team,canonical_url:'github.com/shared/new-current-repo',short_name:'current'});
 f.db.run('INSERT INTO board_repos(board_id,repo_id) VALUES(?,?)',f.A.board,currentRepo);
 f.db.run('UPDATE cards SET repo_id=? WHERE id=?',currentRepo,id);
 for(const result of [await f.actions.call(g.token,'integration','plexiform_get_card',{card_id:id}),await f.actions.call(g.token,'integration','plexiform_list_cards',{board_id:f.A.board}),await f.actions.call(g.token,'integration','plexiform_update_card',args),await f.actions.call(g.token,'integration','plexiform_update_card',args)]){
  assert.equal(JSON.stringify(result).includes(f.sender.run.run_id),false,'former repo runner context must not leak');
 }
});
