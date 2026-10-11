'use strict';
// Discover in the real app: the Tasks page's community gallery, with the
// 'gallery' session's fetch and main's native dialog stubbed in main, so
// nothing reaches plexiform.dev and no dialog is shown.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { launchApp, windowByFile } = require('./app');

// The app ships the owner's public key (build/gallery-key.pub.pem), so only
// the committed, signed index is accepted: the stub serves exactly those bytes.
const crypto = require('node:crypto');
const V = require('../src/plugins/index-verify.js');
const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'gallery', 'index.json'));
const SIG = fs.readFileSync(path.join(ROOT, 'gallery', 'index.json.sig'));
const KEY_ID = V.keyId(crypto.createPublicKey(fs.readFileSync(path.join(ROOT, 'build', 'gallery-key.pub.pem'), 'utf8')));
const COUNT = fs.readdirSync(path.join(ROOT, 'gallery', 'items')).reduce((n, kind) => n + fs.readdirSync(path.join(ROOT, 'gallery', 'items', kind)).length, 0);
const RECIPE = JSON.parse(fs.readFileSync(path.join(ROOT, 'gallery', 'items', 'recipe', 'explain-repo.json'), 'utf8'));
const CHARACTER = JSON.parse(fs.readFileSync(path.join(ROOT, 'gallery', 'items', 'character', 'pebble.json'), 'utf8'));
const PROMPT = RECIPE.payload.prompt;

test('Browse the gallery fetches only on a click, shows the signing key, and adds a recipe and a character after a confirm', async ({}, testInfo) => {
  const h = await launchApp();
  const inspect = (file, script) => h.app.evaluate(async ({ webContents }, { file, script }) => {
    const page = webContents.getAllWebContents().find((w) => { try { return new URL(w.getURL()).pathname.endsWith('/' + file); } catch { return false; } });
    return page ? page.executeJavaScript(script) : null;
  }, { file, script });
  try {
    const widget = await windowByFile(h.app, 'index.html');
    await h.app.evaluate(({ dialog, session }, { index, sig }) => {
      globalThis.__gallery = { fetches: [], confirms: [] };
      session.fromPartition('gallery').fetch = async (url, opts) => {
        globalThis.__gallery.fetches.push({ url, redirect: opts && opts.redirect });
        if (url.endsWith('/gallery/index.json')) return new Response(Buffer.from(index, 'base64'), { status: 200 });
        if (url.endsWith('/gallery/index.json.sig')) return new Response(Buffer.from(sig, 'base64'), { status: 200 });
        return new Response('missing', { status: 404 });
      };
      dialog.showMessageBox = async (_w, opts) => { globalThis.__gallery.confirms.push(opts); return { response: 1 }; };
    }, { index: INDEX.toString('base64'), sig: SIG.toString('base64') });
    const observed = () => h.app.evaluate(() => globalThis.__gallery);

    await widget.evaluate(() => window.trafficLight.openHelp());
    await expect.poll(() => inspect('sidebar.html', '!!window.buddy')).toBe(true);
    await inspect('sidebar.html', 'window.buddy.select("tasks"); true');
    await expect.poll(() => inspect('tasks.html', '!!window.galleryApi && !!document.querySelector("#cg-open")'), { timeout: 20000 }).toBe(true);

    await inspect('tasks.html', 'document.querySelector("#cg-open").click(); true');
    await expect.poll(() => inspect('tasks.html', '!document.querySelector("#cg-gallery").hidden')).toBe(true);
    expect((await observed()).fetches).toEqual([]);

    await inspect('tasks.html', '[...document.querySelectorAll("#cg-gallery button")].find(b => b.textContent === "Fetch the gallery").click(); true');
    await expect.poll(() => inspect('tasks.html', 'document.querySelectorAll("#cg-gallery .cg-card").length')).toBe(COUNT);
    expect((await observed()).fetches).toEqual([{ url: 'https://plexiform.dev/gallery/index.json', redirect: 'error' }, { url: 'https://plexiform.dev/gallery/index.json.sig', redirect: 'error' }]);
    expect(await inspect('tasks.html', 'document.querySelector(".cg-provenance").textContent')).toBe(`Signed (key ${KEY_ID})`);

    await inspect('tasks.html', 'document.querySelector(\'[data-id="recipe/explain-repo"] .recipe-actions button\').click(); true');
    await expect.poll(() => inspect('tasks.html', 'document.querySelector("#cg-gallery .recipes-status").textContent')).toContain('to My recipes');
    const recipeConfirm = (await observed()).confirms[0];
    expect(recipeConfirm.message).toBe(`Add to My recipes: ${RECIPE.title}?`);
    expect(recipeConfirm.detail).toContain(PROMPT);
    expect(recipeConfirm.detail).toContain('self-declared');
    // The store may rename a gallery id that collides with a built-in recipe; the origin sidecar marks the copy.
    const origin = fs.readdirSync(path.join(h.home, 'recipes')).find((f) => /explain-repo\.origin\.json$/.test(f));
    expect(origin).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(path.join(h.home, 'recipes', origin.replace('.origin.json', '.json')), 'utf8')).edits).toBe(false);

    await inspect('tasks.html', 'document.querySelector(\'[data-id="character/pebble"] .recipe-actions button\').click(); true');
    await expect.poll(() => inspect('tasks.html', 'document.querySelector("#cg-gallery .recipes-status").textContent')).toContain('to Characters');
    expect((await observed()).confirms[1].message).toBe(`Add to Characters: ${CHARACTER.title}?`);
    expect(fs.existsSync(path.join(h.home, 'characters', 'u-pebble', 'character.json'))).toBe(true);

    const png = await h.app.evaluate(async ({ webContents }) => {
      const contents = webContents.getAllWebContents().find((w) => w.getURL().includes('/tasks.html'));
      return (await contents.capturePage()).toPNG().toString('base64');
    });
    await testInfo.attach('gallery', { body: Buffer.from(png, 'base64'), contentType: 'image/png' });

    await inspect('tasks.html', '[...document.querySelectorAll("#cg-gallery button")].find(b => b.textContent === "Back to recipes").click(); if (document.querySelector("#recipes").hidden) document.querySelector("#recipes-open").click(); true');
    await expect.poll(() => inspect('tasks.html', `[...document.querySelectorAll("#recipes .recipe h3")].map(e => e.textContent).includes(${JSON.stringify(RECIPE.title)})`)).toBe(true);
  } finally { await h.cleanup(); }
});
