// Pointing overlay page (src/pointer-overlay-main.js): flies the cursor from
// the widget to each point, shows its label, and flies back. Never handles a
// click: the window ignores the mouse and cannot take focus. Main closes it.
(() => {
  const dot = document.getElementById('dot');
  const label = document.getElementById('label');
  const FLY_MS = 520;
  const ease = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const at = (el, p) => `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function place(p) {
    dot.style.transform = at(dot, p);
    label.style.transform = `translate(${Math.round(p.x + 16)}px, ${Math.round(p.y + 12)}px)`;
  }
  async function fly(a, b) {
    const anim = dot.animate([{ transform: at(dot, a) }, { transform: at(dot, b) }], { duration: FLY_MS, easing: ease, fill: 'forwards' });
    await anim.finished.catch(() => {});
    place(b);
  }
  function say(text) {
    label.textContent = text || '';
    label.style.opacity = text ? '1' : '0';
  }

  window.pointer.onPlay(async (plan) => {
    const pts = (plan && Array.isArray(plan.points) ? plan.points : []).slice(0, 3);
    if (!pts.length) return;
    const budget = Math.max(1500, Number(plan.ms) || 5000);
    if (plan.reduced) {
      const hold = Math.floor(budget / pts.length) - 200;
      dot.style.opacity = '1';
      for (const p of pts) { place(p); say(p.label); await wait(hold); }
      say(''); dot.style.opacity = '0';
      return;
    }
    const home = plan.from || pts[0];
    const flights = (pts.length + 1) * FLY_MS;
    const hold = Math.max(500, Math.floor((budget - flights - 300) / pts.length));
    place(home);
    dot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, fill: 'forwards' });
    let here = home;
    for (const p of pts) {
      say('');
      await fly(here, p);
      here = p;
      say(p.label);
      await wait(hold);
    }
    say('');
    if (plan.from) await fly(here, home);
    dot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
  });
})();
