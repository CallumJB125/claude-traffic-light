'use strict';
// The first-run tour's coachmark (src/first-run-tour.js): a ring round the
// target and a small callout beside it that never covers it. Esc skips, Enter
// advances, Tab stays inside the callout. Text only ever goes in through
// textContent. In the widget it only draws the ring (the callout is on Home).
(function (root) {
  const MARGIN = 8;

  // Where the callout goes: below, above, right, then left of the target,
  // the first side where it fits whole; clamped inside the viewport. With no
  // target (or no side that fits) it is centred, and `covers` says so.
  function place(target, box, view, gap = 10) {
    const clampX = (x) => Math.max(MARGIN, Math.min(x, view.width - box.width - MARGIN));
    const clampY = (y) => Math.max(MARGIN, Math.min(y, view.height - box.height - MARGIN));
    const centre = { side: 'centre', left: Math.max(MARGIN, Math.round((view.width - box.width) / 2)), top: Math.max(MARGIN, Math.round((view.height - box.height) / 2)) };
    if (!target) return { ...centre, covers: false };
    const cx = target.left + target.width / 2, cy = target.top + target.height / 2;
    const tries = [
      { side: 'below', fits: target.top + target.height + gap + box.height + MARGIN <= view.height, left: clampX(cx - box.width / 2), top: target.top + target.height + gap },
      { side: 'above', fits: target.top - gap - box.height >= MARGIN, left: clampX(cx - box.width / 2), top: target.top - gap - box.height },
      { side: 'right', fits: target.left + target.width + gap + box.width + MARGIN <= view.width, left: target.left + target.width + gap, top: clampY(cy - box.height / 2) },
      { side: 'left', fits: target.left - gap - box.width >= MARGIN, left: target.left - gap - box.width, top: clampY(cy - box.height / 2) },
    ];
    const hit = tries.find((t) => t.fits);
    if (hit) return { side: hit.side, left: Math.round(hit.left), top: Math.round(hit.top), covers: false };
    return { ...centre, covers: true };
  }

  function overlaps(a, b) {
    return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
  }

  function create(doc, { onAction, reducedMotion = () => false, waitMs = 1500 } = {}) {
    const win = doc.defaultView;
    let ring = null, card = null, step = null, target = null, lastFocus = null, poll = null;

    const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; };
    const visible = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const find = (sel) => { try { return [...doc.querySelectorAll(sel)].find(visible) || null; } catch { return null; } };

    function clear() {
      if (poll) win.clearInterval(poll); poll = null;
      ring?.remove(); card?.remove(); ring = card = null; target = null;
      doc.removeEventListener('keydown', onKey, true);
      win.removeEventListener('resize', layout);
      if (step && lastFocus && doc.contains(lastFocus)) lastFocus.focus();
      step = null; lastFocus = null;
    }

    function layout() {
      const view = { width: win.innerWidth, height: win.innerHeight };
      const r = target ? target.getBoundingClientRect() : null;
      if (ring && r) Object.assign(ring.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
      if (!card) return;
      const p = place(r && { left: r.left, top: r.top, width: r.width, height: r.height }, { width: card.offsetWidth, height: card.offsetHeight }, view);
      Object.assign(card.style, { left: `${p.left}px`, top: `${p.top}px` });
      card.dataset.side = p.side;
    }

    const send = (kind) => { const id = step?.id; if (id) onAction(kind, id); };
    function onKey(e) {
      if (!card) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); send('skip'); return; }
      if (e.key === 'Enter' && !e.target.closest?.('.tour-skip')) { e.preventDefault(); e.stopPropagation(); send('next'); return; }
      if (e.key === 'Tab') {
        const f = [...card.querySelectorAll('button')];
        const i = f.indexOf(doc.activeElement);
        e.preventDefault();
        f[i < 0 ? 0 : (i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
    }

    function ringOn(n) {
      target = n;
      ring = el('div', 'tour-ring');
      ring.setAttribute('aria-hidden', 'true');
      doc.body.append(ring);
    }

    function render(s) {
      const motion = !reducedMotion();
      if (s.highlight) {
        const n = find(s.highlight);
        if (n) { ringOn(n); ring.classList.toggle('tour-still', !motion); }
        win.addEventListener('resize', layout);
        layout();
        return;
      }
      card = el('div', 'tour-card');
      card.classList.toggle('tour-still', !motion);
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      const h = el('h2', 'tour-title', s.title); h.id = 'tour-title';
      const b = el('p', 'tour-body', s.body); b.id = 'tour-body';
      card.setAttribute('aria-labelledby', h.id);
      card.setAttribute('aria-describedby', b.id);
      card.append(el('p', 'tour-count', `${s.index} of ${s.total}`), h, b);
      if (s.pointsTo === 'widget') card.append(el('p', 'tour-hint', 'Look at the widget at the edge of your screen.'));
      const acts = el('div', 'tour-acts');
      const go = el('button', 'tour-next', s.primary); go.type = 'button'; go.addEventListener('click', () => send('next'));
      const sk = el('button', 'tour-skip', s.skip || 'Skip tour'); sk.type = 'button'; sk.addEventListener('click', () => send('skip'));
      acts.append(go, sk); card.append(acts);
      doc.body.append(card);
      lastFocus = doc.activeElement;
      doc.addEventListener('keydown', onKey, true);
      win.addEventListener('resize', layout);
      layout();
      go.focus();
    }

    function show(s) {
      clear();
      if (!s || typeof s !== 'object' || typeof s.id !== 'string') return;
      step = s;
      const sel = s.highlight || s.selector;
      if (!sel || find(sel)) {
        if (s.selector) ringOn(find(s.selector));
        render(s);
        return;
      }
      // The page may still be drawing: wait a little, then report it absent.
      const started = Date.now();
      poll = win.setInterval(() => {
        const n = find(sel);
        if (!n && Date.now() - started < waitMs) return;
        win.clearInterval(poll); poll = null;
        if (step !== s) return;
        if (!n) { if (!s.highlight) onAction('missing', s.id); return; }
        if (s.selector) ringOn(n);
        render(s);
      }, 100);
    }

    return { show, clear, layout, current: () => step };
  }

  const api = { place, overlaps, create, MARGIN };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TourCoachmark = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
