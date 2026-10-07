import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePresentation } from '../js/render-capture.js';
import { drawer } from '../js/render-drawer.js';
import { tableScreen } from '../js/render-table.js';
import { card, cardActions } from '../js/render-board.js';
import { displayFace, cardWorkPhase, observedLane, groupColumns } from '../js/view.js';
import { textOf, byClass, byAttr } from '../js/h.js';
import { model, view, live } from './fixtures.js';
const report = { source: 'local_observation', provider: 'codex', reported_status: 'working', status: 'working', tracking: 'active', fresh: true, age_ms: 1000, received_at: '2026-10-03T12:00:00.000Z' };
const observed = (extra = {}) => view({ run_state: 'todo', run: null, live: null, repo: null, branch: null, base_ref: null, capture: report, ...extra });
const rendered = (v, opts = {}, m = {}) => card({ view: v, face: displayFace(v, opts), elapsed_ms: opts.elapsed_ms ?? 0 }, model([], m));

test('captured existing work shows AI identity, reported activity and last report instead of another launch', () => {
 const v = observed(), n = rendered(v), p = capturePresentation(v);
 assert.equal(p.label, 'Reported Codex · AI working'); assert.equal(p.lastReport, 'Last report · 1s ago'); assert.equal(p.fresh, true);
 assert.equal(byClass(n, 'pill').length, 0); assert.equal(n.props['data-tone'], 'none');
 const opens = byAttr(n, 'data-action', 'open');
 assert.equal(textOf(opens.at(-2)), 'Show details'); assert.equal(textOf(opens.at(-1)), 'Handover'); assert.equal(opens.at(-1).props['data-section'], 'handover');
 assert.equal(byAttr(n, 'data-action', 'give_to_claude').length, 0); assert.doesNotMatch(textOf(n), /Send to AI|no repo yet/);
 assert.match(textOf(n), /Stop it in your AI tool/);
});
test('stale, invalid-age, stopped and disconnected capture reports never claim current AI work', () => {
 for (const [capture, elapsed, lost] of [[report, 59000, false], [{...report, age_ms: -1},0,false], [{...report, age_ms: null},0,false], [{...report, fresh:false},0,false], [{...report, tracking:'stopped'},0,false], [report,0,true], [report,NaN,false]]) {
  const p = capturePresentation(observed({capture}),elapsed,lost);assert.equal(p.fresh,false);assert.equal(p.status,'unknown');assert.doesNotMatch(p.label,/AI working/);
 }
 const stale = rendered(observed(), {elapsed_ms:59000});assert.match(textOf(stale),/no recent report/);assert.match(textOf(stale),/Last report: AI working · 1m ago/);
 const lost = rendered(observed(), {}, {conn:{status:'lost'}});assert.match(textOf(lost),/connection lost/);assert.equal(byAttr(lost,'data-green').length,0);
});
test('Review never invents an AI reviewer: current work, completed report and missing report stay distinct', () => {
 const working = rendered(observed({column:'in_review'}));assert.match(textOf(working),/Reported Codex · AI working/);assert.doesNotMatch(textOf(working),/AI reviewing|awaiting human review/i);
 const review = rendered(observed({column:'in_review',capture:{...report,status:'review',reported_status:'review'}}));assert.match(textOf(review),/Reported Codex · awaiting human review/);assert.doesNotMatch(textOf(review),/AI reviewing/);
 const stale = rendered(observed({column:'in_review',capture:{...report,status:'unknown',reported_status:'review',fresh:false,age_ms:null}}));assert.match(textOf(stale),/no recent report/);assert.match(textOf(stale),/Last report: awaiting human review/);
});
test('heartbeat alone never creates an AI working caption; real activity and completed review do', () => {
 const heartbeat = view({live:live({activity_age_ms:null,tool_in_flight:null})});assert.equal(displayFace(heartbeat).green,false);assert.notEqual(cardWorkPhase(heartbeat,displayFace(heartbeat)),'AI working');
 const active = view();assert.equal(cardWorkPhase(active,displayFace(active)),'AI working');
 const disconnected = displayFace(active,{connection_lost:true});assert.equal(cardWorkPhase(active,disconnected),'AI activity not confirmed');
 const review = view({run_state:'in_review',live:null});assert.equal(cardWorkPhase(review,displayFace(review)),'Awaiting human review');assert.doesNotMatch(textOf(rendered(review)),/AI reviewing/);
});
test('manual tasks retain launch and repo setup; captured cards with a real queued run retain cancel', () => {
 const manual = observed({capture:null,column:'todo'}), m = rendered(manual);assert.equal(byAttr(m,'data-action','give_to_claude').length,1);assert.match(textOf(m),/no repo yet/);
 const queued = observed({run_state:'queued',target:{member_id:'m-alice',name:'Alice',is_viewer:true}}), q = rendered(queued);assert.equal(byAttr(q,'data-action','cancel').length,1);assert.equal(byClass(q,'capture-report').length,0);
});
test('held transfer actions distinguish choosing another AI from reading its handover', () => {
 const v = view({handover_hold:true}), face = {actions:['take_over_with_claude','view_handover']};const n=cardActions(face,v,new Set());assert.equal(textOf(byAttr(n,'data-action','take_over_with_claude')[0]),'Choose next AI');assert.equal(textOf(byAttr(n,'data-action','view_handover')[0]),'Read handover');
 assert.equal(textOf(byAttr(cardActions(face,view(),new Set()),'data-action','take_over_with_claude')[0]),'Send to AI…');
 const move=cardActions({actions:['switch_ai']},view(),new Set());assert.equal(textOf(move),'Move to another AI');
});

const surfaces = (v, lost = false) => {
 const e = { view:v, face:displayFace(v,{connection_lost:lost}), elapsed_ms:0 };
 const m = model([e], { conn:{status:lost?'lost':'open'}, table:{sort:{by:'key',dir:'asc'},filter:''}, detail:{cardId:v.id,data:{card:v,feed:[],comments:[],asks:[],permission_requests:[]},elapsed_ms:0,tab:'activity'} });
 return [drawer(m),tableScreen(m)];
};
test('drawer and table drop current observed activity on disconnect even when elapsed time is frozen', () => {
 for (const surface of surfaces(observed())) { assert.match(textOf(surface),/Reported Codex · AI working/); assert.equal(byAttr(surface,'data-fresh','true').length,1); }
 for (const surface of surfaces(observed(),true)) { assert.match(textOf(surface),/Reported Codex · connection lost/); assert.equal(byAttr(surface,'data-fresh','true').length,0); assert.match(textOf(surface),/Last report: AI working/); }
});
test('drawer and table use the real queued run instead of its historical capture metadata', () => {
 const queued=observed({run_state:'queued',target:{member_id:'m-alice',name:'Alice',is_viewer:true}});
 for (const surface of surfaces(queued)) { assert.equal(byClass(surface,'capture-report').length,0); assert.match(textOf(surface),/Queued/); }
 const detail=surfaces(queued)[0]; assert.equal(byAttr(detail,'data-action','cancel').length,1);
});

test('a report with no live age shows relative time with the exact time on hover, never raw ISO', () => {
 const received_at = new Date(Date.now() - 3 * 86_400_000).toISOString();
 const v = observed({ capture: { ...report, age_ms: null, fresh: false, reported_status: 'idle', status: 'unknown', received_at } });
 const p = capturePresentation(v);
 assert.equal(p.lastReport, 'Last report: idle · 3 days ago'); assert.doesNotMatch(p.lastReport, /\d{4}-\d{2}-\d{2}T/); assert.ok(p.exact);
 const n = rendered(v); assert.equal(byClass(n, 'capture-last-report')[0].props.title, `Reported ${p.exact}`);
 assert.match(capturePresentation(observed({ capture: { ...report, age_ms: null, fresh: false, received_at: new Date(Date.now() - 120_000).toISOString() } })).lastReport, /· 2m ago$/);
});
test('stale observed sessions leave In progress for the Idle lane; day-old ones are hidden; manual and finished cards stay', () => {
 const at = (ms) => new Date(Date.now() - ms).toISOString();
 const cap = (ms, extra = {}) => ({ ...report, age_ms: null, fresh: false, received_at: at(ms), column: 'in_progress', ...extra });
 const lane = (c, extra = {}) => observedLane(observed({ column: 'in_progress', capture: c, ...extra }));
 assert.equal(lane(cap(1000, { fresh: true })), 'active');
 assert.equal(lane(cap(120_000)), 'idle');
 assert.equal(lane(cap(120_000, { reported_status: 'review' })), 'active');
 assert.equal(lane(cap(2 * 86_400_000)), 'archived');
 assert.equal(lane(cap(2 * 86_400_000, { managed: { column: false } })), 'active');
 const entry = (c) => { const v = observed({ column: 'in_progress', capture: c }); return { view: v, face: displayFace(v), elapsed_ms: 0 }; };
 const cols = groupColumns([entry(cap(120_000)), entry(cap(1000, { fresh: true, age_ms: 1000 }))]);
 assert.equal(cols.idle.length, 1); assert.equal(cols.in_progress.length, 1);
});
