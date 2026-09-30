// Shared by every page: nav shadow, the page-long nerve, the OS-aware download
// label, and the waitlist form. No dependencies.
(function () {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
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
