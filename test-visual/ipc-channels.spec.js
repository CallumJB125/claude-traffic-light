'use strict';
// Redesign R2b (plan-r2b-auth §5): with the chat-first preview gate off, the
// app registers exactly the ipcMain channels it did on main before R2b. The
// committed list (test/fixtures/ipc-channels-gate-off.txt) was
// generated from main (70328b0f; #102 and #103 add no channel) with
// PLEXIFORM_WRITE_IPC_LIST=1; any added or
// missing channel fails, so nothing R2b adds can reach a gate-off build.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile } = require('./app');

const LIST = path.join(__dirname, '..', 'test', 'fixtures', 'ipc-channels-gate-off.txt');

// invoke handlers plus on() listeners, once the set has stopped growing (boot registers some lazily).
async function channels(app) {
  const read = () => app.evaluate(({ ipcMain }) => {
    const invoke = ipcMain._invokeHandlers instanceof Map ? [...ipcMain._invokeHandlers.keys()] : null;
    return { invoke, on: ipcMain.eventNames().map(String) };
  });
  let last = '', stable = 0, out = null;
  for (let i = 0; i < 40 && stable < 4; i++) {
    out = await read();
    const key = JSON.stringify(out);
    stable = key === last ? stable + 1 : 0; last = key;
    await new Promise((r) => setTimeout(r, 250));
  }
  expect(Array.isArray(out.invoke), 'Electron exposes its invoke handler map').toBe(true);
  return [...out.invoke.map((n) => `handle ${n}`), ...out.on.map((n) => `on ${n}`)].sort();
}

test('gate off: the registered ipcMain channels equal main\'s before R2b', async () => {
  const h = await launchApp({});
  try {
    await windowByFile(h.app, 'index.html');
    const now = await channels(h.app);
    expect(now.some((n) => /^(handle|on) (thread|newchat):/.test(n)), 'no thread:* or newchat:* channel').toBe(false);
    if (process.env.PLEXIFORM_WRITE_IPC_LIST === '1') { fs.writeFileSync(LIST, `${now.join('\n')}\n`); return; }
    const committed = fs.readFileSync(LIST, 'utf8').split('\n').filter(Boolean);
    expect(now).toEqual(committed);
  } finally { await h.cleanup(); }
});
