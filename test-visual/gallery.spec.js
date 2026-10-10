'use strict';
// Discover in the real app: the Tasks page's community gallery, with the
// 'gallery' session's fetch and main's native dialog stubbed in main, so
// nothing reaches plexiform.dev and no dialog is shown.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { launchApp, windowByFile } = require('./app');
const S = require('../src/gallery-schema');
const Hatch = require('../characters/hatch');

const PROMPT = 'Read the repository and explain it.\n\nGALLERY-SPEC-FULL-PROMPT: list every module.';
const base = (kind, id, payload) => ({ schema: 1, kind, id, title: `Spec ${id}`, summary: `About ${id}.`, author: { name: 'Ana', github: 'ana-dev' }, license: 'CC0-1.0', tags: [], stacks: ['any'], tools: ['auto'], added: '2026-10-01', updated: '2026-10-05', payload });
const items = [
  base('recipe', 'spec-explain', { id: 'spec-explain', title: 'Spec spec-explain', what: 'Explains the repo.', prompt: PROMPT, tool: 'auto', edits: false, cost: 'Low.' }),
  base('character', 'speccy', Hatch.templateCharacter({ name: 'Speccy' })),
  base('pack', 'spec-pack', { members: ['recipe/spec-explain', 'character/speccy'], note: '' }),
];
const INDEX = S.buildIndex(items.map((item) => ({ item, name: item.id }))).text;

test('Browse the gallery fetches only on a click, labels it unsigned, and adds a recipe and a character after a confirm', async ({}, testInfo) => {
  const h = await launchApp();
  const inspect = (file, script) => h.app.evaluate(async ({ webContents }, { file, script }) => {
    const page = webContents.getAllWebContents().find((w) => { try { return new URL(w.getURL()).pathname.endsWith('/' + file); } catch { return false; } });
    return page ? page.executeJavaScript(script) : null;
  }, { file, script });
  try {
    const widget = await windowByFile(h.app, 'index.html');
    await h.app.evaluate(({ dialog, session }, index) => {
      globalThis.__gallery = { fetches: [], confirms: [] };
      session.fromPartition('gallery').fetch = async (url, opts) => {
        globalThis.__gallery.fetches.push({ url, redirect: opts && opts.redirect });
        return url.endsWith('/gallery/index.json') ? new Response(index, { status: 200 }) : new Response('missing', { status: 404 });
      };
      dialog.showMessageBox = async (_w, opts) => { globalThis.__gallery.confirms.push(opts); return { response: 1 }; };
    }, INDEX);
    const observed = () => h.app.evaluate(() => globalThis.__gallery);

    await widget.evaluate(() => window.trafficLight.openHelp());
    await expect.poll(() => inspect('sidebar.html', '!!window.buddy')).toBe(true);
    await inspect('sidebar.html', 'window.buddy.select("tasks"); true');
    await expect.poll(() => inspect('tasks.html', '!!window.galleryApi && !!document.querySelector("#cg-open")'), { timeout: 20000 }).toBe(true);

    await inspect('tasks.html', 'document.querySelector("#cg-open").click(); true');
    await expect.poll(() => inspect('tasks.html', '!document.querySelector("#cg-gallery").hidden')).toBe(true);
    expect((await observed()).fetches).toEqual([]);

    await inspect('tasks.html', '[...document.querySelectorAll("#cg-gallery button")].find(b => b.textContent === "Fetch the gallery").click(); true');
    await expect.poll(() => inspect('tasks.html', 'document.querySelectorAll("#cg-gallery .cg-card").length')).toBe(3);
    expect((await observed()).fetches).toEqual([{ url: 'https://plexiform.dev/gallery/index.json', redirect: 'error' }]);
    expect(await inspect('tasks.html', 'document.querySelector(".cg-provenance").textContent')).toBe('Unsigned · fetched from plexiform.dev over HTTPS');

    await inspect('tasks.html', 'document.querySelector(\'[data-id="recipe/spec-explain"] .recipe-actions button\').click(); true');
    await expect.poll(() => inspect('tasks.html', 'document.querySelector("#cg-gallery .recipes-status").textContent')).toContain('to My recipes');
    const recipeConfirm = (await observed()).confirms[0];
    expect(recipeConfirm.message).toBe('Add to My recipes: Spec spec-explain?');
    expect(recipeConfirm.detail).toContain(PROMPT);
    expect(recipeConfirm.detail).toContain('self-declared');
    expect(JSON.parse(fs.readFileSync(path.join(h.home, 'recipes', 'spec-explain.json'), 'utf8')).edits).toBe(false);
    expect(fs.existsSync(path.join(h.home, 'recipes', 'spec-explain.origin.json'))).toBe(true);

    await inspect('tasks.html', 'document.querySelector(\'[data-id="character/speccy"] .recipe-actions button\').click(); true');
    await expect.poll(() => inspect('tasks.html', 'document.querySelector("#cg-gallery .recipes-status").textContent')).toContain('to Characters');
    expect((await observed()).confirms[1].message).toBe('Add to Characters: Speccy?');
    expect(fs.existsSync(path.join(h.home, 'characters', 'u-speccy', 'character.json'))).toBe(true);

    const png = await h.app.evaluate(async ({ webContents }) => {
      const contents = webContents.getAllWebContents().find((w) => w.getURL().includes('/tasks.html'));
      return (await contents.capturePage()).toPNG().toString('base64');
    });
    await testInfo.attach('gallery', { body: Buffer.from(png, 'base64'), contentType: 'image/png' });

    await inspect('tasks.html', '[...document.querySelectorAll("#cg-gallery button")].find(b => b.textContent === "Back to recipes").click(); if (document.querySelector("#recipes").hidden) document.querySelector("#recipes-open").click(); true');
    await expect.poll(() => inspect('tasks.html', '[...document.querySelectorAll("#recipes .recipe h3")].map(e => e.textContent).includes("Spec spec-explain")')).toBe(true);
  } finally { await h.cleanup(); }
});
