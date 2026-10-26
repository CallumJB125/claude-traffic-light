// C-K: no answer path types into a terminal. Answers reach Claude only through the hook's answer file; nothing shipped
// may send keys, paste text into a pane, or script a click on a terminal's dialog. Comments may name these (they
// explain why not). The scan covers the whole repo except tests, fixtures, docs and build output.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'out', 'work', 'outputs', 'docs', '.omc', '.claude', 'test', 'tests', 'test-visual', '__screenshots__', 'fixtures', 'coverage', 'test-results', 'playwright-report', 'release']);
const EXTS = /\.(js|cjs|mjs|ts|swift|m|mm|h|sh|applescript|scpt|py|ps1)$/;
const FORBIDDEN = [
  /send-keys|send_keys|\bsendkeys\b|SendKeys\b/i,
  /\bkeystroke\b|\bkey code\b|\bkey down\b|\bkey up\b/i,
  /\bxdotool\b|\bcliclick\b|\bydotool\b|\bwtype\b/i,
  /CGEventCreateKeyboardEvent|CGEventPost|CGEventKeyboardSetUnicodeString/,
  /\b(?:paste-buffer|load-buffer|set-buffer)\b/i,
  /\bwrite text\b/i,
  /(?:@|\bcli)\s+send-text\b/i,
  /-X\s+stuff\b/,
  /click\s+(?:button|menu item|checkbox|radio button)\b/i,
  /tmux[^\n]{0,60}['"`]send['"`]/i,
];

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) || e.name.startsWith('test-') ? [] : sources(p);
    return EXTS.test(e.name) ? [p] : [];
  });
}
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => (/^\s*(\/\/|\*|#)/.test(l) ? '' : l.replace(/(^|\s)\/\/\s.*$/, '$1'))).join('\n');
const forbidden = (line) => FORBIDDEN.some((re) => re.test(line));

test('C-K: no send-keys, paste, UI-scripted click or synthetic key event anywhere in the shipped code', () => {
  const files = sources(ROOT).filter((f) => !/\.test\.[cm]?js$/.test(f));
  assert.ok(files.length > 300, `scanned ${files.length}`);
  for (const dir of ['adapters', 'remote', 'native', 'scripts', 'buddy-window', 'board', 'src', 'hooks']) assert.ok(files.some((f) => f.startsWith(path.join(ROOT, dir) + path.sep)), `${dir} is scanned`);
  assert.ok(files.some((f) => path.dirname(f) === ROOT && f.endsWith('widget.js')), 'root renderers are scanned');
  const hits = files.flatMap((f) => code(fs.readFileSync(f, 'utf8')).split('\n').map((l, i) => (forbidden(l) ? `${path.relative(ROOT, f)}:${i + 1}: ${l.trim().slice(0, 100)}` : null)).filter(Boolean));
  assert.deepEqual(hits, []);
});

test('C-K: the check itself sees every pattern it forbids', () => {
  for (const bad of [
    "exec('tmux send-keys -t x Enter')", 'tell application "System Events" to keystroke "y"', "run('tmux', ['send', 'y'])",
    "tmux('paste-buffer', '-t', pane)", 'tmux load-buffer -', 'tmux set-buffer -- "y"', 'tell session 1 to write text "y"',
    'kitty @ send-text y', 'wezterm cli send-text y', 'screen -X stuff "y"', 'CGEventPost(kCGHIDEventTap, ev)', 'key down return',
    'ydotool key 28', 'wtype y', 'tell process "Terminal" to click button "Allow"', 'xdotool key Return',
  ]) assert.ok(forbidden(bad), bad);
  assert.equal(forbidden(code('// tmux send-keys is never used\nconst a = 1;')), false);
});
