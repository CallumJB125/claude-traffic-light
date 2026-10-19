'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const Cards = require('../src/result-cards');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const cards = () => [
  { id: 'todo', kind: 'checklist', title: 'Release checks', items: [{ id: 'one', label: 'Review output', done: false }] },
  { id: 'count', kind: 'metric', title: 'Reviewed items', value: '12', unit: 'items', note: 'Reported by the task' },
  { id: 'table', kind: 'table', title: 'Results', columns: ['Name', 'Value'], rows: [['Initial', '<img src=x onerror=bad()>']] },
];
const data = () => ({ brief: 'Review results', decisions: ['Keep the approved scope'], progress: 'Report', nextAction: 'Review', artifacts: [], reportedChecks: [] });

test('closed card shapes enforce limits, unique ids and cleaning without executable actions', () => {
  const source = cards(), copy = Cards.cleanResultCards(source, v => v.replace('Reported', 'Cleaned'));
  assert.equal(copy[1].note, 'Cleaned by the task'); assert.equal(source[1].note, 'Reported by the task');
  const invalid = [
    [...source, source[0]], [{ ...source[0], id: 123 }], [{ ...source[0], onChange: 'fetch(secret)' }], [{ ...source[0], items: Array(21).fill(source[0].items[0]) }],
    [{ ...source[2], columns: Array(7).fill('x') }], [{ ...source[2], rows: [['wrong width']] }], [{ ...source[2], rows: Array(21).fill(['a', 'b']) }],
    Array.from({ length: 9 }, (_, i) => ({ ...source[1], id: `m${i}` })),
    Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, kind: 'table', title: '', columns: Array(6).fill('Column'), rows: Array.from({ length: 20 }, () => Array(6).fill('x'.repeat(240))) })),
  ];
  for (const value of invalid) assert.throws(() => Cards.cleanResultCards(value), TypeError);
});

test('packet and renderer guard preserve optional cards and redact card values before storage', async () => {
  const { cleanPacketData, buildPacket, packetData } = await import('../board/tasks-engine/checkpoint.js');
  const payload = data(), output = cards(); output[1].note = `Bearer ${'a'.repeat(40)}`;
  const p = buildPacket({ ...payload, resultCards: output }, { root: '/tmp/project' }, { version: 2, at: 100, author: { kind: 'human', id: 'owner', source: 'local' }, provenance: 'participant', observed: { state: 'parked', tests: null } });
  assert.equal(p.resultCards.length, 3); assert.doesNotMatch(JSON.stringify(p), new RegExp('a'.repeat(40)));
  assert.equal(packetData(p).resultCards.length, 3);
  assert.equal(Object.hasOwn(cleanPacketData(payload, { root: '/tmp/project' }), 'resultCards'), false, 'legacy omission remains available for engine preservation');
  const P = await import('../board/tasks-api/protocol.js');
  const { taskFace } = await import('../board/tasks-api/face.js');
  const guard = require('../src/tasks-guard').createGuard({ P, taskFace });
  assert.equal(guard.sanitizeCheckpoint(p).resultCards.length, 3);
  assert.equal(guard.validateCheckpoint({ id: 'task-a', expectedVersion: 2, data: { ...payload, resultCards: [] } }).ok, true);
  assert.equal(guard.validateCheckpoint({ id: 'task-a', expectedVersion: 2, data: { ...payload, resultCards: [{ ...output[0], credentials: 'no' }] } }).ok, false);
});

test('card provenance survives packet projection and cannot be supplied as editable data', async () => {
  const { cleanPacketData, buildPacket, packetData } = await import('../board/tasks-engine/checkpoint.js');
  const { buildSchema } = await import('../board/tasks-api/scripts/build-schema.js');
  const { validate } = await import('../board/tasks-api/validate.js');
  const P = await import('../board/tasks-api/protocol.js');
  const { taskFace } = await import('../board/tasks-api/face.js');
  const guard = require('../src/tasks-guard').createGuard({ P, taskFace });
  const resultCardsSource = { version: 2, at: 100, author: { kind: 'agent', id: 'task-a', source: 'mcp' } };
  const meta = { version: 3, at: 200, author: { kind: 'supervisor', id: 'engine', source: 'engine' }, provenance: 'frozen', observed: { state: 'parked', tests: null }, resultCardsSource };
  const p = buildPacket({ ...data(), resultCards: cards() }, { root: '/tmp/project' }, meta);
  assert.deepEqual(p.resultCardsSource, resultCardsSource);
  assert.equal(validate(buildSchema(), 'Checkpoint', p), null);
  const projected = guard.sanitizeCheckpoint(p);
  assert.deepEqual(projected.resultCardsSource, { ...resultCardsSource, author: { kind: 'agent', source: 'mcp' } });
  assert.deepEqual(require('../src/task-outputs').cardsSource({ checkpoint: projected }), { version: 2, at: 100, author: 'Task agent' });
  assert.equal(Object.hasOwn(packetData(p), 'resultCardsSource'), false);
  const forged = { ...data(), resultCardsSource };
  assert.throws(() => cleanPacketData(forged, { root: '/tmp/project' }), { code: 'VALIDATION' });
  assert.equal(guard.validateCheckpoint({ id: 'task-a', expectedVersion: 3, data: forged }).ok, false);
  assert.ok(validate(buildSchema(), 'CheckpointData', forged));
  assert.throws(() => buildPacket(data(), { root: '/tmp/project' }, { ...meta, resultCardsSource: { ...resultCardsSource, version: 4 } }), { code: 'VALIDATION' });
});

test('cards persist checkbox and metric edits, restore on reopen, and preserve a table draft on conflict', async t => {
  const row = { id: 'task-a', title: 'Outputs', state: 'in_review', label: 'Needs review', tone: 'purple', green: false, actions: ['message'], confirm: [], ai: { id: 'codex' }, cost: { usd: 0, budgetUsd: null }, where: 'project', workInPlace: false, text: 'Review results', messages: [], openApprovals: [], openAsk: null,
    checkpoint: { schemaVersion: 1, version: 2, at: 100, ...data(), resultCards: cards(), resultCardsSource: { version: 1, at: 50, author: { kind: 'agent', source: 'mcp' } }, author: { kind: 'supervisor' }, provenance: 'frozen', observed: { tests: null } } };
  const requests = [];
  async function open() {
    const dom = new JSDOM(read('tasks.html'), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://plexiform.invalid/tasks.html?embedded=1' });
    t.after(() => dom.window.close()); const w = dom.window, d = w.document;
    w.CSS ??= {}; w.CSS.escape ??= value => value; w.HTMLElement.prototype.scrollIntoView = () => {};
    w.tasksApi = { state: async () => ({ conn: { status: 'connected' }, tasks: [row] }), open: async () => ({ ok: true, detail: structuredClone(row), replay: [] }), close: async () => {}, onChanged: () => {}, onEvent: () => {},
      saveCheckpoint: async request => {
        requests.push(request);
        if (request.expectedVersion !== row.checkpoint.version) return { ok: false, code: 'CONFLICT' };
        const resultCards = Cards.cleanResultCards(request.data.resultCards);
        row.checkpoint = { ...row.checkpoint, ...request.data, resultCards, version: row.checkpoint.version + 1 };
        return { ok: true, checkpoint: structuredClone(row.checkpoint) };
      } };
    for (const file of ['src/tasks-view.js', 'src/result-cards.js', 'src/result-cards-view.js', 'src/task-outputs.js', 'tasks.js']) w.eval(read(file));
    await tick(); d.querySelector('[data-id="task-a"]').click(); await tick();
    return { w, d, button: label => [...d.querySelectorAll('button')].find(b => b.textContent === label), input: (label, value) => { const input = [...d.querySelectorAll('input')].find(n => n.getAttribute('aria-label') === label); input.value = value; input.dispatchEvent(new w.Event('input')); } };
  }
  const first = await open(); assert.equal(first.d.querySelector('#result-cards img'), null);
  assert.match(first.d.querySelector('#result-cards').textContent, /Cards last saved by Task agent at checkpoint version 1\. Included in checkpoint version 2/);
  first.d.querySelector('[data-card-id="todo"] input').click(); await tick();
  assert.equal(row.checkpoint.resultCards[0].items[0].done, true); assert.equal(requests[0].expectedVersion, 2);
  first.d.querySelector('[data-card-id="count"] button').click(); first.input('Value', '15'); first.button('Save card changes').click(); await tick();
  assert.equal(row.checkpoint.resultCards[1].value, '15'); assert.equal(row.checkpoint.decisions[0], 'Keep the approved scope');
  const reopened = await open();
  assert.equal(reopened.d.querySelector('[data-card-id="todo"] input').checked, true);
  assert.match(reopened.d.querySelector('[data-card-id="count"]').textContent, /15 items/);
  reopened.d.querySelector('[data-card-id="table"] button').click(); reopened.input('Row 1, Name', 'Preserved draft');
  row.checkpoint.version++; // another writer wins while this draft is open
  reopened.button('Save card changes').click(); await tick();
  assert.match(reopened.d.getElementById('result-card-error').textContent, /draft is preserved/);
  assert.equal(reopened.d.querySelector('[aria-label="Row 1, Name"]').value, 'Preserved draft');
  assert.equal(row.checkpoint.resultCards[2].rows[0][0], 'Initial');
  reopened.button('Reload and discard this draft').click(); await tick();
  assert.equal(reopened.d.getElementById('result-card-editor'), null);
  assert.match(reopened.d.querySelector('[data-card-id="table"]').textContent, /Initial/);
});
