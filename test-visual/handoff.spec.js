'use strict';
// Real Electron acceptance for "Hand off to another AI…" on the Sessions page:
// the item is listed, the preview goes through main's confirm dialog, Cancel
// shares nothing, and Confirm hands the scrubbed packet to the chosen tool
// (launched here: this Mac's plan has handoff.launch), and End stops it.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { launchApp, signal, windowByFile, fakeProviderCalls } = require('./app');

const DOC = [
  '<!-- plexiform-session-handover v1 -->',
  '# Session handover: codex handoff',
  '',
  '## Session',
  '- Adapter: codex',
  '- Session id: handoff',
  '- Working folder: /work/handoff',
  '- Branch: feat/handoff',
  '',
  '## Current goal',
  'Latest request: Finish the importer',
  '',
  '## What was asked',
  '- First prompt: Finish the importer, api_key=sk-abcdefghijklmnopqrstuvwx',
  '- Latest prompt: Finish the importer',
  '',
  '## Files touched',
  'Edited (1):',
  '```',
  'src/importer.js',
  '```',
  'Read or opened (0):',
  '(none)',
  '',
  '## Last assistant status line',
  'Importer parses the fixture.',
  '',
].join('\n');

test('hand off lists, previews, cancels and confirms through the real app', async () => {
  const h = await launchApp();
  const inspect = (file, script) => h.app.evaluate(async ({ webContents }, { file, script }) => {
    const page = webContents.getAllWebContents().find((w) => { try { return new URL(w.getURL()).pathname.endsWith('/' + file); } catch { return false; } });
    return page ? page.executeJavaScript(script) : null;
  }, { file, script });
  try {
    const widget = await windowByFile(h.app, 'index.html');
    await expect.poll(() => fs.existsSync(path.join(h.home, 'token'))).toBe(true);
    // A live local Codex session whose handover document already exists (Claude Code is the tool on this Mac).
    await signal(h, { signal: 'stop', session: 'handoff', source: 'codex', cwd: '/work/handoff' });
    fs.mkdirSync(path.join(h.home, 'handovers'), { recursive: true });
    fs.writeFileSync(path.join(h.home, 'handovers', 'codex-handoff.md'), DOC);

    // main's dialog and clipboard, observed instead of shown.
    await h.app.evaluate(({ dialog, clipboard }) => {
      globalThis.__handoff = { confirms: [], clip: [], response: 0 };
      dialog.showMessageBox = async (_w, opts) => { globalThis.__handoff.confirms.push(opts); return { response: globalThis.__handoff.response }; };
      clipboard.writeText = (t) => { globalThis.__handoff.clip.push(t); };
    });
    const observed = () => h.app.evaluate(() => globalThis.__handoff);

    await widget.evaluate(() => window.trafficLight.openHelp());
    await expect.poll(() => inspect('sidebar.html', '!!window.buddy')).toBe(true);
    await inspect('sidebar.html', 'window.buddy.select("sessions"); true');
    await expect.poll(() => inspect('sessions.html', '!!document.querySelector(".continue-wrap button")'), { timeout: 20000 }).toBe(true);

    const items = () => inspect('sessions.html', '[...document.querySelectorAll(".continue-menu .continue-label")].map(e => e.textContent)');
    const note = () => inspect('sessions.html', 'document.querySelector(".continue-note").textContent');
    const open = async () => {
      await inspect('sessions.html', 'document.querySelector(".continue-wrap button").click(); true');
      await expect.poll(items).toContain('Hand off to another AI…');
      await inspect('sessions.html', '[...document.querySelectorAll(".continue-item")].find(b => b.textContent.startsWith("Hand off")).click(); true');
      await expect.poll(items).toContain('Claude Code');
      await inspect('sessions.html', '[...document.querySelectorAll(".continue-item")].find(b => b.textContent.startsWith("Claude Code")).click(); true');
    };

    // Cancel: the preview was shown, nothing was copied.
    await open();
    await expect.poll(note).toContain('Cancelled. Nothing was shared.');
    let o = await observed();
    expect(o.confirms).toHaveLength(1);
    expect(o.confirms[0].title).toBe('Hand off to another AI');
    expect(o.confirms[0].message).toBe('Hand off this work to Claude Code?');
    expect(o.confirms[0].detail).toContain('Finish the importer');
    expect(o.confirms[0].detail).toContain('src/importer.js');
    expect(o.confirms[0].detail).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(o.confirms[0].buttons).toEqual(['Cancel', 'Confirm and hand off']);
    expect(o.clip).toHaveLength(0);

    // Confirm: the same preview, then the packet goes to the tool. This Mac's
    // plan has handoff.launch, so Claude Code is started with it; End stops it.
    await h.app.evaluate(() => { globalThis.__handoff.response = 1; });
    await open();
    const head = () => inspect('sessions.html', 'document.querySelector(".continue-panel .continue-note")?.textContent ?? ""');
    // The fake answers at once, so the panel may already have moved on from "reading" to "replied".
    await expect.poll(head, { timeout: 15000 }).toMatch(/Claude Code (is reading the handover…|replied\. Answer below)/);
    o = await observed();
    expect(o.confirms).toHaveLength(2);
    expect(o.confirms[1].detail).toBe(o.confirms[0].detail);
    expect(o.clip).toHaveLength(0);
    // The tool that started is the fake in this test's HOME, and it was sent the scrubbed handover as its prompt.
    await expect.poll(() => fakeProviderCalls(h.userHome).some((c) => c.stdin?.includes('Finish the importer'))).toBe(true);
    const calls = fakeProviderCalls(h.userHome);
    expect(calls.find((c) => c.argv)?.name).toBe('claude');
    expect(calls.find((c) => c.argv).argv).toContain('-p');
    expect(calls.map((c) => c.stdin ?? '').join('')).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    await inspect('sessions.html', '[...document.querySelectorAll(".continue-panel button")].find(b => b.textContent === "End").click(); true');
    await expect.poll(head, { timeout: 15000 }).toContain('This Claude Code session has ended.');
  } finally {
    await h.cleanup();
  }
});
