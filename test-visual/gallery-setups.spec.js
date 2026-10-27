'use strict';
// D6 in the real app: a setup added from the Tasks page's gallery is parked in
// main and pulled by the Setups page when it is shown again (a cached view,
// not reloaded). Every file needs its own tick before Apply, which writes into
// a throwaway HOME. The gallery fetch and the dialog are stubbed in main.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchApp, windowByFile } = require('./app');

// The app ships the owner's public key (build/gallery-key.pub.pem), so only
// the committed, signed index is accepted: the stub serves exactly those bytes.
const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'gallery', 'index.json'));
const SIG = fs.readFileSync(path.join(ROOT, 'gallery', 'index.json.sig'));
// The Discover page shows one kind per tab: the setup items.
const COUNT = fs.readdirSync(path.join(ROOT, 'gallery', 'items', 'setup')).length;
const ITEM = JSON.parse(fs.readFileSync(path.join(ROOT, 'gallery', 'items', 'setup', 'explain-diff-command.json'), 'utf8'));
const FILE = ITEM.payload.files[0];
const CMD = FILE.content;

test('a gallery setup opens on a cached Setups page and needs its own tick before Apply', async ({}, testInfo) => {
  const h = await launchApp();
  const inspect = (file, script) => h.app.evaluate(async ({ webContents }, { file, script }) => {
    const page = webContents.getAllWebContents().find((w) => { try { return new URL(w.getURL()).pathname.endsWith('/' + file); } catch { return false; } });
    return page ? page.executeJavaScript(script) : null;
  }, { file, script });
  try {
    const widget = await windowByFile(h.app, 'index.html');
    await h.app.evaluate(({ dialog, session }, { index, sig }) => {
      globalThis.__gallery = { fetches: 0, confirms: [] };
      session.fromPartition('gallery').fetch = async (url) => {
        globalThis.__gallery.fetches += 1;
        if (url.endsWith('/gallery/index.json')) return new Response(Buffer.from(index, 'base64'), { status: 200 });
        if (url.endsWith('/gallery/index.json.sig')) return new Response(Buffer.from(sig, 'base64'), { status: 200 });
        return new Response('missing', { status: 404 });
      };
      dialog.showMessageBox = async (a, b) => { const opts = b || a; globalThis.__gallery.confirms.push(opts); return { response: 1 }; };
    }, { index: INDEX.toString('base64'), sig: SIG.toString('base64') });
    const observed = () => h.app.evaluate(() => globalThis.__gallery);

    await widget.evaluate(() => window.trafficLight.openHelp());
    await expect.poll(() => inspect('sidebar.html', '!!window.buddy')).toBe(true);
    // Setups first, so the page is cached when the gallery sends the person back to it.
    await inspect('sidebar.html', 'window.buddy.select("setups"); true');
    await expect.poll(() => inspect('setups.html', '!!document.querySelector("#personal h2")'), { timeout: 20000 }).toBe(true);
    await inspect('setups.html', 'window.__specLoads = (window.__specLoads || 0) + 1; true');

    await inspect('sidebar.html', 'window.buddy.select("discover"); true');
    await expect.poll(() => inspect('discover.html', '!!window.galleryApi && !!document.querySelector("#cg-gallery h2")'), { timeout: 20000 }).toBe(true);
    await inspect('discover.html', '[...document.querySelectorAll("#cg-gallery button")].find(b => b.textContent === "Fetch the gallery").click(); true');
    await inspect('discover.html', '[...document.querySelectorAll(".cg-tabs .cg-chip")].find(b => b.textContent === "Setups").click(); true');
    await expect.poll(() => inspect('discover.html', 'document.querySelectorAll("#cg-gallery .cg-card").length')).toBe(COUNT);
    // The file's full text is in the item's drawer, before Add.
    await inspect('discover.html', 'document.querySelector(\'[data-id="setup/explain-diff-command"]\').click(); true');
    expect(await inspect('discover.html', 'document.querySelector("#cg-drawer pre").textContent')).toBe(CMD);
    await inspect('discover.html', 'document.querySelector("#cg-drawer .cg-drawer-close").click(); true');

    await inspect('discover.html', '[...document.querySelectorAll(\'[data-id="setup/explain-diff-command"] .recipe-actions button\')].find(b => b.textContent === "Add").click(); true');
    const personal = () => inspect('setups.html', 'document.querySelector("#personal").textContent');
    await expect.poll(personal, { timeout: 15000 }).toContain('Setup from the community gallery');
    expect(await inspect('setups.html', 'window.__specLoads')).toBe(1);
    const add = (await observed()).confirms[0];
    expect(add.message).toBe(`Review on the Setups page: ${ITEM.title}?`);
    expect(add.detail).toContain(`~/${FILE.relative_path}`);
    const text = await personal();
    expect(text).toContain('An AI will follow these instructions in every session.');
    expect(text).toContain(CMD.split('\n').find((l) => l.startsWith('Explain')));
    expect(text).toContain('self-declared');

    const png = await h.app.evaluate(async ({ webContents }) => {
      const contents = webContents.getAllWebContents().find((w) => w.getURL().includes('/setups.html'));
      return (await contents.capturePage()).toPNG().toString('base64');
    });
    await testInfo.attach('gallery-setup-review', { body: Buffer.from(png, 'base64'), contentType: 'image/png' });

    const applyDisabled = () => inspect('setups.html', '[...document.querySelectorAll("#personal button")].find(b => b.textContent.startsWith("Apply selected")).disabled');
    await inspect('setups.html', '{ const i = document.querySelector("#personal .personal-unit input"); i.checked = true; i.dispatchEvent(new Event("change")); } true');
    expect(await applyDisabled()).toBe(true);
    await inspect('setups.html', '{ const i = document.querySelectorAll("#personal .personal-unit input")[1]; i.checked = true; i.dispatchEvent(new Event("change")); } true');
    expect(await applyDisabled()).toBe(false);
    expect(fs.existsSync(path.join(h.userHome, '.claude', 'commands'))).toBe(false); // the fake providers own the rest of .claude
    await inspect('setups.html', '[...document.querySelectorAll("#personal button")].find(b => b.textContent.startsWith("Apply selected")).click(); true');
    await expect.poll(personal).toContain('Applied 1 change');
    expect(fs.readFileSync(path.join(h.userHome, FILE.relative_path), 'utf8')).toBe(CMD);
    expect((await observed()).confirms[1].detail).toContain(FILE.relative_path);
  } finally {
    await h.cleanup();
  }
});
