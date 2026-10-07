'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'aitools.html'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'aitools.js'), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 5));

const row = (o) => ({ kind: 'tool', installed: true, version: null, connected: false, state: 'ready', primary: { action: 'connect', label: 'Connect' }, detail: 'Found on this Mac, not connected yet.', error: null, lastEvent: { at: null, text: 'no events yet' }, chips: ['Live status'], note: null, canUndo: false, ...o });

async function open(rows, api = {}) {
  const dom = new JSDOM(html.replace(/<script src[^>]*><\/script>/, ''), { runScripts: 'outside-only', pretendToBeVisual: true });
  const calls = [];
  const state = { rows, pending: rows.filter((r) => r.installed && !r.connected).map((r) => r.id) };
  dom.window.Element.prototype.scrollIntoView = () => {};
  dom.window.aiToolsApi = {
    scan: async () => state, focus: async () => null, onChanged() {},
    preview: async (id) => ({ ok: true, id, files: [{ file: '~/.codex/hooks.json', existed: true, backup: 'hooks.json.plexiform-backup-<time>', lines: [{ kind: 'add', text: '"command": "node emit.js"' }], unchanged: 12 }] }),
    connect: async (id) => { calls.push(['connect', id]); state.rows = rows.map((r) => (r.id === id ? { ...r, connected: true, state: 'connected', primary: { action: 'disconnect', label: 'Disconnect' }, canUndo: true } : r)); return { ok: true, message: 'Connected.' }; },
    openInstall: async (id) => { calls.push(['install', id]); return true; },
    connectAll: async () => ({ ok: true, results: [{ id: 'codex', ok: true, message: 'Connected.' }] }),
    undo: async () => ({ ok: true, message: 'Restored your original config.' }),
    disconnect: async () => ({ ok: true, message: 'x' }), addCustom: async () => ({ ok: true, command: 'plexiform-run aider' }), ...api,
  };
  dom.window.eval(script);
  await tick();
  return { dom, doc: dom.window.document, calls, state };
}

test('each tool is a row with its state, chips and exactly one primary button; missing tools get an install link, never a dead button', async () => {
  const { doc, calls } = await open([
    row({ id: 'codex', label: 'Codex CLI', version: '0.159.2', chips: ['Live status', 'Board cards'] }),
    row({ id: 'cursor', label: 'Cursor', installed: false, state: 'missing', primary: { action: 'install', label: 'How to install' }, chips: [] }),
  ]);
  const sections = [...doc.querySelectorAll('section.tool')];
  assert.equal(sections.length, 2);
  const codex = sections[0];
  assert.match(codex.textContent, /Codex CLI/);
  assert.match(codex.textContent, /v0\.159\.2/);
  assert.match(codex.textContent, /Last event: no events yet/);
  assert.deepEqual([...codex.querySelectorAll('.chips li')].map((l) => l.textContent), ['Live status', 'Board cards']);
  assert.deepEqual([...codex.querySelectorAll('button')].map((b) => b.textContent), ['Connect']);
  const cursor = sections[1];
  assert.match(cursor.textContent, /Not installed/);
  const btn = cursor.querySelector('button');
  assert.equal(btn.textContent, 'How to install');
  btn.click(); await tick();
  assert.deepEqual(calls, [['install', 'cursor']]);
  assert.equal(doc.getElementById('connect-all').hidden, false);
  assert.match(doc.getElementById('status').textContent, /Found Codex CLI/);
});

test('Connect previews the exact lines first and writes only after the confirm button', async () => {
  const { doc, calls } = await open([row({ id: 'codex', label: 'Codex CLI' })]);
  doc.querySelector('section.tool button').click(); await tick();
  assert.deepEqual(calls, [], 'nothing written by the first click');
  const diff = doc.querySelector('.diff');
  assert.match(diff.textContent, /\+ "command": "node emit\.js"/);
  assert.match(diff.textContent, /12 unchanged lines/);
  assert.match(doc.querySelector('.preview').textContent, /A copy of the file is saved first/);
  const confirm = [...doc.querySelectorAll('.preview button')].find((b) => /Confirm/.test(b.textContent));
  confirm.click(); await tick(); await tick();
  assert.deepEqual(calls, [['connect', 'codex']]);
  const sec = doc.querySelector('section.tool');
  assert.match(sec.textContent, /Connected\./);
  assert.deepEqual([...sec.querySelectorAll('button')].map((b) => b.textContent), ['Disconnect', 'Undo']);
});

test('a failed preview shows its error with a Check again button instead of a confirm', async () => {
  const { doc } = await open([row({ id: 'gemini', label: 'Gemini CLI', state: 'fix', primary: { action: 'fix', label: 'Fix' }, error: 'settings.json is not valid JSON' })], {
    preview: async () => ({ ok: false, error: '~/.gemini/settings.json is not valid JSON (x).' }),
  });
  doc.querySelector('section.tool button').click(); await tick();
  assert.match(doc.querySelector('.preview .error').textContent, /not valid JSON/);
  assert.deepEqual([...doc.querySelectorAll('.preview button')].map((b) => b.textContent), ['Check again']);
});

test('Connect all shows every diff, then one confirm reports per-tool results', async () => {
  const { doc } = await open([row({ id: 'codex', label: 'Codex CLI' }), row({ id: 'gemini', label: 'Gemini CLI' })]);
  doc.getElementById('connect-all').click(); await tick(); await tick();
  const box = doc.getElementById('all-preview');
  assert.equal(box.hidden, false);
  assert.equal(box.querySelectorAll('.diff').length, 2);
  [...box.querySelectorAll('button')].find((b) => /Confirm and connect 2/.test(b.textContent)).click();
  await tick(); await tick();
  assert.equal(box.hidden, true);
  assert.match(doc.getElementById('status').textContent, /Codex CLI: connected/);
});
