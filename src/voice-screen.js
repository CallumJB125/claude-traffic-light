// Screen-aware voice questions (Clicky-style): the prompt that hands the
// user's own `claude` one screenshot, the [POINT:x,y:label] tags it may answer
// with, and the mapping from screenshot pixels to global screen points.
// Pure: no Electron, no fs. src/voice-capture-main.js does the capture.

const MAX_POINTS = 3;
const MAX_LABEL = 40;
const CLAUDE_MAX_BUDGET_USD = '0.10';

const SYSTEM = 'You are Plexiform, a desk widget. The user asked a spoken question while looking at their screen. Read the screenshot file you are given, then answer in at most two short sentences of plain words for text-to-speech. When showing a place on screen helps, add up to three tags [POINT:x,y:label] after the sentences, with x and y in the screenshot\'s own pixels and a label of one to three words. Never add a tag you are not sure about.';

// The isolation of the free-form path (src/voice.js claudeArgs), with one
// difference: the Read tool, allowed for this one file only, so the CLI can
// open the screenshot. dontAsk denies anything else without a prompt.
function claudeArgs(imagePath) {
  if (!isAbsolute(imagePath)) throw new Error('screenshot path must be absolute');
  return ['-p', '--model', 'haiku', '--setting-sources', '', '--strict-mcp-config',
    '--tools', 'Read', '--allowedTools', `Read(/${imagePath})`, '--permission-mode', 'dontAsk',
    '--no-session-persistence', '--max-budget-usd', CLAUDE_MAX_BUDGET_USD, '--output-format', 'text', '--system-prompt', SYSTEM];
}
const isAbsolute = (p) => typeof p === 'string' && p.startsWith('/') && !p.includes('\0') && !/(^|\/)\.\.(\/|$)/.test(p);

function prompt({ question, imagePath, width, height, point = true, snap = null }) {
  const lines = [
    `Screenshot: ${imagePath} (${Math.round(width)} x ${Math.round(height)} pixels, the display under the mouse). Open it with the Read tool.`,
  ];
  if (!point) lines.push('Do not add any POINT tags.');
  if (snap) lines.push(`Sessions snapshot:\n${JSON.stringify(snap)}`);
  lines.push(`Question: ${String(question || '').slice(0, 500)}`);
  return lines.join('\n\n');
}

// [POINT:x,y] or [POINT:x,y:label] or Clicky's [POINT:x,y:label:screen2];
// anything else that opens with [POINT is dropped from the speech, never used.
const TAG = /\[POINT\b[^\]\n]{0,160}\]?/gi;
const GOOD = /^\[POINT:\s*(\d{1,6}(?:\.\d+)?)\s*,\s*(\d{1,6}(?:\.\d+)?)\s*(?::([^\]:[]{0,80}))?(?::\s*screen\d{1,2})?\s*\]$/i;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cleanLabel = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);

function parse(text, { width, height } = {}) {
  const raw = String(text || '');
  const points = [];
  for (const m of raw.matchAll(TAG)) {
    if (points.length >= MAX_POINTS) break;
    const g = GOOD.exec(m[0]);
    if (!g || !(width > 0) || !(height > 0)) continue;
    const x = Number(g[1]);
    const y = Number(g[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({ x: clamp(Math.round(x), 0, Math.round(width) - 1), y: clamp(Math.round(y), 0, Math.round(height) - 1), label: cleanLabel(g[3]) });
  }
  return { text: strip(raw), points };
}
function strip(text) {
  return String(text || '').replace(TAG, ' ').replace(/[ \t]+([.,!?])/g, '$1').replace(/\s+/g, ' ').trim();
}

// Screenshot pixels → global screen points (Electron DIP). The image is the
// display at native resolution, so its size over the display's bounds is the
// scale (2 on Retina); a second display adds its bounds' offset, which can be
// negative (left of or above the primary).
function toGlobal(p, display, image) {
  const b = display.bounds;
  const sx = image && image.width > 0 ? image.width / b.width : display.scaleFactor || 1;
  const sy = image && image.height > 0 ? image.height / b.height : display.scaleFactor || 1;
  return {
    x: clamp(Math.round(b.x + p.x / sx), b.x, b.x + b.width - 1),
    y: clamp(Math.round(b.y + p.y / sy), b.y, b.y + b.height - 1),
    label: p.label, displayId: display.id,
  };
}
const imageSize = (display) => ({ width: Math.round(display.size.width * (display.scaleFactor || 1)), height: Math.round(display.size.height * (display.scaleFactor || 1)) });

module.exports = { claudeArgs, prompt, parse, strip, toGlobal, imageSize, MAX_POINTS, MAX_LABEL, SYSTEM, CLAUDE_MAX_BUDGET_USD };
