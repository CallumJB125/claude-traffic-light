import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../js/markdown.js';
import { textOf, findAll, walk } from '../js/h.js';
import { mergeHandover, renderMarkdown as handoverMarkdown, applyPatch } from '../../shared/handover.js';

const tags = (blocks) => blocks.map((b) => b.tag);

test('headings, lists, checklists, code spans and fenced code get structure', () => {
  const md = '## Plan\n- [x] Reproduce\n- [~] Fix `submit.ts`\n- [ ] Test\n\n```\nnpm test\n```\nplain `x` text';
  const b = renderMarkdown(md);
  assert.deepEqual(tags(b), ['h4', 'ul', 'pre', 'p'], '## sits one below the drawer section (# → h3)');
  const items = findAll(b[1], (n) => n.tag === 'li');
  assert.deepEqual(items.map((i) => i.props['data-check']), ['done', 'doing', 'todo']);
  assert.equal(findAll(b[1], (n) => n.tag === 'code').length, 1);
  assert.equal(textOf(b[2]), 'npm test');
});

test('everything else stays literal text: HTML, links, emphasis', () => {
  const md = '<b>bold</b> [link](javascript:alert(1)) **strong** <script>x</script>';
  const b = renderMarkdown(md);
  assert.equal(textOf(b), md);
  walk({ tag: 'div', props: {}, children: b }, (n) => assert.ok(['div', 'p'].includes(n.tag), `unexpected <${n.tag}>`));
});

test('an unterminated fence swallows the rest as code, never as markup', () => {
  const b = renderMarkdown('```\n## not a heading\n<i>x</i>');
  assert.deepEqual(tags(b), ['pre']);
  assert.equal(textOf(b), '## not a heading\n<i>x</i>');
});

test('the shared handover template renders without loss of section headings', () => {
  const narrative = applyPatch(null, { hypothesis: 'h', next: 'n', done: ['a', 'b'] }, { at_ms: 1000 });
  const doc = mergeHandover({ card: { key: 'BDL-1', title: 't' }, narrative });
  const md = handoverMarkdown(doc, { now_ms: 5000 });
  const heads = renderMarkdown(md).filter((x) => /^h\d$/.test(x.tag)).map(textOf);
  assert.ok(heads.includes('Current hypothesis'));
  assert.ok(heads.includes('How to take over'));
});
