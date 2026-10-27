'use strict';
// Redesign R2a: transcript markdown → tree, and the tree → DOM (text only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Md = require('../src/transcript-md.js');
const Dom = require('../src/transcript-dom.js');

const ROOT = path.join(__dirname, '..');
const open = [];
test.afterEach(() => { while (open.length) open.pop().close(); });
const doc = () => { const d = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' }); open.push(d.window); return d.window.document; };
const types = (tree) => tree.map((n) => n.type);

test('markdown: the fixed block set', () => {
  const t = Md.parse('# Title\n\n#### Small\n\npara one\nstill one\n\n- a\n- b\n\n1. x\n2. y\n\n> quoted\n\n```js\nconst a = 1;\n```\n\n| h1 | h2 |\n|----|----|\n| c1 | c2 |');
  assert.deepEqual(types(t), ['h3', 'h4', 'p', 'ul', 'ol', 'blockquote', 'pre', 'table']);
  assert.equal(t[2].children[0].text, 'para one still one');
  assert.equal(t[6].text, 'const a = 1;');
  assert.equal(t[7].children.length, 2, 'header row + one row');
});

test('markdown: inline code, strong, em, snake_case stays text', () => {
  const [p] = Md.parse('Run `npm test` then **check** the *flaky* one in my_file_name');
  assert.deepEqual(p.children.map((n) => n.type), ['text', 'code', 'text', 'strong', 'text', 'em', 'text']);
  assert.equal(p.children.at(-1).text, ' one in my_file_name');
});

test('markdown: links keep http(s) only; anything else reads as its text', () => {
  const [p] = Md.parse('[docs](https://example.com/a) and [bad](javascript:alert(1)) and [file](file:///etc/passwd)');
  const links = p.children.filter((n) => n.type === 'link');
  assert.deepEqual(links, [{ type: 'link', text: 'docs', url: 'https://example.com/a' }]);
  assert.ok(!JSON.stringify(p).includes('javascript:'), 'the javascript: address is gone');
  assert.ok(!JSON.stringify(p).includes('file:'), 'the file: address is gone');
});

test('markdown: unknown or HTML constructs are plain text', () => {
  const [p] = Md.parse('<b>bold</b> <img src=x onerror=alert(1)>');
  assert.deepEqual(p.children, [{ type: 'text', text: '<b>bold</b> <img src=x onerror=alert(1)>' }]);
  assert.deepEqual(Md.parse(''), []);
  assert.deepEqual(Md.parse(null), []);
});

test('markdown: an unclosed fence takes the rest; huge input is capped', () => {
  assert.deepEqual(types(Md.parse('```\nnever closed\nstill code')), ['pre']);
  const t = Md.parse('a'.repeat(Md.MAX_CHARS + 50));
  assert.equal(t[0].children[0].text.length, Md.MAX_CHARS);
});

test('dom: a hostile transcript builds no element outside the fixed set and no attribute handlers', () => {
  const d = doc();
  const hostile = '<script>parent.x=1</script>\n\n<img src=x onerror="parent.y=1">\n\n[click](javascript:parent.z=1)\n\n<svg onload="parent.w=1"></svg>';
  d.body.append(Dom.render(d, { items: [{ kind: 'text', role: 'assistant', text: hostile }] }));
  const tags = new Set([...d.body.querySelectorAll('*')].map((n) => n.tagName.toLowerCase()));
  for (const t of tags) assert.ok(['div', 'p', 'span', 'pre', 'code', 'ul', 'ol', 'li', 'em', 'strong', 'blockquote', 'h3', 'h4', 'table', 'tr', 'td'].includes(t), `unexpected <${t}>`);
  for (const n of d.body.querySelectorAll('*')) for (const a of n.attributes) assert.ok(['class', 'data-group'].includes(a.name), `unexpected attribute ${a.name}`);
  assert.equal(d.querySelectorAll('a, script, img, svg, iframe').length, 0);
  assert.ok(d.body.textContent.includes('<script>parent.x=1</script>'), 'shown as text');
});

test('dom: a link shows its text and address, never an anchor', () => {
  const d = doc();
  d.body.append(Dom.markdown(d, 'See [the docs](https://example.com/x).'));
  assert.equal(d.querySelector('a'), null);
  assert.equal(d.querySelector('.tx-link').textContent, 'the docs (https://example.com/x)');
});

test('dom: roles, the opening prompt once, and undelivered messages last', () => {
  const d = doc();
  d.body.append(Dom.render(d, {
    prompt: 'Fix the tests',
    items: [{ kind: 'text', role: 'user', text: 'Fix the tests' }, { kind: 'text', role: 'assistant', text: 'On it.' }, { kind: 'text', role: 'system', text: 'Model switched' }],
    waiting: [{ body: 'Also the docs' }],
  }));
  const msgs = [...d.body.children].map((n) => n.className);
  assert.deepEqual(msgs, ['tx-msg tx-user', 'tx-msg tx-ai', 'tx-note', 'tx-msg tx-user is-waiting']);
  assert.equal(d.querySelectorAll('.tx-user').length, 2, 'the prompt is not shown twice');
});

test('tool steps: consecutive steps collapse into one summary line (§2.4)', () => {
  const steps = [
    { kind: 'tool', name: 'Read', summary: 'a.js', done: true, ok: true, durationMs: 100 },
    { kind: 'tool', name: 'Read', summary: 'b.js', done: true, ok: true, durationMs: 100 },
    { kind: 'tool', name: 'Read', summary: 'c.js', done: true, ok: true, durationMs: 100 },
    { kind: 'tool', name: 'Edit', summary: 'server.js', done: true, ok: true, durationMs: 2000 },
    { kind: 'tool', name: 'Bash', summary: 'npm test', done: true, ok: true, durationMs: 9000 },
    { kind: 'tool', name: 'Bash', summary: 'npm test', done: true, ok: false, durationMs: 3000 },
  ];
  const g = Dom.groups([{ kind: 'text', role: 'assistant', text: 'x' }, ...steps, { kind: 'text', role: 'assistant', text: 'y' }, steps[0]]);
  assert.deepEqual(g.map((x) => x.kind), ['text', 'steps', 'text', 'steps']);
  assert.equal(Dom.summary(g[1].steps), 'Read 3 files · Edited server.js · Ran npm test (2)');
  const d = doc();
  d.body.append(Dom.render(d, { items: steps, open: new Set([0]) }));
  assert.ok(d.querySelector('.tx-steps').classList.contains('is-failed'), 'a failed step marks the group with the Stuck shape');
  assert.equal(d.querySelectorAll('.tx-step').length, 6);
  assert.equal(d.querySelectorAll('.tx-step.is-failed').length, 1);
  assert.equal(d.querySelector('.tx-steps-head .tx-dur').textContent, '14 s');
});

// §R4.2 static lint: no sandbox ever allows scripts, and the transcript code
// never touches an HTML sink.
test('static: no sandbox attribute anywhere allows scripts', () => {
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'test-results', 'test-visual'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(html|js|cjs|mjs)$/.test(e.name)) files.push(p);
  } };
  walk(ROOT);
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/sandbox\s*=\s*["'`]([^"'`]*)["'`]/gi)) assert.ok(!/allow-scripts/i.test(m[1]), `${path.relative(ROOT, f)}: sandbox="${m[1]}"`);
    for (const m of s.matchAll(/setAttribute\(\s*['"]sandbox['"]\s*,\s*['"`]([^'"`]*)/g)) assert.ok(!/allow-scripts/i.test(m[1]), `${path.relative(ROOT, f)}: setAttribute sandbox`);
  }
});

test('static: the transcript and thread code use no HTML sinks', () => {
  const names = ['src/transcript-md.js', 'src/transcript-dom.js', ...fs.readdirSync(ROOT).filter((n) => /^thread.*\.js$/.test(n))];
  for (const n of names) {
    const s = fs.readFileSync(path.join(ROOT, n), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'createContextualFragment', 'DOMParser']) assert.ok(!s.includes(sink), `${n} uses ${sink}`);
    assert.ok(!/setAttribute\(\s*['"]on/i.test(s), `${n} sets an on* attribute`);
    assert.ok(!/\.on[a-z]+\s*=/.test(s.replace(/\.onload\s*=\s*resolve/g, '')), `${n} assigns an on* handler property`);
  }
});
