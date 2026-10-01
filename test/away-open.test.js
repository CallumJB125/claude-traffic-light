const test = require('node:test');
const assert = require('node:assert/strict');
const { openAway } = require('../src/away-open.js');

const item = { sessionId: 'a', cwd: '/w/api', folder: 'api', hostApp: 'Ghostty' };
const run = (over = {}) => {
  const jumped = [];
  const args = { item, sessions: [{ sessionId: 'a', cwd: '/w/api' }], jump: async (...a) => { jumped.push(a); return { app: 'iTerm2', exact: true }; }, isRemote: () => false, ...over };
  return openAway(args).then((r) => ({ r, jumped }));
};

test('no item: nothing opened', async () => {
  assert.deepEqual((await run({ item: null })).r, { opened: 'none' });
});

test('a live session is jumped to by the session, never by folder title', async () => {
  const { r, jumped } = await run();
  assert.deepEqual(r, { opened: 'iTerm2', folder: 'api' });
  assert.deepEqual(jumped, [[{ sessionId: 'a', cwd: '/w/api' }, 'api', 'Ghostty']]);
});

test('an ended session: nothing is jumped to or activated, and the note says so', async () => {
  const { r, jumped } = await run({ sessions: [] });
  assert.equal(r.opened, 'none-found');
  assert.match(r.note, /ended/);
  assert.equal(jumped.length, 0);
});

test('a remote session is not jumped to', async () => {
  const { r, jumped } = await run({ sessions: [{ sessionId: 'a', remote: true }], isRemote: (s) => !!s.remote });
  assert.equal(r.opened, 'none-found');
  assert.match(r.note, /another machine/);
  assert.equal(jumped.length, 0);
});

test('a session with no terminal record: the jumper\'s note and command come back, no app', async () => {
  const { r } = await run({ jump: async () => ({ app: null, exact: false, cant: 'Can\'t tell which terminal window this session is in, so nothing was switched.', command: 'tmux attach -t w' }) });
  assert.equal(r.opened, 'none-found');
  assert.match(r.note, /Can't tell which terminal/);
  assert.equal(r.command, 'tmux attach -t w');
});

test('a jump that finds nothing and says nothing is none-found without a note', async () => {
  const { r } = await run({ jump: async () => null });
  assert.deepEqual(r, { opened: 'none-found', folder: 'api' });
});
