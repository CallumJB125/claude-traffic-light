import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { render } from '../js/h.js';
import { phoneView } from '../js/phone-render.js';

test('phone sign-in repaint keeps one link and restores retry after starting', () => {
  const dom = new JSDOM('<main id="root"></main>');
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const root = document.getElementById('root');
    const st = { view: 'signin', auth: { emailEnabled: false }, notice: null };
    render(root, phoneView(st, 0, { browserSigningIn: true }));
    assert.equal(root.querySelector('[data-action="browser-signin"]').disabled, true);
    const ui = { browserSigningIn: false, browserSignin: { code: '123456', url: 'https://hub.example/phone-connect#fixture' } };
    for (let i = 0; i < 20; i++) render(root, phoneView(st, i * 1000, ui));
    assert.equal(root.querySelectorAll('#browser-signin-status a').length, 1);
    assert.equal(root.querySelectorAll('#browser-signin-status p').length, 1);
    assert.equal(root.querySelector('[data-action="browser-signin"]').disabled, false);
    assert.equal(root.querySelector('form').hidden, true);
    render(root, phoneView(st, 21000, { browserSigningIn: false, browserSignin: { error: 'Try again.' } }));
    assert.equal(root.querySelectorAll('#browser-signin-status a').length, 0);
    assert.equal(root.querySelector('#browser-signin-status').textContent, 'Try again.');
  } finally { globalThis.document = previous; dom.window.close(); }
});
