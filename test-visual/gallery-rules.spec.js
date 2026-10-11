'use strict';
// D5 in the real app: widget rules added from the Tasks page's gallery open in
// Widget configuration as an offer, after main's native confirm, and replace
// the rules only on Load. The gallery session's fetch and the dialog are
// stubbed in main, so nothing reaches plexiform.dev and no dialog is shown.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { launchApp, windowByFile } = require('./app');

// The app ships the owner's public key (build/gallery-key.pub.pem), so only
// the committed, signed index is accepted: the stub serves exactly those bytes.
const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'gallery', 'index.json'));
const SIG = fs.readFileSync(path.join(ROOT, 'gallery', 'index.json.sig'));
const COUNT = fs.readdirSync(path.join(ROOT, 'gallery', 'items')).reduce((n, kind) => n + fs.readdirSync(path.join(ROOT, 'gallery', 'items', kind)).length, 0);
const ITEM = JSON.parse(fs.readFileSync(path.join(ROOT, 'gallery', 'items', 'rules', 'quiet-desk.json'), 'utf8'));
const NAMES = ITEM.payload.rules.map((r) => r.name);

test('widget rules from the gallery confirm natively, then wait in Widget configuration for Load', async ({}, testInfo) => {
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
    await inspect('sidebar.html', 'window.buddy.select("tasks"); true');
    await expect.poll(() => inspect('tasks.html', '!!window.galleryApi && !!document.querySelector("#cg-open")'), { timeout: 20000 }).toBe(true);
    await inspect('tasks.html', 'document.querySelector("#cg-open").click(); true');
    await inspect('tasks.html', '[...document.querySelectorAll("#cg-gallery button")].find(b => b.textContent === "Fetch the gallery").click(); true');
    await expect.poll(() => inspect('tasks.html', 'document.querySelectorAll("#cg-gallery .cg-card").length')).toBe(COUNT);
    expect(await inspect('tasks.html', 'document.querySelector(\'[data-id="rules/quiet-desk"]\').textContent')).toContain(NAMES[1]);

    await inspect('tasks.html', 'document.querySelector(\'[data-id="rules/quiet-desk"] .recipe-actions button\').click(); true');
    await expect.poll(() => inspect('tasks.html', 'document.querySelector("#cg-gallery .recipes-status").textContent')).toContain('in Widget configuration');
    const confirm = (await observed()).confirms[0];
    expect(confirm.message).toBe(`Open in Widget configuration: ${ITEM.title}?`);
    expect(confirm.detail).toContain(`${NAMES.length} widget rules: ${NAMES.join(', ')}.`);
    expect(confirm.detail).toContain('self-declared');

    const lights = await windowByFile(h.app, 'lights.html');
    await lights.waitForLoadState('load');
    await expect(lights.locator('#rules-choice')).toBeVisible();
    await expect(lights.locator('#rules-summary')).toContainText(`${NAMES.length} rules`);
    await expect(lights.locator('#rules-summary code')).toHaveCount(0);
    await expect(lights.locator('#rule-list li', { hasText: NAMES[0] })).toHaveCount(0);
    await testInfo.attach('gallery-rules-offer', { body: await lights.screenshot(), contentType: 'image/png' });

    await lights.click('#rules-choice [data-rules=load]');
    await expect(lights.locator('#rule-list li')).toHaveCount(NAMES.length);
    await expect(lights.locator('#rule-list li').first()).toContainText(NAMES[0]);
    await expect(lights.locator('#save-state')).toContainText('From the gallery');
    expect((await observed()).fetches).toBe(2); // one Fetch click: the index and its signature; the add fetches nothing
  } finally { await h.cleanup(); }
});
