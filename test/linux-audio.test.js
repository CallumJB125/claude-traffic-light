const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const LinuxAudio = require('../src/linux-audio.js');

// A fake spawn: `present` lists the commands that exist.
function fakeSpawn(present, log) {
  return (file, args, opts) => {
    const c = new EventEmitter();
    c.kill = () => log.push(['kill', file]);
    const input = [];
    c.stdin = opts.stdio[0] === 'pipe' ? { on() {}, end: (t) => input.push(t) } : null;
    log.push([file, ...args]);
    setImmediate(() => {
      if (!present.includes(file)) c.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      else { log.push(['stdin', file, input.join('')]); c.emit('exit', 0); }
    });
    return c;
  };
}

test('linux audio: speech falls through to the first installed speaker, text on stdin only', async () => {
  const log = [];
  await new Promise((resolve) => LinuxAudio.speak('-rf is a word', resolve, { spawnImpl: fakeSpawn(['espeak'], log) }));
  assert.deepEqual(log.filter((l) => l[0] !== 'stdin'), [['spd-say', '-w', '-e'], ['espeak-ng', '--stdin'], ['espeak', '--stdin']]);
  assert.deepEqual(log.find((l) => l[0] === 'stdin'), ['stdin', 'espeak', '-rf is a word']);
});

test('linux audio: a sound file plays through paplay, then aplay; nothing installed beeps', async () => {
  const log = [];
  const exists = () => true;
  await new Promise((resolve) => { LinuxAudio.play('/s/a.wav', { exists, onMissing: () => {}, spawnImpl: fakeSpawn(['aplay'], log) }); setTimeout(resolve, 20); });
  assert.deepEqual(log.filter((l) => l[0] !== 'stdin'), [['paplay', '/s/a.wav'], ['aplay', '-q', '/s/a.wav']]);
  let beeped = 0;
  await new Promise((resolve) => { LinuxAudio.play('/s/a.wav', { exists, onMissing: () => { beeped += 1; resolve(); }, spawnImpl: fakeSpawn([], []) }); });
  assert.equal(beeped, 1);
});

test('linux audio: a macOS sound name plays the freedesktop sound, or beeps without one', () => {
  const log = [];
  LinuxAudio.play(null, { exists: (f) => f === LinuxAudio.THEME_SOUND, onMissing: () => {}, spawnImpl: fakeSpawn(['paplay'], log) });
  assert.deepEqual(log[0], ['paplay', LinuxAudio.THEME_SOUND]);
  let beeped = false;
  assert.equal(LinuxAudio.play(null, { exists: () => false, onMissing: () => { beeped = true; } }), null);
  assert.equal(beeped, true);
});
