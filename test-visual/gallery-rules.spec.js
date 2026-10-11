'use strict';
// D5 in the real app: widget rules added from the Tasks page's gallery open in
// Widget configuration as an offer, after main's native confirm, and replace
// the rules only on Load. The gallery session's fetch and the dialog are
// stubbed in main, so nothing reaches plexiform.dev and no dialog is shown.
const { test, expect } = require('@playwright/test');
const { launchApp, windowByFile } = require('./app');
const S = require('../src/gallery-schema');
const Rules = require('../rules');

const rule = (id, name, then) => Rules.normalizeRule({ id, name, when: { signal: ['stop'] }, then });
const item = { schema: 1, kind: 'rules', id: 'spec-calm', title: 'Spec calm', summary: 'Two quiet rules.', author: { name: 'Ana', github: 'ana-dev' }, license: 'CC0-1.0', tags: [], stacks: ['any'], tools: [], added: '2026-10-01', updated: '2026-10-05', payload: { rulesVersion: Rules.RULES_VERSION, rules: [rule('spec-a', 'Gallery rule A', { lamp: 'green' }), rule('spec-b', 'Gallery rule B', { lamp: 'amber' })] } };
const INDEX = S.buildIndex([{ item, name: item.id }]).text;

test('widget rules from the gallery confirm natively, then wait in Widget configuration for Load', async ({}, testInfo) => {
  const h = await launchApp();
  const inspect = (file, script) => h.app.evaluate(async ({ webContents }, { file, script }) => {
    const page = webContents.getAllWebContents().find((w) => { try { return new URL(w.getURL()).pathname.endsWith('/' + file); } catch { return false; } });
    return page ? page.executeJavaScript(script) : null;
  }, { file, script });
  try {
    const widget = await windowByFile(h.app, 'index.html');
    await h.app.evaluate(({ dialog, session }, index) => {
      globalThis.__gallery = { fetches: 0, confirms: [] };
      session.fromPartition('gallery').fetch = async (url) => { globalThis.__gallery.fetches += 1; return url.endsWith('/gallery/index.json') ? new Response(index, { status: 200 }) : new Response('missing', { status: 404 }); };
      dialog.showMessageBox = async (_w, opts) => { globalThis.__gallery.confirms.push(opts); return { response: 1 }; };
    }, INDEX);
    const observed = () => h.app.evaluate(() => globalThis.__gallery);

    await widget.evaluate(() => window.trafficLight.openHelp());
    await expect.poll(() => inspect('sidebar.html', '!!window.buddy')).toBe(true);
    await inspect('sidebar.html', 'window.buddy.select("tasks"); true');
    await expect.poll(() => inspect('tasks.html', '!!window.galleryApi && !!document.querySelector("#cg-open")'), { timeout: 20000 }).toBe(true);
    await inspect('tasks.html', 'document.querySelector("#cg-open").click(); true');
    await inspect('tasks.html', '[...document.querySelectorAll("#cg-gallery button")].find(b => b.textContent === "Fetch the gallery").click(); true');
    await expect.poll(() => inspect('tasks.html', 'document.querySelectorAll("#cg-gallery .cg-card").length')).toBe(1);
    expect(await inspect('tasks.html', 'document.querySelector(\'[data-id="rules/spec-calm"]\').textContent')).toContain('Gallery rule B');

    await inspect('tasks.html', 'document.querySelector(\'[data-id="rules/spec-calm"] .recipe-actions button\').click(); true');
    await expect.poll(() => inspect('tasks.html', 'document.querySelector("#cg-gallery .recipes-status").textContent')).toContain('in Widget configuration');
    const confirm = (await observed()).confirms[0];
    expect(confirm.message).toBe('Open in Widget configuration: Spec calm?');
    expect(confirm.detail).toContain('2 widget rules: Gallery rule A, Gallery rule B.');
    expect(confirm.detail).toContain('self-declared');

    const lights = await windowByFile(h.app, 'lights.html');
    await lights.waitForLoadState('load');
    await expect(lights.locator('#rules-choice')).toBeVisible();
    await expect(lights.locator('#rules-summary')).toContainText('2 rules');
    await expect(lights.locator('#rules-summary code')).toHaveCount(0);
    await expect(lights.locator('#rule-list li', { hasText: 'Gallery rule A' })).toHaveCount(0);
    await testInfo.attach('gallery-rules-offer', { body: await lights.screenshot(), contentType: 'image/png' });

    await lights.click('#rules-choice [data-rules=load]');
    await expect(lights.locator('#rule-list li')).toHaveCount(2);
    await expect(lights.locator('#rule-list li').first()).toContainText('Gallery rule A');
    await expect(lights.locator('#save-state')).toContainText('From the gallery');
    expect((await observed()).fetches).toBe(1);
  } finally { await h.cleanup(); }
});
