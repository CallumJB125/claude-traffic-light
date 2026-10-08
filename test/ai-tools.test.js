'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AiTools = require('../src/ai-tools.js');
const Adapters = require('../adapters/index.js');

const HOOKS = path.join(__dirname, '..', 'hooks');
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-aitools-'));
const rig = (opts = {}) => {
  const h = opts.home || home();
  const dataDir = path.join(h, 'data');
  fs.mkdirSync(path.join(h, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(h, '.gemini'), { recursive: true });
  const runtime = Adapters.Runtime.make({ execPath: null, hooksDir: HOOKS, dataDir });
  let t = 1_000_000_000_000;
  const tools = AiTools.create({ home: h, runtime, dataDir, pathDirs: () => [], extraBinDirs: [], now: () => t,
    run: (_bin, _args, _o, cb) => { cb(null, 'tool 1.2.3\n'); return {}; }, ...opts.deps });
  return { h, tools, runtime, tick: (ms) => { t += ms; }, clock: () => t };
};
const row = (snap, id) => snap.rows.find((r) => r.id === id);
const backups = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.plexiform-backup-'));

test('scan lists every platform: detected ones ready to connect, the rest "Not installed" with an install link', async () => {
  const { tools } = rig();
  const snap = await tools.scan();
  assert.deepEqual(snap.rows.filter((r) => r.kind === 'tool').map((r) => r.id), ['claude', 'codex', 'gemini', 'cursor', 'hermes']);
  assert.equal(row(snap, 'codex').state, 'ready');
  assert.equal(row(snap, 'codex').primary.label, 'Connect');
  assert.equal(row(snap, 'gemini').lastEvent.text, 'no events yet');
  const missing = row(snap, 'cursor');
  assert.equal(missing.state, 'missing');
  assert.equal(missing.detail, 'Not installed');
  assert.deepEqual(missing.primary, { action: 'install', label: 'How to install' });
  assert.match(tools.installUrl('cursor'), /^https:\/\//);
  assert.deepEqual(snap.pending.sort(), ['codex', 'gemini']);
});

test('a tool found on PATH is detected and its version read', async () => {
  const h = home(), bin = path.join(h, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'cursor-agent'), '#!/bin/sh\n', { mode: 0o755 });
  const { tools } = rig({ home: h, deps: { pathDirs: () => [bin] } });
  const r = row(await tools.scan(), 'cursor');
  assert.equal(r.installed, true);
  assert.equal(r.version, '1.2.3');
  assert.equal(r.state, 'ready');
});

test('preview shows the exact lines to add and writes nothing', async () => {
  const { h, tools } = rig();
  const file = path.join(h, '.gemini', 'settings.json');
  const original = JSON.stringify({ theme: 'dark', hooks: { BeforeTool: [{ matcher: 'x', hooks: [{ type: 'command', command: 'mine' }] }] } }, null, 2);
  fs.writeFileSync(file, original);
  const p = tools.preview('gemini');
  assert.equal(p.ok, true);
  const added = p.files[0].lines.filter((l) => l.kind === 'add').map((l) => l.text).join('\n');
  assert.match(added, /--adapter gemini BeforeTool/);
  assert.match(added, /--adapter gemini SessionEnd/);
  assert.ok(!p.files[0].lines.some((l) => l.kind === 'del' && /mine/.test(l.text)), 'foreign hook is not removed');
  assert.match(p.files[0].backup, /settings\.json\.plexiform-backup-/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(backups(path.dirname(file)), []);
});

test('connect backs up first, writes, reads back, is idempotent, and Undo restores the original bytes', async () => {
  const { h, tools, tick, runtime } = rig();
  const file = path.join(h, '.gemini', 'settings.json');
  const original = '{\n  "theme": "dark",\n  "hooks": {"BeforeTool": [{"matcher": "x", "hooks": [{"type": "command", "command": "mine"}]}]}\n}\n';
  fs.writeFileSync(file, original);
  const r = await tools.connect('gemini');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.changed, true);
  const [b] = backups(path.dirname(file));
  assert.ok(b, 'backup exists');
  assert.equal(fs.readFileSync(path.join(path.dirname(file), b), 'utf8'), original);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(written.hooks.BeforeTool.some((g) => g.hooks.some((x) => x.command === 'mine')), 'foreign hook kept');
  assert.equal(Adapters.get('gemini').isInstalled({ home: h, runtime }), true);
  assert.equal(row(await tools.scan(), 'gemini').state, 'connected');

  tick(5000);
  const again = await tools.connect('gemini');
  assert.deepEqual([again.ok, again.changed], [true, false]);
  assert.equal(backups(path.dirname(file)).length, 1, 'no second backup when nothing changed');

  const u = tools.undo('gemini');
  assert.equal(u.ok, true, JSON.stringify(u));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(row(await tools.scan(), 'gemini').state, 'ready');
});

test('Undo on a file Plexiform created removes it again, and refuses once you have edited it', async () => {
  const { h, tools } = rig();
  const file = path.join(h, '.cursor', 'hooks.json');
  fs.mkdirSync(path.dirname(file));
  assert.equal((await tools.connect('cursor')).ok, true);
  assert.ok(fs.existsSync(file));
  assert.equal(tools.undo('cursor').ok, true);
  assert.equal(fs.existsSync(file), false);

  await tools.connect('cursor');
  fs.appendFileSync(file, '\n');
  const r = tools.undo('cursor');
  assert.equal(r.ok, false);
  assert.match(r.error, /has changed since Plexiform wrote it/);
  assert.ok(fs.existsSync(file));
});

test('hook commands point at the running app\'s real hooks folder, also in an unpackaged run', async () => {
  const { h, tools } = rig();
  await tools.connect('gemini');
  const text = fs.readFileSync(path.join(h, '.gemini', 'settings.json'), 'utf8');
  assert.ok(text.includes(JSON.stringify(path.join(HOOKS, 'emit.js')).slice(1, -1)), text.slice(0, 400));
  assert.match(text, /node /);
});

test('an unreadable config gets a clear error, is left alone, and leaves no backup behind', async () => {
  const { h, tools } = rig();
  const file = path.join(h, '.gemini', 'settings.json');
  fs.writeFileSync(file, '{ not json');
  const p = tools.preview('gemini');
  assert.equal(p.ok, false);
  assert.match(p.error, /settings\.json is not valid JSON/);
  const r = await tools.connect('gemini');
  assert.equal(r.ok, false);
  assert.match(r.error, /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  assert.deepEqual(backups(path.dirname(file)), []);
  const snap = await tools.scan();
  assert.equal(row(snap, 'gemini').state, 'fix');
  assert.equal(row(snap, 'gemini').primary.label, 'Fix');
});

test('a write that is refused restores the file and says so in plain words', { skip: process.getuid && process.getuid() === 0 }, async () => {
  const { h, tools } = rig();
  const dir = path.join(h, '.gemini');
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{}\n');
  fs.chmodSync(file, 0o444);
  fs.chmodSync(dir, 0o555);
  try {
    const r = await tools.connect('gemini');
    assert.equal(r.ok, false);
    assert.match(r.error, /permission denied|cannot write|EACCES|EPERM/i);
  } finally { fs.chmodSync(dir, 0o755); fs.chmodSync(file, 0o644); }
  assert.equal(fs.readFileSync(file, 'utf8'), '{}\n');
});

test('Codex connects through its lifecycle hooks file with no separate review step, and Disconnect removes only ours', async () => {
  const { h, tools } = rig();
  const file = path.join(h, '.codex', 'hooks.json');
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }, null, 2));
  const p = tools.preview('codex');
  assert.equal(p.ok, true);
  assert.match(p.files[0].lines.filter((l) => l.kind === 'add').map((l) => l.text).join('\n'), /--adapter codex --lifecycle SessionStart/);
  const r = await tools.connect('codex');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reviewRequired, undefined);
  assert.equal(row(await tools.scan(), 'codex').state, 'connected');
  const d = tools.disconnect('codex');
  assert.equal(d.ok, true, JSON.stringify(d));
  const left = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(left.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo mine' }] }]);
});

test('stale hooks (another app path) show Reconnect, and reconnecting repoints them', async () => {
  const h = home();
  const other = rig({ home: h });
  await other.tools.connect('gemini');
  const moved = AiTools.create({ home: h, runtime: Adapters.Runtime.make({ execPath: null, hooksDir: '/elsewhere/hooks', dataDir: path.join(h, 'data') }),
    dataDir: path.join(h, 'data'), pathDirs: () => [], extraBinDirs: [], run: (_b, _a, _o, cb) => { cb(null, '1.0.0'); return {}; } });
  const r = row(await moved.scan(), 'gemini');
  assert.equal(r.state, 'reconnect');
  assert.equal(r.primary.label, 'Reconnect');
  assert.equal((await moved.connect('gemini')).ok, true);
  assert.equal(row(await moved.scan(), 'gemini').state, 'connected');
  assert.ok(!fs.readFileSync(path.join(h, '.gemini', 'settings.json'), 'utf8').includes(HOOKS));
});

test('Connect all connects every detected tool in turn and reports each result, one failure not stopping the rest', async () => {
  const { h, tools } = rig();
  fs.mkdirSync(path.join(h, '.cursor'));
  fs.writeFileSync(path.join(h, '.gemini', 'settings.json'), '{ broken');
  const r = await tools.connectAll();
  assert.equal(r.ok, false);
  assert.deepEqual(r.results.map((x) => [x.id, x.ok]).sort(), [['codex', true], ['cursor', true], ['gemini', false]]);
  assert.match(r.results.find((x) => x.id === 'gemini').error, /not valid JSON/);
  const snap = await tools.scan();
  assert.equal(row(snap, 'cursor').state, 'connected');
  assert.equal(row(snap, 'gemini').state, 'fix');
});

test('last event comes from the newest session of that tool', async () => {
  const { h, tools, clock } = rig();
  const dir = path.join(h, 'data', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ sessionId: 'a', source: 'codex', updatedAt: new Date(clock() - 120000).toISOString() }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ sessionId: 'b', source: 'codex', updatedAt: new Date(clock() - 900000).toISOString() }));
  const snap = await tools.scan();
  assert.equal(row(snap, 'codex').lastEvent.text, '2 min ago');
  assert.equal(row(snap, 'gemini').lastEvent.text, 'no events yet');
  fs.rmSync(dir, { recursive: true });
  assert.equal(row(await tools.scan(), 'codex').lastEvent.text, '2 min ago', 'remembered after the session file is swept');
});

test('capability chips come from the matrix and the adapter, and Handover only where the handover writer reports', async () => {
  const { tools } = rig();
  const snap = await tools.scan();
  assert.deepEqual(row(snap, 'claude').chips, ['Live status', 'Answer prompts', 'Board cards', 'Cost']);
  assert.deepEqual(row(snap, 'gemini').chips, ['Live status', 'Board cards']);
  const withHandover = rig({ deps: { handoverSources: () => ['gemini'] } });
  assert.ok(row(await withHandover.tools.scan(), 'gemini').chips.includes('Handover'));
  assert.ok(!row(await withHandover.tools.scan(), 'codex').chips.includes('Handover'));
});

test('Hermes is not offered a plugin command from an unpackaged run', async () => {
  const { h, tools } = rig();
  fs.mkdirSync(path.join(h, '.hermes'));
  assert.match(tools.preview('hermes').error, /installed app/);
  assert.match((await tools.connect('hermes')).error, /installed app/);
});

test('a blocked app copy refuses to write any hooks', async () => {
  const { h, tools } = rig({ deps: { blocked: () => 'Move it to Applications first.' } });
  const r = await tools.connect('gemini');
  assert.deepEqual([r.ok, r.error], [false, 'Move it to Applications first.']);
  assert.equal(fs.existsSync(path.join(h, '.gemini', 'settings.json')), false);
});

test('custom tools: Add installs plexiform-run, lists the command, and never overwrites a foreign file', async () => {
  const { h, tools } = rig();
  const bad = tools.addCustom('Aider', '');
  assert.equal(bad.ok, false);
  const r = tools.addCustom('Aider', 'aider --model sonnet');
  assert.equal(r.ok, true, JSON.stringify(r));
  const runner = path.join(h, '.local', 'bin', 'plexiform-run');
  assert.ok(fs.statSync(runner).mode & 0o100, 'executable');
  const snap = await tools.scan();
  const c = row(snap, 'custom:Aider');
  assert.equal(c.state, 'connected');
  assert.match(c.command, /plexiform-run aider --model sonnet$/);
  assert.deepEqual(c.chips, ['Live status']);
  assert.match(c.note, /cannot answer prompts/);
  tools.removeCustom('Aider');
  assert.equal(row(await tools.scan(), 'custom:Aider'), undefined);

  const rig2 = rig();
  fs.mkdirSync(path.join(rig2.h, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(rig2.h, '.local', 'bin', 'plexiform-run'), 'mine\n');
  const refused = rig2.tools.addCustom('Aider', 'aider');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not made by Plexiform/);
  assert.equal(fs.readFileSync(path.join(rig2.h, '.local', 'bin', 'plexiform-run'), 'utf8'), 'mine\n');
});

test('diffLines reports only changed lines and the unchanged count', () => {
  const d = AiTools.diffLines('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(d.lines, [{ kind: 'del', text: 'b' }, { kind: 'add', text: 'B' }, { kind: 'add', text: 'd' }]);
  assert.equal(d.unchanged, 2);
});
