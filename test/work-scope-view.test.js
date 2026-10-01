// Work-scope badges and the tray toggle (src/work-scope-view.js, contract §C2).
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../src/work-scope-view.js');

test('no scope, an unknown one, or "outside": nothing at all', () => {
  for (const s of [null, undefined, {}, { state: 'weird' }, { state: 'outside', board: null, repo: null }]) assert.equal(W.scopeView(s), null);
});

test('watching is muted and never says counting; counting names the board; personal offers Undo', () => {
  const watching = W.scopeView({ state: 'watching', board: { id: 'b1', name: 'Platform' }, repo: { short: 'acme/api', canonicalUrl: 'https://github.com/acme/api' } });
  assert.deepEqual(watching, { state: 'watching', label: 'watching locally', tone: 'muted', markPersonal: true, undo: false, repoUrl: 'https://github.com/acme/api' });
  assert.doesNotMatch(watching.label, /counting/);
  assert.equal(W.scopeView({ state: 'counting', board: { id: 'b1', name: ' Platform ' }, repo: { short: 'acme/api' } }).label, 'counting for Platform');
  assert.equal(W.scopeView({ state: 'counting', board: null, repo: null }).label, 'counting for your team');
  assert.equal(W.scopeView({ state: 'counting', board: null, repo: null }).repoUrl, null, 'no canonical URL: no repo-wide option');
  assert.equal(W.scopeView({ state: 'counting', board: null, repo: { canonicalUrl: 'x'.repeat(301) } }).repoUrl, null);
  assert.deepEqual(W.scopeView({ state: 'personal', board: null, repo: null }), { state: 'personal', label: 'personal', tone: 'personal', markPersonal: false, undo: true, repoUrl: null });
});

test('tray: the most recently active scoped session; disabled with none; hidden without scopes', () => {
  const s = (id, at, scope, cwd = `/w/${id}`) => ({ sessionId: id, updatedAt: at, cwd, scope });
  const counting = { state: 'counting', board: { name: 'P' }, repo: null };
  assert.equal(W.trayItem([s('a', '2026-10-01T10:00:00Z', counting)], { available: false }), null, 'no work-scope module');
  assert.deepEqual(W.trayItem([]), { label: W.TRAY_LABEL, enabled: false, checked: false, sessionId: null });
  assert.equal(W.trayItem([s('a', '2026-10-01T10:00:00Z', null)]), null, 'scope null everywhere: hidden');
  const item = W.trayItem([s('old', '2026-10-01T09:00:00Z', counting), s('new', '2026-10-01T10:00:00Z', { state: 'personal' }, '/w/my-app'), s('remote', '2026-10-01T11:00:00Z', counting)].map((x, i) => (i === 2 ? { ...x, remote: true } : x)));
  assert.deepEqual(item, { label: `${W.TRAY_LABEL} (my-app)`, enabled: true, checked: true, sessionId: 'new' });
});

test('scopes by session id, for the rows', () => {
  assert.deepEqual(W.scopesBySession([{ sessionId: 'a', scope: { state: 'counting' } }, { sessionId: 'b', scope: null }, null]), { a: { state: 'counting' } });
});
