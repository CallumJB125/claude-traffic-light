// Screen-aware voice (Clicky-style), main side. Only with voice.screen on and
// only for the question being held: capture the display under the mouse,
// write it to a private temp file, let the user's own `claude` read that one
// file (src/voice-screen.js claudeArgs), and delete it whatever happens.
// Every Electron and fs dependency is injected so tests use fakes.
const VoiceScreen = require('./voice-screen.js');

const PERMISSION_TEXT = 'To use the screen, turn on Screen Recording for Plexiform in System Settings, Privacy and Security, Screen Recording. Answering without it.';
const ASK_TIMEOUT_MS = 60000;

function create({ platform = process.platform, systemPreferences, desktopCapturer, screen, fs, path, tmpdir, randomHex, askClaude, spawn, env, carry = null, log = () => {} }) {
  function permission() {
    if (platform !== 'darwin') return 'granted';
    try { return systemPreferences.getMediaAccessStatus('screen'); } catch { return 'unknown'; }
  }

  // → { ok:true, png, display, image } | { ok:false, reason: 'permission'|'error' }
  async function capture() {
    const status = permission();
    if (status !== 'granted') {
      // Not asked yet: one capture call makes macOS show its prompt; the
      // question itself still goes without the screen.
      if (status === 'not-determined') { try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); } catch { /* prompt only */ } }
      return { ok: false, reason: 'permission' };
    }
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const want = VoiceScreen.imageSize(display);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: want }); // privacy-flow: voice-screen
      const src = sources.find((s) => String(s.display_id) === String(display.id)) || (sources.length === 1 ? sources[0] : null);
      if (!src || !src.thumbnail || src.thumbnail.isEmpty()) return { ok: false, reason: 'error' };
      return { ok: true, png: src.thumbnail.toPNG(), display, image: src.thumbnail.getSize() };
    } catch (err) {
      log(`[voice] screen capture failed: ${err.message}`);
      return { ok: false, reason: 'error' };
    }
  }

  // One question with the screen. onCancel is the flow's hook: a new press
  // cancels the claude run, which resolves, and the finally removes the file.
  // → { text, points (global), permission:false } | null (no answer)
  async function ask({ question, snap = null, point = true, onCancel = () => {} }) {
    const shot = await capture();
    if (!shot.ok) return { text: null, points: [], permission: shot.reason === 'permission' };
    let dir = null;
    try {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir, `plexiform-voice-${randomHex()}-`)));
      fs.chmodSync(dir, 0o700);
      const file = path.join(dir, 'screen.png');
      fs.writeFileSync(file, shot.png, { mode: 0o600 }); // privacy-flow: voice-screen
      const run = askClaude({
        spawn, fs, tmpdir, env, carry, timeoutMs: ASK_TIMEOUT_MS, maxChars: 800,
        args: VoiceScreen.claudeArgs(file),
        prompt: VoiceScreen.prompt({ question, imagePath: file, width: shot.image.width, height: shot.image.height, point, snap }),
      });
      onCancel(run.cancel);
      const said = await run.promise;
      if (!said) return { text: null, points: [], permission: false };
      const parsed = VoiceScreen.parse(said, shot.image);
      return { text: parsed.text, points: point ? parsed.points.map((p) => VoiceScreen.toGlobal(p, shot.display, shot.image)) : [], permission: false };
    } catch (err) {
      log(`[voice] screen question failed: ${err.message}`);
      return { text: null, points: [], permission: false };
    } finally {
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }

  return { ask, capture, permission };
}

module.exports = { create, PERMISSION_TEXT, ASK_TIMEOUT_MS };
