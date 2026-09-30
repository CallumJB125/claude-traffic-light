// Pointer-event card dragging (mouse, pen, touch long-press) and the FLIP
// settle. No library. Motion is transform/opacity on a fixed-position clone;
// the real card stays in its slot as the dashed placeholder until the drop.
// Touch starts only after a long press, so a swipe still scrolls the column.

const SLOP = 5;
const TOUCH_SLOP = 8;
const LONG_PRESS_MS = 260;
const EDGE = 56;
const SCROLL_MAX = 18;
const LIFT = 'rotate(2deg) scale(1.03)';
// A touch of overshoot: the settle reads as a spring without bouncing.
const SETTLE = 'cubic-bezier(0.22, 1.25, 0.36, 1)';
const SLIDE = 'cubic-bezier(0.23, 1, 0.32, 1)';

export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const INTERACTIVE = 'a, input, select, textarea, button:not(.card-open), [contenteditable]';

/**
 * Wires pointer dragging on `.card[data-draggable="true"]`.
 *  dragIds(cardEl) → ids or null     start(ids)   hover(columnId|null)
 *  drop(ids, columnId, ghostRect) → bool (true = the app moved them)
 *  end()                              called once whenever a drag is over
 */
export function installDnd({ root, dragIds, start, hover, drop, end }) {
  let pend = null;
  let drag = null;

  function cleanupPending() {
    if (!pend) return;
    clearTimeout(pend.timer);
    pend = null;
  }

  function begin() {
    const p = pend;
    cleanupPending();
    if (!p) return;
    const r = p.el.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.className = 'card-ghost';
    ghost.style.width = `${r.width}px`;
    ghost.style.height = `${r.height}px`;
    const clone = p.el.cloneNode(true);
    clone.classList.add('is-lifted');
    clone.classList.remove('is-dragging', 'is-selected');
    clone.setAttribute('aria-hidden', 'true');
    for (const n of clone.querySelectorAll('[id]')) n.removeAttribute('id');
    ghost.append(clone);
    if (p.ids.length > 1) ghost.dataset.count = String(p.ids.length);
    document.body.append(ghost);
    drag = { ids: p.ids, el: p.el, ghost, pointerId: p.pointerId, type: p.type, dx: p.x0 - r.left, dy: p.y0 - r.top, w: r.width, h: r.height, x: p.x, y: p.y, over: null, raf: 0, home: r };
    document.body.classList.add('is-card-dragging');
    if (p.type === 'touch') navigator.vibrate?.(8);
    start(p.ids);
    place();
    loop();
  }

  function place() {
    drag.ghost.style.transform = `translate3d(${drag.x - drag.dx}px, ${drag.y - drag.dy}px, 0)`;
  }

  function loop() {
    if (!drag) return;
    place();
    autoscroll();
    const at = document.elementFromPoint(drag.x, drag.y);
    const col = at?.closest?.('.column[data-column]')?.dataset.column ?? null;
    if (col !== drag.over) { drag.over = col; hover(col); }
    drag.raf = requestAnimationFrame(loop);
  }

  // Near an edge the board (or the column under the pointer) scrolls; speed
  // grows with how close the pointer is, like every native list.
  function autoscroll() {
    const speed = (d) => Math.ceil(SCROLL_MAX * (1 - Math.max(0, d) / EDGE));
    const board = root.querySelector('.board');
    if (board) {
      const b = board.getBoundingClientRect();
      if (drag.x < b.left + EDGE) board.scrollLeft -= speed(drag.x - b.left);
      else if (drag.x > b.right - EDGE) board.scrollLeft += speed(b.right - drag.x);
    }
    const body = document.elementFromPoint(drag.x, drag.y)?.closest?.('.column-body');
    if (body) {
      const c = body.getBoundingClientRect();
      if (drag.y < c.top + EDGE) body.scrollTop -= speed(drag.y - c.top);
      else if (drag.y > c.bottom - EDGE) body.scrollTop += speed(c.bottom - drag.y);
    }
  }

  function finish(commit) {
    const d = drag;
    if (!d) return;
    drag = null;
    cancelAnimationFrame(d.raf);
    document.body.classList.remove('is-card-dragging');
    // A drag that ended over a card must not also "click" it open.
    const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
    document.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', swallow, true), 0);
    const rect = { left: d.x - d.dx, top: d.y - d.dy };
    const moved = commit && d.over ? drop(d.ids, d.over, rect) : false;
    end();
    if (moved) { d.ghost.remove(); return; }
    // Nothing moved: the card glides back to its slot.
    const home = d.el.isConnected ? d.el.getBoundingClientRect() : d.home;
    if (prefersReducedMotion()) { d.ghost.remove(); return; }
    const a = d.ghost.animate(
      [{ transform: d.ghost.style.transform }, { transform: `translate3d(${home.left}px, ${home.top}px, 0)` }],
      { duration: 220, easing: SLIDE, fill: 'forwards' },
    );
    a.onfinish = a.oncancel = () => d.ghost.remove();
  }

  function onDown(e) {
    if (drag || pend || !e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target.closest?.('.card[data-draggable="true"]');
    if (!el || e.target.closest(INTERACTIVE)) return;
    const ids = dragIds(el);
    if (!ids) return;
    pend = { el, ids, pointerId: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, timer: 0 };
    if (e.pointerType === 'touch') pend.timer = setTimeout(begin, LONG_PRESS_MS);
  }

  function onMove(e) {
    if (drag) {
      if (e.pointerId !== drag.pointerId) return;
      drag.x = e.clientX;
      drag.y = e.clientY;
      return;
    }
    if (!pend || e.pointerId !== pend.pointerId) return;
    pend.x = e.clientX;
    pend.y = e.clientY;
    const d = Math.hypot(e.clientX - pend.x0, e.clientY - pend.y0);
    if (pend.type === 'touch') { if (d > TOUCH_SLOP) cleanupPending(); } else if (d > SLOP) begin();
  }

  function onUp(e) {
    if (drag && e.pointerId === drag.pointerId) finish(e.type === 'pointerup');
    else if (pend && e.pointerId === pend.pointerId) cleanupPending();
  }

  function onKey(e) {
    if (drag && e.key === 'Escape') { e.preventDefault(); finish(false); }
  }

  document.addEventListener('pointerdown', onDown);
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
  document.addEventListener('keydown', onKey, true);
  // Once a long press has lifted the card, the finger must drag it, not the page.
  document.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
  document.addEventListener('contextmenu', (e) => { if (drag || pend?.type === 'touch') e.preventDefault(); });
  // Native HTML5 drag is off: the avatar images inside a card would start one.
  document.addEventListener('dragstart', (e) => { if (e.target.closest?.('.card')) e.preventDefault(); });

  return { active: () => !!drag, cancel: () => finish(false) };
}

// ── FLIP: settle cards from where they were to where they are ───────────────

export function snapshotRects(root) {
  const m = new Map();
  for (const el of root.querySelectorAll('.card[data-card-id]')) m.set(el.dataset.cardId, el.getBoundingClientRect());
  return m;
}

/**
 * After a render, slide every card that moved. `lifted` maps the ids that were
 * just dropped to the ghost's rect: they start there, still tilted and raised,
 * and settle flat. Everything else slides from its previous slot.
 */
export function playFlip(root, before, lifted = null) {
  if (prefersReducedMotion()) return;
  for (const el of root.querySelectorAll('.card[data-card-id]')) {
    const id = el.dataset.cardId;
    const from = lifted?.get(id) ?? before.get(id);
    if (!from) continue;
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const up = lifted?.has(id);
    if (!up && Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.style.zIndex = up ? '20' : '';
    const a = el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)${up ? ` ${LIFT}` : ''}` }, { transform: 'none' }],
      { duration: up ? 280 : 200, easing: up ? SETTLE : SLIDE },
    );
    if (up) a.onfinish = a.oncancel = () => { el.style.zIndex = ''; };
  }
}
