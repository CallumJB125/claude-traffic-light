'use strict';
// The widget's "Teammates" panel: teammates' open "Can you look at this?" requests
// and my Waiting on take the recap's panel when there is no recap, each row opens
// agent mail, the X hides that set until it changes, and the recap wins when both exist.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../widget.js'), 'utf8');
const slice = source.slice(source.indexOf('const AWAY_LINES = 3;'), source.indexOf('refresh();\nwindow.trafficLight.onStatusChanged(refresh);'));
function fixture() {
  const dom = new JSDOM('<body><div id="away"><div class="head"><span id="away-head"></span><button id="away-x"></button></div><div id="away-rows"></div></div></body>', { runScripts: 'outside-only' });
  const w = dom.window, opened = [], feedback = [];
  w.trafficLight = { openMail: async () => { opened.push(1); return true; }, awayOpen: async () => ({}), awayDismiss: () => { feedback.push('away-dismiss'); } };
  w.showFeedback = (t) => feedback.push(t);
  w.eval(slice);
  return { w, opened, feedback, rows: () => [...w.document.querySelectorAll('#away-rows .row')].map((r) => r.textContent), body: w.document.body };
}
const team = { looks: [{ id: 'l1', from: 'Ana', question: 'Is the retry loop safe?', handling: false }], waiting: [{ id: 'w1', to: 'Ben', question: 'Check the notes', state: 'seen' }] };

test('teammate requests show in the panel and each row opens agent mail', async () => {
  const f = fixture();
  f.w.renderAway(null, team);
  assert.equal(f.body.classList.contains('away'), true); assert.equal(f.body.classList.contains('team'), true);
  assert.equal(f.w.document.getElementById('away-head').textContent, 'Teammates');
  assert.deepEqual(f.rows(), ['Ana · asks · Is the retry loop safe?', 'Waiting on Ben · seen']);
  f.w.document.querySelector('#away-rows .row.look').click(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.opened.length, 1);
});

test('the recap wins over teammate requests, and no team means no panel', () => {
  const f = fixture();
  f.w.renderAway({ to: 5, headline: 'Away', items: [{ kind: 'done', folder: 'shop' }] }, team);
  assert.equal(f.body.classList.contains('team'), false);
  assert.equal(f.w.document.getElementById('away-head').textContent, 'While you were away');
  f.w.renderAway(null, null);
  assert.equal(f.body.classList.contains('away'), false); assert.deepEqual(f.rows(), []);
});

test('the X hides this set of requests locally until they change, and does not dismiss the recap', () => {
  const f = fixture();
  f.w.renderAway(null, team);
  f.w.document.getElementById('away-x').click();
  assert.equal(f.body.classList.contains('away'), false); assert.deepEqual(f.feedback, [], 'no recap dismiss was sent');
  f.w.renderAway(null, team);
  assert.equal(f.body.classList.contains('away'), false, 'the same set stays hidden');
  f.w.renderAway(null, { ...team, looks: [{ ...team.looks[0], handling: true }] });
  assert.equal(f.body.classList.contains('away'), true, 'a change brings it back');
  assert.match(f.rows()[0], /handling/);
});

test('long lists collapse to three lines plus a count', () => {
  const f = fixture();
  const many = { looks: [1, 2, 3, 4].map((i) => ({ id: `l${i}`, from: `P${i}`, question: `q${i}`, handling: false })), waiting: [{ id: 'w', to: 'X', question: 'y', state: 'sent' }] };
  f.w.renderAway(null, many);
  assert.equal(f.rows().length, 3);
  assert.equal(f.w.document.querySelector('#away-rows .more').textContent, '+2 more');
});
