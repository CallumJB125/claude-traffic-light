'use strict';
// The visual specs launch the app with an empty HOME of its own, so a baseline never depends on this machine's
// ~/.claude, ~/.codex or shell rc files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { homeEnv, HOME_POINTERS, isBootDeath, underTmp, withFakesFirst } = require('../test-visual/app.js');

test('visual launches: HOME is never the real home, and nothing inherited points back into it', () => {
  const base = { HOME: os.homedir(), USERPROFILE: os.homedir(), PATH: '/usr/bin', ZDOTDIR: os.homedir(), CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude'), CODEX_HOME: path.join(os.homedir(), '.codex'), XDG_CONFIG_HOME: os.homedir(), XDG_DATA_HOME: os.homedir(), XDG_STATE_HOME: os.homedir() };
  const env = homeEnv('/tmp/cbuddy-visual-user-x', base);
  assert.equal(env.HOME, '/tmp/cbuddy-visual-user-x');
  assert.equal(env.USERPROFILE, '/tmp/cbuddy-visual-user-x');
  assert.notEqual(env.HOME, os.homedir());
  for (const k of HOME_POINTERS) assert.equal(k in env, false, k);
  assert.equal(env.PATH, '/tmp/cbuddy-visual-user-x/.local/bin:/usr/bin'); // the fake providers come first
});

test('visual launches: launchApp builds the app env from homeEnv and cleans the temp home up', () => {
  const src = fs.readFileSync(path.join(__dirname, '../test-visual/app.js'), 'utf8');
  assert.match(src, /\.\.\.homeEnv\(userHome\),/);
  assert.match(src, /fs\.rmSync\(userHome, \{ recursive: true, force: true \}\)/);
});

test('visual launches: launchApp refuses a caller-supplied HOME', () => {
  const src = fs.readFileSync(path.join(__dirname, '../test-visual/app.js'), 'utf8');
  assert.match(src, /'HOME' in env \|\| 'USERPROFILE' in env/);
});

test('visual launches: only an early first-line "closed"/"crash" is a boot death worth one retry', () => {
  const closed = new Error('electronApplication.evaluate: Target page, context or browser has been closed\nBrowser logs:\n<launching> electron');
  assert.equal(isBootDeath(closed, 1500), true);
  assert.equal(isBootDeath(new Error('Process crashed on start'), 300), true);
  // An assertion whose app log mentions a crash, or a close, is not a boot death.
  const assertion = new Error('expect(locator).toBeVisible() failed\nBrowser logs:\n[err] renderer crash reported\nTarget closed');
  assert.equal(isBootDeath(assertion, 1500), false);
  // Late deaths (after the first start had time to boot) are real failures.
  assert.equal(isBootDeath(closed, 25000), false);
  assert.equal(isBootDeath(null, 100), false);
});

test('visual launches: a caller PATH keeps the fakes first, and home-pointer variables may only name a temp dir', () => {
  const src = fs.readFileSync(path.join(__dirname, '../test-visual/app.js'), 'utf8');
  assert.match(src, /\.\.\.\(env\.PATH \? \{ PATH: withFakesFirst\(userHome, env\.PATH\) \}/);
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-bin-'));
  const fakes = path.join('/tmp/u', '.local', 'bin');
  assert.equal(withFakesFirst('/tmp/u', `${stub}:/usr/bin:/opt/homebrew/bin`), `${stub}:${fakes}:/usr/bin:/opt/homebrew/bin`); // a spec's own stub stays first, the fakes beat every real dir
  assert.equal(withFakesFirst('/tmp/u', '/usr/bin'), `${fakes}:/usr/bin`);
  assert.equal(withFakesFirst('/tmp/u', stub), `${stub}:${fakes}`);
  assert.match(src, /for \(const k of HOME_POINTERS\) if \(k in env && !underTmp\(env\[k\]\)\) throw/);
  assert.equal(underTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'under-tmp-'))), true);
  const real = os.userInfo().homedir; // the account's home, whatever HOME says
  assert.equal(underTmp(real), false);
  assert.equal(underTmp(path.join(real, '.claude')), false);
  assert.equal(underTmp(path.join(os.tmpdir(), 'does-not-exist-x')), false); // unresolvable counts as not safe
});

// The rule for the whole directory, self-launching specs included: nothing sets HOME or USERPROFILE for an app or the
// run, and a spec that starts Electron itself sets no PATH either (launchApp prepends the fakes to a caller PATH, a
// direct electron.launch would not). app.js builds the env (homeEnv) and provider-isolation.spec.js tests the refusal.
test('visual specs: no spec sets HOME, USERPROFILE or (for a direct electron.launch) PATH', () => {
  const dir = path.join(__dirname, '../test-visual');
  const allowed = new Set(['app.js', 'provider-isolation.spec.js']);
  const hits = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !allowed.has(f))) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const direct = /electron\.launch\(|_electron\.launch\(/.test(text);
    text.split('\n').forEach((line, i) => {
      const code = line.replace(/^\s*\/\/.*$/, '');
      if (/(^|[^A-Za-z0-9_])(HOME|USERPROFILE)\s*:/.test(code)) hits.push(`${name}:${i + 1} sets a HOME key: ${code.trim().slice(0, 100)}`);
      if (/process\.env\.(HOME|USERPROFILE|PATH)\s*=[^=]/.test(code) || /process\.env\[['"](HOME|USERPROFILE|PATH)['"]\]\s*=[^=]/.test(code)) hits.push(`${name}:${i + 1} assigns process.env: ${code.trim().slice(0, 100)}`);
      if (direct && /(^|[^A-Za-z0-9_])PATH\s*:/.test(code)) hits.push(`${name}:${i + 1} sets PATH next to a direct electron.launch: ${code.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('visual specs: the source rule would catch a violation (self-check of the patterns)', () => {
  const sample = ["electron.launch({ env: { ...process.env, HOME: tmp } })", "process.env.HOME = x;", "process.env['PATH'] = y;", "env: { USERPROFILE: x }"];
  const hit = (code) => /(^|[^A-Za-z0-9_])(HOME|USERPROFILE)\s*:/.test(code) || /process\.env\.(HOME|USERPROFILE|PATH)\s*=[^=]/.test(code) || /process\.env\[['"](HOME|USERPROFILE|PATH)['"]\]\s*=[^=]/.test(code);
  for (const s of sample) assert.equal(hit(s), true, s);
  assert.equal(hit("CLAUDE_TRAFFIC_LIGHT_HOME: home"), false);
  assert.equal(hit("PLEXIFORM_SESSION_TABS_HOME: home"), false);
});
