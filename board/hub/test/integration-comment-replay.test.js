import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {startHub} from './helpers.js';
import {createSentryConnector} from '../integrations/sentry/index.js';

async function fixture(t) {
  let h = await startHub(); t.after(() => h.close());
  h.hub.setVaultKey(randomBytes(32));
  h.app.integrations.register(createSentryConnector());
  const connection = h.app.integrations.createConnection({orgId:h.ids.org, memberId:h.ids.alice, provider:'sentry', external_id:'synthetic'});
  const cookie = await h.login('alice'), first = await h.createCard(cookie), second = await h.createCard(cookie);
  return {
    get h() { return h; }, connection, first, second,
    async restart() { const dataDir=h.dataDir; await h.close(); h=await startHub({dataDir}); h.app.integrations.register(createSentryConnector()); },
    comment(card, request='status-1') { const ctx=h.app.integrations.ctxFor(connection.id); return ctx.act('sentry.notice', {card_id:card.id}, s=>s.actAs(h.ids.alice).comment(card.id,{request_id:request,body:'Sentry reports resolved.'})); },
  };
}
test('integration comment is recorded once across an actual hub restart', async t => {
  const f=await fixture(t), first=await f.comment(f.first);
  await f.restart(); const replay=await f.comment(f.first);
  assert.equal(replay.result.comment.id,first.result.comment.id);
  assert.equal(f.h.db.get('SELECT count(*) n FROM comments WHERE card_id=?',f.first.id).n,1);
  assert.equal(f.h.db.get("SELECT count(*) n FROM journal WHERE card_id=? AND kind='comment.create'",f.first.id).n,1);
});
for(const restart of [false,true]) test(`integration comment request cannot target another card after ${restart?'restart':'cache hit'}`, async t => {
  const f=await fixture(t); await f.comment(f.first); if(restart)await f.restart();
  await assert.rejects(f.comment(f.second),error=>error.code==='CONFLICT');
  assert.equal(f.h.db.get('SELECT count(*) n FROM comments WHERE card_id=?',f.second.id).n,0);
});
test('a failed durable receipt rolls back the comment and its journal before the same request succeeds', async t => {
  const f=await fixture(t), before=f.h.db.get('SELECT count(*) n FROM journal').n;
  f.h.db.exec("CREATE TEMP TRIGGER fail_comment_receipt BEFORE INSERT ON integration_comment_requests BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;");
  await assert.rejects(f.comment(f.first), /synthetic receipt failure/);
  assert.equal(f.h.db.get('SELECT count(*) n FROM comments WHERE card_id=?',f.first.id).n,0);
  assert.equal(f.h.db.get('SELECT count(*) n FROM journal').n,before);
  f.h.db.exec('DROP TRIGGER fail_comment_receipt');
  await f.comment(f.first); await f.comment(f.first);
  assert.equal(f.h.db.get('SELECT count(*) n FROM comments WHERE card_id=?',f.first.id).n,1);
});
for(const change of ['pause','autonomy']) test(`queued integration comment rechecks ${change} and can retry after recovery`, async t => {
  const f=await fixture(t); let release, admitted;
  const entered=new Promise(r=>admitted=r),original=f.h.app.api.comment;
  const held=f.h.hub.withBoard(f.h.ids.board,()=>new Promise(r=>release=r));
  await new Promise(r=>setImmediate(r));
  f.h.app.api.comment=function(...args){const result=original.apply(this,args);admitted();return result;};
  let delivery;
  try {
    delivery=f.comment(f.first); const refused=assert.rejects(delivery,error=>error.code==='FORBIDDEN'); await entered;
    if(change==='pause')f.h.db.run("UPDATE connections SET status='paused' WHERE id=?",f.connection.id);
    else f.h.app.integrations.setSettings(f.connection.id,{autonomy:{'sentry.notice':'off'}});
    release();await held;await refused;
    assert.equal(f.h.db.get('SELECT count(*) n FROM comments WHERE card_id=?',f.first.id).n,0);
    if(change==='pause')f.h.db.run("UPDATE connections SET status='active' WHERE id=?",f.connection.id);
    else f.h.app.integrations.setSettings(f.connection.id,{autonomy:{'sentry.notice':null}});
    await f.comment(f.first);assert.equal(f.h.db.get('SELECT count(*) n FROM comments WHERE card_id=?',f.first.id).n,1);
  } finally { release?.();await held;await delivery?.catch(()=>{});f.h.app.api.comment=original; }
});
