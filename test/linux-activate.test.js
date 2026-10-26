const test = require('node:test');
const assert = require('node:assert/strict');
const LinuxActivate = require('../src/linux-activate.js');

test('linux activate: the folder name first, then terminal names, via wmctrl -a', async () => {
  const calls = [];
  const exec = async (f, a) => { calls.push([f, ...a]); return a[1] === 'Konsole'; };
  assert.deepEqual(await LinuxActivate.activate('proj', exec), { app: 'Konsole', exact: false });
  assert.deepEqual(calls.slice(0, 3), [['wmctrl', '-a', 'proj'], ['wmctrl', '-a', 'Terminal'], ['wmctrl', '-a', 'Konsole']]);
  assert.deepEqual(await LinuxActivate.activate('proj', async (f, a) => a[1] === 'proj'), { app: 'proj', exact: true });
});

test('linux activate: no wmctrl says so; no match says so; neither raises anything', async () => {
  let n = 0;
  const r = await LinuxActivate.activate('proj', async () => { n += 1; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
  assert.match(r.cant, /wmctrl isn't installed/);
  assert.equal(n, 1, 'stops at the first ENOENT');
  assert.match((await LinuxActivate.activate('', async () => false)).cant, /couldn.t find which terminal window/i);
});

const TMUX_SESSION = { terminal: { env: { TMUX: '/tmp/tmux-1000/default,99,0', TMUX_PANE: '%1' } } };
function fakeRun(over = {}) {
  const calls = [];
  const run = async (f, a) => {
    calls.push([f, ...a]);
    if (over[f]) return over[f](a);
    return { ok: false, stdout: '' };
  };
  return { run, calls };
}
const tmuxOut = (clients) => ({
  tmux: (a) => (a.includes('display-message') ? { ok: true, stdout: '$3\n' } : { ok: true, stdout: clients }),
});

test('linux activate: the tmux client\'s terminal is raised by pid, through its parents, before any title', async () => {
  const execs = [];
  const { run, calls } = fakeRun({
    ...tmuxOut('500\t$3\n600\t$9\n'),
    ps: (a) => ({ ok: true, stdout: { 500: '400', 400: '300', 300: '1' }[a[3]] + '\n' }),
    wmctrl: () => ({ ok: true, stdout: '0x01 0 111 host other\n0x02 0 300 host the task summary\n' }),
  });
  const r = await LinuxActivate.activate('proj', async (f, a) => { execs.push([f, ...a]); return true; }, TMUX_SESSION, run);
  assert.deepEqual(r, { app: 'terminal', exact: true });
  assert.deepEqual(execs, [['wmctrl', '-i', '-a', '0x02']]);
  assert.ok(calls.some((c) => c[0] === 'tmux' && c.includes('list-clients')));
});

test('linux activate: two tmux clients on the session, or no window for the pid, falls to the title', async () => {
  const two = fakeRun({ ...tmuxOut('500\t$3\n501\t$3\n'), wmctrl: () => ({ ok: true, stdout: '' }) });
  assert.deepEqual(await LinuxActivate.activate('proj', async (f, a) => a[1] === 'proj', TMUX_SESSION, two.run), { app: 'proj', exact: true });
  assert.ok(!two.calls.some((c) => c[0] === 'wmctrl'), 'no pid lookup with two clients');
  const none = fakeRun({ ...tmuxOut('500\t$3\n'), ps: () => ({ ok: true, stdout: '1\n' }), wmctrl: () => ({ ok: true, stdout: '0x01 0 111 host other\n' }) });
  assert.deepEqual(await LinuxActivate.activate('proj', async (f, a) => a[1] === 'Konsole', TMUX_SESSION, none.run), { app: 'Konsole', exact: false });
});

test('linux activate: a tmux session with no wmctrl is told so, not given null', async () => {
  const { run } = fakeRun({ ...tmuxOut('500\t$3\n') });
  const r = await LinuxActivate.activate('proj', async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, TMUX_SESSION, run);
  assert.match(r.cant, /wmctrl isn't installed/);
});
