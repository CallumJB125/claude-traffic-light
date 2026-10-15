'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const dir = path.join(__dirname, '..', 'buddy-window');
const html = fs.readFileSync(path.join(dir, 'sidebar.html'), 'utf8');
const renderer = fs.readFileSync(path.join(dir, 'sidebar.js'), 'utf8');
const preload = fs.readFileSync(path.join(dir, 'sidebar-preload.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'file:///fixture/sidebar.html' });
  t.after(() => dom.window.close());
  const sent = [], listeners = new Map();
  const pages = {
    pages: [
      { id: 'board', title: 'Board', icon: 'board', kind: 'local' },
      { id: 'home', title: 'Home', icon: 'sun', kind: 'local' },
      { id: 'settings', title: 'Settings', icon: 'gear', kind: 'local' },
    ],
    sections: [{ id: 'work', title: 'Workspace', icon: 'board', default: 'home', pages: ['board', 'home'] }],
    footer: ['settings'],
    brand: { name: 'Plexiform', hubText: { local: 'My board is ready' } },
  };
  vm.runInNewContext(preload, { require: name => {
    assert.equal(name, 'electron');
    return {
      contextBridge: { exposeInMainWorld: (key, value) => { dom.window[key] = value; } },
      ipcRenderer: {
        invoke: async channel => { assert.equal(channel, 'buddy:pages'); return pages; },
        send: (...args) => sent.push(args),
        on: (channel, callback) => { listeners.set(channel, callback); },
      },
    };
  } });
  dom.window.eval(renderer);
  await tick();
  const update = state => listeners.get('buddy:state')({}, {
    selected: 'board', workspaces: [{ id: 'local', name: 'My board', kind: 'local' }],
    active: 'local', signedIn: false, hub: { state: 'ready', mode: 'local' }, ...state,
  });
  update({ accountStorage: 'ready' });
  const document = dom.window.document;
  return { dom, document, sent, update, status: () => document.getElementById('account-storage'),
    retry: () => document.querySelector('#account-storage button') };
}

for (const [status, text] of [
  ['restoring', 'Unlocking saved sign-in… You can keep using Plexiform.'],
  ['saving', 'Saving sign-in securely… You can keep using Plexiform.'],
]) {
  test(`${status} sign-in announces progress while page navigation and workspaces remain usable`, async t => {
    const f = await fixture(t);
    f.update({ accountStorage: status });
    assert.equal(f.status().hidden, false);
    assert.equal(f.status().textContent, text);
    assert.equal(f.retry(), null, 'a pending native operation offers no competing retry');
    const home = f.document.querySelector('[data-page="home"]');
    assert.equal(home.disabled, false);
    home.click();
    assert.deepEqual(f.sent, [['buddy:select', 'home']]);
    const workspace = f.document.querySelector('#ws-select');
    assert.equal(workspace.disabled, false);
    workspace.value = 'signin';
    workspace.dispatchEvent(new f.dom.window.Event('change'));
    assert.deepEqual(f.sent.at(-1), ['buddy:workspace', 'signin']);
  });
}

test('locked saved sign-in shows recovery guidance as text and retries through the dedicated bridge', async t => {
  const f = await fixture(t);
  const help = 'Open Keychain Access and unlock your login keychain, then try again in Plexiform. <img src=x onerror=alert(1)>';
  f.update({ accountStorage: 'locked', accountStorageHelp: help });
  assert.equal(f.status().hidden, false);
  assert.ok(f.status().textContent.includes(help));
  assert.equal(f.status().querySelector('img'), null, 'recovery guidance cannot become markup');
  assert.equal(f.retry().textContent, 'Retry saved sign-in');
  assert.equal(f.retry().disabled, false);
  f.retry().click();
  assert.deepEqual(f.sent, [['buddy:account-storage-retry']]);
  f.document.querySelector('[data-page="settings"]').click();
  assert.deepEqual(f.sent.at(-1), ['buddy:select', 'settings']);
});

test('retry progress removes the retry control and successful restoration clears the message', async t => {
  const f = await fixture(t);
  f.update({ accountStorage: 'locked', accountStorageHelp: 'Unlock your login keychain.' });
  f.retry().click();
  f.update({ accountStorage: 'restoring' });
  assert.equal(f.retry(), null);
  assert.match(f.status().textContent, /Unlocking saved sign-in/);
  assert.doesNotMatch(f.status().textContent, /login keychain/);
  f.update({ accountStorage: 'ready' });
  assert.equal(f.status().hidden, true);
  assert.equal(f.status().textContent, '');
  assert.equal(f.retry(), null);
});

test('idle, cleared, unavailable and unknown storage states stay quiet', async t => {
  const f = await fixture(t);
  for (const status of ['idle', 'empty', 'cleared', 'unavailable', 'unknown', null, undefined]) {
    f.update({ accountStorage: 'locked', accountStorageHelp: 'Unlock your login keychain.' });
    f.update({ accountStorage: status });
    assert.equal(f.status().hidden, true);
    assert.equal(f.status().textContent, '');
    assert.equal(f.retry(), null);
  }
});

test('unrelated state updates preserve a focused retry button and locked message', async t => {
  const f = await fixture(t);
  f.update({ accountStorage: 'locked', accountStorageHelp: 'Unlock your login keychain.' });
  const retry = f.retry();
  retry.focus();
  f.update({ runners: ['Fixture team'] });
  assert.equal(f.retry(), retry);
  assert.equal(f.document.activeElement, retry);
  assert.match(f.status().textContent, /Unlock your login keychain/);
});
