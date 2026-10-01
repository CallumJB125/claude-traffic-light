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

module.exports = { NONE, baseOf, stripBounds, sameStrip };
