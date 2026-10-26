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

const TMUX_SESSION = { hostApp: 'GNOME Terminal', terminal: { env: { TMUX: '/tmp/tmux-1000/default,99,0', TMUX_PANE: '%1' } } };
const X11 = { env: { DISPLAY: ':0' }, hostname: 'box', tmuxBin: '/usr/bin/tmux' };
// ps -e -o pid=,ppid=,comm= : right-aligned numbers, as procps prints them.
const PS = '    1     0 systemd\n  300     1 gnome-terminal-\n  400   300 bash\n  500   400 tmux: client\n  600   500 sudo\n  200     1 plasmashell\n';
const WM = [
  '0x01200003  -1 200  box Desktop — Plasma',
  '0x03a00004  0 300  box  first   window',
  '0x03a00099  0 300  box second\twindow\twith tabs',
  '0x0500000a  0 400  box   shell',
  '0x05000001  1 300  otherhost forwarded',
  '0x05000002  1 300  N/A no host',
].join('\n');
function fakeRun({ clients = '500\t$3\n600\t$9\n', ps = PS, wm = WM, wmOk = true } = {}) {
  const calls = [];
  const run = async (f, a) => {
    calls.push([f, ...a]);
    if (f === '/usr/bin/tmux') return a.includes('display-message') ? { ok: true, stdout: '$3\n' } : { ok: true, stdout: clients };
    if (f === 'ps') return { ok: true, stdout: ps };
    if (f === 'wmctrl') return { ok: wmOk, stdout: wm };
    return { ok: false, stdout: '' };
  };
  return { run, calls };
}
const recorder = (answer = true) => { const execs = []; return { execs, exec: async (f, a) => { execs.push([f, ...a]); return answer; } }; };
const only = (id) => WM.split('\n').filter((l) => l.startsWith(id)).join('\n');

test('linux activate: the tmux client\'s terminal, found through its shell, is raised alone and not claimed exact', async () => {
  const rec = recorder();
  const one = fakeRun({ wm: WM.replace(/^0x03a00004.*$/m, '0x03a00004  0 999  box  elsewhere') });
  assert.deepEqual(await LinuxActivate.activate('proj', rec.exec, TMUX_SESSION, one.run, X11), { app: 'GNOME Terminal', exact: false });
  assert.deepEqual(rec.execs, [['wmctrl', '-i', '-a', '0x03a00099']]);
  assert.equal(one.calls.filter((c) => c[0] === 'ps').length, 1, 'one process-table snapshot');
  assert.deepEqual(one.calls[0].slice(0, 3), ['/usr/bin/tmux', '-S', '/tmp/tmux-1000/default']);
});

test('linux activate: several windows on the terminal\'s pid raise nothing and say so', async () => {
  const rec = recorder();
  const r = await LinuxActivate.activate('proj', rec.exec, TMUX_SESSION, fakeRun().run, X11);
  assert.match(r.cant, /several windows/);
  assert.deepEqual(rec.execs, []);
});

test('linux activate: a terminal with no visible window never climbs to what launched it', async () => {
  const rec = recorder();
  const wm = `${only('0x01200003')}\n${only('0x0500000a')}`; // plasmashell's window (200) and the shell's (400): neither is the terminal (300)
  const ps = PS.replace('  300     1 gnome-terminal-', '  300   200 gnome-terminal-');
  const r = await LinuxActivate.activate('proj', rec.exec, TMUX_SESSION, fakeRun({ wm, ps }).run, X11);
  assert.match(r.cant, /no window/);
  assert.deepEqual(rec.execs, []);
});

test('linux activate: windows from another host, or with no host, are never raised', async () => {
  const rec = recorder();
  const wm = `${only('0x05000001')}\n${only('0x05000002')}`;
  assert.match((await LinuxActivate.activate('proj', rec.exec, TMUX_SESSION, fakeRun({ wm }).run, X11)).cant, /no window/);
  assert.deepEqual(rec.execs, []);
  const fq = fakeRun({ wm: '0x0300000a  0 300  box.lan  mine' });
  assert.deepEqual(await LinuxActivate.activate('p', recorder().exec, TMUX_SESSION, fq.run, { ...X11, hostname: 'box.lan' }), { app: 'GNOME Terminal', exact: false });
});

test('linux activate: a nested tmux or an ssh client stops with a reason; two tmux clients too', async () => {
  const nested = PS.replace('  400   300 bash', '  400   250 bash').replace('  200     1 plasmashell', '  250     1 sshd');
  assert.match((await LinuxActivate.activate('p', recorder().exec, TMUX_SESSION, fakeRun({ ps: nested }).run, X11)).cant, /another tmux or over ssh/);
  assert.match((await LinuxActivate.activate('p', recorder().exec, TMUX_SESSION, fakeRun({ clients: '500\t$3\n501\t$3\n' }).run, X11)).cant, /which terminal shows/);
});

test('linux activate: a superseded click never raises', async () => {
  const rec = recorder();
  let live = true;
  const base = fakeRun({ wm: WM.replace(/^0x03a00004.*$/m, '0x03a00004  0 999  box  elsewhere') });
  const run = async (f, a) => { const r = await base.run(f, a); if (f === 'wmctrl') live = false; return r; };
  assert.equal(await LinuxActivate.activate('p', rec.exec, TMUX_SESSION, run, { ...X11, isCancelled: () => !live }), null);
  assert.deepEqual(rec.execs, []);
});

test('linux activate: a lookup past its time budget raises nothing', async () => {
  let t = 0;
  const rec = recorder();
  const run = async (f, a) => { t += 3000; return fakeRun().run(f, a); };
  const r = await LinuxActivate.activate('p', rec.exec, TMUX_SESSION, run, { ...X11, now: () => t });
  assert.match(r.cant, /took too long/);
  assert.deepEqual(rec.execs, []);
});

test('linux activate: a tmux session with no wmctrl is told so; without the vetted tmux nothing runs', async () => {
  const base = fakeRun();
  const run = async (f, a) => (f === 'wmctrl' ? { ok: false, stdout: '', missing: true } : base.run(f, a));
  assert.match((await LinuxActivate.activate('p', recorder().exec, TMUX_SESSION, run, X11)).cant, /wmctrl isn't installed/);
  const none = fakeRun();
  assert.match((await LinuxActivate.activate('p', recorder().exec, TMUX_SESSION, none.run, { ...X11, tmuxBin: null })).cant, /which terminal shows/);
  assert.equal(none.calls.length, 0);
});

test('linux activate: Wayland without an X display says so before any command runs', async () => {
  let ran = 0;
  const r = await LinuxActivate.activate('proj', async () => { ran += 1; return true; }, null, null, { env: { WAYLAND_DISPLAY: 'wayland-0' } });
  assert.match(r.cant, /Wayland/);
  assert.equal(ran, 0);
  assert.deepEqual(await LinuxActivate.activate('proj', async () => true, null, null, { env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' } }), { app: 'proj', exact: true });
});
