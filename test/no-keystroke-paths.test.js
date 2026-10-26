// C-K: no answer path types into a terminal. Answers reach Claude only through the hook's answer file; nothing in the
// app, main or the hooks may send keys to tmux or script keystrokes. Comments may name them (they explain why not).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FORBIDDEN = /send-keys|send_keys|\bsendkeys\b|\bkeystroke\b|\bkey code\b|\bxdotool\b|\bcliclick\b|CGEventCreateKeyboardEvent|SendKeys\b|tmux[^\n]{0,60}['"`]send['"`]/i;

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(p);
    return /\.(js|cjs|mjs)$/.test(e.name) ? [p] : [];
  });
}
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => (/^\s*(\/\/|\*)/.test(l) ? '' : l.replace(/(^|\s)\/\/\s.*$/, '$1'))).join('\n');

test('C-K: no send-keys, tmux send or AppleScript keystroke in src/, main.js or hooks/', () => {
  const files = [path.join(ROOT, 'main.js'), ...sources(path.join(ROOT, 'src')), ...sources(path.join(ROOT, 'hooks'))];
  assert.ok(files.length > 50);
  const hits = files.flatMap((f) => code(fs.readFileSync(f, 'utf8')).split('\n').map((l, i) => (FORBIDDEN.test(l) ? `${path.relative(ROOT, f)}:${i + 1}: ${l.trim().slice(0, 100)}` : null)).filter(Boolean));
  assert.deepEqual(hits, []);
});

test('C-K: the check itself sees the patterns it forbids', () => {
  for (const bad of ["exec('tmux send-keys -t x Enter')", 'tell application "System Events" to keystroke "y"', "run('tmux', ['send', 'y'])"]) assert.ok(FORBIDDEN.test(bad), bad);
  assert.equal(code('// tmux send-keys is never used\nconst a = 1;').includes('send-keys'), false);
});
