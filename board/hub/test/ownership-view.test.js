import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { communicationRig } from './communication-helpers.js';
import { runHb, until } from './helpers.js';
import { OWNERSHIP_TTL_MS } from '../ownership.js';
import { readOwnership, guardOwnership } from '../ownership-view.js';

async function declared(t) {
  const f = await communicationRig(t);
  for (const [participant, paths] of [[f.sender, ['src/shared/**']], [f.recipient, ['src/shared/ui.js']]]) {
    const d = await participant.client.rpc(participant.run, 'board_declare_plan', { paths });
    assert.equal(d.ok, true);
    await participant.client.hb([runHb(participant.run, { child_alive: true, cost_usd: null })]);
  }
  return f;
}

test('actual staff ownership HTTP exposes bounded current declarations, overlaps and a relative lease to writers and viewers', async t => {
  const f = await declared(t), path = `/api/cards/${f.sender.run.card_id}/ownership?board_id=${f.A.board}`;
  for (const user of [f.users.amember, f.users.aviewer]) {
    const r = await f.as(user, 'GET', path);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ownership.state, 'editing');
    assert.ok(r.body.ownership.expires_in_ms > 0 && r.body.ownership.expires_in_ms <= OWNERSHIP_TTL_MS);
    assert.equal(r.body.ownership.card_key, f.sender.run.key);
    assert.deepEqual(r.body.ownership.paths, ['src/shared/**']);
    assert.equal(r.body.ownership_overlaps.length, 1);
    assert.equal(r.body.ownership_intents.length, 2);
    assert.equal(r.body.grants_execution, false); assert.equal(r.body.global_filesystem_lock, false);
    assert.equal(r.text.includes('B-SECRET'), false);
  }
  f.h.clock.advance(OWNERSHIP_TTL_MS + 1);
  const expired = await f.as(f.users.amember, 'GET', path);
  assert.equal(expired.status, 200);
  assert.equal(expired.body.ownership.state, 'planned');
  assert.equal(expired.body.ownership.expires_in_ms, null);
});

test('current card, selected board and live repository are checked before returning declarations', async t => {
  const f = await declared(t), path = `/api/cards/${f.sender.run.card_id}/ownership`;
  for (const [user, target] of [[f.users.ub, path], [f.users.n, path], [f.users.amember, `${path}?board_id=${f.B.board}`]]) {
    const r = await f.as(user, 'GET', target);
    assert.ok([403, 404].includes(r.status), r.text);
    assert.equal(r.text.includes('src/shared'), false);
  }
  f.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?', f.A.board, f.A.repo);
  const unavailable = await f.as(f.users.amember, 'GET', path);
  assert.equal(unavailable.status, 404);
  assert.equal(unavailable.text.includes('src/shared'), false);
});

for (const change of ['credential-revoked', 'credential-owner-and-member-rebound', 'membership-removed', 'card-archived', 'repository-unlinked']) {
  test(`actual queued ownership HTTP refuses ${change} without disclosing old paths`, async t => {
    const f = await declared(t), hub = f.h.hub, original = hub.withBoard.bind(hub);
    let release, entered = false;
    const held = original(f.A.board, () => new Promise(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    hub.withBoard = (id, fn) => { if (id === f.A.board) entered = true; return original(id, fn); };
    try {
      const pending = f.as(f.users.amember, 'GET', `/api/cards/${f.sender.run.card_id}/ownership`);
      await until(() => entered);
      if (change === 'credential-revoked') f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?', hub.iso(), f.users.amember.device_id);
      if (change === 'credential-owner-and-member-rebound') {
        f.db.run('UPDATE user_devices SET user_id=? WHERE id=?', f.users.ub.id, f.users.amember.device_id);
        f.db.run('UPDATE members SET user_id=? WHERE id=?', f.users.ub.id, f.A.member);
      }
      if (change === 'membership-removed') f.db.run('UPDATE members SET removed_at=? WHERE id=?', hub.iso(), f.A.member);
      if (change === 'card-archived') f.db.run('UPDATE cards SET archived_at=? WHERE id=?', hub.iso(), f.sender.run.card_id);
      if (change === 'repository-unlinked') f.db.run('DELETE FROM board_repos WHERE board_id=? AND repo_id=?', f.A.board, f.A.repo);
      release(); await held;
      const r = await pending;
      assert.ok([401, 403, 404, 409].includes(r.status), r.text);
      assert.equal(r.text.includes('src/shared'), false);
    } finally { release?.(); await held; hub.withBoard = original; }
  });
}

test('authority and projections are fresh after the queued read resolves', async t => {
  const f = await declared(t), own = f.h.hub.ownership, original = own.staffRead.bind(own);
  own.staffRead = async (...args) => {
    const result = await original(...args);
    f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?', f.h.hub.iso(), f.users.amember.device_id);
    return result;
  };
  const r = await f.as(f.users.amember, 'GET', `/api/cards/${f.sender.run.card_id}/ownership`);
  assert.equal(r.status, 401); assert.equal(r.text.includes('src/shared'), false);
});

test('an after-read peer removal cannot survive in the delivered projection', async t => {
  const f = await declared(t), own = f.h.hub.ownership, original = own.staffRead.bind(own);
  own.staffRead = async (...args) => {
    const result = await original(...args);
    f.db.run('UPDATE members SET removed_at=? WHERE id=?', f.h.hub.iso(), f.A.admin);
    return result;
  };
  const r = await f.as(f.users.amember, 'GET', `/api/cards/${f.sender.run.card_id}/ownership`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.ownership_intents.some(p => p.run_id === f.recipient.run.run_id), false);
  assert.deepEqual(r.body.ownership_overlaps, []);
});

test('queued caller mutations cannot replace the original credential or board selection', async t => {
  const f = await declared(t), hub = f.h.hub, member = { ...hub.member(f.A.member) },
    cred = { kind: 'device', id: f.users.amember.device_id }, boards = [f.A.board];
  let release;
  const held = hub.withBoard(f.A.board, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  try {
    const pending = readOwnership(hub, member, f.sender.run.card_id, cred, { boardIds: boards }).then(value => ({ value }), error => ({ error }));
    f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?', hub.iso(), f.users.amember.device_id);
    cred.id = f.users.aadmin.device_id; member.user_id = f.users.aadmin.id; boards.push(f.B.board);
    release(); await held;
    const result = await pending;
    assert.equal(result.error?.code, 'UNAUTHENTICATED'); assert.equal(result.value, undefined);
  } finally { release?.(); await held; }
});

for (const change of ['credential-revoked', 'owner-rebound', 'repository-moved', 'peer-removed', 'lease-expired']) {
  test(`final ordinary HTTP response boundary rechecks ${change}`, async t => {
    const f = await declared(t), hub=f.h.hub, original=hub.ownership.snapshotFor.bind(hub.ownership); let calls=0;
    hub.ownership.snapshotFor=(...args)=>{
      const result=original(...args);
      if(++calls===2)queueMicrotask(()=>{
        if(change==='credential-revoked')f.db.run('UPDATE user_devices SET revoked_at=? WHERE id=?',hub.iso(),f.users.amember.device_id);
        if(change==='owner-rebound'){
          f.db.run('UPDATE user_devices SET user_id=? WHERE id=?',f.users.ub.id,f.users.amember.device_id);
          f.db.run('UPDATE members SET user_id=? WHERE id=?',f.users.ub.id,f.A.member);
        }
        if(change==='repository-moved'){
          const repo=randomUUID();f.db.insert('repos',{id:repo,org_id:f.A.team,canonical_url:`github.com/current/${repo}`,short_name:'current'});
          f.db.run('INSERT INTO board_repos(board_id,repo_id) VALUES(?,?)',f.A.board,repo);
          f.db.run('UPDATE cards SET repo_id=? WHERE id=?',repo,f.sender.run.card_id);
        }
        if(change==='peer-removed')f.db.run('UPDATE members SET removed_at=? WHERE id=?',hub.iso(),f.A.admin);
        if(change==='lease-expired')f.h.clock.advance(OWNERSHIP_TTL_MS+1);
      });return result;
    };
    const r=await f.as(f.users.amember,'GET',`/api/cards/${f.sender.run.card_id}/ownership`);
    if(['credential-revoked','owner-rebound','repository-moved'].includes(change)){
      assert.ok([401,403,404,409].includes(r.status),`status ${r.status}`);assert.equal(r.text.includes('src/shared'),false);
    }else{
      assert.equal(r.status,200);
      if(change==='peer-removed'){assert.equal(r.body.ownership_intents.length,1);assert.deepEqual(r.body.ownership_overlaps,[]);}
      else{assert.equal(r.body.ownership.state,'planned');assert.equal(r.body.ownership.expires_in_ms,null);}
    }
  });
}
test('final delivery refuses forged projection bindings',async t=>{
  const f=await declared(t),value=await readOwnership(f.h.hub,f.h.hub.member(f.A.member),f.sender.run.card_id,{kind:'device',id:f.users.amember.device_id});
  assert.throws(()=>guardOwnership(f.h.hub,{...value}),{code:'FORBIDDEN'});
  assert.throws(()=>guardOwnership({},value),{code:'FORBIDDEN'});
});
