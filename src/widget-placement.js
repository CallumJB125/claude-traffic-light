'use strict';
// Where the widget goes when it has no saved spot (first run, Reset Widget Position, a saved spot on a display
// that is gone). Pure: `screen` is Electron's screen module (or a fake with getPrimaryDisplay, getAllDisplays
// and getDisplayMatching), `main` is the visible Plexiform window's bounds, or null.
// The default is the top-right of the display the main window is on (the primary otherwise), 16 px in from the
// edges. The main window's title bar and its top-right controls live in the band along its top, so a spot that
// touches that band slides down below it; if there is no room below, the widget takes the bottom-right.
const MARGIN = 16;
const HEADER_H = 56; // title bar plus the top-right control row

const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

function defaultBounds(screen, size, main = null, { margin = MARGIN, headerH = HEADER_H } = {}) {
  const { width, height } = size;
  const display = main ? screen.getDisplayMatching(main) : screen.getPrimaryDisplay();
  const wa = display.workArea;
  const x = wa.x + wa.width - width - margin;
  let y = wa.y + margin;
  if (main) {
    const band = { x: main.x - margin, y: main.y - margin, width: main.width + 2 * margin, height: headerH + 2 * margin };
    if (overlaps({ x, y, width, height }, band)) {
      y = main.y + headerH + margin;
      if (y + height > wa.y + wa.height - margin) y = wa.y + wa.height - height - margin;
    }
  }
  return { x: Math.round(x), y: Math.round(Math.max(wa.y, y)), width, height };
}

// A saved rect that no longer shows on any display goes to the default spot, keeping its size.
function visibleOrDefault(screen, saved, main = null, margin = 20) {
  const shown = screen.getAllDisplays().some(({ workArea: wa }) => saved.x + saved.width > wa.x + margin && saved.x < wa.x + wa.width - margin && saved.y + saved.height > wa.y + margin && saved.y < wa.y + wa.height - margin);
  return shown ? saved : defaultBounds(screen, { width: saved.width, height: saved.height }, main);
}

module.exports = { MARGIN, HEADER_H, defaultBounds, visibleOrDefault };
