// Find agents page pieces that don't touch IPC: the hand-drawn glyphs, the
// search over the shipped catalogue, the prompt renderer, and the page's own
// rules (CSP, no markup sinks).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Icons = require('../agent-icons.js');
const Search = require('../src/agent-catalog-search.js');
const Prompt = require('../src/agent-prompt-render.js');
const Catalog = require('../src/agent-catalog.js');
const Palette = require('../src/command-palette.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const shipped = Catalog.shipped();
const slim = shipped.catalog.agents.map(Catalog.summary);

// ── icons ──
test('every icon the shipped catalogue names is drawn, plus the fallback and the sidebar glyph', () => {
  const used = new Set(shipped.catalog.agents.map((a) => a.icon));
  for (const c of Object.values(shipped.catalog.categories)) used.add(c.icon);
  for (const id of used) assert.ok(Object.hasOwn(Icons.GLYPHS, id), `missing glyph ${id}`);
  assert.ok(Icons.GLYPHS.sparkle && Icons.GLYPHS['find-agents']);
  assert.deepEqual(Icons.paths('no-such-glyph'), Icons.GLYPHS.sparkle);
  assert.deepEqual(Icons.paths('__proto__'), Icons.GLYPHS.sparkle);
});

test('glyphs are plain path data on the 16px grid', () => {
  for (const [id, ps] of Object.entries(Icons.GLYPHS)) {
    assert.ok(Array.isArray(ps) && ps.length >= 1 && ps.length <= 4, id);
    for (const d of ps) {
      assert.match(d, /^[MLHVCSQAZmlhvcsqaz0-9.\s,-]+$/, `${id}: only path commands and numbers`);
      assert.ok(!/fill|url\(|</.test(d), id);
      // Absolute coordinates stay on the grid (relative ones are deltas).
      for (const seg of d.match(/[MLC][^MLHVCSQAZmlhvcsqaz]*/g) || []) {
        for (const n of seg.slice(1).trim().split(/[\s,]+|(?=-)/).filter(Boolean).map(Number)) assert.ok(n >= 0 && n <= 16, `${id}: ${seg}`);
      }
    }
  }
});

test('the DOM builder makes an aria-hidden svg of paths', () => {
  const made = [];
  const node = (tag) => ({ tag, attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.kids.push(c); } });
  const doc = { createElementNS: (ns, tag) => { assert.equal(ns, 'http://www.w3.org/2000/svg'); const n = node(tag); made.push(n); return n; } };
  const svg = Icons.element(doc, 'shield');
  assert.equal(svg.attrs['aria-hidden'], 'true');
  assert.equal(svg.attrs.viewBox, '0 0 16 16');
  assert.deepEqual(svg.kids.map((k) => k.attrs.d), Icons.GLYPHS.shield);
});

// ── search ──
const index = Search.buildIndex(slim);
const ids = (q, f) => Search.search(index, q, f).map((a) => a.id);

test('search ranks a name match first and ANDs terms', () => {
  assert.equal(ids('sql')[0], '0xfurai/sql-expert');
  assert.ok(ids('frontend developer').includes('voltagent/frontend-developer'));
  const both = ids('marketing seo');
  assert.ok(both.length > 0 && both.every((id) => ids('seo').includes(id)));
  assert.deepEqual(ids('zzzzqqq'), []);
});

test('long prose needs a real substring, so short words do not match everything', () => {
  assert.ok(ids('ios').length < 80);
  assert.ok(ids('k8s').length < 10);
});

test('search is accent- and case-insensitive', () => {
  assert.deepEqual(ids('SÉCURITY'), ids('security'));
});

test('filters: category, source, tools, only; duplicates show once unless a source is picked', () => {
  assert.ok(ids('', { category: 'security' }).every((id) => shipped.get(id).category === 'security'));
  const dupes = slim.filter((a) => !a.primary);
  assert.ok(dupes.length > 0);
  const all = new Set(ids(''));
  for (const d of dupes) assert.ok(!all.has(d.id), d.id);
  const src = dupes[0].source;
  assert.ok(ids('', { source: src }).includes(dupes[0].id));
  assert.ok(Search.search(index, '', { tools: 'every' }).every((a) => a.everyTool));
  assert.ok(Search.search(index, '', { tools: 'limited' }).every((a) => !a.everyTool));
  assert.deepEqual(ids('', { only: new Set(['0xfurai/sql-expert']) }), ['0xfurai/sql-expert']);
});

test('PR4 Works with: a platform filter keeps only agents that render for it, from the list\'s works field', () => {
  const { worksWith } = require('../src/agent-install.js');
  const withWorks = Search.buildIndex(shipped.catalog.agents.map((a) => ({ ...Catalog.summary(a), works: worksWith(a) })));
  const codex = Search.search(withWorks, '', { works: 'codex' }).map((a) => a.id);
  assert.ok(codex.length > 0);
  assert.ok(!codex.includes('voltagent/ab-test-analysis'), 'read-only agents are not offered for Codex');
  assert.ok(Search.search(withWorks, '', { works: 'claude' }).map((a) => a.id).includes('voltagent/ab-test-analysis'));
  assert.deepEqual(Search.search(index, '', { works: 'codex' }), [], 'an agent without a works list matches no platform');
  assert.deepEqual(Search.search(withWorks, '', { works: 'nope' }), []);
});

test('the page offers Works with only for the tools the list names, and Clear search resets it', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'agents-find-view.js'), 'utf8');
  assert.match(view, /worksTools\.length \? select\('af-works'/);
  assert.match(view, /works: f\.works \|\| null/);
  for (const m of view.matchAll(/filters = \{[^}]*\}/g)) assert.match(m[0], /works: ''/);
});

test('queries are capped: terms, length, and a regex-looking query is just text', () => {
  assert.equal(Search.terms('a b c d e f g h i j k').length, Search.MAX_TERMS);
  assert.ok(Search.terms('x'.repeat(10000)).every((t) => t.length <= 64));
  assert.doesNotThrow(() => Search.search(index, '(a+)+$ [ \\ .* (?:'));
});

test('search over the shipped catalogue: p95 under 100 ms of CPU', () => {
  const qs = ['react', 'security', 'sql', 'rust', 'k8s', 'ios', 'marketing seo', 'a', 'zzzz', 'frntend', 'python data', 'frontend developer', 'devops cloud', 'test', 'design', 'x'.repeat(300)];
  const times = [];
  for (let r = 0; r < 4; r++) for (const q of qs) {
    const t = process.cpuUsage();
    Search.search(index, q);
    const d = process.cpuUsage(t);
    times.push((d.user + d.system) / 1000);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  assert.ok(p95 < 100 * (process.env.CI ? 3 : 1), `p95 ${p95.toFixed(1)} ms`);
});

test('scoreNorm is score() without the normalising step', () => {
  for (const [h, n] of [['react-expert', 'react'], ['Frontend Developer', 'fd'], ['abc', ''], ['x', 'y']]) assert.equal(Palette.scoreNorm(Palette.norm(h), Palette.norm(n)), Palette.score(h, n));
});

// ── the list fields the page gets ──
test('summary never carries the prompt, and tools are said in plain words', () => {
  for (const a of slim) {
    assert.ok(!('raw' in a) && !('bodyOffset' in a));
    assert.ok(a.toolsSummary.length > 0);
  }
  assert.ok(JSON.stringify(slim).length < 1.5 * 1024 * 1024);
  assert.equal(Catalog.toolsInWords({ declared: null }), 'Every tool your AI tool has. The author didn\'t limit it.');
  assert.equal(Catalog.toolsInWords({ declared: ['Read', 'Grep'] }), 'Read files.');
  assert.equal(Catalog.toolsInWords({ declared: ['Read', 'Edit', 'Bash', 'WebFetch'] }), 'Read files, edit files, run terminal commands and use the web.');
  assert.equal(Catalog.toolsInWords({ declared: ['Read', 'mcp__x'] }), 'Read files and use one other tool (mcp__x).');
  assert.equal(Catalog.toolsInWords({ declared: [] }), 'No tools.');
});

// ── prompt renderer ──
const flat = (blocks) => JSON.stringify(blocks);

test('prompt blocks: headings, lists, fences, quotes, rules, inline code and bold', () => {
  const b = Prompt.render('# Title\n\nPara one\ncontinues\n\n- a\n- b\n  more\n\n1. x\n2) y\n\n```bash\nrm -rf /\n```\n> said\n---\nUse `npm` and **care**.');
  assert.deepEqual(b.map((x) => x.type), ['heading', 'para', 'list', 'list', 'code', 'quote', 'rule', 'para']);
  assert.equal(b[0].level, 1);
  assert.equal(b[1].runs[0].text, 'Para one continues');
  assert.deepEqual(b[2].items.map((i) => i[0].text), ['a', 'b more']);
  assert.equal(b[3].ordered, true);
  assert.deepEqual(b[4], { type: 'code', lang: 'bash', text: 'rm -rf /' });
  assert.deepEqual(b[7].runs.map((r) => r.kind), ['text', 'code', 'text', 'strong', 'text']);
});

test('markup in a prompt is only ever text, and links show their URL', () => {
  const b = Prompt.render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) ![i](https://e.vil/x.png) &lt;b&gt;');
  const s = flat(b);
  assert.ok(!/"html"/.test(s));
  assert.equal(b[0].runs[0].text, '<script>alert(1)</script>');
  assert.equal(b[1].runs[0].text, '<img src=x onerror=alert(1)>');
  assert.equal(b[2].runs[0].text, 'click (javascript:alert(1)) i (https://e.vil/x.png) &lt;b&gt;');
  for (const x of b) for (const r of x.runs || []) assert.ok(['text', 'code', 'strong'].includes(r.kind));
});

test('the renderer stays linear on hostile input', () => {
  for (const s of ['['.repeat(65536), '`'.repeat(65535), '**'.repeat(32768), `${'['.repeat(65000)}](x`, '!['.repeat(30000), `${'- '.repeat(20000)}`, `${'#'.repeat(60000)} x`]) {
    const t = process.cpuUsage();
    Prompt.render(s);
    const d = process.cpuUsage(t);
    assert.ok((d.user + d.system) / 1000 < 500, `${s.slice(0, 6)}…`);
  }
});

test('every shipped prompt renders', () => {
  for (const a of shipped.catalog.agents) assert.ok(Prompt.render(shipped.body(a)).length > 0, a.id);
});

// ── the page ──
test('the page keeps the strict CSP and loads only its own scripts', () => {
  const html = read('agents-find.html');
  assert.match(html, /content="default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'"/);
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), 'no inline script');
  assert.ok(!/\son[a-z]+=/.test(html), 'no inline handlers');
  assert.ok(!/style=/.test(html), 'no inline style');
  for (const src of html.match(/src="[^"]+"/g)) assert.ok(fs.existsSync(path.join(ROOT, src.slice(5, -1))), src);
});

test('the page never parses third-party text as markup, and has no links (the window opens any http(s) link)', () => {
  for (const f of ['agents-find.html', 'agents-find-view.js', 'agents-find-preload.js', 'agent-icons.js', 'src/agent-catalog-search.js', 'src/agent-prompt-render.js']) {
    // Same-origin stylesheets are the only href the page may carry.
    const js = read(f).replace(/<link rel="stylesheet" href="[a-z-]+\.css">/g, '');
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'DOMParser', 'createContextualFragment', 'new Function', 'srcdoc', '<a ', "setAttribute('style'", 'setAttribute("style"', '.src =', "el('a'", "createElement('a')", 'window.open']) assert.ok(!js.includes(sink), `${f}: ${sink}`);
    assert.ok(!/\beval\b/.test(js), `${f}: eval`);
    assert.ok(!/\bhref\b/.test(js), `${f}: no href`);
    assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(js), `${f}: no network`);
  }
});

test('the preload exposes only the Find agents calls and rebuilds every argument', () => {
  const src = read('agents-find-preload.js');
  const exposed = {};
  const invoked = [];
  const electron = { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: { invoke: (...a) => { invoked.push(a); return Promise.resolve(null); } } };
  new Function('require', src)((m) => (m === 'electron' ? electron : null));
  assert.deepEqual(Object.keys(exposed), ['agentsApi']);
  assert.deepEqual(Object.keys(exposed.agentsApi).sort(), ['add', 'addToProject', 'adopt', 'adoptable', 'backupPlan', 'detail', 'list', 'mine', 'onShow', 'openTools', 'remove', 'showBackup', 'status', 'stopManaging', 'targets', 'undo', 'undoOp', 'undoProject', 'undoProjectOp', 'update']);
  const evil = { platform: 'claude', alt: 'yes', path: '/etc', toString: () => 'x' };
  exposed.agentsApi.add({ toString: () => 'a'.repeat(500) }, 'f'.repeat(100), [evil, 'codex', ...Array(30).fill('gemini')]);
  const [ch, id, sha, plats] = invoked.at(-1);
  assert.equal(ch, 'agents:add');
  assert.equal(id.length, 200);
  assert.equal(sha.length, 64);
  assert.equal(plats.length, 16);
  assert.deepEqual(plats[0], { platform: 'claude', alt: false });
  assert.notEqual(plats[0], evil);
  assert.equal(plats[1], 'codex');
  exposed.agentsApi.addToProject('x', 'y', '/etc/passwd');
  assert.deepEqual(invoked.at(-1), ['agents:add-to-project', 'x', 'y']);
  exposed.agentsApi.undo({});
  assert.deepEqual(invoked.at(-1), ['agents:undo', '[object Object]']);
  // PR 4: names, ids and backup ids only, each cut to size; no paths.
  exposed.agentsApi.adopt([...Array(500).fill('a.md'), { toString: () => 'x'.repeat(300) }]);
  let [c2, names] = invoked.at(-1);
  assert.equal(c2, 'agents:adopt');
  assert.equal(names.length, 400);
  assert.ok(names.every((n) => typeof n === 'string' && n.length <= 128));
  exposed.agentsApi.adopt('not a list');
  assert.deepEqual(invoked.at(-1), ['agents:adopt', []]);
  exposed.agentsApi.update('x', 'f'.repeat(99), '/etc');
  assert.deepEqual(invoked.at(-1), ['agents:update', 'x', 'f'.repeat(64)]);
  exposed.agentsApi.remove('x', '/etc');
  assert.deepEqual(invoked.at(-1), ['agents:remove', 'x']);
  exposed.agentsApi.stopManaging('/etc');
  assert.deepEqual(invoked.at(-1), ['agents:stop-managing']);
  exposed.agentsApi.undoOp('u'.repeat(99));
  assert.deepEqual(invoked.at(-1), ['agents:undo-op', 'u'.repeat(36)]);
  exposed.agentsApi.undoProjectOp(null);
  assert.deepEqual(invoked.at(-1), ['agents:undo-project-op', '']);
  exposed.agentsApi.showBackup('b'.repeat(99), '/etc');
  assert.deepEqual(invoked.at(-1), ['agents:show-backup', 'b'.repeat(64)]);
  exposed.agentsApi.backupPlan('b');
  assert.deepEqual(invoked.at(-1), ['agents:backup-plan', 'b']);
  // agents:show passes only the literal 'mine'.
  const on = [];
  const e2 = { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: { invoke: () => null, on: (ch, fn) => on.push([ch, fn]) } };
  new Function('require', src)((m) => (m === 'electron' ? e2 : null));
  const got = [];
  exposed.agentsApi.onShow((v) => got.push(v));
  assert.equal(on[0][0], 'agents:show');
  for (const v of ['mine', 'all', { toString: () => 'mine' }, '<img>']) on[0][1]({}, v);
  assert.deepEqual(got, ['mine']);
});

test('the page is registered in the Agents section with its own glyph', () => {
  const Pages = require('../buddy-window/pages.js');
  const p = Pages.pageById('agents-find');
  assert.equal(p.file, 'agents-find.html');
  assert.equal(p.preload, 'agents-find-preload.js');
  assert.ok(Pages.SECTIONS.find((s) => s.id === 'sessions').pages.includes('agents-find'));
  assert.ok(read('buddy-window/sidebar.js').includes("'find-agents': ['M6.5 2a2"));
  const pkg = JSON.parse(read('package.json'));
  for (const f of ['agents-find.html', 'agents-find-preload.js', 'agents-find-view.js', 'agents-find-view.css', 'agent-icons.js']) assert.ok(pkg.build.files.includes(f), f);
});

test('the page names only ids, the catalogue sha, platforms and an undo id', () => {
  const js = read('agents-find-view.js');
  const calls = [...js.matchAll(/api\.(\w+)\(([^)]*)\)/g)].map((m) => `${m[1]}(${m[2]})`);
  const allowed = new Set(['list()', 'status()', 'detail(a.id)', 'targets(a.id)', 'add(a.id, catalogSha, platforms)', 'undo(opId)', 'addToProject(a.id, state.catalogSha)', 'undoProject(r.opId)', 'openTools()',
    // PR 4: file names, agent ids, undo ids and backup ids, all from main's own answers.
    'mine()', 'adoptable()', 'adopt(names)', 'stopManaging()', 'update(a.agentId, state.catalogSha)', 'remove(a.agentId)', 'undo(o.opId)', 'undoOp(o.opId)', 'undoProject(o.opId)', 'undoProjectOp(o.opId)', 'showBackup(b.id)', 'showBackup(n.backup)']);
  for (const c of calls) assert.ok(allowed.has(c), c);
  assert.match(js, /const names = matches\.map\(\(m\) => m\.name\);/, 'adopt names come from agents:adoptable');
});
