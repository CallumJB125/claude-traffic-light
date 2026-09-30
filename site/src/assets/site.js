// Shared by every page: a small spring engine, magnetic buttons, nav shadow,
// the page-long nerve, the OS-aware download label, and the waitlist form.
// No dependencies.
(function () {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── springs ─────────────────────────────────────────────────────────────
  // Motion that has mass: a value chases its target with a response time and a
  // damping ratio (Apple's spring model), so it can overshoot and settle
  // instead of easing on a fixed curve, and a new target mid-flight bends the
  // path rather than restarting it. One rAF loop runs only while something is
  // still moving. With reduced motion a spring jumps straight to its target.
  const active = new Set();
  let raf = 0;
  let last = 0;
  const TAU = Math.PI * 2;
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (const s of [...active]) s.step(dt);
    raf = active.size ? requestAnimationFrame(tick) : 0;
  }
  function spring(initial, { response = 0.5, damping = 0.8, precision = 0.0005, onUpdate = () => {} } = {}) {
    const k = (TAU / response) ** 2;
    const c = (2 * damping * TAU) / response;
    const s = {
      x: initial, v: 0, target: initial,
      step(dt) {
        let rest = dt;
        while (rest > 0) { const h = Math.min(rest, 1 / 120); s.v += (-k * (s.x - s.target) - c * s.v) * h; s.x += s.v * h; rest -= h; }
        if (Math.abs(s.x - s.target) < precision && Math.abs(s.v) < precision * 20) { s.x = s.target; s.v = 0; active.delete(s); }
        onUpdate(s.x);
      },
      to(t) {
        s.target = t;
        if (reduce) { s.x = t; s.v = 0; active.delete(s); onUpdate(t); return; }
        if (!active.has(s)) { active.add(s); if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); } }
      },
      jump(x) { s.x = x; s.target = x; s.v = 0; active.delete(s); onUpdate(x); },
    };
    return s;
  }
  window.PX = { spring, reduce, clamp: (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v)) };

  // ── magnetic buttons ────────────────────────────────────────────────────
  // A big button leans toward a nearby pointer and settles back on a spring.
  // It uses the individual `translate` property, so the press and hover
  // transforms in the stylesheet still compose. Mouse only.
  if (!reduce && matchMedia('(hover: hover) and (pointer: fine)').matches) {
    for (const el of document.querySelectorAll('.btn:not(.btn-small)')) {
      const sx = spring(0, { response: 0.45, damping: 0.6, precision: 0.01 });
      const sy = spring(0, { response: 0.45, damping: 0.6, precision: 0.01 });
      const put = () => { el.style.translate = sx.x || sy.x ? `${sx.x.toFixed(2)}px ${sy.x.toFixed(2)}px` : ''; };
      sx.step = ((orig) => (dt) => { orig(dt); put(); })(sx.step);
      sy.step = ((orig) => (dt) => { orig(dt); put(); })(sy.step);
      let inside = false;
      addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'mouse') return;
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        const near = Math.abs(dx) < r.width / 2 + 56 && Math.abs(dy) < r.height / 2 + 56;
        if (near) { inside = true; sx.to(Math.max(-9, Math.min(9, dx * 0.22))); sy.to(Math.max(-7, Math.min(7, dy * 0.3))); }
        else if (inside) { inside = false; sx.to(0); sy.to(0); }
      }, { passive: true });
      document.addEventListener('pointerleave', () => { sx.to(0); sy.to(0); });
    }
  }

  const nav = document.querySelector('.nav');
  const root = document.documentElement;
  let queued = false;
  function frame() {
    queued = false;
    if (nav) nav.classList.toggle('scrolled', window.scrollY > 8);
    const max = root.scrollHeight - window.innerHeight;
    root.style.setProperty('--page', max > 0 ? String(Math.min(1, window.scrollY / max)) : '1');
  }
  addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(frame); } }, { passive: true });
  addEventListener('resize', frame);
  frame();

  // what to call the download button
  function detectOS() {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    const ua = navigator.userAgent || '';
    if (/mac/i.test(p) || /Macintosh/.test(ua)) return 'mac';
    if (/win/i.test(p) || /Windows/.test(ua)) return 'win';
    if (/linux|x11/i.test(p) || /Linux/.test(ua)) return /Android/.test(ua) ? 'other' : 'linux';
    return 'other';
  }
  const NAMES = { mac: 'Mac', win: 'Windows', linux: 'Linux' };
  const os = detectOS();
  window.__os = os;
  if (NAMES[os]) for (const el of document.querySelectorAll('[data-os-label]')) el.firstChild.textContent = `${el.firstChild.textContent.replace(/ for (Mac|Windows|Linux)$/, '')} for ${NAMES[os]}`;

  // waitlist
  const form = document.getElementById('wl-form');
  if (form) {
    const msg = document.getElementById('wl-msg');
    const say = (text, cls) => { msg.textContent = text; msg.className = `form-msg ${cls || ''}`; };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = form.email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { say('That email doesn\'t look right. Check it and try again.', 'err'); form.email.focus(); return; }
      const btn = form.querySelector('button');
      btn.disabled = true;
      say('Sending…');
      try {
        const res = await fetch(form.action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, uses: form.uses.value, company: form.company.value }) });
        const body = await res.json().catch(() => ({}));
        if (res.ok) { say('You\'re on the list. We\'ll email your invite.', 'ok'); form.reset(); }
        else say(body.error || 'That didn\'t go through. Try again in a minute.', 'err');
      } catch {
        say('We couldn\'t reach the server. Try again, or email us.', 'err');
      } finally { btn.disabled = false; }
    });
  }
  void reduce;
})();
