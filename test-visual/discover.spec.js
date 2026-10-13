'use strict';
// The Discover page in the real app: a sidebar entry of its own, tabs per
// kind, a pack as one card, the item drawer, Add pack after one confirm, and
// the Installed tab with Remove. The 'gallery' session's fetch and main's
// native dialog are stubbed in main, so nothing reaches plexiform.dev and no
// dialog is shown.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { launchApp, windowByFile } = require('./app');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'gallery', 'index.json'));
const SIG = fs.readFileSync(path.join(ROOT, 'gallery', 'index.json.sig'));
const items = (kind) => fs.readdirSync(path.join(ROOT, 'gallery', 'items', kind)).map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'gallery', 'items', kind, f), 'utf8')));
const PACK = items('pack')[0];
const RECIPE_COUNT = items('recipe').length;
const PACK_COUNT = items('pack').length;
const packRecipes = PACK.payload.members.filter((m) => m.startsWith('recipe/'));
const packCharacters = PACK.payload.members.filter((m) => m.startsWith('character/'));

test('Discover is its own page with tabs, one card per pack, a drawer, Add pack and an Installed tab', async ({}, testInfo) => {
  const h = await launchApp();
  const inspect = (file, script) => h.app.evaluate(async ({ webContents }, { file, script }) => {
    const page = webContents.getAllWebContents().find((w) => { try { return new URL(w.getURL()).pathname.endsWith('/' + file); } catch { return false; } });
    return page ? page.executeJavaScript(script) : null;
  }, { file, script });
  const d = (script) => inspect('discover.html', script);
  try {
    const widget = await windowByFile(h.app, 'index.html');
    await h.app.evaluate(({ dialog, session }, { index, sig }) => {
      globalThis.__gallery = { confirms: [] };
      session.fromPartition('gallery').fetch = async (url) => {
        if (url.endsWith('/gallery/index.json')) return new Response(Buffer.from(index, 'base64'), { status: 200 });
        if (url.endsWith('/gallery/index.json.sig')) return new Response(Buffer.from(sig, 'base64'), { status: 200 });
        return new Response('missing', { status: 404 });
      };
      dialog.showMessageBox = async (_w, opts) => { globalThis.__gallery.confirms.push(opts); return { response: 1 }; };
    }, { index: INDEX.toString('base64'), sig: SIG.toString('base64') });
    const confirms = () => h.app.evaluate(() => globalThis.__gallery.confirms);

    await widget.evaluate(() => window.trafficLight.openHelp());
    await expect.poll(() => inspect('sidebar.html', '!!window.buddy')).toBe(true);
    // Listed in the sidebar beside Tasks.
    await inspect('sidebar.html', 'window.buddy.select("sessions"); true');
    await expect.poll(() => inspect('sidebar.html', '[...document.querySelectorAll(".nav-sub:not([hidden]) .nav-label")].map(e => e.textContent).join()')).toContain('Discover');
    await inspect('sidebar.html', 'window.buddy.select("discover"); true');
    await expect.poll(() => d('!!window.galleryApi && !!document.querySelector("#cg-gallery h2")'), { timeout: 20000 }).toBe(true);
    expect(await d('document.querySelector("#cg-gallery h2").textContent')).toBe('Discover');
    expect(await d('[...document.querySelectorAll(".cg-tabs .cg-chip")].map(b => b.textContent)')).toEqual(['Installed', 'Recipes', 'Characters', 'Packs', 'Widget rules', 'Setups']);

    await d('[...document.querySelectorAll("#cg-gallery button")].find(b => b.textContent === "Fetch the gallery").click(); true');
    await expect.poll(() => d('document.querySelectorAll("#cg-gallery .cg-card").length')).toBe(RECIPE_COUNT);
    // A recipe appears once on its tab, whatever packs hold it.
    expect(await d(`[...document.querySelectorAll(".cg-card")].filter(c => c.dataset.id === ${JSON.stringify(packRecipes[0])}).length`)).toBe(1);

    // Packs: one card each, members named, no Add of their own.
    await d('[...document.querySelectorAll(".cg-tabs .cg-chip")].find(b => b.textContent === "Packs").click(); true');
    await expect.poll(() => d('document.querySelectorAll("#cg-gallery .cg-card").length')).toBe(PACK_COUNT);
    expect(await d(`document.querySelectorAll('[data-id="${PACK.id}"] .cg-members li').length`)).toBe(PACK.payload.members.length);
    expect(await d(`document.querySelectorAll('[data-id="${PACK.id}"] .cg-members .btn.primary').length`)).toBe(0);

    // The drawer: the whole item, the site link, Add pack.
    await d(`document.querySelector('[data-id="${PACK.id}"]').click(); true`);
    await expect.poll(() => d('!document.querySelector("#cg-drawer").hidden')).toBe(true);
    expect(await d('document.querySelector("#cg-drawer-title").textContent')).toBe(PACK.title);
    expect(await d('document.querySelector("#cg-drawer a.cg-site").href')).toBe(`https://plexiform.dev/gallery/${PACK.id}`);
    expect(await d('[...document.querySelectorAll(".cg-facts dt")].map(e => e.textContent)')).toEqual(['By', 'License', 'Added', 'Updated', 'Stacks', 'Tools', 'Tags', 'sha256']);
    const png = await h.app.evaluate(async ({ webContents }) => {
      const contents = webContents.getAllWebContents().find((w) => w.getURL().includes('/discover.html'));
      return (await contents.capturePage()).toPNG().toString('base64');
    });
    await testInfo.attach('discover-drawer', { body: Buffer.from(png, 'base64'), contentType: 'image/png' });

    await d('[...document.querySelectorAll("#cg-drawer button")].find(b => b.textContent === "Add pack").click(); true');
    await expect.poll(() => d('document.querySelector("#cg-gallery .recipes-status").textContent')).toContain(`from “${PACK.title}”`);
    const c = await confirms();
    expect(c.length).toBe(1);
    expect(c[0].message).toBe(`Add the pack: ${PACK.title}?`);
    expect(await d('document.querySelector("#cg-drawer").hidden')).toBe(true);
    for (const id of packRecipes) {
      const origin = fs.readdirSync(path.join(h.home, 'recipes')).find((f) => f.endsWith('.origin.json') && JSON.parse(fs.readFileSync(path.join(h.home, 'recipes', f), 'utf8')).gallery_id === id);
      expect(origin, id).toBeTruthy();
    }
    for (const id of packCharacters) {
      const dirs = fs.readdirSync(path.join(h.home, 'characters'));
      expect(dirs.some((dir) => { try { return JSON.parse(fs.readFileSync(path.join(h.home, 'characters', dir, 'hatch.json'), 'utf8')).params?.gallery_id === id; } catch { return false; } }), id).toBe(true);
    }

    // Installed: everything the pack put here, each with Remove; the card is marked.
    await d('[...document.querySelectorAll(".cg-tabs .cg-chip")].find(b => b.textContent === "Installed").click(); true');
    await expect.poll(() => d('document.querySelectorAll(".cg-installed").length')).toBe(packRecipes.length + packCharacters.length);
    await d('[...document.querySelectorAll(".cg-installed button")].find(b => b.textContent === "Remove").click(); true');
    await expect.poll(() => d('document.querySelectorAll(".cg-installed").length')).toBe(packRecipes.length + packCharacters.length - 1);
    await d('[...document.querySelectorAll(".cg-tabs .cg-chip")].find(b => b.textContent === "Packs").click(); true');
    await expect.poll(() => d(`[...document.querySelectorAll('[data-id="${PACK.id}"] .cg-members li')].filter(li => li.textContent.includes("installed")).length`)).toBe(packRecipes.length + packCharacters.length - 1);
  } finally { await h.cleanup(); }
});
