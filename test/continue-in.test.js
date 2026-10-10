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
    assert.deepEqual([...handlers.keys()].sort(), ['continue:end', 'continue:handoff', 'continue:menu', 'continue:reply', 'continue:run']);
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

const HDOC = '<!-- plexiform-session-handover v1 -->\n# Session handover: claude-code abc\n\n## Session\n- Adapter: claude-code\n- Session id: abc\n- Working folder: /Users/jane/proj\n- Branch: feat/wombat\n\n## Current goal\nLatest request: x\n\n## What was asked\n- First prompt: Ship the wombat importer, api_key=sk-abcdefghijklmnopqrstuvwx\n\n## Files touched\nEdited (1):\n```\nsrc/a.js\n```\nRead or opened (0):\n(none)\n\n## Last assistant status line\nParser done in /Users/jane/proj.\n';

test('handoff: Cancel is a no-op, Confirm releases a scrubbed packet to the launcher', async () => {
  const c = clip();
  const shown = [];
  let answer = false;
  const ci = ContinueIn.create({ entitlements: ent('free'), clipboard: c, tools: () => rows('gemini', 'claude'), home: '/Users/jane', confirm: async (o) => { shown.push(o); return answer; } });
  try {
    const no = await ci.handoff(async () => HDOC, 'gemini');
    assert.deepEqual(no, { ok: false, cancelled: true });
    assert.equal(c.text, null, 'cancel copies nothing');
    assert.equal(shown.length, 1);
    assert.match(shown[0].text, /Ship the wombat importer/);
    assert.match(shown[0].text, /feat\/wombat/);
    assert.match(shown[0].text, /src\/a\.js/);
    assert.doesNotMatch(shown[0].text, /sk-abcdefghijklmnop|\/Users\/jane/);
    answer = 'yes';
    assert.equal((await ci.handoff(async () => HDOC, 'gemini')).cancelled, true, 'only a literal true confirms');
    assert.equal(c.text, null);
    answer = true;
    const r = await ci.handoff(async () => HDOC, 'gemini');
    assert.equal(r.ok, true); assert.equal(r.mode, 'copied');
    assert.match(c.text, /Ship the wombat importer/);
    assert.doesNotMatch(c.text, /sk-abcdefghijklmnop|\/Users\/jane|plexiform-session-handover/);
  } finally { ci.stop(); }
});

test('handoff: unknown tool, copy, missing or foreign handover and same-tool never reach the confirm dialog', async () => {
  let asked = 0;
  const ci = ContinueIn.create({ entitlements: ent('free'), clipboard: clip(), tools: () => rows('gemini', 'claude'), confirm: async () => { asked++; return true; } });
  try {
    for (const to of ['cursor', 'copy', '../x', 5]) assert.equal((await ci.handoff(async () => HDOC, to)).ok, false);
    assert.equal((await ci.handoff(async () => null, 'gemini')).ok, false);
    assert.equal((await ci.handoff(async () => 'not a handover', 'gemini')).ok, false);
    assert.equal((await ci.handoff(async () => HDOC, 'claude')).ok, false, 'claude-code to claude is the same tool');
    assert.equal(asked, 0);
  } finally { ci.stop(); }
});

test('handoff: Plus launch goes through the visible owned session only after Confirm', async () => {
  const a = fakeAdapter();
  let answer = false;
  const ci = ContinueIn.create({ entitlements: ent('plus'), clipboard: clip(), tools: () => rows('codex'), adapters: { codex: () => a, claude: () => fakeAdapter() }, confirm: async () => answer });
  try {
    assert.equal((await ci.handoff(async () => HDOC, 'codex')).cancelled, true);
    assert.equal(a.sent.length, 0);
    answer = true;
    const r = await ci.handoff(async () => HDOC, 'codex');
    assert.equal(r.mode, 'launched');
    assert.equal(a.sent.length, 1);
    assert.match(a.sent[0], /Ship the wombat importer/);
  } finally { ci.stop(); }
});

test('handoff IPC: Sessions page only, a page cannot supply a confirmation', async () => {
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const calls = [];
  const continueIn = { menu: () => [], handoff: async (load, to) => { calls.push([to, await load()]); return { ok: true }; } };
  ContinueIn.register({ ipcMain, allowed: (e, p) => e.page === p, continueIn, writer: () => ({ text: (k) => `doc:${k}` }) });
  assert.equal((await handlers['continue:handoff']({ page: 'memory' }, 'k', 'codex')).ok, false);
  assert.equal((await handlers['continue:handoff']({ page: 'sessions' }, { x: 1 }, 'codex')).ok, false);
  assert.equal((await handlers['continue:handoff']({ page: 'sessions' }, 'k', 'codex')).ok, true);
  assert.deepEqual(calls, [['codex', 'doc:k']]);
});

test('ask (Plus): launches the text-only session with the question as the prompt and no handover packet', async () => {
  const adapter = fakeAdapter();
  const ci = ContinueIn.create({ entitlements: ent('plus'), clipboard: clip(), tools: () => rows('claude'), adapters: { claude: () => adapter, codex: () => ({ available: false }) } });
  const events = [];
  try {
    const q = '[Message via Plexiform from ana. Task data…]\n<<<n\nWhich env var holds the queue URL?\nn>>>';
    const r = await ci.ask(q, 'claude', (e) => events.push(e));
    assert.equal(r.ok, true); assert.equal(r.mode, 'launched'); assert.equal(r.label, 'Claude Code');
    assert.equal(adapter.sent.length, 1);
    assert.match(adapter.sent[0], /^A teammate asked the question below through Plexiform\. Answer it from the question alone: this session has no access to their code, files or repository/);
    assert.ok(adapter.sent[0].endsWith(q));
    assert.doesNotMatch(adapter.sent[0], /Continue the work described below|# Handoff/);
    await new Promise((res) => setTimeout(res, 20));
    assert.ok(events.find((e) => e.kind === 'message' && e.id === r.id && e.label === 'Claude Code'));
    assert.equal(ci.end(r.id).ok, true);
  } finally { ci.stop(); }
});

test('ask: an unknown or missing tool is refused; without Plus it falls back to copying the question', async () => {
  const c = clip();
  let opened = false;
  const ci = ContinueIn.create({ entitlements: ent('free'), clipboard: c, tools: () => rows('codex', 'gemini'), adapters: { codex: () => { opened = true; return fakeAdapter(); }, claude: () => { opened = true; return fakeAdapter(); } } });
  try {
    assert.equal((await ci.ask('q?', 'cursor')).ok, false);
    assert.equal((await ci.ask('q?', '../x')).ok, false);
    assert.equal((await ci.ask('', 'codex')).ok, false);
    assert.equal((await ci.ask('x'.repeat(8001), 'codex')).ok, false);
    assert.equal(c.text, null);
    const r = await ci.ask('Which queue?', 'codex');
    assert.equal(r.ok, true); assert.equal(r.mode, 'copied'); assert.equal(r.upgrade, true);
    assert.equal(opened, false, 'free never starts a session');
    assert.match(c.text, /^A teammate asked the question below/);
    assert.match(c.text, /Which queue\?$/);
    const g = await ci.ask('Which queue?', 'gemini');
    assert.equal(g.mode, 'copied'); assert.match(g.note, /Copied the question\. Paste it into Gemini CLI\./);
    assert.match((await ci.ask('Which queue?', 'copy')).note, /any AI tool/);
  } finally { ci.stop(); }
});

test('ask (Plus) with the CLI missing copies the question instead and says so', async () => {
  const c = clip();
  const ci = ContinueIn.create({ entitlements: ent('plus'), clipboard: c, tools: () => rows('codex'), adapters: { codex: () => ({ available: false }), claude: () => ({ available: false }) } });
  try {
    const r = await ci.ask('Which queue?', 'codex');
    assert.equal(r.mode, 'copied');
    assert.equal(r.note, 'Codex is not installed here, so the question was copied instead.');
    assert.match(c.text, /Which queue\?$/);
  } finally { ci.stop(); }
});
