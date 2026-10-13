'use strict';
// Hand-off requests through the actual main.js: an AI asks over the local
// /team/mail endpoint (what hand_off_to_tool sends) to hand its work to
// another tool; the request is a card on Sessions, nothing starts until
// Confirm, Dismiss ends it, and hand_off_status reads the state. No hub or
// account is needed. The target is whichever launchable tool this Mac has;
// none means skip.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { launchApp, embedded } = require('./app');

test('hand-off requests: a card on Sessions, dismissed or confirmed only by the person; the AI reads only states', async () => {
  test.setTimeout(120000);
  const h = await launchApp();
  const { app, home, port } = h;
  try {
    await expect.poll(() => fs.existsSync(path.join(home, 'token')), { timeout: 15000 }).toBe(true);
    const mail = async (op, args) => (await fetch(`http://127.0.0.1:${port}/team/mail`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-buddy-token': fs.readFileSync(path.join(home, 'token'), 'utf8') }, body: JSON.stringify({ op, args }) })).json();
    const page = await embedded(app, 'sessions', 'sessions.html');
    const panel = page.locator('#handoffs');
    await expect(panel).toBeHidden();

    // A tool that is not on this Mac is refused with the list of ones that are; none found means nothing to test here.
    const probe = await mail('request_handoff', { from: 'claude', to: 'nosuchtool', title: 'x' });
    expect(probe).toMatchObject({ available: false, reason: 'not_found' });
    const found = (probe.message.match(/hand off to: (.*)\.$/) || [])[1];
    test.skip(!found || found === 'none', 'no launchable AI tool on this Mac');
    const to = found.split(', ')[0];

    const r = await mail('request_handoff', { from: 'hermes', to, reason: 'needs a second opinion', title: 'Finish the parser', brief: 'Grammar done, tests not.', files: ['src/parser.js'] });
    expect(r, JSON.stringify(r)).toMatchObject({ available: true, status: 'waiting_for_your_person' });
    await expect(panel).toBeVisible({ timeout: 15000 });
    await expect(panel).toContainText('asks to hand off to');
    await expect(panel).toContainText('Why: needs a second opinion');
    await expect(panel).toContainText('Goal: Finish the parser');
    await expect(panel).toContainText('Files: src/parser.js');
    const status = await mail('hand_off_status', { request_id: r.request_id });
    expect(status.requests[0]).toMatchObject({ request_id: r.request_id, to, status: 'waiting_for_your_person', outcome: null });

    // Cancel on the native preview: still pending, nothing started.
    await app.evaluate(({ dialog }) => { globalThis.__ho = { shown: [], response: 0 }; dialog.showMessageBox = async (_w, o) => { const opts = o || _w; globalThis.__ho.shown.push(opts); return { response: globalThis.__ho.response }; }; });
    await panel.getByRole('button', { name: 'Confirm…' }).click();
    await expect(page.locator('#handoffs-status')).toContainText('Cancelled. Nothing was started.');
    const shown = (await app.evaluate(() => globalThis.__ho.shown)).at(-1);
    expect(shown.detail).toContain('# Handoff from hermes to');
    expect(shown.detail).toContain('Finish the parser');
    expect((await mail('hand_off_status', { request_id: r.request_id })).requests[0].status).toBe('waiting_for_your_person');

    // Dismiss ends it; the AI sees "dismissed"; the panel keeps the card with its state.
    await panel.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('#handoffs-status')).toContainText('Dismissed. Nothing was started.');
    await expect(panel).toContainText('Dismissed');
    expect((await mail('hand_off_status', { request_id: r.request_id })).requests[0].status).toBe('dismissed');
    expect(await panel.getByRole('button', { name: 'Confirm…' }).count()).toBe(0);
  } finally {
    await h.cleanup();
  }
});
