// Mounts the pixel-Claude rig into a container and drives it from a resolved
// "look" (see rules.js). Plain script — loaded with <script src> by both
// index.html and lights.html, since neither renderer can require().
//
//   const rig = mountRig(container);
//   rig.setLook({ lamp: 'green', lampColor: null, eyes: 'default', pose: 'think' });
//   rig.celebrate();
(function () {
  const SVG = `
<svg class="rig" viewBox="0 0 64 82" overflow="visible" xmlns="http://www.w3.org/2000/svg">
  <g class="sign-assembly">
    <rect x="4" y="24" width="56" height="5" fill="#726c62" />
    <rect class="lamp" data-slot="red" x="7" y="7" width="15" height="15" rx="2.5" />
    <rect class="lamp" data-slot="amber" x="24.5" y="7" width="15" height="15" rx="2.5" />
    <rect class="lamp" data-slot="green" x="42" y="7" width="15" height="15" rx="2.5" />
    <rect fill="#da7756" x="0" y="29" width="9" height="10" />
  </g>
  <g class="claude-body" fill="#da7756">
    <rect x="17" y="39" width="30" height="13" />
    <rect x="4" y="52" width="56" height="7" />
    <rect x="15" y="59" width="7" height="9" />
    <rect x="28.5" y="59" width="7" height="9" />
    <rect x="42" y="59" width="7" height="9" />
    <rect class="eye-open" x="22" y="43.5" width="4.5" height="4.5" />
    <rect class="eye-open" x="37.5" y="43.5" width="4.5" height="4.5" />
    <rect class="eye-closed" x="21" y="45.25" width="6.5" height="1.6" rx="0.8" />
    <rect class="eye-closed" x="36.5" y="45.25" width="6.5" height="1.6" rx="0.8" />
    <circle class="think-dot d1" cx="24" cy="34" r="2" />
    <circle class="think-dot d2" cx="32" cy="34" r="2" />
    <circle class="think-dot d3" cx="40" cy="34" r="2" />
    <g class="thumbs-up">
      <rect x="50" y="48" width="8" height="7" rx="1" />
      <rect x="48" y="42" width="4" height="8" rx="1.5" />
    </g>
    <rect class="grumpy-mouth" x="26" y="49" width="12" height="1.8" rx="0.9" />
    <!-- prop: guitar, slung across the front, strummed by a small hand -->
    <g class="prop prop-guitar">
      <rect x="24" y="48" width="20" height="11" rx="4" fill="#8a5a2b" />
      <rect x="27" y="50" width="6" height="7" rx="3" fill="#2a1d12" />
      <rect x="41" y="40" width="18" height="3" fill="#c99a5b" transform="rotate(-30 41 40)" />
      <rect x="55" y="31" width="5" height="4" fill="#3a2a1a" />
      <rect x="33" y="50" width="12" height="0.6" fill="#f2efe8" />
      <rect x="33" y="52" width="12" height="0.6" fill="#f2efe8" />
      <rect x="33" y="54" width="12" height="0.6" fill="#f2efe8" />
      <rect class="strum-hand" x="36" y="46" width="5" height="5" rx="1" fill="#da7756" stroke="#211f1c" stroke-width="0.5" />
    </g>
    <g class="prop prop-notes">
      <text class="note n1" x="46" y="44">♪</text>
      <text class="note n2" x="52" y="40">♫</text>
      <text class="note n3" x="42" y="36">♪</text>
    </g>
    <!-- prop: rifle, held at the hip, firing to the right -->
    <g class="prop prop-ak">
      <g class="ak-body">
        <rect x="36" y="50" width="9" height="5" rx="1" fill="#7a4a24" />
        <rect x="43" y="48" width="15" height="5" fill="#3b3b40" />
        <rect x="48" y="53" width="4" height="7" rx="1" fill="#5a4a2a" transform="skewX(-12)" />
        <rect x="57" y="49" width="10" height="2.2" fill="#2b2b30" />
        <rect x="53" y="45.5" width="2" height="3" fill="#2b2b30" />
        <rect x="41" y="52" width="5" height="4" rx="1" fill="#da7756" stroke="#211f1c" stroke-width="0.5" />
      </g>
      <polygon class="muzzle" points="67,50 73,46 70,50 74,50.5 70,51 73,54" fill="#ffd166" />
      <rect class="casing c1" x="52" y="46" width="1.6" height="2.6" rx="0.4" fill="#e0b040" />
      <rect class="casing c2" x="52" y="46" width="1.6" height="2.6" rx="0.4" fill="#e0b040" />
      <rect class="casing c3" x="52" y="46" width="1.6" height="2.6" rx="0.4" fill="#e0b040" />
    </g>
  </g>
  <!-- prop: banner, dropped over the sign, with the rule's own text -->
  <g class="prop prop-banner">
    <rect x="1" y="3" width="62" height="17" rx="2" fill="#f2efe8" stroke="#211f1c" stroke-width="1" />
    <rect x="1" y="3" width="62" height="3" fill="#e2231a" />
    <text class="banner-text" x="32" y="16" text-anchor="middle" textLength="56" lengthAdjust="spacingAndGlyphs">INPUT NEEDED</text>
  </g>
  <text class="zzz z1" x="46" y="37">z</text>
  <text class="zzz z2" x="50" y="32">z</text>
  <text class="zzz z3" x="54" y="27">z</text>
  <text class="zzz z4" x="58" y="22">z</text>
  <text class="zzz z5" x="48" y="24">z</text>
  <g class="confetti-group">
    <rect class="confetti c1" x="30" y="20" width="3" height="3" fill="#f2a200" style="--dx:-14px;--dy:-18px" />
    <rect class="confetti c2" x="32" y="20" width="3" height="3" fill="#2fae3e" style="--dx:10px;--dy:-22px" />
    <rect class="confetti c3" x="34" y="22" width="3" height="3" fill="#e2231a" style="--dx:20px;--dy:-8px" />
    <rect class="confetti c4" x="30" y="22" width="3" height="3" fill="#f2efe8" style="--dx:-20px;--dy:-6px" />
    <rect class="confetti c5" x="32" y="24" width="3" height="3" fill="#da7756" style="--dx:6px;--dy:-26px" />
    <rect class="confetti c6" x="28" y="24" width="3" height="3" fill="#f2a200" style="--dx:-8px;--dy:-24px" />
  </g>
</svg>`;

  const POSES = ['none', 'think', 'wave', 'thumbs', 'sleep', 'blink', 'nod', 'bounce', 'look', 'spin', 'party', 'guitar', 'ak47', 'banner'];
  const DEFAULT_TEXT = 'INPUT NEEDED';
  const SLOT_COLORS = { red: '#e2231a', amber: '#f2a200', green: '#2fae3e' };

  function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return `rgba(0,0,0,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  function mountRig(container) {
    container.innerHTML = SVG;
    const svg = container.querySelector('.rig');
    const lamps = Array.from(svg.querySelectorAll('.lamp'));
    let current = null;

    function setLook(look) {
      const lamp = look.lamp || 'off';
      const lit = SLOT_COLORS[lamp] ? lamp : null;
      const color = look.lampColor || (lit ? SLOT_COLORS[lit] : null);
      for (const el of lamps) {
        const on = lit && el.dataset.slot === lit;
        el.classList.toggle('on', !!on);
        el.classList.toggle('pulse', !!on && look.pulse !== false && lit === 'green' && !look.lampColor);
      }
      svg.style.setProperty('--lamp-on', color || 'var(--lamp-off)');
      svg.style.setProperty('--lamp-glow', color ? hexToRgba(color, 0.85) : 'transparent');

      const eyes = look.eyes || 'default';
      svg.classList.toggle('eyes-closed', eyes === 'closed');
      svg.style.setProperty('--eye-color', /^#/.test(eyes) ? eyes : '#211f1c');

      const pose = POSES.includes(look.pose) ? look.pose : 'none';
      // Only touch pose classes on a real change so a poll doesn't restart
      // an infinite animation mid-swing (visible stutter).
      if (!current || current.pose !== pose) {
        for (const p of POSES) svg.classList.remove(`pose-${p}`);
        if (pose !== 'none') svg.classList.add(`pose-${pose}`);
      }
      svg.classList.toggle('grumpy', !!look.grumpy);
      svg.classList.toggle('face-left', look.facing === 'left');
      const text = (look.text || DEFAULT_TEXT).toUpperCase().slice(0, 24);
      const t = svg.querySelector('.banner-text');
      if (t.textContent !== text) t.textContent = text;
      current = { ...look, pose };
    }

    let burstTimer = null;
    function burst(ms = 1200) {
      svg.classList.add('firing');
      clearTimeout(burstTimer);
      burstTimer = setTimeout(() => svg.classList.remove('firing'), ms);
    }

    function celebrate() {
      svg.querySelectorAll('.confetti').forEach((el) => {
        el.classList.remove('burst');
        void el.getBoundingClientRect();
        el.classList.add('burst');
      });
    }

    return { svg, setLook, celebrate, burst, get look() { return current; } };
  }

  window.mountRig = mountRig;
  window.RIG_POSES = POSES;
  window.RIG_DEFAULT_TEXT = DEFAULT_TEXT;
})();
