import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { remoteRig, grant, oauth } from './remote-helpers.js';
import { communicationRig, taskMessage } from './communication-helpers.js';
import { RemoteActions } from '../remote/actions.js';
import { drawer } from '../../web/js/render-drawer.js';
import { displayFace } from '../../web/js/view.js';
import { packetPanel, messagePanel } from '../../web/js/render-communication.js';

const text = node => node == null ? '' : Array.isArray(node) ? node.map(text).join(' ') : node.tag === '#text' ? node.text : (node.children ?? []).map(text).join(' ');
async function comment(f,g) {
  return f.actions.call(g.token,'integration','plexiform_add_comment',{card_id:f.A.card,body:'Reported work, not evidence',request_id:randomUUID()});
}
test('ordinary staff card detail and text-only renderer expose unverified application provenance',async t=>{
  const f=await remoteRig(t),g=await grant(f,{name:'<img src=x onerror=alert(1)> Synthetic app'}),created=await comment(f,g);
  const result=await f.as(f.users.ua,'GET',`/api/cards/${f.A.card}`);assert.equal(result.status,200,result.text);
  const c=result.body.comments.find(row=>row.id===created.comment.id);assert.equal(c.identity_source,'remote_grant');assert.equal(c.application_verified,false);assert.equal(c.account_id,f.users.amember.id);
  const vnode=drawer({detail:{cardId:f.A.card,data:result.body,tab:'comments',at:0},clock:0,now:0,readOnly:true,entries:[{view:result.body.card,face:displayFace(result.body.card)}],me:{member:f.h.hub.activeMember(f.A.owner)}});
  assert.match(text(vnode),/via .*Synthetic app.*unverified application/);assert.equal(JSON.stringify(vnode).includes('"tag":"img"'),false);
});

test('remote packet/message and its ordinary comment remain unverified in human views',async t=>{
  const f=await communicationRig(t);f.h.hub.config.publicUrl=f.h.base;f.authority=f.h.hub.remoteAuthority;f.actions=new RemoteActions(f.h.hub);
  const g=await grant(f),id=f.sender.run.card_id;
  const packet=await f.actions.call(g.token,'integration','plexiform_write_packet',{card_id:id,request_id:randomUUID(),expected_version:0,expected_fence:f.h.hub.card(id).fence,data:{brief:'A handoff',decisions:[],progress:'',nextAction:'Review',artifacts:[],reportedChecks:[]}});
  const message=await f.actions.call(g.token,'integration','plexiform_send_message',{card_id:id,expected_fence:f.h.hub.card(id).fence,...taskMessage(f.recipient)});
  const detail=f.actions.api.detail(f.h.hub.activeMember(f.A.owner),id),c=detail.comments.find(row=>row.id===f.db.get('SELECT comment_id FROM task_messages WHERE id=?',message.message.id).comment_id);
  assert.equal(c.identity_source,'remote_grant');assert.equal(c.application_verified,false);
  const model={me:{member:{role:'viewer'}},board:{}},state={cardId:id,data:detail,packetLoaded:true,packet:packet.packet,messagesLoaded:true,messages:{messages:[message.message],peers:[]}};
  assert.match(text(packetPanel(state,model)),/unverified application/);assert.match(text(messagePanel(state,model)),/unverified application/);
  assert.equal(packet.packet.author.provider,null);assert.equal(message.message.grants_execution,false);
});

for(const deletion of ['account','team'])test(`${deletion} deletion atomically clears capability material and application label but retains remote history`,async t=>{
  const f=await remoteRig(t),g=await grant(f,{name:'Personal application label to erase'}),created=await comment(f,g),q=await oauth(f);
  const tokens=f.authority.token(q.body),gesture=f.authority.gesture(g.member,g.identity.cred,{purpose:'create'}),unconsumed=f.authority.authorize(q.params);
  f.authority.preview(unconsumed.intent_id,unconsumed.browser,q.identity);f.authority.consent(g.member,q.identity.cred,unconsumed.intent_id,unconsumed.browser,{approve:true,board_ids:[f.A.board],mode:'read'});
  const receipts=f.db.all('SELECT * FROM remote_actions');
  if(deletion==='account')f.h.hub.accounts.eraseUser(g.identity.user);
  else f.h.hub.teams.deleteTeam(f.db.get('SELECT * FROM orgs WHERE id=?',f.A.team));
  for(const token of[g.token,tokens.access_token])assert.throws(()=>f.authority.authenticate(token,token===g.token?'integration':'mcp'),error=>error.code==='UNAUTHENTICATED');
  assert.equal(f.db.get('SELECT count(*) n FROM remote_tokens WHERE grant_id IN (SELECT id FROM remote_grants WHERE org_id=?)',f.A.team).n,0);
  assert.equal(f.db.get('SELECT count(*) n FROM remote_codes WHERE grant_id IN (SELECT id FROM remote_grants WHERE org_id=?)',f.A.team).n,0);
  assert.equal(f.db.get('SELECT 1 x FROM remote_gestures WHERE id=?',gesture.gesture_id),null);
  if(deletion==='account')assert.equal(f.db.get('SELECT 1 x FROM remote_intents WHERE id=?',unconsumed.intent_id),null);
  const grants=f.db.all('SELECT * FROM remote_grants WHERE org_id=?',f.A.team);assert.ok(grants.length>=3);assert.ok(grants.every(row=>row.revoked_at&&row.application==='Deleted connection'));
  assert.deepEqual(f.db.all('SELECT * FROM remote_actions'),receipts);
  const identity=f.actions.commentIdentity({id:created.comment.id});assert.equal(identity.identity_source,'remote_grant');assert.equal(identity.application,'Deleted connection');assert.equal(identity.application_verified,false);
  for(const patch of["application='Other label'","revoked_at=NULL"] )assert.throws(()=>f.db.run('UPDATE remote_grants SET '+patch+' WHERE id=?',g.grant.id));
});

test('live grant labels cannot be tombstoned and failed deletion rolls all capability cleanup back',async t=>{
  const f=await remoteRig(t),g=await grant(f);
  assert.throws(()=>f.db.run("UPDATE remote_grants SET application='Deleted connection',revoked_at=? WHERE id=?",f.h.hub.iso(),g.grant.id));
  const before=JSON.stringify(['users','orgs','remote_grants','remote_tokens'].map(table=>f.db.all(`SELECT * FROM ${table} ORDER BY rowid`)));
  const original=f.authority.cleanupDeleted.bind(f.authority);f.authority.cleanupDeleted=now=>{original(now);throw new Error('synthetic failure after cleanup');};
  assert.throws(()=>f.h.hub.accounts.eraseUser(g.identity.user),/synthetic failure/);
  assert.equal(JSON.stringify(['users','orgs','remote_grants','remote_tokens'].map(table=>f.db.all(`SELECT * FROM ${table} ORDER BY rowid`))),before);
  assert.equal(f.authority.authenticate(g.token).member.id,f.A.member);
});
