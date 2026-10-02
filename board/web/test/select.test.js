import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { h, render } from '../js/h.js';

test('empty options submit empty values; controlled selects choose options after insertion and replacement', () => {
  const dom = new JSDOM('<main></main>');
  const before = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const root = document.querySelector('main');
    render(root, h('select', { name: 'repo' }, h('option', { value: '' }, 'No repo (a human task)'), h('option', { value: 'r' }, 'Repo')));
    assert.equal(root.firstChild.value, '');
    assert.equal(root.querySelector('option').getAttribute('value'), '');
    const choices = (value) => h('select', { value }, h('option', { key: 'a', value: 'a' }, 'First'), h('option', { key: value, value }, 'Selected'));
    render(root, choices('b'));
    assert.equal(root.firstChild.value, 'b');
    render(root, choices('c'));
    assert.equal(root.firstChild.value, 'c');
  } finally {
    globalThis.document = before;
    dom.window.close();
  }
});
