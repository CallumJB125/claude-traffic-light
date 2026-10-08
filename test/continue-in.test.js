'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ContinueIn = require('../src/continue-in.js');

const DOC = '<!-- plexiform-session-handover v1 -->\n# Handover\n\n## Goal\nShip the wombat importer\n';
const ent = (plan) => ({ has: (f) => f === 'handoff.copy' || (plan === 'plus' && f === 'handoff.launch') });
const clip = () => ({ text: null, writeText(t) { this.text = t; } });
const rows = (...installed) => ['claude', 'codex', 'gemini', 'cursor', 'hermes'].map((id) => ({ id, label: id, installed: installed.includes(id), connected: false }));

function fakeAdapter() {
  let listener = () => {};
  const sent = [];
  return {
    sent,
    open: async () => ({ target: 't1' }),
    on: (cb) => { listener = cb; return () => { listener = () => {}; }; },
    send: async ({ target, text }) => { sent.push(text); setImmediate(() => { listener({ kind: 'message', target, text: `echo:${text.slice(0, 20)}` }); listener({ kind: 'turn-completed', target, status: 'completed' }); }); },
    release: () => {},
    stop: () => {},
  };
}

test('the menu lists only the tools found on this Mac, in a fixed order, then Copy as prompt', () => {
  assert.deepEqual(ContinueIn.choices(rows('hermes', 'codex', 'gemini')).map((c) => c.id), ['codex', 'gemini', 'hermes', 'copy']);
  assert.deepEqual(ContinueIn.choices(rows()).map((c) => c.id), ['copy']);
  assert.deepEqual(ContinueIn.choices(null).map((c) => c.id), ['copy']);
  assert.deepEqual(ContinueIn.choices([{ id: 'claude', installed: 'yes' }, { id: 'cursor', installed: true }]).map((c) => c.id), ['cursor', 'copy']);
});

test('only Codex and Claude Code launch, and only when the plan includes it', () => {
  const free = ContinueIn.choices(rows('claude', 'codex', 'gemini', 'cursor', 'hermes'));
  assert.ok(free.every((c) => c.mode === 'copy'));
  const plus = ContinueIn.choices(rows('claude', 'codex', 'gemini', 'cursor', 'hermes'), { canLaunch: true });
  assert.deepEqual(plus.filter((c) => c.mode === 'launch').map((c) => c.id), ['claude', 'codex']);
  assert.deepEqual(plus.map((c) => c.label), ['Claude Code', 'Codex', 'Gemini CLI', 'Cursor', 'Hermes', 'Copy as prompt']);
});

test('a tool that is not installed cannot be picked; a found copy-only tool gets the prompt on the clipboard', async () => {
  const c = clip();
  const ci = ContinueIn.create({ entitlements: ent('free'), clipboard: c, tools: () => rows('gemini') });
  try {
    assert.equal((await ci.run(async () => DOC, 'cursor')).ok, false);
    assert.equal((await ci.run(async () => DOC, '../../x')).ok, false);
    assert.equal(c.text, null);
    const r = await ci.run(async () => DOC, 'gemini');
    assert.equal(r.ok, true); assert.equal(r.mode, 'copied');
    assert.match(r.note, /Paste it into Gemini CLI/);
    assert.match(c.text, /^Continue the work described below/);
    assert.match(c.text, /Ship the wombat importer/);
    assert.doesNotMatch(c.text, /plexiform-session-handover/);
    const any = await ci.run(async () => DOC, 'copy');
    assert.equal(any.ok, true); assert.match(any.note, /any AI tool/);
    assert.equal((await ci.run(async () => null, 'copy')).ok, false, 'no handover, nothing copied');
  } finally { ci.stop(); }
});

test('free plan: picking Codex falls back to the copy and never starts a session', async () => {
  const c = clip();
  let opened = false;
  const ci = ContinueIn.create({ entitlements: ent('free'), clipboard: c, tools: () => rows('codex'), adapters: { codex: () => { opened = true; return fakeAdapter(); }, claude: () => { opened = true; return fakeAdapter(); } } });
  try {
    const r = await ci.run(async () => DOC, 'codex');
    assert.equal(r.ok, true); assert.equal(r.mode, 'copied'); assert.equal(r.upgrade, true);
    assert.equal(opened, false);
    assert.ok(c.text);
  } finally { ci.stop(); }
});

test('Plus: Codex launches through the existing hand-off with the handover as its first message, events carry the label', async () => {
  const adapter = fakeAdapter();
  const ci = ContinueIn.create({ entitlements: ent('plus'), clipboard: clip(), tools: () => rows('codex'), adapters: { codex: () => adapter, claude: () => ({ available: false }) } });
  const events = [];
  try {
    const r = await ci.run(async () => DOC, 'codex', (e) => events.push(e));
    assert.equal(r.ok, true); assert.equal(r.mode, 'launched'); assert.equal(r.label, 'Codex');
    assert.match(adapter.sent[0], /^Continue the work described below/);
    await new Promise((res) => setTimeout(res, 20));
    assert.ok(events.find((e) => e.kind === 'message' && e.id === r.id && e.label === 'Codex'));
    assert.ok(events.find((e) => e.kind === 'done' && e.status === 'completed'));
    assert.deepEqual(await ci.reply(r.id, 'and add tests'), { ok: true });
    assert.equal(ci.end(r.id).ok, true);
  } finally { ci.stop(); }
});

test('register: every channel checks its page, and Running now runs by handover key from the writer', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const asked = [];
  const c = clip();
  const continueIn = ContinueIn.create({ entitlements: ent('free'), clipboard: c, tools: () => rows('hermes') });
  ContinueIn.register({ ipcMain, allowed: (e, page) => e.page === page, continueIn, writer: () => ({ text: (k) => { asked.push(k); return k === 'codex-abc' ? DOC : null; } }) });
  try {
    assert.deepEqual([...handlers.keys()].sort(), ['continue:end', 'continue:menu', 'continue:reply', 'continue:run']);
    assert.equal((await handlers.get('continue:menu')({ page: 'board' })).ok, false);
    assert.deepEqual((await handlers.get('continue:menu')({ page: 'memory' })).choices.map((x) => x.id), ['hermes', 'copy']);
    assert.equal((await handlers.get('continue:run')({ page: 'memory' }, 'codex-abc', 'hermes')).ok, false, 'Search runs through its own hand-off channels');
    assert.equal(asked.length, 0);
    const r = await handlers.get('continue:run')({ page: 'sessions' }, 'codex-abc', 'hermes');
    assert.equal(r.ok, true); assert.match(r.note, /Hermes/);
    assert.deepEqual(asked, ['codex-abc']);
    assert.equal((await handlers.get('continue:run')({ page: 'sessions' }, { k: 1 }, 'hermes')).ok, false);
  } finally { continueIn.stop(); }
});

test('the board popup lists the menu natively and resolves with the run, or null when dismissed', async () => {
  let template = null, popped = null;
  const Menu = { buildFromTemplate: (t) => { template = t; return { popup: (o) => { popped = o; } }; } };
  const c = clip();
  const continueIn = ContinueIn.create({ entitlements: ent('free'), clipboard: c, tools: () => rows('cursor') });
  try {
    const p = ContinueIn.popup({ Menu, continueIn, window: 'win', load: async () => DOC });
    assert.equal(popped.window, 'win');
    const items = template.filter((t) => t.click);
    assert.deepEqual(items.map((t) => t.label), ['Cursor (copies the prompt)', 'Copy as prompt']);
    items[0].click();
    popped.callback();
    const r = await p;
    assert.equal(r.ok, true); assert.match(r.note, /Cursor/);
    const q = ContinueIn.popup({ Menu, continueIn, window: 'win', load: async () => DOC });
    popped.callback();
    assert.equal(await q, null);
  } finally { continueIn.stop(); }
});
