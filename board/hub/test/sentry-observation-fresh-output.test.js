// Regressions for independently observed cached and post-await output failures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash,createHmac} from 'node:crypto';
import {startHub} from './helpers.js';
import {createSentryConnector} from '../integrations/sentry/index.js';
const observations=[];
async function fixture(t){const h=await startHub();t.after(()=>h.destroy());h.hub.setVaultKey(randomBytes(32));h.app.integrations.register(createSentryConnector({now:()=>h.clock.wall()}));const cookie=await h.login('alice'),secret=randomBytes(24).toString('base64url');const response=await h.api(cookie,'POST','/api/integrations/sentry/token',{token:secret});assert.equal(response.status,200,response.text);const c=response.body.connection;await h.api(cookie,'PATCH',`/api/integrations/${c.id}`,{config:{default_board_id:h.ids.board}});const card=await h.createCard(cookie);const ctx=h.app.integrations.ctxFor(c.id);await ctx.act('sentry.status',{},s=>s.link(card.id,'issue','12345'));return{h,c,cookie,secret,card,ctx};}
const request=seed=>`sentry-issue-status-12345-${createHash('sha256').update(seed).digest('hex')}`;
const observe=(f,seed='one',state='resolved',card=f.card)=>f.ctx.act('sentry.status',{card_id:card.id},s=>s.actAs(f.h.ids.alice).observeLink(card.id,'issue','12345',{state},{request_id:request(seed),body:`Synthetic ${state}`}));
const counts=f=>({comments:f.h.db.get("SELECT count(*) n FROM comments WHERE source='integration'").n,receipts:f.h.db.get('SELECT count(*) n FROM integration_comment_requests').n});
const status=f=>JSON.parse(f.h.db.get('SELECT status FROM external_links WHERE connection_id=?',f.c.id)?.status??'{}');
for(const change of ['pause','user-rebind','unlink','card-archive'])test(`final observation result refuses ${change} after API committed before registry await resolves`,async t=>{
 const f=await fixture(t);const original=f.h.app.api.comment;let entered,release;const admitted=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 f.h.app.api.comment=async function(...args){const out=await original.apply(this,args);entered();await hold;return out;};
 const pending=observe(f);await admitted;assert.deepEqual(counts(f),{comments:1,receipts:1});
 if(change==='pause')f.h.db.run("UPDATE connections SET status='paused' WHERE id=?",f.c.id);
 if(change==='user-rebind'){const user=randomUUID();f.h.db.insert('users',{id:user,display_name:'Synthetic replacement',created_at:f.h.hub.iso()});f.h.db.run('UPDATE members SET user_id=? WHERE id=?',user,f.h.ids.alice);}
 if(change==='unlink')f.h.db.run('DELETE FROM external_links WHERE connection_id=?',f.c.id);
 if(change==='card-archive')f.h.db.run('UPDATE cards SET archived_at=? WHERE id=?',f.h.hub.iso(),f.card.id);
 release();let out,error;try{out=await pending;}catch(e){error={code:e.code,cacheable:e.cacheable};}
 observations.push({test:'final-output',change,out,error,counts:counts(f),cached:!!f.h.hub.cachedResponse(f.h.ids.alice,`int:${f.c.id}:${request('one')}`)});
 assert.ok(error,`expected fresh refusal, got ${JSON.stringify(out)}`);
 assert.equal(error.cacheable,false);assert.deepEqual(counts(f),{comments:1,receipts:1},'already committed effects remain truthful');
});
test('D8 observation replay refuses same event remapped to a second card instead of returning first card comment',async t=>{
 const f=await fixture(t),one=await observe(f);const next=await f.h.createCard(f.cookie);
 f.h.db.run('UPDATE external_links SET card_id=? WHERE connection_id=?',next.id,f.c.id);
 let out,error;try{out=await observe(f,'one','resolved',next);}catch(e){error=e.code;}
 observations.push({test:'cache-cross-card',firstComment:one.result.comment.id,newCard:next.id,out,error,counts:counts(f)});
 assert.equal(error,'CONFLICT',`cached output must bind comment to requested card, got ${JSON.stringify(out)}`);
});
test('durable046 cross-card replay already refuses after in-memory cache clear',async t=>{
 const f=await fixture(t);await observe(f);const next=await f.h.createCard(f.cookie);f.h.db.run('UPDATE external_links SET card_id=? WHERE connection_id=?',next.id,f.c.id);f.h.hub.requestCache.clear();await assert.rejects(observe(f,'one','resolved',next),e=>e.code==='CONFLICT');assert.deepEqual(counts(f),{comments:1,receipts:1});
});

test('cached observation needs its exact durable receipt even while the link remains live',async t=>{
 const f=await fixture(t);await observe(f);f.h.db.run('DELETE FROM integration_comment_requests WHERE connection_id=?',f.c.id);await assert.rejects(observe(f),e=>e.code==='CONFLICT'&&e.cacheable===false);assert.deepEqual(counts(f),{comments:1,receipts:0});
});
for(const change of ['settings','autonomy'])test(`post-commit ${change} refuses private output and success cache without undoing effects`,async t=>{
 const f=await fixture(t),original=f.h.app.api.comment;let entered,release;const admitted=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 f.h.app.api.comment=async function(...args){const out=await original.apply(this,args);entered();await hold;return out;};
 const pending=observe(f),refusal=assert.rejects(pending,e=>e.code==='FORBIDDEN'&&e.cacheable===false);await admitted;
 const prior=JSON.parse(f.h.db.get('SELECT settings FROM connections WHERE id=?',f.c.id).settings);
 const settings=change==='settings'?{...prior,config:{...prior.config,include_message:true}}:{...prior,autonomy:{...prior.autonomy,'sentry.status':'off'}};
 f.h.db.run('UPDATE connections SET settings=? WHERE id=?',JSON.stringify(settings),f.c.id);release();await refusal;assert.deepEqual(counts(f),{comments:1,receipts:1});assert.equal(f.h.hub.cachedResponse(f.h.ids.alice,`int:${f.c.id}:${request('one')}`),null);
});
