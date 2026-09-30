// Linux sound and speech. There is no afplay or say, and which players are
// installed varies, so each is a list tried in order: the next one runs when
// the last is missing (ENOENT). Sounds play through PulseAudio/PipeWire
// (paplay), then ALSA (aplay). Speech uses speech-dispatcher, then eSpeak NG,
// then eSpeak. Text goes in on stdin, never argv, so a reply that starts with
// '-' is never read as an option. macOS's named sounds (Glass, Ping…) have no
// Linux files; they play the freedesktop "complete" sound, or beep.
const { spawn } = require('child_process');

const PLAYERS = [['paplay', []], ['aplay', ['-q']]];
const SPEAKERS = [['spd-say', ['-w', '-e']], ['espeak-ng', ['--stdin']], ['espeak', ['--stdin']]];
const THEME_SOUND = '/usr/share/sounds/freedesktop/stereo/complete.oga';

// Runs the first command that exists. Returns { kill } for whichever is
// running; done(ok) once it ends (ok false when none could start).
function firstAvailable(chain, args, { input = null, spawnImpl = spawn, done = () => {} } = {}) {
  let child = null;
  let i = 0;
  const next = () => {
    if (i >= chain.length) { done(false); return; }
    const [file, pre] = chain[i++];
    child = spawnImpl(file, [...pre, ...args], { stdio: [input == null ? 'ignore' : 'pipe', 'ignore', 'ignore'] });
    let failed = false;
    child.on('error', (err) => { failed = true; if (err.code === 'ENOENT') next(); else done(false); });
    child.on('exit', (code) => { if (!failed) done(code === 0); });
    if (input != null && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  };
  next();
  return { kill: () => { try { child && child.kill(); } catch { /* gone */ } } };
}

// file: a path, or null for a named macOS sound. onMissing: no player at all.
function play(file, { exists, onMissing, spawnImpl } = {}) {
  const target = file || (exists(THEME_SOUND) ? THEME_SOUND : null);
  if (!target || !exists(target)) { onMissing(); return null; }
  return firstAvailable(PLAYERS, [target], { spawnImpl, done: (ok) => { if (!ok) onMissing(); } });
}

function speak(text, done, { spawnImpl } = {}) {
  return firstAvailable(SPEAKERS, [], { input: String(text), spawnImpl, done: () => done() });
}

module.exports = { play, speak, firstAvailable, PLAYERS, SPEAKERS, THEME_SOUND };
