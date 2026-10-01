// The widget's size while something hangs under Claude (the waiting-input
// bubble or the "while you were away" recap). The widget's own rect is the
// base; a strip adds height, and for the bubble enough width to read it,
// split evenly so Claude stays put. The grown rect is kept on screen by
// moving it up or left, never by shrinking it. Pure: main applies the result.
'use strict';

const NONE = Object.freeze({ kind: null, px: 0, w: 0, dx: 0, dy: 0 });

// The widget's own rect, given its current rect and the strip applied to it.
function baseOf(current, strip = NONE) {
  return { x: current.x + strip.dx, y: current.y + strip.dy, width: current.width - strip.w, height: current.height - strip.px };
}

// next: { kind: 'bubble'|'away'|null, px, minWidth }. → { bounds, strip }
function stripBounds(current, strip = NONE, next = {}, workArea = null) {
  const base = baseOf(current, strip);
  const px = next.kind ? Math.max(0, Math.round(next.px || 0)) : 0;
  if (!px) return { bounds: base, strip: NONE };
  const extra = next.minWidth ? Math.max(0, Math.round(next.minWidth) - base.width) : 0;
  const b = { x: base.x - Math.round(extra / 2), y: base.y, width: base.width + extra, height: base.height + px };
  if (workArea) {
    const right = workArea.x + workArea.width;
    const bottom = workArea.y + workArea.height;
    if (b.x + b.width > right) b.x = right - b.width;
    if (b.x < workArea.x) b.x = workArea.x;
    if (b.y + b.height > bottom) b.y = bottom - b.height;
    if (b.y < workArea.y) b.y = workArea.y;
  }
  return { bounds: b, strip: { kind: next.kind, px, minWidth: next.minWidth || 0, w: extra, dx: base.x - b.x, dy: base.y - b.y } };
}

// Whether `next` asks for something other than what is applied.
const sameStrip = (strip, next) => (strip.kind || null) === (next.kind || null) && strip.px === (next.kind ? Math.round(next.px || 0) : 0) && (strip.minWidth || 0) === (next.minWidth || 0);

// Whether roam, glide, the garden and resizing must wait. The bubble and the
// recap change the window's width or hang a lot under Claude, so moving or
// resizing the grown rect would carry them along wrongly; the quiet update
// row (no extra width, no offset of its own) can ride along.
const blocksTravel = (strip) => !!strip && (strip.kind === 'bubble' || strip.kind === 'away');

// Resize the widget's own rect by `factor` about its centre, keeping its
// shape and limits, then hang the same strip under it again.
// limits: { minWidth, maxWidth, aspect }. → { bounds, strip }
function resizeBase(current, strip = NONE, factor, limits, workArea = null) {
  const base = baseOf(current, strip);
  const width = Math.round(Math.min(limits.maxWidth, Math.max(limits.minWidth, base.width * factor)));
  const height = Math.round(width / limits.aspect);
  const next = { x: Math.round(base.x + base.width / 2 - width / 2), y: Math.round(base.y + base.height / 2 - height / 2), width, height };
  if (!strip.kind) return { bounds: next, strip: NONE };
  return stripBounds(next, NONE, { kind: strip.kind, px: strip.px, minWidth: strip.minWidth }, workArea);
}

module.exports = { NONE, baseOf, stripBounds, sameStrip, blocksTravel, resizeBase };
