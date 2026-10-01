// The widget's empty corners let clicks through: the renderer hit-tests each
// mousemove and asks for setIgnoreMouseEvents(true) over nothing drawn. On
// macOS and Windows `forward: true` keeps the mousemoves coming while clicks
// fall through, so the renderer sees the cursor come back. Linux has no
// forwarding: once ignored, the window never hears from the mouse again and
// the widget becomes unclickable. There main watches the cursor instead, and
// while it is over the window asks the renderer to hit-test that point.
const POLL_MS = 50;

const inside = (p, b) => p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;

function create({ platform = process.platform, screen, getWin, every, stopTimer }) {
  let poll = null;
  let last = null;

  function tick() {
    const win = getWin();
    if (!win || win.isDestroyed()) { poll = stopTimer(poll); return; }
    const p = screen.getCursorScreenPoint();
    if (last && last.x === p.x && last.y === p.y) return;
    last = p;
    const b = win.getBounds();
    if (inside(p, b)) win.webContents.send('hit-test', p.x - b.x, p.y - b.y);
  }

  function set(ignore) {
    const win = getWin();
    if (!win) return;
    if (platform !== 'linux') { win.setIgnoreMouseEvents(!!ignore, { forward: true }); return; }
    win.setIgnoreMouseEvents(!!ignore);
    if (ignore && !poll) { last = null; poll = every(POLL_MS, tick, 'click-through'); }
    if (!ignore) poll = stopTimer(poll);
  }

  return { set };
}

module.exports = { create, inside, POLL_MS };
