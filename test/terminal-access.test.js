'use strict';
// QoL4b: Settings › Terminal → Terminal access. Reading never prompts; Test is the one path that can, on a click,
// for a running app only (review B4-M1); a jump records what it saw (B4-S2); the copy is history (B4-S1); once
// denied, no Test (B4-S3); Health warns for a denied Automation app only (Q2).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const TA = require('../src/terminal-access.js');
const { createJumper } = require('../src/focus/jump.js');
const Health = require('../src/health.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const mainSrc = read('main.js');
const AT = Date.UTC(2026, 10, 6, 12);

function store({ file = null, up = true, answer = { ok: true, stderr: '' }, clock = { t: AT } } = {}) {
  const calls = { running: [], script: [], writes: [] };
  const s = TA.createStore({
    read: () => { if (file === null) throw new Error('ENOENT'); return file; },
    write: (o) => calls.writes.push(JSON.parse(JSON.stringify(o))),
    now: () => clock.t,
    running: async (b) => { calls.running.push(b); return typeof up === 'function' ? up(b) : up; },
    script: async (b, ms) => { calls.script.push([b, ms]); return typeof answer === 'function' ? answer(b) : answer; },
  });
  return { s, calls, clock };
}

test('cleanSeen keeps only the four names, two states and a finite time', () => {
  assert.deepEqual(TA.cleanSeen(null), {});
  assert.deepEqual(TA.cleanSeen({ apps: [] }), {});
  const out = TA.cleanSeen({ v: 1, apps: {
    Terminal: { state: 'allowed', at: AT, extra: 'x' }, iTerm2: { state: 'maybe', at: AT }, Ghostty: { state: 'denied', at: 'soon' },
    'Ghostty Dock': { state: 'denied', at: AT }, Warp: { state: 'allowed', at: AT }, __proto__: { state: 'allowed', at: AT },
  } });
  assert.deepEqual(out, { Terminal: { state: 'allowed', at: AT }, 'Ghostty Dock': { state: 'denied', at: AT } });
});

test('view: installed terminals only, copy says it is history with a date, denied has no Test, Accessibility last', () => {
  const installed = (app) => ['Terminal', 'iTerm2', 'Ghostty', 'kitty'].includes(app);
  const rows = TA.view({ installed, trusted: false, seen: { Terminal: { state: 'allowed', at: AT }, iTerm2: { state: 'denied', at: AT } } });
  assert.deepEqual(rows.map((r) => [r.app, r.state]), [['Terminal', 'allowed'], ['iTerm2', 'denied'], ['Ghostty', 'unknown'], ['kitty', 'not-needed'], ['Accessibility', 'off']]);
  assert.match(rows[0].text, /^Allowed when last used \(6 Nov\)\.$/);
  assert.match(rows[1].text, /^Turned off when last tried \(6 Nov\)\.$/);
  assert.deepEqual(rows[1].actions, ['open-settings'], 'macOS will not ask again, so no Test');
  assert.match(rows[1].fix, /Automation and turn on iTerm2 under Plexiform/);
  assert.deepEqual(rows[0].actions, ['test', 'open-settings']);
  assert.deepEqual(rows[2].actions, ['test', 'open-settings']);
  assert.deepEqual(rows[3].actions, []);
  assert.deepEqual(rows[4].actions, ['open-settings']);
  const on = TA.view({ installed: () => false, trusted: true, seen: {} });
  assert.deepEqual(on.map((r) => [r.app, r.state, r.actions.length]), [['Accessibility', 'allowed', 0]]);
});

test('Health: a warning only for a denied Automation app, never for Accessibility being off', () => {
  const installed = () => true;
  assert.equal(TA.healthRow(TA.view({ installed, trusted: false, seen: { Terminal: { state: 'allowed', at: AT } } })), null);
  const row = TA.healthRow(TA.view({ installed, trusted: true, seen: { Ghostty: { state: 'denied', at: AT }, Terminal: { state: 'denied', at: AT } } }));
  assert.equal(row.status, 'warn');
  assert.match(row.detail, /Terminal or Ghostty/);
  assert.equal(row.fix, 'terminal-access-open');
  const report = Health.runChecks({ home: os.tmpdir(), root: path.join(os.tmpdir(), 'nope-qol4b'), terminalAccess: row });
  const c = report.checks.find((x) => x.id === 'terminal-access');
  assert.equal(c.label, 'Terminal access');
  assert.equal(c.fixLabel, 'Open Terminal settings');
  assert.equal(Health.runChecks({ home: os.tmpdir(), root: path.join(os.tmpdir(), 'nope-qol4b') }).checks.some((x) => x.id === 'terminal-access'), false);
});

test('B4-M1: Test never runs a script while the app is not running, so it can never launch it', async () => {
  const { s, calls } = store({ up: false });
  const r = await s.test('iTerm2');
  assert.deepEqual(calls.running, ['com.googlecode.iterm2']);
  assert.deepEqual(calls.script, [], 'stopped before any osascript');
  assert.equal(r.note, 'Open iTerm2 first, then press Test.');
  assert.deepEqual(calls.writes, []);
  // A running check that throws counts as not running.
  const t = store({ up: () => { throw new Error('lsappinfo'); } });
  assert.equal((await t.s.test('Terminal')).ok, false);
  assert.deepEqual(t.calls.script, []);
});

test('Test: allowed and denied are recorded; denied stops further Tests; unknown names and fast repeats do nothing', async () => {
  const clock = { t: AT };
  const ok = store({ clock });
  const r = await ok.s.test('Ghostty');
  assert.equal(r.ok, true);
  assert.deepEqual(ok.calls.script, [['com.mitchellh.ghostty', TA.TEST_TIMEOUT_MS]]);
  assert.deepEqual(ok.calls.writes.at(-1), { v: 1, apps: { Ghostty: { state: 'allowed', at: AT } } });
  assert.deepEqual(await ok.s.test('Ghostty'), { ok: false, note: '' }, 'within 2 s');
  clock.t += TA.MIN_TEST_GAP_MS;
  assert.equal((await ok.s.test('Ghostty')).ok, true);

  const no = store({ answer: { ok: false, stderr: 'execution error: Not authorized to send Apple events to Terminal. (-1743)' } });
  const d = await no.s.test('Terminal');
  assert.equal(d.ok, false);
  assert.match(d.note, /macOS turned it off/);
  assert.deepEqual(no.s.seen(), { Terminal: { state: 'denied', at: AT } });
  no.clock.t += 5000;
  const again = await no.s.test('Terminal');
  assert.match(again.note, /won't ask again/);
  assert.equal(no.calls.script.length, 1, 'no second script once denied');

  const slow = store({ answer: { ok: false, stderr: '', timedOut: true } });
  assert.match((await slow.s.test('iTerm2')).note, /No answer in 30 seconds/);
  assert.deepEqual(slow.calls.writes, [], 'a timeout records nothing');

  for (const bad of ['Warp', 'kitty', '__proto__', '', null, { app: 'Terminal' }]) {
    const x = store();
    assert.deepEqual(await x.s.test(bad), { ok: false, note: '' }, String(bad));
    assert.deepEqual(x.calls.running, []);
  }
});

test('the store reads its file once, cleaned, and a failing write keeps the run going', async () => {
  const s = TA.createStore({ read: () => ({ apps: { Terminal: { state: 'denied', at: AT }, Bad: { state: 'allowed', at: AT } } }), write: () => { throw new Error('disk'); }, now: () => AT + 1, running: async () => true, script: async () => ({ ok: true }) });
  assert.deepEqual(s.seen(), { Terminal: { state: 'denied', at: AT } });
  assert.equal(s.record('iTerm2', 'allowed'), true);
  assert.equal(s.record('iTerm2', 'maybe'), false);
  assert.equal(s.record('Warp', 'allowed'), false);
  assert.deepEqual(s.seen().iTerm2, { state: 'allowed', at: AT + 1 });
});

test('the test script is a read-only count by bundle id; lsappinfo is read for a pid', () => {
  assert.equal(TA.testScript('com.apple.Terminal'), 'tell application id "com.apple.Terminal" to count windows');
  for (const { bundle } of Object.values(TA.AUTOMATION)) assert.match(bundle, /^[a-z0-9.]+$/i);
  assert.equal(TA.runningFrom('"pid"=584\n'), true);
  assert.equal(TA.runningFrom(''), false);
  assert.equal(TA.runningFrom('"pid"=[ NULL ]'), false);
});

// B4-S2: what a jump saw, recorded only for Automation needs, never breaking the jump.
function jumper(focusResult, access) {
  return createJumper({
    localHost: 'here', platform: 'darwin', access,
    focus: async () => focusResult,
    activate: async () => { throw new Error('never activates on macOS'); },
    explainer: { onNeeds: () => null, onDenied: () => {} },
    liveness: async () => 'alive',
  });
}
const sess = { host: 'here', sessionId: 's1', hostApp: 'Terminal', cwd: '/p', terminal: { tty: '/dev/ttys001' } };

test('a jump records allowed for an Automation adapter hit, denied on -1743, and nothing for others', async () => {
  const seen = [];
  const rec = (app, state) => seen.push([app, state]);
  assert.equal((await jumper({ ok: true, adapter: 'terminal-app', exact: true }, rec)(sess, 'p')).exact, true);
  await jumper({ ok: true, adapter: 'tmux+iterm', exact: true }, rec)(sess, 'p');
  await jumper({ ok: true, adapter: 'kitty', exact: true }, rec)(sess, 'p');
  await jumper({ ok: true, adapter: 'ghostty-dock', exact: true }, rec)(sess, 'p');
  await jumper({ ok: false, adapter: 'ghostty', denied: 'automation', needs: { permission: 'automation', app: 'Ghostty' } }, rec)(sess, 'p');
  await jumper({ ok: false, adapter: 'x', denied: 'automation', needs: { permission: 'accessibility', app: 'Terminal' } }, rec)(sess, 'p');
  assert.deepEqual(seen, [['Terminal', 'allowed'], ['iTerm2', 'allowed'], ['Ghostty', 'denied']]);
});

test('a throwing access hook never breaks the jump', async () => {
  const r = await jumper({ ok: true, adapter: 'terminal-app', exact: true }, () => { throw new Error('boom'); })(sess, 'p');
  assert.deepEqual(r, { app: 'Terminal', exact: true });
  const miss = await jumper({ ok: false, adapter: 'iterm', denied: 'automation', needs: { permission: 'automation', app: 'iTerm2' } }, () => { throw new Error('boom'); })(sess, 'p');
  assert.equal(miss.app, null);
});

test('main: channels are Settings › Terminal only, Test is gated to the four names, Open settings opens only two fixed URLs', () => {
  for (const ch of ['view', 'test', 'open']) assert.match(mainSrc, new RegExp(`utilityHandle\\('terminal-access:${ch}', settingsPane\\('terminal'\\)`), ch);
  assert.match(mainSrc, /if \(!IS_MAC \|\| !TerminalAccess\.known\(app\)\)/);
  assert.match(mainSrc, /which !== 'automation' && which !== 'accessibility'/);
  assert.match(mainSrc, /isTrustedAccessibilityClient\(false\)/);
  assert.doesNotMatch(mainSrc, /isTrustedAccessibilityClient\(true\)/, 'reading never prompts');
  assert.match(mainSrc, /if \(id === 'terminal-access-open'\) \{ openSettingsAt\('terminal-access'\);/);
  assert.match(mainSrc, /if \(d === 'terminal-access'\) \{ if \(!IS_MAC\) return false; openSettingsAt\('terminal-access'\); return true; \}/);
  // Preview on: the Terminal pane; off: the old page's Advanced section (settings.js onShowSection).
  assert.match(mainSrc, /'terminal-access': 'terminal' \}\);/);
  assert.match(read('settings.js'), /if \(id === 'terminal-access'\) \{ showSection\('advanced'\); window\.loadTerminalAccess\?\.\(\);/);
  const term = read('src/terminal.js');
  assert.match(term, /execFile\('\/usr\/bin\/lsappinfo', \['info', '-only', 'pid', '-app', bundle\]/);
  assert.match(term, /access: \(app, state\) => access\.record\(app, state\)/);
});

test('renderer: rows are built with textContent, Test only where the row offers it, the section hides when empty', () => {
  const js = read('settings.js');
  const start = js.indexOf('// Terminal access (QoL4b)');
  const block = js.slice(start, js.indexOf('// Ghostty Dock: Install only', start));
  assert.ok(start > 0 && block.length > 200);
  assert.doesNotMatch(block, /innerHTML|insertAdjacentHTML/);
  assert.match(block, /if \(acts\.includes\('test'\)\)/);
  assert.match(block, /'terminal-access', 'terminal-access-title'\]\) document\.getElementById\(id\)\.hidden = !list\.childElementCount/);
  const html = read('settings.html');
  // Hidden until rows arrive, so a page that never asks (the old Preferences page, other OSes) shows nothing.
  assert.match(html, /<h2 data-pane="terminal" id="terminal-access-title" hidden>Terminal access<\/h2>/);
  assert.match(html, /<div class="field" data-pane="terminal" id="terminal-access" hidden>/);
  assert.match(read('onboarding.html'), /id="terminal-access-box" hidden/);
});
