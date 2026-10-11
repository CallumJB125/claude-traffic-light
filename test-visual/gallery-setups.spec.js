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
const S = require('../src/gallery-schema');

const CMD = '# Spec command\nGALLERY-SETUP-SPEC: explain the diff, change nothing.\n';
const item = { schema: 1, kind: 'setup', id: 'spec-setup', title: 'Spec setup', summary: 'One command.', author: { name: 'Ana', github: 'ana-dev' }, license: 'CC0-1.0', tags: [], stacks: ['any'], tools: ['claude'], added: '2026-10-01', updated: '2026-10-05', payload: { schema: 1, files: [{ id: '3e1a0f4b-6d4a-4b82-8d5e-4f5a6b7c8d9e', source_id: 'claude-code', relative_path: '.claude/commands/spec-explain.md', format: 'text', content: CMD, note: '' }], items: [], note: '' } };
const INDEX = S.buildIndex([{ item, name: item.id }]).text;

test('a gallery setup opens on a cached Setups page and needs its own tick before Apply', async ({}, testInfo) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-setups-home-'));
  const h = await launchApp({ env: { HOME: home, USERPROFILE: home } });
  const inspect = (file, script) => h.app.evaluate(async ({ webContents }, { file, script }) => {
    const page = webContents.getAllWebContents().find((w) => { try { return new URL(w.getURL()).pathname.endsWith('/' + file); } catch { return false; } });
    return page ? page.executeJavaScript(script) : null;
  }, { file, script });
  try {
    const widget = await windowByFile(h.app, 'index.html');
    await h.app.evaluate(({ dialog, session }, index) => {
      globalThis.__gallery = { confirms: [] };
      session.fromPartition('gallery').fetch = async (url) => (url.endsWith('/gallery/index.json') ? new Response(index, { status: 200 }) : new Response('missing', { status: 404 }));
      const answer = async (opts) => { globalThis.__gallery.confirms.push(opts); return { response: 1 }; };
      dialog.showMessageBox = async (a, b) => answer(b || a);
    }, INDEX);
    const observed = () => h.app.evaluate(() => globalThis.__gallery);

    await widget.evaluate(() => window.trafficLight.openHelp());
    await expect.poll(() => inspect('sidebar.html', '!!window.buddy')).toBe(true);
    // Setups first, so the page is cached when the gallery sends the person back to it.
    await inspect('sidebar.html', 'window.buddy.select("setups"); true');
    await expect.poll(() => inspect('setups.html', '!!document.querySelector("#personal h2")'), { timeout: 20000 }).toBe(true);
    await inspect('setups.html', 'window.__specLoads = (window.__specLoads || 0) + 1; true');

    await inspect('sidebar.html', 'window.buddy.select("tasks"); true');
    await expect.poll(() => inspect('tasks.html', '!!window.galleryApi && !!document.querySelector("#cg-open")'), { timeout: 20000 }).toBe(true);
    await inspect('tasks.html', 'document.querySelector("#cg-open").click(); true');
    await inspect('tasks.html', '[...document.querySelectorAll("#cg-gallery button")].find(b => b.textContent === "Fetch the gallery").click(); true');
    await expect.poll(() => inspect('tasks.html', 'document.querySelectorAll("#cg-gallery .cg-card").length')).toBe(1);
    expect(await inspect('tasks.html', 'document.querySelector(\'[data-id="setup/spec-setup"] pre\').textContent')).toBe(CMD);

    await inspect('tasks.html', 'document.querySelector(\'[data-id="setup/spec-setup"] .recipe-actions button\').click(); true');
    const personal = () => inspect('setups.html', 'document.querySelector("#personal").textContent');
    await expect.poll(personal, { timeout: 15000 }).toContain('Setup from the community gallery');
    expect(await inspect('setups.html', 'window.__specLoads')).toBe(1);
    const add = (await observed()).confirms[0];
    expect(add.message).toBe('Review on the Setups page: Spec setup?');
    expect(add.detail).toContain('~/.claude/commands/spec-explain.md');
    const text = await personal();
    expect(text).toContain('An AI will follow these instructions in every session.');
    expect(text).toContain('GALLERY-SETUP-SPEC');
    expect(text).toContain('self-declared');

    const png = await h.app.evaluate(async ({ webContents }) => {
      const contents = webContents.getAllWebContents().find((w) => w.getURL().includes('/setups.html'));
      return (await contents.capturePage()).toPNG().toString('base64');
    });
    await testInfo.attach('gallery-setup-review', { body: Buffer.from(png, 'base64'), contentType: 'image/png' });

    const applyDisabled = () => inspect('setups.html', '[...document.querySelectorAll("#personal button")].find(b => b.textContent.startsWith("Apply selected")).disabled');
    await inspect('setups.html', 'const i = document.querySelector("#personal .personal-unit input"); i.checked = true; i.dispatchEvent(new Event("change")); true');
    expect(await applyDisabled()).toBe(true);
    await inspect('setups.html', 'const i = document.querySelectorAll("#personal .personal-unit input")[1]; i.checked = true; i.dispatchEvent(new Event("change")); true');
    expect(await applyDisabled()).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
    await inspect('setups.html', '[...document.querySelectorAll("#personal button")].find(b => b.textContent.startsWith("Apply selected")).click(); true');
    await expect.poll(personal).toContain('Applied 1 change');
    expect(fs.readFileSync(path.join(home, '.claude', 'commands', 'spec-explain.md'), 'utf8')).toBe(CMD);
    expect((await observed()).confirms[1].detail).toContain('.claude/commands/spec-explain.md');
  } finally {
    await h.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
