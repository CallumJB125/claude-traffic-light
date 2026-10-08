import test from 'node:test';
import assert from 'node:assert/strict';
import { captureLabel } from '../js/render-capture.js';
import { card } from '../js/render-board.js';
import { textOf, byClass, byAttr } from '../js/h.js';
import { displayFace } from '../js/view.js';
import { model, view } from './fixtures.js';

const capture = { source: 'local_observation', provider: 'codex', provider_verified: false, fresh: true, age_ms: 10, status: 'working', tracking: 'active', verified_run: false };
const observed = extra => view({ run: null, live: null, run_state: 'todo', capture, ...extra });
test('observed work displays reported status without a verified run or green running label', () => {
 const v=observed(), face=displayFace(v), node=card({view:v,face,elapsed_ms:0},model([]));
 assert.equal(face.green,false);assert.equal(textOf(byClass(node,'capture-report')[0]),'Reported Codex · AI working');assert.equal(byClass(node,'pill').length,0);
});
test('receipt freshness expires with the browser clock and reboot or stopped tracking never appears current', () => {
 assert.match(captureLabel(observed(),59990),/no recent report/);
 assert.match(captureLabel(observed({capture:{...capture,fresh:false,age_ms:null}})),/no recent report/);
 assert.match(captureLabel(observed({capture:{...capture,tracking:'stopped'}})),/tracking stopped/);
 assert.equal(captureLabel(observed({capture:{...capture,provider:'<script>'}})),null);
});
test('a real board run keeps its independently verified run presentation', () => {
 const v=view({capture}), face=displayFace(v), node=card({view:v,face,elapsed_ms:0},model([]));
 assert.equal(face.green,true);assert.equal(byClass(node,'capture-report').length,0);assert.match(textOf(byClass(node,'pill')[0]),/^Running/);
});
test('a captured card shows its WorkRecord goal, summary and changed files, and offers the session handover', () => {
 const summary = `Goal: Add retry to the payment webhook\n\n${'Added exponential backoff and a timeout test. '.repeat(8)}\n\nFiles: src/webhook.js, test/webhook.test.js, README.md, docs/a.md (+2 more)`;
 const v=observed({capture:{...capture,summary}}), node=card({view:v,face:displayFace(v),elapsed_ms:0},model([]));
 assert.match(textOf(byClass(node,'capture-goal')[0]),/Goal Add retry to the payment webhook/);
 const s=textOf(byClass(node,'capture-summary')[0]);assert.ok(s.length<=240&&s.endsWith('…'));
 assert.deepEqual(byClass(node,'capture-file').map(textOf),['src/webhook.js','test/webhook.test.js','README.md']);
 assert.equal(textOf(byClass(node,'capture-file-more')[0]),'+3 more');
 const handover=byAttr(node,'data-action','open').find(n=>n.props['data-section']==='handover');assert.equal(textOf(handover),'Handover');assert.equal(handover.props['data-card'],v.id);
});
test('a captured card without a record body shows no record block; a plain legacy summary is just summary; a real run shows none', () => {
 const none=observed(), n1=card({view:none,face:displayFace(none),elapsed_ms:0},model([]));assert.equal(byClass(n1,'capture-record').length,0);
 const legacy=observed({capture:{...capture,summary:'Fixed the flaky test'}}), n2=card({view:legacy,face:displayFace(legacy),elapsed_ms:0},model([]));
 assert.equal(textOf(byClass(n2,'capture-summary')[0]),'Fixed the flaky test');assert.equal(byClass(n2,'capture-goal').length,0);
 const run=view({capture:{...capture,summary:'Goal: x'}}), n3=card({view:run,face:displayFace(run),elapsed_ms:0},model([]));assert.equal(byClass(n3,'capture-record').length,0);
});
