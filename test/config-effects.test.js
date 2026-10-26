const test = require('node:test');
const assert = require('node:assert/strict');
const { applyConfigSideEffects } = require('../src/config-effects.js');

const deps = () => {
  const calls = [];
  const d = new Proxy({}, { get: (_t, name) => (...a) => { calls.push([name, ...a.length ? [true] : []]); return Promise.resolve(); } });
  return { d, names: () => calls.map((c) => c[0]) };
};

test('a restore that turns remoteTailscale and askFromWidget off applies both', () => {
  const { d, names } = deps();
  applyConfigSideEffects({ remoteTailscale: true, askFromWidget: true }, { remoteTailscale: false, askFromWidget: false }, d);
  assert.ok(names().includes('syncTailnetListener'));
  assert.ok(names().includes('installHooks'));
  assert.equal(names().at(-1), 'broadcastStatus');
});

test('nothing changed: only the broadcast', () => {
  const { d, names } = deps();
  applyConfigSideEffects({ showWidget: true, voice: { a: 1 } }, { showWidget: true, voice: { a: 1 } }, d);
  assert.deepEqual(names(), ['broadcastStatus']);
});

test('each setting reaches its own side effect', () => {
  const run = (prev, next) => { const { d, names } = deps(); applyConfigSideEffects(prev, next, d); return names(); };
  assert.ok(run({ showWidget: true }, { showWidget: false }).includes('applyWidgetVisibility'));
  assert.ok(run({ showWidget: true }, { showWidget: false }).includes('createTray'));
  assert.ok(run({ menuBarMode: false }, { menuBarMode: true }).includes('createTray'));
  assert.ok(run({ voice: { a: 1 } }, { voice: { a: 2 } }).includes('applyVoiceHotkey'));
  assert.ok(run({ busyCalendar: false }, { busyCalendar: true }).includes('enableCalendar'));
  assert.ok(!run({ busyCalendar: true }, { busyCalendar: true }).includes('enableCalendar'));
});

test('a save that names a key applies its effect even when the value is the same', () => {
  const { d, names } = deps();
  applyConfigSideEffects({ showWidget: true }, { showWidget: true }, d, (k) => k === 'showWidget');
  assert.ok(names().includes('applyWidgetVisibility'));
});


test('automatic team sharing setting applies the hosting side effect',()=>{
 let calls=0;applyConfigSideEffects({teamSessionSharing:true},{teamSessionSharing:false},{syncInteractionHost:()=>calls++,broadcastStatus(){}});assert.equal(calls,1);
});

test('the agent mail inbox preference syncs the poller, and only that preference does',()=>{
 let calls=0;const d={syncAgentMail:()=>calls++,syncInteractionHost(){},broadcastStatus(){},applyWidgetVisibility(){},createTray(){}};
 applyConfigSideEffects({showWidget:true},{showWidget:false},d);assert.equal(calls,0);
 applyConfigSideEffects({agentMailInbox:false},{agentMailInbox:true},d);assert.equal(calls,1);
});

// ── C-P: the answering default, for new installs only ────────────────────────
const fs = require('fs');
const path = require('path');
const { testTempDir } = require('./helpers/tmp');
const AskDefault = require('../src/ask-default.js');
const Claude = require('../adapters/claude-code.js');
const Help = require('../help.js');
const RT = require('../adapters/runtime.js').make({ execPath: null, hooksDir: path.join(__dirname, '..', 'hooks'), dataDir: path.join(__dirname, '..', '.tmp-data') });
const written = (root) => JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const permissionHook = (settings) => !!settings.hooks.PermissionRequest;

test('C-P: a brand-new install records askFromWidget true, and its hooks then carry the blocking permission hook', () => {
  const root = testTempDir('ask-default-');
  const firstRun = Help.shouldOnboard({ onboarded: false, helpShown: false, devRun: false });
  assert.equal(AskDefault.migrate({ root, firstRun }), true);
  const cfg = written(root);
  assert.equal(cfg.askFromWidget, true);
  assert.equal(cfg.claudeAutoConnect, undefined, 'nothing else is decided for the person: setup\'s Connect still holds the hooks');
  assert.equal(permissionHook(Claude.apply({}, RT, { askFromWidget: cfg.askFromWidget })), true);
  assert.equal(AskDefault.migrate({ root, firstRun }), null, 'written once; a second launch leaves it alone');
});

test('C-P: an existing config, with or without the key, is never flipped on', () => {
  const root = testTempDir('ask-default-');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ askFromWidget: false, showTasks: false }));
  assert.equal(AskDefault.migrate({ root, firstRun: true }), null, 'a recorded choice stands, even on a first-run-looking folder');
  assert.equal(written(root).askFromWidget, false);
  const marked = testTempDir('ask-default-');
  fs.writeFileSync(path.join(marked, 'config.json'), JSON.stringify({ showTasks: false }));
  assert.equal(AskDefault.migrate({ root: marked, firstRun: Help.shouldOnboard({ onboarded: true, helpShown: false, devRun: false }) }), false, 'onboarded markers exist: existing install');
  assert.deepEqual(written(marked), { showTasks: false, askFromWidget: false }, 'other keys untouched');
  assert.equal(permissionHook(Claude.apply({}, RT, { askFromWidget: written(marked).askFromWidget })), false, 'its hooks are unchanged');
  const legacy = testTempDir('ask-default-');
  assert.equal(AskDefault.migrate({ root: legacy, firstRun: Help.shouldOnboard({ onboarded: false, helpShown: true, devRun: false }) }), false, 'an install that saw the old Help');
});

test('C-P (G1): a rename-retry launch (old-product install found, no markers yet) is an existing install', () => {
  const root = testTempDir('ask-default-');
  assert.equal(AskDefault.migrate({ root, firstRun: true, renameFound: true }), false);
  assert.equal(written(root).askFromWidget, false);
});

test('C-P: claudeAutoConnect already set, no markers: an existing install', () => {
  const root = testTempDir('ask-default-');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ claudeAutoConnect: true }));
  assert.equal(AskDefault.migrate({ root, firstRun: true }), false);
  assert.deepEqual(written(root), { claudeAutoConnect: true, askFromWidget: false });
});

test('C-P: a dev run writes nothing; every reader\'s own default stays false', () => {
  const root = testTempDir('ask-default-');
  assert.equal(AskDefault.migrate({ root, firstRun: false, devRun: true }), null);
  assert.equal(fs.existsSync(path.join(root, 'config.json')), false);
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(src('main.js'), /^\s*askFromWidget: false,/m);
  assert.match(src('mcp-server.js'), /^\s*askFromWidget: false,/m);
});

test('C-P/G2: before setup\'s Connect a new install installs no hook at all', () => {
  const start = Help.firstRunStart({ firstRun: true, claudeAutoConnect: undefined });
  assert.equal(start.holdClaude, true, 'main saves claudeAutoConnect:false, so claudeAutoConnect() is false and installHooks never runs');
  assert.equal(start.setLoginItem, false);
});
