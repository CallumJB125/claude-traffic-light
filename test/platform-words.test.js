'use strict';
// A2: platform words. Brand.machine() / Brand.keys() in both brand modules,
// the lab-reported strings on Linux, and a lint that keeps new literal
// "this Mac" out of renderer files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Brand = require('../brand.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('Brand.machine and Brand.keys: Mac words on macOS, computer and Ctrl elsewhere', () => {
  assert.equal(Brand.machine('darwin'), 'Mac');
  assert.equal(Brand.machine('linux'), 'computer');
  assert.equal(Brand.machine('win32'), 'computer');
  assert.deepEqual({ ...Brand.keys('darwin'), combo: Brand.keys('darwin').combo('K') }, { mod: '⌘', combo: '⌘K', enter: 'Return' });
  assert.deepEqual({ ...Brand.keys('linux'), combo: Brand.keys('linux').combo('K') }, { mod: 'Ctrl', combo: 'Ctrl+K', enter: 'Enter' });
  assert.equal(Brand.keys('win32').combo('.'), 'Ctrl+.');
  assert.equal(Brand.machine(), Brand.machine(process.platform), 'left out, it is the running platform');
});

test('board/shared/brand.js gives the same words', async () => {
  const board = await import(path.join(ROOT, 'board', 'shared', 'brand.js'));
  for (const p of ['darwin', 'linux', 'win32']) {
    assert.equal(board.machine(p), Brand.machine(p), p);
    for (const k of ['mod', 'enter']) assert.equal(board.keys(p)[k], Brand.keys(p)[k], `${p} ${k}`);
    assert.equal(board.keys(p).combo('K'), Brand.keys(p).combo('K'));
  }
});

test('in a page, the platform comes from the browser: a Linux page shows Ctrl+K and Ctrl+.', () => {
  for (const [page, want] of [['overview.html', 'Ctrl+K'], ['waiting.html', 'Ctrl+.']]) {
    for (const [platform, shown] of [['Linux x86_64', want], ['MacIntel', want.replace('Ctrl+', '⌘')]]) {
      const dom = new JSDOM(read(page), { runScripts: 'outside-only' });
      Object.defineProperty(dom.window.navigator, 'platform', { value: platform });
      dom.window.eval(read('brand.js'));
      dom.window.eval(read('platform-words.js'));
      assert.equal(dom.window.document.querySelector('[data-combo]').textContent, shown, `${page} on ${platform}`);
      dom.window.close();
    }
    assert.ok(read(page).indexOf('src="brand.js"') < read(page).indexOf('src="platform-words.js"'), `${page} loads brand.js first`);
  }
  assert.ok(require('../package.json').build.files.includes('platform-words.js'), 'packaged');
});

test('the lab-reported strings say "this computer" on Linux (A2)', () => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  const fresh = ['../brand.js', '../buddy-window/brand.js', '../buddy-window/pages.js', '../src/spend-safety.js', '../src/setup-checklist.js'].map((m) => require.resolve(m));
  const drop = () => { for (const f of fresh) delete require.cache[f]; };
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  drop();
  try {
    const BW = require('../buddy-window/brand.js');
    assert.equal(BW.LOCAL_BOARD, 'My board (this computer)');
    assert.equal(BW.HUB_TEXT.local, 'Board on this computer');
    assert.equal(require('../buddy-window/pages.js').pageById('thismac').title, 'This computer');
    assert.match(require('../src/spend-safety.js').limitEstimate([], 'pro', 1e12).note, /transcripts on this computer,/);
    assert.match(JSON.stringify(require('../src/setup-checklist.js').build({ account: {} })), /Your board stays on this computer until you do\./);
  } finally {
    Object.defineProperty(process, 'platform', real);
    drop();
  }
  // The renderer strings from the lab reports are built from the platform words, not written as Mac text.
  assert.match(read('onboarding.js'), /on this \$\{MACHINE\}\. We add/);
  assert.match(read('onboarding.js'), /`Open \$\{TERMINAL\}, type `, code, ` and press \$\{KEYS\.enter\}\.`/);
  assert.match(read('onboarding.js'), /your board stays on this \$\{MACHINE\} until you do/);
  assert.match(read('buddy-window/sidebar.js'), /w\.kind === 'local' \? state\.localBoard/);
  assert.match(read('board/tasks-engine/bus/dispatcher.js'), /: `This \$\{machine\(\)\}`, provider/);
  assert.match(read('main.js'), /page\.id === 'settings' && !IS_MAC\) wc\.insertCSS\('[^']*\.field:has\(#roam\)/, 'the Dock-icon setting is macOS only, so it is hidden elsewhere');
});

// ── Lint: no new literal "this Mac" in renderer files ─────────────────────
// Renderer files: every page (*.html at the root and in buddy-window/) and the
// scripts those pages load. Use `this ${Brand.machine()}` instead. The counts
// below are what was there when the lint arrived (lab PR 7 fixed only the
// strings the lab reports named); a count may only go down, and when it does,
// lower it here.
const ALLOWED = {
  'agent-bus-view.js': 2, 'agent-mail-view.js': 1, 'aitools.js': 2, 'buddy-window/account.js': 16, 'buddy-window/sidebar.js': 1,
  'handoff-requests-view.js': 1, 'help.html': 2, 'onboarding.html': 4, 'overview-directory.js': 1, 'overview-share.js': 1,
  'recipes.js': 1, 'sessions.html': 1, 'sessions.js': 1, 'settings-crash-reports.js': 2, 'settings.html': 15, 'settings.js': 2,
  'setups.js': 1, 'src/rule-templates.js': 1, 'src/simple-mode.js': 1, 'src/tasks-view.js': 4, 'tasks.js': 7, 'usage-work-view.js': 1,
};

function rendererFiles() {
  const pages = [...fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')), ...fs.readdirSync(path.join(ROOT, 'buddy-window')).filter((f) => f.endsWith('.html')).map((f) => `buddy-window/${f}`)];
  const files = new Set(pages);
  for (const page of pages) {
    for (const m of read(page).matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) {
      if (/^[a-z]+:/i.test(m[1])) continue;
      const f = path.posix.normalize(path.posix.join(path.posix.dirname(page), m[1]));
      if (fs.existsSync(path.join(ROOT, f))) files.add(f);
    }
  }
  return [...files].sort();
}

test('lint: no new literal "this Mac" in renderer files (use Brand.machine())', () => {
  const files = rendererFiles();
  assert.ok(files.length > 100 && files.includes('onboarding.js') && files.includes('buddy-window/account.js'), 'the scan finds the pages and their scripts');
  const problems = [];
  for (const f of files) {
    const n = (read(f).match(/\bthis Mac\b/gi) || []).length, allowed = ALLOWED[f] ?? 0;
    if (n > allowed) problems.push(`${f}: ${n} literal "this Mac" (allowed ${allowed}). Write \`this \${Brand.machine()}\` (or s.brand.machine / BRAND.MACHINE where main sends it).`);
    else if (n < allowed) problems.push(`${f}: down to ${n} from ${allowed}; lower its count in ALLOWED.`);
  }
  for (const f of Object.keys(ALLOWED)) if (!files.includes(f)) problems.push(`${f} is in ALLOWED but is no longer a renderer file; remove it.`);
  assert.deepEqual(problems, []);
});

test('lint: it catches a new one', () => {
  const n = (s) => (s.match(/\bthis Mac\b/gi) || []).length;
  assert.equal(n('Board on this Mac. This Mac runs it.'), 2);
  assert.equal(n('Board on this ${Brand.machine()}; this MacBook'), 0);
});
