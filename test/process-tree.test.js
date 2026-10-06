const test = require('node:test');
const assert = require('node:assert/strict');
const ProcessTree = require('../hooks/process-tree.js');

test('process tree: macOS asks /bin/ps exactly as before', () => {
  const calls = [];
  const parentOf = ProcessTree.parentLookup({ platform: 'darwin', run: (f, a, t) => { calls.push([f, a, t]); return '  812 /bin/zsh\n'; } });
  assert.deepEqual(parentOf(900, 1500), { ppid: 812, comm: '/bin/zsh' });
  assert.deepEqual(calls, [['/bin/ps', ['-o', 'ppid=,comm=', '-p', '900'], 1500]]);
});

test('process tree: Linux reads /proc/<pid>/stat and never runs a command', () => {
  const parentOf = ProcessTree.parentLookup({
    platform: 'linux',
    run: () => { throw new Error('no subprocess on Linux'); },
    readFile: (f) => ({ '/proc/900/stat': '900 (bash) S 812 900 900 34816 900 4194560', '/proc/812/stat': '812 (my (odd) name) S 1 812' })[f] ?? (() => { throw new Error('ENOENT'); })(),
  });
  assert.deepEqual(parentOf(900), { ppid: 812, comm: 'bash' });
  assert.deepEqual(parentOf(812), { ppid: 1, comm: 'my (odd) name' });
  assert.equal(parentOf(5), null);
});

test('process tree: Windows takes one snapshot for the whole walk', () => {
  let runs = 0;
  const parentOf = ProcessTree.parentLookup({
    platform: 'win32',
    run: (f, a) => {
      if (f === 'wmic') throw new Error('wmic is not recognized');
      runs += 1;
      assert.equal(f, 'powershell');
      assert.equal(a[a.length - 1], ProcessTree.WIN_SNAPSHOT);
      return '4 0 System\r\n7000 6000 claude.exe\r\n7100 7000 bash.exe\r\n7200 7100 cmd.exe\r\n7300 7200 Plexiform Beta.exe\r\n';
    },
  });
  assert.deepEqual(parentOf(7200), { ppid: 7100, comm: 'cmd.exe' });
  assert.deepEqual(parentOf(7100), { ppid: 7000, comm: 'bash.exe' });
  assert.deepEqual(parentOf(7300), { ppid: 7200, comm: 'Plexiform Beta.exe' });
  assert.equal(parentOf(1), null);
  assert.equal(runs, 1);
});

test('process tree: Windows asks wmic about one pid at a time and never starts PowerShell', () => {
  const calls = [];
  const table = { 7200: 'Node,Name,ParentProcessId\r\nPC,cmd.exe,7100\r\n\r\n', 7100: 'Node,Name,ParentProcessId\r\nPC,bash.exe,7000\r\n' };
  const parentOf = ProcessTree.parentLookup({ platform: 'win32', run: (f, a) => { calls.push(f); return table[Number(/ProcessId=(\d+)/.exec(a.join(' '))[1])]; } });
  assert.deepEqual(parentOf(7200), { ppid: 7100, comm: 'cmd.exe' });
  assert.deepEqual(parentOf(7100), { ppid: 7000, comm: 'bash.exe' });
  assert.deepEqual(calls, ['wmic', 'wmic']);
});

test('process tree: wmic missing falls back to one PowerShell snapshot, and wmic is not retried', () => {
  const calls = [];
  const parentOf = ProcessTree.parentLookup({ platform: 'win32', run: (f) => { calls.push(f); if (f === 'wmic') throw new Error('ENOENT'); return '7200 7100 cmd.exe\r\n7100 7000 bash.exe\r\n'; } });
  assert.deepEqual(parentOf(7200), { ppid: 7100, comm: 'cmd.exe' });
  assert.deepEqual(parentOf(7100), { ppid: 7000, comm: 'bash.exe' });
  assert.deepEqual(calls, ['wmic', 'powershell']);
});

test('process tree: parseWmic rejects junk', () => {
  assert.equal(ProcessTree.parseWmic(''), null);
  assert.equal(ProcessTree.parseWmic('No Instance(s) Available.'), null);
  assert.equal(ProcessTree.parseWmic('Node,Name,ParentProcessId\r\nPC,cmd.exe,abc'), null);
});
