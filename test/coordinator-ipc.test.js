'use strict';
// Complete renderer/preload/main/service/controls path against an injected
// shared-session hub. This exercises production IPC guards without paid work.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { createOverviewMain } = require('../src/overview-main');
const ROOT = path.join(__dirname, '..'), read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tick = async () => { for (let i = 0; i < 15; i++) await new Promise(r => setImmediate(r)); };
function fixture() {
  let revoked = false;
  const handlers = new Map(), calls = [];
  const state = { provider: { id: 'codex', label: 'Codex' }, generation: 1, activeTurn: null, status: 'ready', capabilities: { newTurn: true }, deliveries: [] };
  const contents = { id: 2, mainFrame: {}, isDestroyed: () => false, send() {} };
  const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => ctx.foreground };
  const ctx = { contents, window: win, generation: 1, document: 1, foreground: true };
  const buddy = { overviewContext: () => ctx.foreground ? ctx : null, overviewReadContext: () => ctx };
  const hub = { origin: 'https://hub.example', viewer: () => ({ id: 'human', name: 'Human' }),
    teams: async () => [{ id: 'team-1', name: 'Dev' }],
    sessions: async () => revoked ? [] : [{ ref: 'private-provider-ref', team: { id: 'team-1', name: 'Dev' }, owner: { id: 'bob', name: 'Bob' }, share: { explicit: true, scope: 'interact' }, provider: state.provider, device: { label: 'Other Mac' }, task_title: 'Review parser', state: 'idle', online: true, observed_at: Date.now(), capabilities: { newTurn: true } }],
    inspect: async (_v, _team, ref) => !revoked && ref === 'private-provider-ref' ? { ok: true, state: structuredClone(state) } : { ok: false, status: 'forbidden' },
    act: async (_v, _team, ref, command, _id, fresh) => {
      if (revoked || !fresh() || ref !== 'private-provider-ref' || command.generation !== state.generation || command.turn !== state.activeTurn) return { ok: false, status: 'stale' };
      calls.push(command); const delivery = { id: crypto.randomUUID(), text: command.text, state: 'acknowledged', response: '' }; state.deliveries.push(delivery); return { ok: true, status: 'acknowledged', delivery };
    },
  };
  const overview = createOverviewMain({ buddy: () => buddy, teamHub: () => hub });
  overview.register({ handle: (key, fn) => handlers.set(key, fn) });
  let api;
  const event = { sender: contents, senderFrame: contents.mainFrame };
  vm.runInNewContext(read('overview-preload.js'), { Buffer, Promise, require: () => ({ contextBridge: { exposeInMainWorld(_key, value) { api = value; } }, ipcRenderer: { invoke: (key, ...args) => Promise.resolve(handlers.get(key)(event, ...structuredClone(args))).then(structuredClone), on() {}, removeListener() {} } }) });
  const dom = new JSDOM(read('overview.html'), { runScripts: 'outside-only', pretendToBeVisual: true }), doc = dom.window.document;
  dom.window.overviewApi = api; dom.window.eval(read('overview-coordinator.js'));
  const $ = id => doc.getElementById(id);
  return { api, ctx, handlers, event, calls, state, dom, doc, $, hub, revoke: () => revoked = true,
    async draft() {
      const d = await api.directory({ view: 'team', team: null }); const option = doc.createElement('option'); option.value = d.team.key; $('team-pick').append(option);
      $('team-section').hidden = false; $('coordinator-panel').open = true; $('coordinator-refresh').click(); await tick();
      $('coordinator-title').value = 'Parser review'; doc.querySelector('[aria-label="Assignment name"]').value = 'Reviewer';
      const select = doc.querySelector('[aria-label="Assignment session"]'); select.selectedIndex = 1;
      doc.querySelector('[aria-label="Assignment message"]').value = 'Inspect parser behavior'; $('coordinator-review').click(); await tick();
    },
    close() { overview.close(); dom.window.close(); },
  };
}
test('actual Overview bridge reaches named review, exact guarded send and correlated reply', async () => {
  const x = fixture();
  try {
    await x.draft(); assert.equal(x.$('coordinator-preview').hidden, false); assert.equal(x.calls.length, 0);
    const grant = x.$('coordinator-results').querySelector('input'); assert.ok(grant); grant.checked = true; grant.dispatchEvent(new x.dom.window.Event('change'));
    x.$('coordinator-confirm').click(); await tick(); assert.equal(x.calls.length, 1); assert.equal(x.calls[0].text, 'Inspect parser behavior');
    x.state.deliveries[0].response = 'Correlated parser review'; x.state.deliveries[0].state = 'completed';
    x.$('coordinator-replies').click(); await tick(); assert.match(x.$('coordinator-results').textContent, /Correlated parser review/);
    assert.doesNotMatch(x.doc.body.textContent, /private-provider-ref/);
  } finally { x.close(); }
});
test('first coordinator inventory can adopt the initial team through real service without a second click', async () => {
  const x = fixture(); try { const r = await x.api.coordinator.inventory({ team: null }); assert.equal(r.ok, true); assert.equal(r.entries.length, 1); assert.equal(x.calls.length, 0); } finally { x.close(); }
});
for (const mutation of ['revoked', 'background', 'document', 'busy']) test(`${mutation} after actual renderer review refuses without provider dispatch`, async () => {
  const x = fixture();
  try {
    await x.draft(); const grant = x.$('coordinator-results').querySelector('input'); assert.ok(grant); grant.checked = true; grant.dispatchEvent(new x.dom.window.Event('change'));
    if (mutation === 'revoked') x.revoke();
    if (mutation === 'background') x.ctx.foreground = false;
    if (mutation === 'document') x.ctx.document++;
    if (mutation === 'busy') { x.state.status = 'working'; x.state.activeTurn = crypto.randomUUID(); }
    x.$('coordinator-confirm').click(); await tick(); assert.equal(x.calls.length, 0);
  } finally { x.close(); }
});
test('forged preload authority and foreign-frame calls fail closed', async () => {
  const x = fixture(); try {
    assert.equal((await x.api.coordinator.propose({ team: 'a'.repeat(32), title: 'Forged', assignments: [], actor: 'owner' })).ok, false);
    const result = await x.handlers.get('overview:coordinator-inventory')({ sender: x.event.sender, senderFrame: {} }, { team: null }); assert.equal(result.ok, false); assert.equal(x.calls.length, 0);
  } finally { x.close(); }
});

test('owner request UI uses real preload/main and exact one-use selection before executing an approved proposal',async()=>{
 const x=fixture(), records=new Map(), effects=[];
 x.hub.proposals=async(_viewer,_team,_ref,operation,input,fresh)=>{
  if(!fresh())return{ok:false,status:'stale'};
  if(operation==='request'){const p={...input,status:'pending',digest:'a'.repeat(64),acknowledgedAt:null,expiresAt:null,receipt:null};records.set(p.id,p);return{ok:true,proposal:{...p}};}
  if(operation==='list')return{ok:true,proposals:[...records.values()].map(p=>({...p}))};
  const p=records.get(input.id);if(!p||p.status!=='approved')return{ok:false,status:'stale'};
  p.status='sent';p.receipt={id:crypto.randomUUID(),state:'acknowledged'};effects.push(input.text);return{ok:true,proposal:{...p}};
 };
 try{
  await x.draft();x.$('coordinator-request-owner').click();await tick();assert.equal(records.size,1);assert.deepEqual(effects,[]);
  const p=[...records.values()][0];assert.equal(p.text,'Inspect parser behavior');p.status='approved';p.acknowledgedAt=new Date().toISOString();p.expiresAt=new Date(Date.now()+600000).toISOString();
  const button=label=>[...x.doc.querySelectorAll('button')].find(b=>b.textContent===label);
  button('Check owner decisions for this session').click();await tick();assert.match(x.doc.body.textContent,/Owner acknowledged this exact version/);
  button('Send this approved message once').click();await tick();assert.deepEqual(effects,['Inspect parser behavior']);assert.match(x.doc.body.textContent,/Provider receipt:/);
  assert.equal(button('Send this approved message once'),undefined);
 }finally{x.close();}
});

for(const change of ['background','document','revoke'])test(`owner-approved selection is fenced after ${change}`,async()=>{
 const x=fixture();let effects=0;
 const p={id:crypto.randomUUID(),decision:crypto.randomUUID(),version:1,generation:1,title:'Exact request',text:'Only this',digest:'a'.repeat(64),status:'approved',receipt:null};
 x.hub.proposals=async(_v,_t,_r,op,_p,fresh)=>{if(!fresh())return{ok:false};if(op==='list')return{ok:true,proposals:[p]};effects++;return{ok:true,proposal:p};};
 try{
  await x.draft();const id=x.doc.querySelector('[aria-label="Assignment session"]').value;
  const list=await x.api.coordinator.remoteList({id});assert.equal(list.ok,true);
  if(change==='background')x.ctx.foreground=false;if(change==='document')x.ctx.document++;if(change==='revoke')x.revoke();
  assert.equal((await x.api.coordinator.remoteSend({selection:list.proposals[0].selection})).ok,false);assert.equal(effects,0);
 }finally{x.close();}
});

test('revising a retained owner decision sends exact replacement text through one-use IPC review',async()=>{
 const x=fixture(),records=[{id:crypto.randomUUID(),decision:crypto.randomUUID(),version:1,generation:1,title:'Original request',text:'Earlier text',digest:'a'.repeat(64),status:'approved',receipt:null}],requests=[];
 x.hub.proposals=async(_v,_t,_r,op,input,fresh)=>{if(!fresh())return{ok:false};if(op==='list')return{ok:true,proposals:records.map(p=>({...p}))};assert.equal(op,'request');requests.push(input);records[0].status='superseded';const p={...input,status:'pending',receipt:null};records.push(p);return{ok:true,proposal:p};};
 try{
  await x.draft();const button=label=>[...x.doc.querySelectorAll('button')].find(b=>b.textContent===label);
  button('Check owner decisions for this session').click();await tick();
  const input=x.doc.querySelector('[aria-label="Revised owner request"]');assert.equal(input.value,'Earlier text');input.value='New exact owner-reviewed text';
  button('Send revised text for owner review').click();await tick();assert.equal(requests.length,1);assert.equal(requests[0].decision,records[0].decision);assert.equal(requests[0].version,2);assert.equal(requests[0].text,'New exact owner-reviewed text');assert.match(x.doc.body.textContent,/superseded/);assert.deepEqual(x.calls,[]);
 }finally{x.close();}
});
