'use strict';
// The Discover page's catalogue / build log / remix views (vibe-view.js) in jsdom, against a stubbed vibeApi.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'discover.html'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'vibe-view.js'), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
const click = async (w, el) => { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); for (let i = 0; i < 5; i++) await tick(); };
const byText = (root, sel, text) => [...root.querySelectorAll(sel)].find((b) => b.textContent.startsWith(text));

function rig() {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  const final = { title: 'Building todo', timeline: [{}], prompts: [{}], files: [], cost_usd: 1.5, deployed_url: null, kit: null };
  const view = { ok: true, fields: { title: 'Building todo' }, items: [{ id: 'i1', section: 'prompts', include: true, text: 'Build <b>it</b>' }, { id: 'i2', section: 'files', include: true, path: 'src/a.js', edits: 2 }], final, digest: 'd'.repeat(64), problems: [] };
  w.vibeApi = {
    catalog: async () => ({ ok: true, fetched: true, tabs: [{ id: 'starters', label: 'Starters', items: [] }, { id: 'skills', label: 'Skills', items: [{ source: 'gallery', id: 'recipe/x', sha256: 'a', title: 'Explain', what: 'w', cost: 'Low.', author: 'Ana', used: 'Not installed here', permissions: ['Reads only'], install: 'add' }] }, { id: 'mcp', label: 'MCP servers', items: [] }] }),
    install: async (...a) => { calls.push(['install', ...a]); return { ok: true }; },
    report: async (...a) => { calls.push(['report', ...a]); return { ok: true }; },
    sessions: async () => ({ ok: true, sessions: [{ key: 'claude-code.s1', label: 'Claude Code · todo' }] }),
    draft: async (...a) => { calls.push(['draft', ...a]); return view; },
    review: async (r) => { calls.push(['review', r]); return view; },
    teams: async () => ({ ok: true, teams: [{ id: 't1', name: 'Alpha' }] }),
    publish: async (...a) => { calls.push(['publish', ...a]); return { ok: true, url: 'https://hub.example.com/b/x' }; },
    published: async () => ({ ok: true, logs: [] }),
    exportHtml: async (...a) => { calls.push(['export', ...a]); return { ok: true, name: 'x.html' }; },
  };
  w.eval(script);
  return { w, d: w.document, calls };
}

test('the catalogue shows cost, permissions and author, and installs through main', async () => {
  const { w, d, calls } = rig();
  await click(w, byText(d, '.vb-tab', 'Catalogue'));
  assert.equal(d.getElementById('cg-gallery').hidden, true);
  await click(w, byText(d, '.cg-chip', 'Skills'));
  const card = d.querySelector('.vb-card');
  assert.match(card.textContent, /Low\..*Ana/s);
  assert.match(card.textContent, /Reads only/);
  await click(w, byText(card, 'button', 'Install'));
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ['install', 'recipe/x', 'a', 'add']);
});

test('the build log review shows every item as text and publishes the reviewed digest to the chosen team', async () => {
  const { w, d, calls } = rig();
  await click(w, byText(d, '.vb-tab', 'Build log'));
  d.querySelector('.vb-pick input').checked = true;
  await click(w, byText(d, 'button', 'Make a draft'));
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['draft', ['claude-code.s1'], { kit: false }]);
  const review = d.querySelector('.vb-review');
  assert.ok(review, 'the review screen is shown');
  assert.equal(review.querySelector('.vb-item textarea').value, 'Build <b>it</b>');
  assert.equal(review.querySelectorAll('b').length, 0, 'item text is never HTML');
  review.querySelector('.vb-item input[type=checkbox]').checked = false;
  d.querySelector('.vb-team').value = 't1';
  await click(w, byText(review, 'button', 'Publish'));
  const sent = calls.find((c) => c[0] === 'review');
  assert.equal(sent[1].items.find((i) => i.id === 'i1').include, false);
  assert.deepEqual(calls.find((c) => c[0] === 'publish'), ['publish', 'd'.repeat(64), 't1']);
  assert.match(d.querySelector('.vb-status').textContent, /hub\.example\.com\/b\/x/);
});
