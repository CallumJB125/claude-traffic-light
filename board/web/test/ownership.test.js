import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { textOf, byAttr } from '../js/h.js';
import { ownershipPanel, ownershipStatus } from '../js/render-ownership.js';
const entry = { run_id: 'run-current', card_key: 'PF-1', card_title: '<script>task</script>', paths: ['src/shared/**'],
  author: { name: '<img onerror=private>', provider_label: 'Codex' }, state: 'editing', expires_in_ms: 10000 };
const detail = { data: { card: {} }, ownershipLoaded: true, ownership: { ownership: entry, ownership_intents: [entry], ownership_overlaps: [] } };

test('lease freshness ages from the observed response and disappears at expiry or lost connection', () => {
  assert.match(ownershipStatus(entry, 9999), /fresh host signal/);
  assert.equal(ownershipStatus(entry, 10000), 'Heartbeat expired');
  assert.equal(ownershipStatus(entry, 0, false), 'Signal unavailable');
  assert.equal(ownershipStatus({ ...entry, expires_in_ms: null }), 'Heartbeat expired');
  assert.equal(ownershipStatus({ state: 'awaiting_review' }), 'Awaiting review');
});

test('coordination displays untrusted path/name/title text and grants no edit or file-lock action', () => {
  const rendered = ownershipPanel(detail, { conn: { status: 'open' } }, 5000), text = textOf(rendered);
  assert.match(text, /do not lock files or grant permission/); assert.match(text, /src\/shared\/\*\*/);
  assert.match(text, /<img onerror=private>/); assert.match(text, /<script>task<\/script>/);
  assert.deepEqual(byAttr(rendered, 'data-action').map(n => n.props['data-action']), ['ownership-reload']);
  assert.equal(textOf(ownershipPanel(detail, { conn: { status: 'lost' } })).includes('fresh host signal'), false);
});

test('failed and archived projections hide all previously loaded declared paths', () => {
  assert.equal(textOf(ownershipPanel({ ...detail, ownershipError: 'Sign in again' }, {})).includes('src/shared'), false);
  assert.equal(textOf(ownershipPanel({ ...detail, data: { card: { archived: true } } }, {})).includes('src/shared'), false);
});

test('actual reconnect and hub restart handlers withhold cached freshness before a pending fresh response', () => {
  const source=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
  const onStatus=source.slice(source.indexOf('function onStatus('),source.indexOf('\nfunction onMessage('));
  const onEpoch=source.slice(source.indexOf('function onHubEpoch('),source.indexOf('\nlet dashUpsertTimer'));
  const state={conn:{status:'lost'},dash:{epoch:'before'},view:'team',presence:{},detail:{...detail,tab:'ownership',cardId:'card',ownershipRx:0}};
  const frames=[],requests=[];
  const handlers=new Function('state','update','refreshDetail','perf','resetDashboard','loadJournal','socket','boot',
    'let detailRefresh=0;'+onEpoch+'\n'+onStatus+'\nreturn{onStatus,onHubEpoch};')(
      state,()=>frames.push(textOf(ownershipPanel(state.detail,{conn:state.conn},0))),(...args)=>{requests.push(args);return new Promise(()=>{});},()=>100,()=>{},()=>{},null,()=>{});
  handlers.onStatus({status:'open'});
  assert.equal(state.detail.ownership,null);assert.equal(state.detail.ownershipLoaded,false);
  assert.equal(requests.length,1);assert.equal(frames.some(text=>text.includes('fresh host signal')),false);
  state.detail={...detail,tab:'ownership',cardId:'card',ownershipRx:0};
  handlers.onHubEpoch('after');
  assert.equal(state.detail.ownership,null);assert.equal(state.detail.ownershipLoaded,false);
  assert.equal(requests.length,2);assert.equal(frames.some(text=>text.includes('fresh host signal')),false);
  state.detail={...detail,tab:'ownership',cardId:'card',ownershipRx:0};
  handlers.onHubEpoch('after');assert.equal(state.detail.ownership,detail.ownership);assert.equal(requests.length,2);
});
