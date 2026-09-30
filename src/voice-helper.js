// Runs the on-device speech helper (native/voice/buddy-listen) for one
// push-to-talk question at a time. `spawn` is injected so tests drive a fake
// helper and never reach the microphone or a permission prompt.
//
// The helper keeps audio in memory only; this side only ever sees text.
const readline = require('readline');

const FRIENDLY = {
  'speech-denied': 'Speech recognition is off for Claude Buddy. Turn it on in System Settings, Privacy and Security, Speech Recognition.',
  'mic-denied': 'The microphone is off for Claude Buddy. Turn it on in System Settings, Privacy and Security, Microphone.',
  'hold-unsupported': "Buddy can't tell when that key is let go. Pick another key in Preferences, or press and hold the widget instead.",
};
const friendly = (e) => FRIENDLY[e] || String(e || 'Listening failed.');

// A stopped helper that hasn't exited by then (a permission prompt left open)
// is killed, so a question can never hold the mic or the widget state.
const STOP_GRACE_MS = 20000;

function createListener({ spawn, helperPath, exists, platform = process.platform, onState, onFinal, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let child = null;
  let killTimer = null;

  const available = () => platform === 'darwin' && !!helperPath && exists(helperPath);
  const unavailableReason = () => (platform !== 'darwin' ? 'Voice questions are macOS only for now.' : 'The voice helper is not built into this copy of Claude Buddy.');

  // holdKey: the macOS keycode being held (hotkey), or null when the caller
  // says when to stop (a long-press on the widget ends on mouseup).
  function start({ holdKey = null, maxMs = 15000 } = {}) {
    if (child) return { ok: false, reason: 'already listening' };
    if (!available()) return { ok: false, reason: unavailableReason() };
    const args = ['listen', '--max-ms', String(maxMs)];
    if (holdKey != null) args.push('--hold-key', String(holdKey));
    let c;
    try { c = spawn(helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (err) { return { ok: false, reason: err.message }; }
    child = c;
    let done = false;
    const finish = (fn) => { if (done) return; done = true; fn(); };
    // No mic badge yet: the helper says "ready" the moment the mic opens.
    onState({ state: 'starting' });
    readline.createInterface({ input: c.stdout }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (done) return;
      if (m.event === 'authorizing') onState({ state: 'authorizing' });
      else if (m.event === 'ready') onState({ state: 'listening' });
      else if (m.event === 'partial') onState({ state: 'listening', partial: String(m.text || '') });
      else if (m.event === 'cancelled') finish(() => onState({ state: 'idle' }));
      else if (m.event === 'final') finish(() => { log(`[voice] transcript ready ${Number(m.ms) || 0} ms after release`); onFinal(String(m.text || '')); });
      else if (m.event === 'error') finish(() => { log(`[voice] helper: ${m.error}`); onState({ state: 'error', error: friendly(m.error) }); });
    });
    if (c.stderr) c.stderr.resume();
    const gone = () => { if (child === c) { child = null; clearTimer(killTimer); killTimer = null; } };
    c.on('error', (err) => { gone(); finish(() => onState({ state: 'error', error: `Voice helper failed: ${err.message}` })); });
    // 'close' (not 'exit'): every stdout line has been read by then.
    c.on('close', () => { gone(); finish(() => onState({ state: 'idle' })); });
    return { ok: true };
  }

  function stop() {
    if (!child) return false;
    try { child.stdin.write('stop\n'); child.stdin.end(); } catch { /* already exiting */ }
    const c = child;
    if (!killTimer) killTimer = setTimer(() => { killTimer = null; if (child === c) cancel(); }, STOP_GRACE_MS);
    return true;
  }

  function cancel() {
    if (!child) return;
    try { child.kill(); } catch { /* gone */ }
  }

  return {
    start, stop, cancel, available, unavailableReason,
    get listening() { return !!child; },
  };
}

// ── One question at a time ─────────────────────────────────────────────────
// Every question gets a number; a new one (or a new press) stops the answer
// being spoken, cancels a free-form question still out with claude, and any
// reply that comes back for an older number is dropped.
function createFlow({ reply, speak, send, speakable = (t) => t }) {
  let seq = 0;
  let speaking = null;
  let cancels = [];

  function interrupt() {
    seq += 1;
    for (const fn of cancels) { try { fn(); } catch { /* already gone */ } }
    cancels = [];
    if (speaking) { const s = speaking; speaking = null; try { s.kill(); } catch { /* done */ } }
  }

  async function question(heard) {
    interrupt();
    const mine = seq;
    send({ state: 'thinking', heard });
    let text;
    try { text = await reply(heard, (fn) => { if (mine === seq) cancels.push(fn); else fn(); }); } catch { text = 'Sorry, I could not work that out.'; }
    if (mine !== seq) return false;
    cancels = [];
    text = speakable(text) || "I don't have an answer for that.";
    send({ state: 'talking', heard, text });
    const child = speak(text, () => {
      if (speaking !== child) return;
      speaking = null;
      send({ state: 'idle' });
    });
    speaking = child;
    return true;
  }

  return { question, interrupt, get seq() { return seq; } };
}

// ── Free-form: the user's own `claude`, isolated ─────────────────────────────
// A fresh empty folder as cwd (removed afterwards) so no project CLAUDE.md or
// memory applies, an allowlisted env, the question on stdin, never in argv.
function askClaude({ spawn, fs, tmpdir, args, env, prompt, timeoutMs = 30000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let child = null;
  let dir = null;
  let settled = false;
  let resolveFn;
  const promise = new Promise((r) => { resolveFn = r; });
  const done = (value) => {
    if (settled) return;
    settled = true;
    clearTimer(timer);
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    resolveFn(value);
  };
  const cancel = () => { if (child) { try { child.kill('SIGKILL'); } catch { /* gone */ } } done(null); };
  const timer = setTimer(cancel, timeoutMs);
  try {
    dir = fs.mkdtempSync(`${tmpdir.replace(/\/$/, '')}/buddy-ask-`);
    child = spawn('claude', args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'ignore'] }); // privacy-flow: voice-ask
  } catch { done(null); return { promise, cancel }; }
  let out = '';
  child.stdout.on('data', (d) => { if (out.length < 256 * 1024) out += d; });
  child.on('error', () => done(null));
  child.on('close', (code) => done(code === 0 ? String(out).trim().slice(0, 400) || null : null));
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  return { promise, cancel };
}

module.exports = { createListener, createFlow, askClaude, friendly, STOP_GRACE_MS };
