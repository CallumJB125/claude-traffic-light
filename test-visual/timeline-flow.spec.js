'use strict';
const { test, expect, _electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('timeline native renderer reads, filters and exports the exact synthetic parent session', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-timeline-native-'));
  const rows = [
    { type: 'user', message: { content: 'Review the authentication flow' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'sub-one', name: 'Agent', input: { description: 'Review', prompt: 'Inspect authentication tests' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'sub-one', content: 'The recorded result has two test recommendations.' }] } },
    { type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Review complete. <script>window.bad=true</script>\n' + 'Detailed result. '.repeat(100) }] } },
  ];
  fs.writeFileSync(path.join(fixture, 'transcript.jsonl'), rows.map((r, i) => JSON.stringify({ timestamp: `2026-10-16T12:00:0${i}Z`, ...r })).join('\n'));
  const app = await _electron.launch({ args: [path.join(__dirname, 'timeline-flow-main.js'), '-ApplePersistenceIgnoreState', 'YES'], env: { ...process.env, PLEXIFORM_TIMELINE_FIXTURE: fixture } });
  try {
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await expect(page.locator('#status')).toHaveText('4 of 4 events, oldest first.');
    await page.getByLabel('Show', { exact: true }).selectOption('subagents');
    await expect(page.locator('#status')).toHaveText('2 of 4 events, oldest first.');
    await expect(page.locator('#events')).toContainText('two test recommendations');
    await page.getByLabel('Search activity').fill('unrelated');
    await expect(page.locator('#status')).toContainText('No activity matches');
    await page.getByLabel('Search activity').clear();
    await page.getByLabel('Show', { exact: true }).selectOption('results');
    await page.locator('#events summary').click();
    await expect(page.locator('#events')).toContainText('<script>window.bad=true</script>');
    expect(await page.evaluate(() => window.bad)).toBeUndefined();
    await page.getByRole('button', { name: 'Save replay…' }).click();
    await expect(page.locator('#save-status')).toContainText('Saved as replay.html');
    expect(fs.readFileSync(path.join(fixture, 'replay.html'), 'utf8')).not.toContain('two test recommendations');
    await page.locator('#prompts').check();
    await page.getByRole('button', { name: 'Save replay…' }).click();
    await expect(page.locator('#save-status')).toContainText('Saved as replay.html');
    const exported = fs.readFileSync(path.join(fixture, 'replay.html'), 'utf8');
    expect(exported).toContain('two test recommendations'); expect(exported).not.toContain('<script>');
    expect(errors).toEqual([]);
    if (process.env.PLEXIFORM_TIMELINE_EVIDENCE) {
      fs.mkdirSync(process.env.PLEXIFORM_TIMELINE_EVIDENCE, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PLEXIFORM_TIMELINE_EVIDENCE, 'timeline-native.png'), fullPage: true });
    }
  } finally { await app.close(); fs.rmSync(fixture, { recursive: true, force: true }); }
});
