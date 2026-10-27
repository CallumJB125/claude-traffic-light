'use strict';
// Where the widget goes when it has no saved spot (first run, Reset Widget Position, a saved spot on a display
// that is gone). Pure: `screen` is Electron's screen module (or a fake with getPrimaryDisplay, getAllDisplays
// and getDisplayMatching), `main` is the visible Plexiform window's bounds, or null.
// The default is the top-right of the display the main window is on (the primary otherwise), 16 px in from the
// edges. With no main window yet (first run creates the widget first), it is placed against the main window's
// predicted default rect, so the spot it saves is already clear of where that window will open. The main window's title bar and its top-right controls live in the band along its top, so a spot that
// touches that band slides down below it; if there is no room below, the widget takes the bottom-right.
const MARGIN = 16;
const HEADER_H = 56; // title bar plus the top-right control row
// The main window's default size (buddy-window/index.js opens it at this size, centred).
const MAIN_WINDOW = Object.freeze({ width: 1320, height: 860 });

const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

// Where a new main window opens: its default size centred on the primary work area, clamped to it.
function predictedMain(screen, size = MAIN_WINDOW) {
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(size.width, wa.width);
  const height = Math.min(size.height, wa.height);
  return { x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2), width, height };
}

function defaultBounds(screen, size, main = null, { margin = MARGIN, headerH = HEADER_H } = {}) {
  const { width, height } = size;
  // A predicted main window is on the primary display by construction.
  const display = main ? screen.getDisplayMatching(main) : screen.getPrimaryDisplay();
  if (!main) main = predictedMain(screen);
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

module.exports = { MARGIN, HEADER_H, MAIN_WINDOW, predictedMain, defaultBounds, visibleOrDefault };
