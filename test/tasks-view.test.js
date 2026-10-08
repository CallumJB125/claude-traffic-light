'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const TV = require('../src/tasks-view.js');

const protocol = () => import(pathToFileURL(path.join(__dirname, '..', 'board', 'tasks-api', 'protocol.js')).href);

test('every contract error code has plain words, and none is the raw server text', async () => {
  const P = await protocol();
  for (const code of P.ERRORS) {
    const t = TV.errorText(code);
    assert.ok(t && t.length > 10 && !/^[A-Z_]+$/.test(t) && !t.includes(code), `${code}: ${t}`);
    assert.ok(Object.hasOwn(TV.ERROR_TEXT, code), `${code} has its own wording`);
  }
  assert.equal(TV.errorText('SOMETHING_NEW'), TV.ERROR_TEXT.INTERNAL, 'an unknown code falls back, never echoes');
});

test('limits match the contract', () => {
  assert.equal(TV.LIMITS.taskText, 20000);
  assert.equal(TV.LIMITS.message, 8 * 1024);
});

test('rowView: label, tone, AI, folder, age and unread come through; a lost task is marked stale', () => {
  const now = 1_000_000_000;
  const r = TV.rowView({ id: 't1', title: 'Add dark mode', label: 'Needs you', tone: 'amber', green: false, reason: 'wants to run Bash', ai: { id: 'codex' }, repo: { name: 'acme-web' }, stateSinceMs: now - 7 * 60000, unread: 2, stale: true }, now);
  assert.deepEqual(r, { id: 't1', title: 'Add dark mode', label: 'Needs you', tone: 'amber', green: false, reason: 'wants to run Bash', ai: 'Codex', where: 'acme-web', age: '7 min ago', unread: 2, board: false, stale: true });
  assert.equal(TV.rowView({ id: 'x', label: 'Running', green: true, ai: {}, stateSinceMs: now }, now).title, 'Untitled task');
  assert.equal(TV.rowView({ id: 'x', label: 'Running', green: 'yes' }, now).green, false, 'green only when exactly true');
  assert.equal(TV.rowView({ id: 'x', hub: { cardKey: 'A-1' } }, now).board, true);
});

test('ageText', () => {
  assert.equal(TV.ageText(10_000), 'just now');
  assert.equal(TV.ageText(3 * 3600_000), '3 h ago');
  assert.equal(TV.ageText(3 * 86400_000), '3 d ago');
  assert.equal(TV.ageText(-1), '');
});

test('sortTasks: needs-you first, finished last, newest first within a group', () => {
  const s = TV.sortTasks([
    { id: 'd', state: 'done', createdAtMs: 9 }, { id: 'r1', state: 'running', createdAtMs: 1 }, { id: 'b', state: 'blocked', createdAtMs: 0 },
    { id: 'r2', state: 'running', createdAtMs: 5 }, { id: 'q', state: 'queued', createdAtMs: 3 },
  ]).map((t) => t.id);
  assert.deepEqual(s, ['b', 'r2', 'r1', 'q', 'd']);
});

test('transcript: partial chunks join, a tool end updates its start, duplicates are ignored', () => {
  const t = TV.newTranscript();
  assert.ok(TV.addEvent(t, { type: 'transcript', seq: 1, role: 'assistant', turn: 1, text: 'Hello ', partial: true }));
  assert.ok(TV.addEvent(t, { type: 'transcript', seq: 2, role: 'assistant', turn: 1, text: 'world', partial: false }));
  assert.equal(t.items.length, 1);
  assert.equal(t.items[0].text, 'Hello world');
  assert.ok(TV.addEvent(t, { type: 'transcript', seq: 3, role: 'assistant', turn: 1, text: 'next' }));
  assert.equal(t.items.length, 2, 'a closed message starts a new item');
  TV.addEvent(t, { type: 'tool', seq: 4, phase: 'start', toolUseId: 'u1', name: 'Bash', summary: 'ls' });
  TV.addEvent(t, { type: 'tool', seq: 5, phase: 'end', toolUseId: 'u1', name: 'Bash', ok: true, durationMs: 40 });
  assert.equal(t.items.length, 3);
  assert.deepEqual([t.items[2].done, t.items[2].ok, t.items[2].durationMs], [true, true, 40]);
  assert.equal(TV.addEvent(t, { type: 'transcript', seq: 2, role: 'assistant', turn: 1, text: 'dup' }), false);
  assert.equal(TV.addEvent(t, { type: 'state', seq: 9 }), false, 'other event types are not transcript');
});

test('transcript: memory is capped by items and by characters, oldest dropped and counted', () => {
  const t = TV.newTranscript();
  const caps = { items: 5, chars: 100 };
  for (let i = 1; i <= 20; i++) TV.addEvent(t, { type: 'transcript', seq: i, role: 'assistant', turn: i, text: 'x'.repeat(30) }, caps);
  assert.ok(t.items.length <= 5 && t.chars <= 100 + 30, `${t.items.length} items, ${t.chars} chars`);
  assert.equal(t.dropped, 20 - t.items.length);
  assert.equal(t.items[t.items.length - 1].turn, 20, 'the newest is kept');
});

test('transcript: an error event shows plain words, never its raw message', () => {
  const t = TV.newTranscript();
  TV.addEvent(t, { type: 'error', seq: 1, code: 'DISK_FULL', message: 'ENOSPC /Users/x/secret' });
  assert.equal(t.items[0].text, TV.ERROR_TEXT.DISK_FULL);
});

test('messages: delivered and read states, quarantine, one entry per id', () => {
  const m = { id: 'm1', direction: 'in', from: { kind: 'human', id: 'you' }, deliveredAt: null, readAt: null, source: null };
  assert.equal(TV.messageStatus(m), 'Waiting to be delivered');
  assert.equal(TV.messageStatus({ ...m, deliveredAt: 5 }), 'Delivered');
  assert.equal(TV.messageStatus({ ...m, deliveredAt: 5, readAt: 6, source: 'live' }), 'Read');
  assert.equal(TV.messageStatus({ ...m, deliveredAt: 5, readAt: 6, source: 'notes' }), 'Read (from its notes)');
  assert.equal(TV.messageStatus({ direction: 'out', from: { kind: 'task' }, deliveredAt: 5 }), 'Delivered', 'what the task sent mirrors delivery too');
  assert.match(TV.messageStatus({ direction: 'in', from: { kind: 'task' }, quarantined: true }), /suspicious/);
  assert.equal(TV.messageStatus({ direction: 'in', from: { kind: 'task' }, quarantined: false }), '');
  const list = [];
  assert.ok(TV.mergeMessage(list, { type: 'message', id: 'm1', direction: 'out' }));
  assert.equal(TV.mergeMessage(list, { type: 'message', id: 'm1', direction: 'out' }), false);
  assert.ok(TV.mergeMessage(list, { type: 'message-state', id: 'm1', deliveredAt: 7, readAt: null, source: 'live' }));
  assert.equal(list[0].deliveredAt, 7);
  assert.equal(TV.mergeMessage(list, { type: 'message-state', id: 'nope' }), false);
  assert.equal(TV.partyName({ kind: 'human', id: 'u' }), 'You');
});

test('composer and message validation use the protocol limits', () => {
  assert.equal(TV.validateDraft({ text: '  ', hasFolder: true }).ok, false);
  assert.match(TV.validateDraft({ text: 'do it', hasFolder: false }).error, /folder/);
  assert.equal(TV.validateDraft({ text: 'do it', hasFolder: true }).ok, true);
  assert.match(TV.validateDraft({ text: 'x'.repeat(20001), hasFolder: true }).error, /1 character over/);
  assert.equal(TV.validateDraft({ text: 'x'.repeat(20000), hasFolder: true }).ok, true);
  assert.equal(TV.validateMessage('hi').ok, true);
  assert.equal(TV.validateMessage('').ok, false);
  assert.equal(TV.validateMessage('é'.repeat(4097)).ok, false, 'counted in bytes, like the supervisor');
  assert.equal(TV.validateMessage('é'.repeat(4096)).ok, true);
});

test('destructive actions each have confirmation words', () => {
  for (const a of TV.CONFIRM_ACTIONS) assert.ok(TV.CONFIRM_TEXT[a] && TV.ACTION_LABEL[a], a);
});

test('menu: Tasks opens its own window only while the registry still says "soon"', () => {
  const AppMenu = require('../src/app-menu.js');
  const groups = [{ id: 'work' }];
  const opened = [];
  const soon = [{ id: 'tasks', title: 'Tasks', kind: 'soon', group: 'work' }];
  const a = AppMenu.appItems({ pages: soon, groups, open: (id) => opened.push(id), openLabel: 'Open', whileSoon: { tasks: () => opened.push('window') } });
  const item = a.find((i) => i.label === 'Open Tasks…');
  assert.ok(item && item.enabled !== false);
  item.click();
  assert.deepEqual(opened, ['window']);
  assert.equal(AppMenu.appItems({ pages: soon, groups, open() {}, openLabel: 'Open' }).find((i) => /Tasks/.test(i.label || '')).label, 'Open Tasks… (soon)');
  const local = [{ id: 'tasks', title: 'Tasks', kind: 'local', group: 'work' }];
  AppMenu.appItems({ pages: local, groups, open: (id) => opened.push(id), openLabel: 'Open', whileSoon: { tasks: () => opened.push('window') } }).find((i) => i.label === 'Open Tasks…').click();
  assert.deepEqual(opened, ['window', 'tasks'], 'once the sidebar entry is wired, the menu follows it');
});

test('the page keeps the strict policy and the package ships what it needs', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'tasks.html'), 'utf8');
  assert.match(html, /default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'/);
  assert.ok(!/<style|style=|onclick=/.test(html));
  const files = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).build.files;
  for (const f of ['tasks.html', 'tasks.js', 'tasks.css', 'tasks-preload.js']) assert.ok(files.includes(f), f);
  const js = fs.readFileSync(path.join(__dirname, '..', 'tasks.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js), 'text only');
});

test('trust labels put the kind before the sender-chosen label, and the native-confirmed actions are not the in-page ones', () => {
  assert.equal(TV.partyText({ kind: 'task', label: 'Dana (your boss)' }), 'another task: Dana (your boss)');
  assert.equal(TV.partyText({ kind: 'card', label: 'ACME-9' }), 'board card: ACME-9');
  assert.equal(TV.partyText({ kind: 'member', label: 'Mallory' }), 'teammate: Mallory');
  assert.equal(TV.partyText({ kind: 'human', label: 'x' }), 'You');
  for (const a of TV.NATIVE_CONFIRM) assert.ok(!TV.CONFIRM_ACTIONS.includes(a), a);
});
