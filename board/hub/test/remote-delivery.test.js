import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { remoteRig, oauth, spareBoard, business } from './remote-helpers.js';
import { communicationRig } from './communication-helpers.js';
import { RemoteActions } from '../remote/actions.js';
import { MAX_RESULT_BYTES } from '../remote/result.js';

const MARK = 'SYNTHETIC-PRIVATE-FINAL-DELIVERY';
async function setup(t, options) {
  const f = await remoteRig(t);
  if (options?.spare) options = { boardIds: [f.A.board, await spareBoard(f)] };
  const q = await oauth(f, options), token = f.authority.token(q.body).access_token;
  const scope = f.authority.authenticate(token, 'mcp');
  f.db.run('UPDATE cards SET body=? WHERE id=?', MARK, f.A.card);
  return { f, q, token, scope };
}
async function rpc(f, token, method, params = {}) {
  const res = await fetch(f.h.base + '/api/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'final-delivery', method, params }) });
  const text = await res.text(); assert.equal(res.status, 200, text);
  assert.ok(Buffer.byteLength(text) <= MAX_RESULT_BYTES); return { body: JSON.parse(text), text };
}
function changeAfterProjection(t, f, method, change, at = 1) {
  const original = RemoteActions.prototype[method]; let changed = false, count = 0;
  RemoteActions.prototype[method] = function (...args) {
    const result = original.apply(this, args);
    if (this.hub === f.h.hub && !changed && ++count === at) {
      changed = true; queueMicrotask(change);
    }
    return result;
  };
  t.after(() => { RemoteActions.prototype[method] = original; });
  return () => changed;
}
function withheld(response, marker = MARK) {
  assert.equal(response.text.includes(marker), false);
  assert.equal(response.body.result?.structuredContent, undefined);
  assert.ok(response.body.error || response.body.result?.isError, response.text);
}
function repository(f) {
  const id = randomUUID(); f.db.insert('repos', { id, org_id: f.A.team, canonical_url: `github.com/synthetic/${id}`, short_name: 'current' });
  f.db.run('INSERT INTO board_repos(board_id,repo_id) VALUES(?,?)', f.A.board, id); return id;
}
for (const dimension of ['grant-revoked', 'token-revoked', 'client-revoked', 'member-owner', 'member-removed', 'member-team',
  'role-changed', 'account-deleted', 'team-deleted', 'epoch', 'board-archived', 'grant-narrowed', 'card-board', 'card-repo']) {
  test(`actual SDK final read delivery refuses ${dimension} after its earlier projection`, async t => {
    const { f, q, token, scope } = await setup(t, {spare: dimension === 'grant-narrowed'}), spare = dimension === 'grant-narrowed' ? scope.boardIds.find(id=>id!==f.A.board) : dimension === 'card-board' ? await spareBoard(f) : null;
    const changed = changeAfterProjection(t, f, 'projectRead', () => {
      if (dimension === 'grant-revoked') f.authority.revokeFamily(scope.grant.id);
      if (dimension === 'token-revoked') f.db.run('UPDATE remote_tokens SET revoked_at=? WHERE token_hash=?', f.h.hub.iso(), scope.tokenHash);
      if (dimension === 'client-revoked') f.db.run('UPDATE remote_clients SET revoked_at=? WHERE id=?', f.h.hub.iso(), q.client.client_id);
      if (dimension === 'member-owner') f.db.run('UPDATE members SET user_id=? WHERE id=?', f.users.n.id, f.A.member);
      if (dimension === 'member-removed') f.db.run('UPDATE members SET removed_at=? WHERE id=?', f.h.hub.iso(), f.A.member);
      if (dimension === 'member-team') f.db.run('UPDATE members SET org_id=? WHERE id=?', f.B.team, f.A.member);
      if (dimension === 'role-changed') f.db.run("UPDATE members SET role='admin' WHERE id=?", f.A.member);
      if (dimension === 'account-deleted') f.db.run('UPDATE users SET deleted_at=? WHERE id=?', f.h.hub.iso(), f.users.amember.id);
      if (dimension === 'team-deleted') f.db.run('UPDATE orgs SET deleted_at=? WHERE id=?', f.h.hub.iso(), f.A.team);
      if (dimension === 'epoch') f.db.setMeta('session_epoch', String(f.authority.epoch()+1));
      if (dimension === 'board-archived') f.db.run('UPDATE boards SET archived_at=? WHERE id=?', f.h.hub.iso(), f.A.board);
      if (dimension === 'grant-narrowed') f.db.run('UPDATE remote_grants SET board_ids=? WHERE id=?', JSON.stringify([spare]), scope.grant.id);
      if (dimension === 'card-board') f.db.run('UPDATE cards SET board_id=? WHERE id=?', spare, f.A.card);
      if (dimension === 'card-repo') f.db.run('UPDATE cards SET repo_id=? WHERE id=?', repository(f), f.A.card);
    });
    const r = await rpc(f, token, 'tools/call', { name: 'plexiform_get_card', arguments: { card_id: f.A.card } });
    assert.equal(changed(), true); withheld(r);
    assert.equal(f.db.get('SELECT count(*) n FROM remote_actions').n, 0, 'reads do not manufacture receipts');
  });
}
for (const dimension of ['grant-revoked','member-owner','role-changed']) test(`actual SDK catalog delivery refuses ${dimension} after catalog computation`, async t => {
  const { f, token, scope } = await setup(t);
  const changed = changeAfterProjection(t,f,'catalog',()=>{
    if(dimension==='grant-revoked')f.authority.revokeFamily(scope.grant.id);
    if(dimension==='member-owner')f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.n.id,f.A.member);
    if(dimension==='role-changed')f.db.run("UPDATE members SET role='viewer' WHERE id=?",f.A.member);
  });
  const r=await rpc(f,token,'tools/list');assert.equal(changed(),true);assert.ok(r.body.error);assert.equal(r.body.result?.tools,undefined);
});
test('final catalog reflects current read-only narrowing rather than advertising prior write authority',async t=>{
  const {f,token,scope}=await setup(t);
  const changed=changeAfterProjection(t,f,'catalog',()=>f.db.run("UPDATE remote_grants SET mode='read' WHERE id=?",scope.grant.id));
  const r=await rpc(f,token,'tools/list');assert.equal(changed(),true);assert.equal(r.body.result.tools.length,7);
  assert.ok(r.body.result.tools.every(tool=>tool.annotations.readOnlyHint));
});
test('unchanged current actor gets a freshly recomputed read and current selected-board projection',async t=>{
  const {f,token,scope}=await setup(t,{spare:true}),spare=scope.boardIds.find(id=>id!==f.A.board);
  const changed=changeAfterProjection(t,f,'projectRead',()=>{
    f.db.run('UPDATE remote_grants SET board_ids=? WHERE id=?',JSON.stringify([spare]),scope.grant.id);
  });
  const r=await rpc(f,token,'tools/call',{name:'plexiform_list_boards',arguments:{}});assert.equal(changed(),true);
  assert.deepEqual(r.body.result.structuredContent.boards.map(board=>board.id),[spare]);assert.equal(r.text.includes(f.A.board),false);
});
test('final card read reprojects text changed after initial read instead of retaining an earlier value',async t=>{
  const {f,token}=await setup(t),changed=changeAfterProjection(t,f,'projectRead',()=>f.db.run('UPDATE cards SET body=? WHERE id=?','SYNTHETIC-CURRENT-BODY',f.A.card));
  const r=await rpc(f,token,'tools/call',{name:'plexiform_get_card',arguments:{card_id:f.A.card}});assert.equal(changed(),true);
  assert.equal(r.text.includes(MARK),false);assert.equal(r.body.result.structuredContent.body,'SYNTHETIC-CURRENT-BODY');
});
for(const dimension of ['grant-revoked','role-changed','card-repo'])test(`committed comment response withholds ${dimension} without undoing or executing its receipt twice`,async t=>{
  const {f,token,scope}=await setup(t),args={request_id:randomUUID(),card_id:f.A.card,body:MARK};
  const changed=changeAfterProjection(t,f,'projectMutation',()=>{
    if(dimension==='grant-revoked')f.authority.revokeFamily(scope.grant.id);
    if(dimension==='role-changed')f.db.run("UPDATE members SET role='viewer' WHERE id=?",f.A.member);
    if(dimension==='card-repo')f.db.run('UPDATE cards SET repo_id=? WHERE id=?',repository(f),f.A.card);
  },2);
  const r=await rpc(f,token,'tools/call',{name:'plexiform_add_comment',arguments:args});assert.equal(changed(),true);withheld(r);
  assert.equal(f.db.get('SELECT count(*) n FROM comments WHERE card_id=? AND body=?',f.A.card,MARK).n,1);
  assert.equal(f.db.get('SELECT count(*) n FROM remote_actions WHERE request_id=?',args.request_id).n,1);
  const before=business(f);
  if(dimension==='card-repo') {
    const retry=await rpc(f,token,'tools/call',{name:'plexiform_add_comment',arguments:args});assert.equal(retry.body.result.structuredContent.comment.body,MARK);
    assert.equal(business(f),before,'fresh retry reprojects sole durable receipt without a second mutation');
  }
});
test('durable replay final response refuses a revoked grant while preserving sole business action and pointer receipt',async t=>{
  const {f,token,scope}=await setup(t),args={request_id:randomUUID(),card_id:f.A.card,body:MARK};
  const first=await rpc(f,token,'tools/call',{name:'plexiform_add_comment',arguments:args});assert.equal(first.body.result.structuredContent.comment.body,MARK);
  const before=business(f),changed=changeAfterProjection(t,f,'projectMutation',()=>f.authority.revokeFamily(scope.grant.id),2);
  const r=await rpc(f,token,'tools/call',{name:'plexiform_add_comment',arguments:args});assert.equal(changed(),true);withheld(r);assert.equal(business(f),before);
});
test('delivery proof cannot be JSON cloned, fabricated, moved between authorities or consumed twice',async t=>{
  const {f,token}=await setup(t),other=await remoteRig(t),catalog=f.actions.catalog(token,'mcp');
  for(const value of [{},JSON.parse(JSON.stringify(catalog)),()=>catalog])assert.throws(()=>f.actions.deliver(value),e=>e.code==='NOT_FOUND');
  assert.throws(()=>other.actions.deliver(catalog),e=>e.code==='NOT_FOUND');
  assert.equal(f.actions.deliver(catalog).length,12);assert.throws(()=>f.actions.deliver(catalog),e=>e.code==='NOT_FOUND');
});
test('final fresh read projection enforces the full MCP envelope limit after accumulated material changes',async t=>{
  const {f,token}=await setup(t),changed=changeAfterProjection(t,f,'projectRead',()=>{
    for(let i=0;i<8;i++)f.db.insert('comments',{id:randomUUID(),card_id:f.A.card,author_member_id:f.A.member,source:'web',trusted:1,for_agent:0,body:'a'.repeat(10_000),created_at:f.h.hub.iso()});
  });
  const r=await rpc(f,token,'tools/call',{name:'plexiform_get_card',arguments:{card_id:f.A.card}});assert.equal(changed(),true);withheld(r);
  assert.equal(JSON.parse(r.body.result.content[0].text).error.code,'PAYLOAD_TOO_LARGE');assert.equal(f.db.get('SELECT count(*) n FROM remote_actions').n,0);
});

for (const operation of ['read','replay']) test(`final sealed packet ${operation} delivery rechecks current evidence/run provenance without rewriting immutable bytes`,async t=>{
  const f=await communicationRig(t); f.h.hub.config.publicUrl=f.h.base; f.authority=f.h.hub.remoteAuthority;
  f.actions=new RemoteActions(f.h.hub); const q=await oauth(f),token=f.authority.token(q.body).access_token,id=f.sender.run.card_id;
  const attached=await f.sender.client.rpc(f.sender.run,'board_attach_evidence',{kind:'log',ref:'https://synthetic.test/final',summary:MARK});
  assert.equal(attached.ok,true,JSON.stringify(attached.error));
  const args={card_id:id,request_id:randomUUID(),expected_version:0,expected_fence:f.h.hub.card(id).fence,
    data:{brief:MARK,decisions:[],progress:'',nextAction:'',artifacts:[{kind:'evidence',id:attached.result.evidence_id}],reportedChecks:[]}};
  const first=await rpc(f,token,'tools/call',{name:'plexiform_write_packet',arguments:args});
  assert.equal(first.body.result.structuredContent.packet.evidence[0].summary,MARK);
  const stored=f.db.get('SELECT * FROM task_packets WHERE id=?',first.body.result.structuredContent.packet.id),before=business(f);
  const changed=changeAfterProjection(t,f,operation==='read'?'projectRead':'projectMutation',()=>{
    f.db.run('UPDATE runs SET repo_id=? WHERE id=?',repository(f),f.sender.run.run_id);
  },operation==='read'?1:2);
  const r=await rpc(f,token,'tools/call',{name:operation==='read'?'plexiform_read_packet':'plexiform_write_packet',arguments:operation==='read'?{card_id:id}:args});
  assert.equal(changed(),true);withheld(r);assert.deepEqual(f.db.get('SELECT * FROM task_packets WHERE id=?',stored.id),stored);
  assert.equal(business(f),before,'no additional packet, journal or remote receipt');
});
