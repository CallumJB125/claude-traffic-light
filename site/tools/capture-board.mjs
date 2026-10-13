// Captures the REAL board web UI (board/web, served by its own mock hub) as
// 2x screenshots for the site, from neutral fixtures (board-neutral.mjs) so no
// real project or person appears. Works on a temporary copy of board/, so the
// app's source is never touched. Every state's rendered text is scanned for
// leftovers of the original fixtures; any hit fails the run.
//
//   node site/tools/capture-board.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { neutralize, FORBIDDEN } from './board-neutral.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.resolve(HERE, '..', 'src', 'assets', 'board');
const SRC_BOARD = path.join(ROOT, 'board');
// node_modules is untracked: take the main checkout's if this worktree has none
const NODE_MODULES = [path.join(SRC_BOARD, 'node_modules'), path.resolve(ROOT, '..', 'claude-traffic-light', 'board', 'node_modules')].find((p) => fs.existsSync(p));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-neutral-'));
const copy = path.join(tmp, 'board');
fs.cpSync(SRC_BOARD, copy, { recursive: true, filter: (s) => !/node_modules|[/\\]test[/\\]|deploy/.test(s) });
fs.symlinkSync(NODE_MODULES, path.join(copy, 'node_modules'));
for (const f of ['web/mock/fixtures.js', 'web/mock/journal.js', 'web/mock/server.js']) {
  const p = path.join(copy, f);
  fs.writeFileSync(p, neutralize(fs.readFileSync(p, 'utf8')));
}
const { createMockHub } = await import(pathToFileURL(path.join(copy, 'web/mock/server.js')).href);

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f));
const raw = path.join(tmp, 'raw');
fs.mkdirSync(raw);

const hub = createMockHub();
const base = `http://127.0.0.1:${await hub.listen(0)}`;
const histHub = createMockHub({ history: true });
const histBase = `http://127.0.0.1:${await histHub.listen(0)}`;
const browser = await chromium.launch({ channel: 'chrome' });
const problems = [];
const leaks = [];
const made = [];

async function open({ scheme, at = base, width = 1440, height = 900 }) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: 'reduce', deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (/status of 401/.test(m.text())) return; if (m.type() === 'error') problems.push(`[console] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  await ctx.request.post(`${at}/__mock/login?as=ana`); // the mock's own test login: sets the dev cookie
  await page.goto(at);
  await page.locator('.card').first().waitFor();
  await page.waitForTimeout(500);
  return page;
}
const rects = {};
// where the story card (and its main action) sit in this frame, in CSS px of the 1440x900 page
async function mark(page, name) {
  rects[name] = await page.evaluate(() => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const card = document.querySelector('[data-card-id="c-152"]');
    const give = [...document.querySelectorAll('button')].find((b) => /^Tackle with AI$/.test(b.textContent.trim()));
    const btn = card ? (card.querySelector('button.primary, .btn-primary, button.btn') || card.querySelector('button')) : give;
    const inView = (r) => r && r.y >= 0 && r.y + r.h <= 900;
    const pick = (el) => { const r = el && box(el); return inView(r) ? r : null; };
    return { card: pick(card), action: pick(btn), give: pick(give), actionText: btn ? btn.textContent.trim() : null };
  });
}
async function shot(page, name, opts = {}) {
  const text = await page.evaluate(() => document.body.innerText);
  const hit = text.match(FORBIDDEN);
  if (hit) leaks.push(`${name}: "${hit[0]}"`);
  const file = path.join(raw, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  made.push(name);
}

try {
  for (const scheme of ['dark', 'light']) {
    const page = await open({ scheme });
    await mark(page, `board-${scheme}`);
    await shot(page, `board-${scheme}`);
    if (scheme === 'dark') {
      // the real card story on CHK-152: each frame is the real board at that step
      const story = [];
      for (let i = 0; i < 12; i += 1) {
        const r = await (await fetch(`${base}/__mock/step`, { method: 'POST' })).json();
        await page.waitForTimeout(550);
        if (['queued', 'running', 'blocked', 'orphaned', 'handed_over', 'in_review', 'done'].includes(r.state) && !story.includes(r.state)) {
          story.push(r.state);
          const nm = `story-${String(story.length).padStart(2, '0')}-${r.state}`;
          await mark(page, nm);
          await shot(page, nm);
        }
      }
    }
    await page.context().close();
    const p2 = await open({ scheme });
    await p2.locator('[data-card-id="c-142"] .card-open').click();
    await p2.locator('.drawer .ask').first().waitFor();
    await p2.waitForTimeout(650);
    await shot(p2, `drawer-${scheme}`);
    await p2.getByRole('tab', { name: 'Handover' }).click();
    await p2.waitForTimeout(500);
    await shot(p2, `handover-${scheme}`);
    await p2.context().close();
    const p3 = await open({ scheme, at: histBase });
    await p3.getByRole('button', { name: 'Table' }).click();
    await p3.locator('.cardtable tbody tr').first().waitFor();
    await p3.waitForTimeout(400);
    await shot(p3, `table-${scheme}`);
    await p3.getByRole('button', { name: 'Dashboard' }).click();
    await p3.waitForTimeout(900);
    await shot(p3, `dashboard-${scheme}`);
    await p3.context().close();
  }
} finally {
  await browser.close();
  await hub.close();
  await histHub.close();
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ viewport: { w: 1440, h: 900 }, rects }, null, 1));
if (problems.length) console.log(`problems:\n${[...new Set(problems)].join('\n')}`);
if (leaks.length) { console.error(`LEAKS of the original fixtures (extend board-neutral.mjs):\n${leaks.join('\n')}`); process.exit(2); }

// WebP at two widths: the page picks by screen
for (const name of made) {
  const src = path.join(raw, `${name}.png`);
  for (const [w, q, suffix] of [[2400, 90, ''], [1200, 88, '-1x']]) {
    const resized = path.join(raw, `${name}${suffix}.png`);
    execFileSync('python3', ['-c', 'import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert("RGB");h=round(im.height*int(sys.argv[3])/im.width);im.resize((int(sys.argv[3]),h),Image.LANCZOS).save(sys.argv[2])', src, resized, String(w)]);
    execFileSync('cwebp', ['-quiet', '-q', String(q), '-m', '6', '-sharp_yuv', resized, '-o', path.join(OUT, `${name}${suffix}.webp`)]);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`captured ${made.length} states: ${made.join(', ')}`);
