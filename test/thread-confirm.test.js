'use strict';
// Redesign R4-1b: the thread's native dialog (plan-r4 §3). index.js threadConfirm/threadHeld/threadWcId, run as
// shipped in the thread world's vm (test/helpers/thread-world.js), and main.js's confirmDialog thread branch,
// run as shipped in a vm the way test/newchat-window-authority.test.js runs it. No window or dialog is opened.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { world, A, B, root } = require('./helpers/thread-world');

const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const yes = { response: 1 };
function opened() { const w = world(); w.ctx.openThread(A); return w; }

test('threadConfirm: the focused, bound thread gets the dialog, parented to its window; the ticket is held only during it', async () => {
  const w = opened();
  assert.equal(w.ctx.api.threadWcId(), w.doc().sender.id);
  assert.equal(w.ctx.api.threadHeld(), false);
  let during = null;
  const r = await w.ctx.api.threadConfirm(async (owner) => { assert.equal(owner, w.win); during = w.ctx.api.threadHeld(); return yes; });
  assert.deepEqual(r, yes);
  assert.equal(during, true);
  assert.equal(w.ctx.api.threadHeld(), false, 'released');
});

test('threadConfirm: unfocused, not shown, or no show function → null, and show is never called', async () => {
  for (const setup of [(w) => { w.win.focused = false; }, (w) => { w.ctx.select('board'); }, (w) => { w.win.minimized = true; }, (w) => { w.win.visible = false; }]) {
    const w = opened(); setup(w);
    let asked = 0;
    assert.equal(await w.ctx.api.threadConfirm(async () => { asked++; return yes; }), null, setup.toString());
    assert.equal(asked, 0);
  }
  assert.equal(await opened().ctx.api.threadConfirm(null), null);
});

test('threadConfirm: any other dialog open (Tasks, Home, Setups, the new chat, another thread one) → null, show never called', async () => {
  for (const other of ['tasksModalTicket', 'homeModalTicket', 'setupModalTicket', 'newChat', 'thread']) {
    const w = opened();
    let release = null;
    if (other === 'newChat') w.ctx.api.newChatHeld = () => true;
    else if (other === 'thread') w.ctx.api.threadConfirm(() => new Promise((r) => { release = r; }));
    else w.ctx[other] = {};
    let asked = 0;
    assert.equal(await w.ctx.api.threadConfirm(async () => { asked++; return yes; }), null, other);
    assert.equal(asked, 0, other);
    release?.(yes);
  }
});

test('threadConfirm: every change while it is open voids the answer: reload, page, rebind, account, workspace, focus, frame', async () => {
  const changes = {
    reload: (w) => w.doc().sender.reload(),
    page: (w) => w.ctx.select('board'),
    rebind: (w) => w.ctx.openThread(B),
    account: (w) => { w.ctx.setupSourcesGeneration++; },
    workspace: (w) => { w.ctx.store.ws = 'ws-2'; },
    focus: (w) => { w.win.focused = false; },
    frame: (w) => { w.doc().sender.mainFrame = { url: w.doc().sender.url }; },
  };
  for (const [name, change] of Object.entries(changes)) {
    const w = opened();
    assert.equal(await w.ctx.api.threadConfirm(async () => { change(w); return yes; }), null, name);
    assert.equal(w.ctx.api.threadHeld(), false, `${name}: released`);
  }
});

test('threadConfirm: a show that throws releases the ticket', async () => {
  const w = opened();
  await assert.rejects(w.ctx.api.threadConfirm(async () => { throw new Error('boom'); }));
  assert.equal(w.ctx.api.threadHeld(), false);
  assert.deepEqual(await w.ctx.api.threadConfirm(async () => yes), yes);
});

test('gate off: no thread dialog, threadHeld is false and threadWcId is null', async () => {
  const w = opened();
  w.ctx.chatFirst = false;
  assert.equal(await w.ctx.api.threadConfirm(async () => yes), null);
  assert.equal(w.ctx.api.threadHeld(), false);
  assert.equal(w.ctx.api.threadWcId(), null);
});

// main.js confirmDialog (plan-r4 §3.2): the thread's wcId gets a dialog only for approve and switchAi.
const start = mainSrc.indexOf('    confirmDialog: async (info, wcId) => {', mainSrc.indexOf('function getTasks()'));
const finish = mainSrc.indexOf('    seen: {', start);
function confirmOf(buddyWin, shows) {
  const c = { tasksPages: () => [], buddyWin, dialog: { showMessageBox: async (owner, o) => { shows.push([owner, o]); return yes; } } };
  vm.runInNewContext('globalThis.confirm=({' + mainSrc.slice(start, finish) + '}).confirmDialog;', c);
  return c.confirm;
}

test('main.js: the thread wcId gets threadConfirm, parented to its window, for approve and switchAi only; anything else → false, no ticket', async () => {
  const tickets = [], shows = [];
  const owner = { name: 'buddy window' };
  const buddyWin = { pageWebContents: () => ({ id: 41 }), newChatWcId: () => 77, threadWcId: () => 88, threadConfirm: async (show) => { tickets.push('thread'); return show(owner); }, tasksConfirm: async () => { tickets.push('tasks'); return yes; } };
  const confirm = confirmOf(buddyWin, shows);
  const info = (action, label) => ({ action, label, title: 'Fix the tests', where: '~/acme', detail: 'Bash will be allowed without asking again for the rest of this task.' });
  assert.equal(await confirm(info('approve', 'Allow for this task'), 88), true);
  assert.equal(await confirm(info('approve', 'Accept and start'), 88), true);
  assert.equal(await confirm(info('switchAi', 'Continue with Codex'), 88), true);
  assert.equal(shows.length, 3);
  assert.ok(shows.every(([o]) => o === owner), 'parented to the thread\'s window');
  assert.deepEqual(shows.map(([, o]) => o.message), ['Allow for this task?', 'Accept and start?', 'Continue with Codex?'], 'the Tasks page\'s own wording');
  assert.equal(JSON.stringify(shows[0][1].buttons), JSON.stringify(['Cancel', 'Allow for this task']), 'Cancel first'); // another realm's array
  assert.equal(shows[0][1].defaultId, 0);
  for (const action of ['discard', 'takeover', 'openPr', 'merge', 'openTerminal', 'create', 'deny', 'stop']) assert.equal(await confirm(info(action, action), 88), false, action);
  assert.deepEqual(tickets, ['thread', 'thread', 'thread'], 'no ticket for anything else');
  // Gate off (threadWcId() null), an older buddy window, or another wcId: the thread branch is unreachable.
  for (const b of [{ ...buddyWin, threadWcId: () => null }, { pageWebContents: () => null }]) assert.equal(await confirmOf(b, shows)(info('approve', 'Allow for this task'), 88), false);
  assert.equal(await confirm(info('approve', 'Allow for this task'), 89), false, 'an unknown sender');
  assert.equal(shows.length, 3);
});
