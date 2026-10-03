import test from 'node:test';
import assert from 'node:assert/strict';
import { captureLabel } from '../js/render-capture.js';
import { card } from '../js/render-board.js';
import { textOf, byClass } from '../js/h.js';
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
