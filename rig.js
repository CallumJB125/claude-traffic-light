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
  <defs>
    <!-- lamp shapes, referenced by href so a rule can swap them -->
    <symbol id="lamp-square" viewBox="0 0 16 16"><rect x="0.5" y="0.5" width="15" height="15" rx="2.5" /></symbol>
    <symbol id="lamp-round" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7.5" /></symbol>
    <symbol id="lamp-heart" viewBox="0 0 16 16"><path d="M8 14.5 L2 8.5 A3.5 3.5 0 0 1 8 4 A3.5 3.5 0 0 1 14 8.5 Z" /></symbol>
    <symbol id="lamp-star" viewBox="0 0 16 16"><polygon points="8,0.8 10.1,5.6 15.3,6.1 11.4,9.6 12.6,14.7 8,12 3.4,14.7 4.6,9.6 0.7,6.1 5.9,5.6" /></symbol>
    <symbol id="lamp-skull" viewBox="0 0 16 16"><path d="M8 1a6 6 0 0 0-6 6c0 2.2 1.1 3.6 2.5 4.5V14h7v-2.5C12.9 10.6 14 9.2 14 7a6 6 0 0 0-6-6z" /><circle cx="5.7" cy="7" r="1.6" fill="#1c1a1f" /><circle cx="10.3" cy="7" r="1.6" fill="#1c1a1f" /><rect x="7.2" y="9.6" width="1.6" height="2" fill="#1c1a1f" /></symbol>
  </defs>
  <g class="scene">
  <g class="mover">
  <g class="sign-assembly">
    <!-- horizontal, three lamps (default) -->
    <g class="sign sign-h3">
      <rect x="4" y="24" width="56" height="5" fill="#726c62" />
      <use class="lamp" data-slot="red" href="#lamp-square" x="6.5" y="6.5" width="16" height="16" />
      <use class="lamp" data-slot="amber" href="#lamp-square" x="24" y="6.5" width="16" height="16" />
      <use class="lamp" data-slot="green" href="#lamp-square" x="41.5" y="6.5" width="16" height="16" />
      <g class="cracks" fill="none" stroke="#f2efe8" stroke-width="0.7" stroke-linecap="round"><path d="M12 8l4 6-2 5M30 7l-3 7 4 4M48 8l-2 5 5 6M27 9l7 8" /></g>
    </g>
    <!-- horizontal, one big lamp -->
    <g class="sign sign-h1">
      <rect x="4" y="24" width="56" height="5" fill="#726c62" />
      <use class="lamp" data-slot="any" href="#lamp-square" x="21" y="2" width="22" height="22" />
      <g class="cracks" fill="none" stroke="#f2efe8" stroke-width="0.7" stroke-linecap="round"><path d="M27 5l5 8-3 7M33 6l4 6" /></g>
    </g>
    <!-- horizontal, five lamps -->
    <g class="sign sign-h5">
      <rect x="4" y="24" width="56" height="5" fill="#726c62" />
      <use class="lamp" data-slot="red" href="#lamp-square" x="4" y="11" width="10" height="10" />
      <use class="lamp" data-slot="amber" href="#lamp-square" x="15.5" y="11" width="10" height="10" />
      <use class="lamp" data-slot="green" href="#lamp-square" x="27" y="11" width="10" height="10" />
      <use class="lamp" data-slot="blue" href="#lamp-square" x="38.5" y="11" width="10" height="10" />
      <use class="lamp" data-slot="pink" href="#lamp-square" x="50" y="11" width="10" height="10" />
      <g class="cracks" fill="none" stroke="#f2efe8" stroke-width="0.7" stroke-linecap="round"><path d="M9 12l3 5M31 12l-2 6M54 12l2 6" /></g>
    </g>
    <!-- vertical, three lamps on a post -->
    <g class="sign sign-v3">
      <rect x="4" y="2" width="4" height="27" fill="#726c62" />
      <rect x="4" y="24" width="12" height="5" fill="#726c62" />
      <use class="lamp" data-slot="red" href="#lamp-square" x="9" y="0" width="9" height="9" />
      <use class="lamp" data-slot="amber" href="#lamp-square" x="9" y="9.5" width="9" height="9" />
      <use class="lamp" data-slot="green" href="#lamp-square" x="9" y="19" width="9" height="9" />
      <g class="cracks" fill="none" stroke="#f2efe8" stroke-width="0.7" stroke-linecap="round"><path d="M11 2l4 5M12 12l3 4" /></g>
    </g>
    <!-- number mode: one big digit where the lamps were -->
    <text class="sign-number" x="32" y="21" text-anchor="middle"></text>
    <rect fill="#da7756" x="0" y="29" width="9" height="10" />
    <text class="tasks-label" x="32" y="28.1" text-anchor="middle"></text>
  </g>
  </g><!-- /mover -->
  </g><!-- /scene -->
  <!-- staged garden: pots, bed, plants and tools; driven by the garden machine below -->
  <g class="garden"></g>
  <!-- rare events, drawn over everything -->
  <g class="event event-ufo">
    <ellipse cx="32" cy="8" rx="16" ry="4" fill="#9aa3ad" /><ellipse cx="32" cy="5.5" rx="8" ry="4.5" fill="#cfe9ff" opacity="0.9" />
    <g class="ufo-lights" fill="#f2d16b"><circle cx="20" cy="9" r="1.2" /><circle cx="26" cy="10.5" r="1.2" /><circle cx="32" cy="11" r="1.2" /><circle cx="38" cy="10.5" r="1.2" /><circle cx="44" cy="9" r="1.2" /></g>
    <polygon class="beam" points="26,11 38,11 48,82 16,82" fill="#7dd3fc" opacity="0.28" />
  </g>
  <g class="event event-portal">
    <ellipse class="portal-ring" cx="62" cy="55" rx="4" ry="14" fill="#5b3fb8" stroke="#a78bfa" stroke-width="1.6" />
  </g>
  <g class="event event-meteor">
    <g class="meteor"><circle cx="0" cy="0" r="3.5" fill="#f2a200" /><path d="M0 0 l-22 -9 l16 6 z" fill="#f28c28" opacity="0.8" /><path d="M0 0 l-30 -6 l20 2 z" fill="#f2d16b" opacity="0.5" /></g>
  </g>
  <g class="claude-body">
    <g class="body body-default">
      <rect x="17" y="39" width="30" height="13" />
      <rect x="4" y="52" width="56" height="7" />
      <rect x="15" y="59" width="7" height="9" />
      <rect x="28.5" y="59" width="7" height="9" />
      <rect x="42" y="59" width="7" height="9" />
    </g>
    <!-- body swaps: whole-sprite variants sharing the eye positions -->
    <g class="body body-dog" fill="#b07a4a">
      <rect x="17" y="39" width="30" height="13" /><rect x="4" y="52" width="56" height="7" />
      <rect x="15" y="59" width="7" height="9" /><rect x="28.5" y="59" width="7" height="9" /><rect x="42" y="59" width="7" height="9" />
      <rect x="11" y="38" width="6" height="13" rx="3" fill="#7d5230" /><rect x="47" y="38" width="6" height="13" rx="3" fill="#7d5230" />
      <rect x="27" y="47.5" width="10" height="4.5" rx="2" fill="#e8c9a8" /><rect x="30.5" y="46.5" width="3" height="2" rx="1" fill="#211f1c" />
      <rect class="wag" x="59" y="52" width="7" height="2.2" rx="1" fill="#7d5230" />
    </g>
    <g class="body body-cat" fill="#8c8c96">
      <rect x="17" y="39" width="30" height="13" /><rect x="4" y="52" width="56" height="7" />
      <rect x="15" y="59" width="7" height="9" /><rect x="28.5" y="59" width="7" height="9" /><rect x="42" y="59" width="7" height="9" />
      <polygon points="18,40 21,31 26,39" /><polygon points="38,39 43,31 46,40" />
      <polygon points="20,38 21.5,34 24,38" fill="#f4a7c0" /><polygon points="40,38 42.5,34 44,38" fill="#f4a7c0" />
      <rect x="30.5" y="47" width="3" height="2" rx="1" fill="#f4a7c0" />
      <rect x="15" y="48.5" width="6" height="0.7" fill="#211f1c" /><rect x="43" y="48.5" width="6" height="0.7" fill="#211f1c" />
      <path class="cat-tail" d="M60 56 q7 -4 4 -10" fill="none" stroke="#8c8c96" stroke-width="2.2" stroke-linecap="round" />
    </g>
    <g class="body body-frog" fill="#5fbf5a">
      <rect x="17" y="41" width="30" height="11" rx="3" /><rect x="4" y="52" width="56" height="7" />
      <rect x="13" y="59" width="9" height="9" rx="2" /><rect x="42" y="59" width="9" height="9" rx="2" />
      <circle cx="24" cy="40" r="4.5" /><circle cx="40" cy="40" r="4.5" />
      <rect x="24" y="49" width="16" height="1.2" rx="0.6" fill="#2d6b2a" />
    </g>
    <g class="body body-robot" fill="#9aa3ad">
      <rect x="17" y="39" width="30" height="13" /><rect x="4" y="52" width="56" height="7" />
      <rect x="13" y="59" width="38" height="9" rx="4" fill="#5c646d" />
      <rect x="31" y="32" width="2" height="7" fill="#5c646d" /><circle class="antenna" cx="32" cy="31" r="2" fill="#e2231a" />
      <rect x="19" y="41" width="26" height="9" fill="#5c646d" />
      <circle cx="8" cy="55.5" r="1" fill="#5c646d" /><circle cx="56" cy="55.5" r="1" fill="#5c646d" />
      <rect x="27" y="47.5" width="10" height="1.4" fill="#38bdf8" />
    </g>
    <g class="body body-ghost" fill="#eef0f5" opacity="0.92">
      <path d="M17 39 h30 v27 l-5 -4 l-5 4 l-5 -4 l-5 4 l-5 -4 l-5 4 z" />
    </g>
    <!-- knock: a fist that raps forward; used when Claude walks to your terminal -->
    <g class="knock-fist"><rect x="50" y="46" width="6" height="6" rx="1.5" fill="#da7756" stroke="#211f1c" stroke-width="0.5" /></g>
    <!-- cookie: the token treat you feed him (⌥-click) -->
    <g class="cookie"><circle cx="54" cy="46" r="3.6" fill="#c98a4b" /><circle cx="52.8" cy="45" r="0.8" fill="#5a3a1a" /><circle cx="55.4" cy="47.2" r="0.8" fill="#5a3a1a" /><circle cx="54.6" cy="44.4" r="0.6" fill="#5a3a1a" /></g>
    <!-- big toothy grin -->
    <g class="grin"><rect x="23" y="48.5" width="18" height="3.6" rx="1.8" fill="#211f1c" /><rect x="24.5" y="49.2" width="15" height="1.6" fill="#f2efe8" /><rect x="28" y="49.2" width="0.6" height="1.6" fill="#211f1c" /><rect x="31.5" y="49.2" width="0.6" height="1.6" fill="#211f1c" /><rect x="35" y="49.2" width="0.6" height="1.6" fill="#211f1c" /></g>
    <!-- selfie: phone held out, flash burst -->
    <g class="selfie"><rect x="50" y="40" width="7" height="11" rx="1.5" fill="#1a1a1e" stroke="#9aa3ad" stroke-width="0.6" /><circle class="flashbulb" cx="53.5" cy="42.3" r="1.1" fill="#fff5d6" /></g>
    <!-- cigarette: held at the mouth, smoke drifts up -->
    <g class="cig">
      <g transform="rotate(-12 34 50)">
        <rect x="34" y="49.2" width="10" height="1.7" rx="0.5" fill="#f2efe8" /><rect x="34" y="49.2" width="2.6" height="1.7" rx="0.5" fill="#d9a066" /><rect class="ember" x="43.2" y="49.1" width="1.4" height="1.9" rx="0.4" fill="#ff5a1f" />
        <rect x="37" y="48.2" width="4.2" height="3.6" rx="1.2" fill="var(--body-color, #da7756)" stroke="#211f1c" stroke-width="0.5" />
      </g>
      <g class="wisps" fill="#c9c9d1"><circle class="wisp s1" cx="44.6" cy="47.5" r="0.7" /><circle class="wisp s2" cx="44.6" cy="47.5" r="0.9" /><circle class="wisp s3" cx="44.6" cy="47.5" r="0.6" /><circle class="wisp s4" cx="44.6" cy="47.5" r="1" /></g>
      <g class="exhale" fill="#d7d7de"><circle class="ex e1" cx="33" cy="51" r="1.4" /><circle class="ex e2" cx="33" cy="51" r="1.9" /><circle class="ex e3" cx="33" cy="51" r="1.2" /></g>
    </g>
    <!-- zyn tin + pouch -->
    <g class="zyn"><rect class="tin" x="49" y="46" width="8" height="8" rx="4" fill="#f2efe8" stroke="#211f1c" stroke-width="0.5" /><text class="tin-text" x="53" y="51.2" text-anchor="middle" font-size="3" font-weight="700" font-family="-apple-system, system-ui, sans-serif" fill="#211f1c">ZYN</text><rect class="pouch" x="53" y="49" width="3" height="1.6" rx="0.8" fill="#f2efe8" stroke="#211f1c" stroke-width="0.4" /></g>
    <!-- table, rolled note, line -->
    <g class="table">
      <rect x="4" y="62" width="56" height="2.2" fill="#8a5a2b" /><rect x="7" y="64" width="2" height="5" fill="#6b4420" /><rect x="55" y="64" width="2" height="5" fill="#6b4420" />
      <rect x="47" y="59.4" width="8" height="2.4" rx="0.4" fill="#f2efe8" stroke="#9aa3ad" stroke-width="0.3" transform="rotate(-8 51 60)" />
      <ellipse x="0" cx="14" cy="61.2" rx="3" ry="1.1" fill="#f7f7fb" />
      <rect class="line" x="19" y="60.9" width="26" height="1.1" rx="0.5" fill="#f7f7fb" />
      <g class="note"><rect x="0" y="0" width="1.8" height="9" rx="0.9" fill="#3fa34a" /><rect x="0" y="0" width="1.8" height="2" rx="0.9" fill="#2f8a3a" /></g>
      <g class="sniff" stroke="#f2efe8" stroke-width="0.8" stroke-linecap="round"><path d="M26 41 l-3 -2 M38 41 l3 -2 M25 44 l-3 0 M39 44 l3 0" /></g>
    </g>
    <!-- syringe -->
    <g class="needle"><rect x="50" y="43" width="8" height="3" rx="0.6" fill="#d7ded6" stroke="#211f1c" stroke-width="0.4" /><rect x="58" y="44" width="4" height="0.8" fill="#9aa3ad" /><rect class="plunger" x="47" y="43.8" width="4" height="1.4" fill="#e2231a" /></g>
    <!-- muscles: arm bulges that grow over time -->
    <g class="muscles" fill="var(--body-color, #da7756)"><ellipse class="bicep b1" cx="9" cy="54" rx="1" ry="1" /><ellipse class="bicep b2" cx="55" cy="54" rx="1" ry="1" /></g>
    <!-- hammer, for tearing the garden down -->
    <g class="hammer"><rect x="49" y="40" width="2.2" height="14" rx="1" fill="#8a5a2b" /><rect x="45" y="36" width="10.5" height="5.5" rx="1.2" fill="#4a4a52" /><rect x="45" y="36" width="10.5" height="1.6" fill="#6a6a74" /></g>
    <!-- skateboard -->
    <g class="skate"><rect x="12" y="69" width="40" height="3" rx="1.5" fill="#5b3fb8" /><circle cx="19" cy="73" r="1.6" fill="#f2efe8" /><circle cx="45" cy="73" r="1.6" fill="#f2efe8" /></g>
    <!-- halo + Xs for dead -->
    <g class="dead"><ellipse cx="32" cy="34" rx="9" ry="2.4" fill="none" stroke="#f2d16b" stroke-width="1.4" /></g>
    <g class="speed-lines" stroke="#f2efe8" stroke-width="1.2" stroke-linecap="round" opacity="0">
      <line x1="2" y1="56" x2="9" y2="56" /><line x1="0" y1="61" x2="8" y2="61" /><line x1="3" y1="66" x2="9" y2="66" />
    </g>
    <!-- arms crossed (rage pose) -->
    <g class="arms-crossed">
      <rect x="14" y="52" width="22" height="4" rx="1.5" transform="rotate(-14 25 54)" />
      <rect x="28" y="52" width="22" height="4" rx="1.5" transform="rotate(14 39 54)" />
    </g>
    <rect class="eye-open" x="22" y="43.5" width="4.5" height="4.5" />
    <rect class="eye-open" x="37.5" y="43.5" width="4.5" height="4.5" />
    <rect class="eye-closed" x="21" y="45.25" width="6.5" height="1.6" rx="0.8" />
    <rect class="eye-closed" x="36.5" y="45.25" width="6.5" height="1.6" rx="0.8" />
    <g class="eyefx eyefx-heart" fill="#f472b6">
      <path d="M24.2 49 l-3 -3 a1.7 1.7 0 0 1 3 -2 a1.7 1.7 0 0 1 3 2 z" /><path d="M39.7 49 l-3 -3 a1.7 1.7 0 0 1 3 -2 a1.7 1.7 0 0 1 3 2 z" />
    </g>
    <g class="eyefx eyefx-dizzy" fill="none" stroke="#211f1c" stroke-width="0.9">
      <path class="spiral" d="M24.2 45.7 m2 0 a2 2 0 1 1 -2 -2 a1.2 1.2 0 1 1 1.2 1.2" /><path class="spiral" d="M39.7 45.7 m2 0 a2 2 0 1 1 -2 -2 a1.2 1.2 0 1 1 1.2 1.2" />
    </g>
    <g class="eyefx eyefx-x" stroke="#211f1c" stroke-width="1.2" stroke-linecap="round">
      <path d="M22 43.5 l4.5 4.5 M26.5 43.5 l-4.5 4.5 M37.5 43.5 l4.5 4.5 M42 43.5 l-4.5 4.5" />
    </g>
    <g class="eyefx eyefx-tears" fill="#38bdf8">
      <rect class="tear t1" x="23" y="48.5" width="1.6" height="2.6" rx="0.8" /><rect class="tear t2" x="38.5" y="48.5" width="1.6" height="2.6" rx="0.8" />
    </g>
    <g class="eyefx eyefx-happy" fill="none" stroke="#211f1c" stroke-width="1.3" stroke-linecap="round">
      <path d="M21.5 47 l2.8 -3 l2.8 3" /><path d="M37 47 l2.8 -3 l2.8 3" />
    </g>
    <g class="eyefx eyefx-angry" fill="#211f1c">
      <rect x="20.5" y="41" width="7" height="1.6" rx="0.8" transform="rotate(18 24 41.8)" /><rect x="36.5" y="41" width="7" height="1.6" rx="0.8" transform="rotate(-18 40 41.8)" />
    </g>
    <g class="eyefx eyefx-sad" fill="#211f1c">
      <rect x="20.5" y="41" width="7" height="1.6" rx="0.8" transform="rotate(-18 24 41.8)" /><rect x="36.5" y="41" width="7" height="1.6" rx="0.8" transform="rotate(18 40 41.8)" />
    </g>
    <g class="eyefx eyefx-surprised">
      <circle cx="24.25" cy="45.75" r="3.4" fill="#f2efe8" /><circle cx="39.75" cy="45.75" r="3.4" fill="#f2efe8" /><circle cx="24.25" cy="45.75" r="1.6" fill="#211f1c" /><circle cx="39.75" cy="45.75" r="1.6" fill="#211f1c" />
      <ellipse cx="32" cy="50" rx="2.2" ry="1.4" fill="#211f1c" />
    </g>
    <g class="eyefx eyefx-wink" fill="#211f1c">
      <rect x="21" y="45.25" width="6.5" height="1.6" rx="0.8" /><rect x="37.5" y="43.5" width="4.5" height="4.5" fill="var(--eye-color)" />
    </g>
    <g class="eyefx eyefx-star" fill="#f2d16b">
      <polygon class="starpupil" points="24.25,41.5 25.5,44.5 28.7,44.7 26.2,46.7 27,49.9 24.25,48.2 21.5,49.9 22.3,46.7 19.8,44.7 23,44.5" /><polygon class="starpupil" points="39.75,41.5 41,44.5 44.2,44.7 41.7,46.7 42.5,49.9 39.75,48.2 37,49.9 37.8,46.7 35.3,44.7 38.5,44.5" />
    </g>
    <g class="eyefx eyefx-money" fill="#2fae3e">
      <text x="24.25" y="49" text-anchor="middle" font-size="7.5" font-weight="700" font-family="-apple-system, system-ui, sans-serif">$</text><text x="39.75" y="49" text-anchor="middle" font-size="7.5" font-weight="700" font-family="-apple-system, system-ui, sans-serif">$</text>
    </g>
    <g class="eyefx eyefx-sleepy" fill="#211f1c">
      <rect x="22" y="43.5" width="4.5" height="2.2" /><rect x="37.5" y="43.5" width="4.5" height="2.2" />
    </g>
    <g class="eyefx eyefx-suspicious" fill="#211f1c">
      <rect x="21" y="44.5" width="6.5" height="2" rx="0.6" /><rect x="36.5" y="44.5" width="6.5" height="2" rx="0.6" />
      <rect x="20.5" y="42" width="7" height="1.4" rx="0.7" /><rect x="36.5" y="42" width="7" height="1.4" rx="0.7" />
    </g>
    <g class="eyefx eyefx-roll">
      <rect x="22" y="43.5" width="4.5" height="4.5" fill="#f2efe8" /><rect x="37.5" y="43.5" width="4.5" height="4.5" fill="#f2efe8" />
      <rect class="rollpupil" x="23.3" y="44.8" width="1.9" height="1.9" fill="#211f1c" /><rect class="rollpupil" x="38.8" y="44.8" width="1.9" height="1.9" fill="#211f1c" />
    </g>
    <g class="eyefx eyefx-googly">
      <circle cx="24.25" cy="45.75" r="3.2" fill="#f2efe8" stroke="#211f1c" stroke-width="0.5" /><circle cx="39.75" cy="45.75" r="3.2" fill="#f2efe8" stroke="#211f1c" stroke-width="0.5" />
      <circle class="googly g1" cx="24.25" cy="45.75" r="1.5" fill="#211f1c" /><circle class="googly g2" cx="39.75" cy="45.75" r="1.5" fill="#211f1c" />
    </g>
    <g class="eyefx eyefx-laser">
      <rect class="beam" x="26.5" y="45" width="60" height="1.6" fill="#ff3b30" opacity="0.9" /><rect class="beam" x="42" y="45" width="60" height="1.6" fill="#ff3b30" opacity="0.9" />
    </g>
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
    <!-- guns: wrapped in an aim group that rotates toward the cursor -->
    <g class="gun-aim">
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
    <!-- prop: sniper rifle with a scope; one shot at a time -->
    <g class="prop prop-sniper">
      <g class="sn-body">
        <rect x="34" y="50" width="11" height="4.5" rx="1" fill="#4b3a2a" />
        <rect x="43" y="48.5" width="16" height="4" fill="#2f3136" />
        <rect x="58" y="49.5" width="16" height="1.8" fill="#26282c" />
        <rect x="47" y="45" width="9" height="2.6" rx="1.3" fill="#1f2937" />
        <rect x="55.5" y="45.3" width="2" height="2" fill="#38bdf8" />
        <rect x="49" y="47.5" width="1.5" height="1.2" fill="#1f2937" />
        <rect x="61" y="51.3" width="1.2" height="4" fill="#26282c" transform="rotate(-20 61 51)" /><rect x="63" y="51.3" width="1.2" height="4" fill="#26282c" transform="rotate(20 63 51)" />
        <rect x="41" y="52" width="5" height="4" rx="1" fill="#da7756" stroke="#211f1c" stroke-width="0.5" />
      </g>
      <polygon class="muzzle" points="74,50.5 82,46 77,50.5 83,51 77,51.5 82,55" fill="#ffd166" />
    </g>
    </g>
  </g>
  <!-- costumes: worn on the head/face, independent of pose -->
  <g class="costume costume-dog">
    <rect x="12" y="37" width="6" height="12" rx="2" fill="#b85f3c" />
    <rect x="46" y="37" width="6" height="12" rx="2" fill="#b85f3c" />
    <rect x="27" y="47" width="10" height="4" rx="2" fill="#e8a37f" />
    <rect x="30.5" y="46" width="3" height="2" rx="1" fill="#211f1c" />
    <rect class="dog-tail" x="59" y="52" width="6" height="2" rx="1" fill="#b85f3c" />
  </g>
  <g class="costume costume-unicorn">
    <polygon points="29,39 35,39 32,25" fill="#f2efe8" stroke="#211f1c" stroke-width="0.6" />
    <polygon points="30,35 34,35 33.2,32 30.8,32" fill="#f472b6" />
    <polygon points="30.8,31 33.2,31 32.6,28.5 31.4,28.5" fill="#38bdf8" />
    <rect x="15" y="39" width="4" height="9" rx="2" fill="#f472b6" />
    <rect x="14" y="43" width="4" height="7" rx="2" fill="#8b5cf6" />
    <circle class="sparkle s1" cx="27" cy="27" r="1" fill="#fff" />
    <circle class="sparkle s2" cx="37" cy="30" r="1" fill="#fff" />
  </g>
  <g class="costume costume-crown">
    <polygon points="20,39 20,30 25,35 32,28 39,35 44,30 44,39" fill="#f2a200" stroke="#a86a00" stroke-width="0.6" />
    <circle cx="25" cy="36.5" r="1" fill="#e2231a" /><circle cx="32" cy="35" r="1" fill="#38bdf8" /><circle cx="39" cy="36.5" r="1" fill="#2fae3e" />
  </g>
  <g class="costume costume-partyhat">
    <polygon points="24,39 40,39 32,22" fill="#38bdf8" />
    <polygon points="26.5,34 37.5,34 35.5,30 28.5,30" fill="#f2a200" />
    <polygon points="29.5,28 34.5,28 33.2,25.5 30.8,25.5" fill="#f472b6" />
    <circle cx="32" cy="22" r="2" fill="#f2efe8" />
  </g>
  <g class="costume costume-shades">
    <rect x="19.5" y="42.5" width="9" height="5.5" rx="1.5" fill="#111" />
    <rect x="35.5" y="42.5" width="9" height="5.5" rx="1.5" fill="#111" />
    <rect x="28.5" y="44" width="7" height="1.4" fill="#111" />
    <rect x="21" y="43.5" width="3" height="1" fill="#fff" opacity="0.5" /><rect x="37" y="43.5" width="3" height="1" fill="#fff" opacity="0.5" />
  </g>
  <g class="costume costume-halo">
    <ellipse class="halo" cx="32" cy="32" rx="9" ry="2.4" fill="none" stroke="#f2d16b" stroke-width="1.6" />
  </g>
  <g class="costume costume-devil">
    <polygon points="19,39 24,39 20,31" fill="#e2231a" />
    <polygon points="40,39 45,39 44,31" fill="#e2231a" />
    <path class="devil-tail" d="M60 54 q6 -2 5 5" fill="none" stroke="#e2231a" stroke-width="1.6" stroke-linecap="round" />
    <polygon points="63,58 67,59 64,62" fill="#e2231a" />
  </g>
  <g class="costume costume-wizard">
    <polygon points="20,39 44,39 34,16" fill="#5b3fb8" />
    <rect x="15" y="38" width="34" height="2.5" rx="1" fill="#5b3fb8" />
    <polygon points="31,30 32.5,26.5 34,30 37.5,30.5 35,33 35.5,36.5 32.5,34.8 29.5,36.5 30,33 27.5,30.5" fill="#f2d16b" transform="scale(0.55) translate(26 18)" />
  </g>
  <g class="costume costume-cat">
    <polygon points="18,40 21,30 26,39" fill="#da7756" stroke="#211f1c" stroke-width="0.5" />
    <polygon points="38,39 43,30 46,40" fill="#da7756" stroke="#211f1c" stroke-width="0.5" />
    <polygon points="20,38 21.5,33 24,38" fill="#f4a7c0" />
    <polygon points="40,38 42.5,33 44,38" fill="#f4a7c0" />
    <rect x="16" y="47" width="6" height="0.7" fill="#211f1c" /><rect x="15.5" y="49" width="6" height="0.7" fill="#211f1c" />
    <rect x="42" y="47" width="6" height="0.7" fill="#211f1c" /><rect x="42.5" y="49" width="6" height="0.7" fill="#211f1c" />
  </g>
  <g class="costume costume-tophat">
    <rect x="22" y="24" width="20" height="15" fill="#1a1a1e" />
    <rect x="17" y="38" width="30" height="2.5" rx="1" fill="#1a1a1e" />
    <rect x="22" y="34" width="20" height="2.5" fill="#e2231a" />
  </g>
  <g class="costume costume-santa">
    <path d="M18 39 q14 -12 27 -2 l1 2 z" fill="#e2231a" /><rect x="16" y="37" width="32" height="3" rx="1.5" fill="#f2efe8" /><circle cx="46" cy="36" r="2.2" fill="#f2efe8" />
  </g>
  <g class="costume costume-pumpkin">
    <ellipse cx="32" cy="34" rx="8" ry="5.5" fill="#f28c28" /><rect x="31" y="27" width="2" height="3" fill="#2d6b2a" />
    <polygon points="28,32 30,34 26,34" fill="#211f1c" /><polygon points="36,32 38,34 34,34" fill="#211f1c" /><path d="M27 36 q5 3 10 0" fill="none" stroke="#211f1c" stroke-width="0.9" />
  </g>
  <g class="costume costume-bunny">
    <rect x="21" y="22" width="5" height="18" rx="2.5" fill="#f2efe8" stroke="#211f1c" stroke-width="0.5" /><rect x="22.5" y="25" width="2" height="12" rx="1" fill="#f4a7c0" />
    <rect x="38" y="22" width="5" height="18" rx="2.5" fill="#f2efe8" stroke="#211f1c" stroke-width="0.5" /><rect x="39.5" y="25" width="2" height="12" rx="1" fill="#f4a7c0" />
  </g>
  <!-- pets: a small companion beside the feet -->
  <g class="pet pet-duck">
    <rect x="55" y="61" width="8" height="7" rx="3" fill="#f2d16b" /><rect x="60" y="58" width="5" height="5" rx="2" fill="#f2d16b" /><rect x="64.5" y="60" width="3" height="1.6" fill="#f28c28" /><rect x="62" y="59.5" width="1" height="1" fill="#211f1c" />
  </g>
  <g class="pet pet-cat">
    <rect x="55" y="61" width="9" height="7" rx="2" fill="#8c8c96" /><rect x="60" y="57" width="5" height="5" fill="#8c8c96" /><polygon points="60,57 61,54.5 62,57" fill="#8c8c96" /><polygon points="63,57 64,54.5 65,57" fill="#8c8c96" /><rect x="61" y="58.5" width="1" height="1" fill="#211f1c" /><rect x="63" y="58.5" width="1" height="1" fill="#211f1c" />
  </g>
  <g class="pet pet-blob">
    <path d="M55 68 q0 -8 5 -8 q5 0 5 8 z" fill="#2fae3e" /><rect x="58" y="63" width="1.2" height="1.2" fill="#211f1c" /><rect x="61" y="63" width="1.2" height="1.2" fill="#211f1c" />
  </g>
  <g class="pet pet-dog">
    <rect x="54" y="61" width="10" height="7" rx="2" fill="#b07a4a" /><rect x="60" y="57" width="6" height="6" rx="1.5" fill="#b07a4a" /><rect x="59" y="56" width="2" height="4" rx="1" fill="#7d5230" /><rect x="65" y="56" width="2" height="4" rx="1" fill="#7d5230" /><rect x="63" y="58.5" width="1" height="1" fill="#211f1c" /><rect x="66" y="60" width="1.6" height="1.2" fill="#211f1c" /><rect class="pet-tail" x="52" y="61" width="3" height="1.6" rx="0.8" fill="#7d5230" />
  </g>
  <g class="pet pet-bunny">
    <rect x="55" y="61" width="9" height="7" rx="3" fill="#f2efe8" /><rect x="60" y="57" width="5" height="5" rx="2" fill="#f2efe8" /><rect x="60" y="51" width="1.8" height="7" rx="0.9" fill="#f2efe8" /><rect x="63" y="51" width="1.8" height="7" rx="0.9" fill="#f2efe8" /><rect x="60.5" y="52" width="0.8" height="5" fill="#f4a7c0" /><rect x="63.5" y="52" width="0.8" height="5" fill="#f4a7c0" /><rect x="62" y="58.5" width="1" height="1" fill="#211f1c" /><rect x="64" y="60" width="1" height="0.8" fill="#f4a7c0" />
  </g>
  <g class="pet pet-parrot">
    <rect x="50" y="18" width="5" height="7" rx="2.5" fill="#2fae3e" /><rect x="51" y="15" width="4" height="4" rx="2" fill="#e2231a" /><rect x="54.5" y="16.5" width="2" height="1.4" rx="0.5" fill="#f2a200" /><rect x="52" y="16" width="0.9" height="0.9" fill="#211f1c" /><rect x="48" y="21" width="3" height="2" rx="1" fill="#38bdf8" /><rect x="51.5" y="25" width="1" height="1.5" fill="#f2a200" /><rect x="53" y="25" width="1" height="1.5" fill="#f2a200" />
  </g>
  <g class="pet pet-frog">
    <rect x="55" y="63" width="9" height="5" rx="2.5" fill="#5fbf5a" /><circle cx="57.5" cy="62.5" r="1.4" fill="#5fbf5a" /><circle cx="61.5" cy="62.5" r="1.4" fill="#5fbf5a" /><rect x="57" y="62" width="1" height="1" fill="#211f1c" /><rect x="61" y="62" width="1" height="1" fill="#211f1c" /><rect class="tongue" x="63" y="65" width="0.8" height="1" fill="#f472b6" />
  </g>
  <g class="pet pet-snail">
    <circle cx="60" cy="64.5" r="3.5" fill="#f2a200" /><circle cx="60" cy="64.5" r="2" fill="none" stroke="#a86a00" stroke-width="0.8" /><rect x="54" y="65" width="9" height="3" rx="1.5" fill="#c9c0a0" /><rect x="53.5" y="62.5" width="0.8" height="3" fill="#c9c0a0" /><rect x="55" y="62.5" width="0.8" height="3" fill="#c9c0a0" />
  </g>
  <g class="pet pet-dragon">
    <rect x="53" y="60" width="11" height="7" rx="3" fill="#8b5cf6" /><rect x="60" y="56" width="6" height="5" rx="2" fill="#8b5cf6" /><polygon class="wing" points="55,60 51,53 58,58" fill="#a78bfa" /><rect x="63" y="57.5" width="1" height="1" fill="#f2d16b" /><rect x="50" y="62" width="4" height="2" rx="1" fill="#8b5cf6" /><polygon class="fire" points="66,58 71,56.5 69,59 72,60 67,60.5" fill="#f28c28" />
  </g>
  <!-- pet reaction bubble -->
  <text class="pet-mark" x="62" y="54" text-anchor="middle" font-size="6" font-weight="700" fill="#f2efe8">!</text>
  <!-- effects: weather and growing things -->
  <g class="effect effect-rain">
    <path d="M22 4 a5 5 0 0 1 9 -2 a4 4 0 0 1 7 3 h-16 z" fill="#8f96a3" /><rect x="20" y="4" width="20" height="3" rx="1.5" fill="#8f96a3" />
    <rect class="drop d1" x="23" y="8" width="1.2" height="3" rx="0.6" fill="#38bdf8" /><rect class="drop d2" x="29" y="8" width="1.2" height="3" rx="0.6" fill="#38bdf8" /><rect class="drop d3" x="35" y="8" width="1.2" height="3" rx="0.6" fill="#38bdf8" />
  </g>
  <g class="effect effect-sun">
    <g class="rays" fill="#f2a200"><rect x="9.3" y="-1" width="1.4" height="4" /><rect x="9.3" y="7" width="1.4" height="4" /><rect x="4" y="4.3" width="4" height="1.4" /><rect x="12" y="4.3" width="4" height="1.4" /></g>
    <circle cx="10" cy="5" r="3.2" fill="#f2d16b" />
  </g>
  <g class="effect effect-snow" fill="#f2efe8">
    <rect class="flake f1" x="10" y="0" width="1.6" height="1.6" /><rect class="flake f2" x="30" y="0" width="1.6" height="1.6" /><rect class="flake f3" x="50" y="0" width="1.6" height="1.6" /><rect class="flake f4" x="20" y="0" width="1.2" height="1.2" /><rect class="flake f5" x="42" y="0" width="1.2" height="1.2" />
  </g>
  <g class="effect effect-sparkles" fill="#f2d16b">
    <polygon class="spk k1" points="12,34 13,37 16,38 13,39 12,42 11,39 8,38 11,37" /><polygon class="spk k2" points="54,28 55,31 58,32 55,33 54,36 53,33 50,32 53,31" /><polygon class="spk k3" points="48,44 48.7,46 50.7,46.7 48.7,47.4 48,49.4 47.3,47.4 45.3,46.7 47.3,46" />
  </g>
  <g class="effect effect-fire">
    <path class="flame" d="M12 68 q3 -8 6 0 q1 -5 3 0 q-2 6 -9 6 z" fill="#f28c28" /><path class="flame" d="M42 68 q3 -8 6 0 q1 -5 3 0 q-2 6 -9 6 z" fill="#f28c28" /><path class="flame" d="M27 68 q3 -6 6 0 q-1 5 -6 5 z" fill="#f2a200" />
  </g>
  <g class="effect effect-beard">
    <path class="beard" d="M22 51 q10 6 20 0 v3 q-10 8 -20 0 z" fill="#5a4636" />
  </g>
  <!-- speech bubble pose -->
  <g class="prop prop-bubble">
    <rect x="30" y="0" width="34" height="13" rx="4" fill="#f2efe8" stroke="#211f1c" stroke-width="0.8" />
    <polygon points="40,12.6 44,12.6 42,18" fill="#f2efe8" stroke="#211f1c" stroke-width="0.8" /><rect x="40.5" y="11.5" width="3" height="2" fill="#f2efe8" />
    <text class="bubble-text" x="47" y="9" text-anchor="middle" textLength="28" lengthAdjust="spacingAndGlyphs">BRB</text>
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
  <!-- one mini rig per other agent (subagent, teammate, ralph/ultrawork worker) -->
  <g class="minions"></g>
  <!-- the agents roster, a tasks-label-style list of who is doing what -->
  <g class="agents-label"></g>
</svg>`;

  const POSES = ['none', 'think', 'wave', 'thumbs', 'sleep', 'blink', 'nod', 'bounce', 'look', 'spin', 'party', 'guitar', 'ak47', 'sniper', 'banner', 'bubble', 'tap', 'arms', 'run', 'knock', 'munch', 'kickflip', 'selfie', 'grin', 'smoke', 'zyn', 'line', 'juice', 'dead'];
  const EVENTS = ['ufo', 'portal', 'meteor'];
  const LAMP_FX = ['none', 'pulse', 'strobe', 'breathe', 'flicker', 'chase', 'police', 'rainbow', 'all', 'sos'];
  const COSTUMES = ['none', 'dog', 'cat', 'unicorn', 'crown', 'partyhat', 'shades', 'halo', 'devil', 'wizard', 'tophat', 'santa', 'pumpkin', 'bunny'];
  const BODIES = ['claude', 'dog', 'cat', 'frog', 'robot', 'ghost'];
  const EYE_MOODS = ['heart', 'happy', 'angry', 'sad', 'surprised', 'wink', 'star', 'money', 'sleepy', 'suspicious', 'roll', 'googly', 'dizzy', 'x', 'tears', 'laser'];
  const EFFECTS = ['none', 'rain', 'sun', 'snow', 'sparkles', 'fire', 'beard', 'garden'];
  const PETS = ['none', 'duck', 'cat', 'blob', 'dog', 'bunny', 'parrot', 'frog', 'snail', 'dragon'];
  const DEFAULT_TEXT = 'INPUT NEEDED';
  const SLOT_COLORS = { red: '#e2231a', amber: '#f2a200', green: '#2fae3e', blue: '#2f6bff', pink: '#f472b6' };
  const SIGNS = ['h3', 'v3', 'h1', 'h5'];
  const LAMP_SHAPES = ['square', 'round', 'heart', 'star', 'skull'];
  const SIGN_FX = ['none', 'wobble', 'spin', 'rattle', 'cracked', 'neon'];

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
      const fx = LAMP_FX.includes(look.lampFx) ? look.lampFx : 'none';
      const groupFx = fx === 'chase' || fx === 'police' || fx === 'all';
      const sign = SIGNS.includes(look.sign) ? look.sign : 'h3';
      for (const sg of SIGNS) svg.classList.toggle(`sign-${sg}`, sign === sg);
      const shape = LAMP_SHAPES.includes(look.lampShape) ? look.lampShape : 'square';
      for (const el of lamps) {
        // a single-lamp sign lights in whatever colour the state has
        const on = (lit && (el.dataset.slot === lit || el.dataset.slot === 'any')) || groupFx;
        el.classList.toggle('on', !!on);
        // pulse is the original green behaviour unless a rule chose an effect
        el.classList.toggle('pulse', !!on && fx === 'none' && lit === 'green' && !look.lampColor);
        const href = `#lamp-${shape}`;
        if (el.getAttribute('href') !== href) el.setAttribute('href', href);
        if (el.dataset.slot === 'blue' || el.dataset.slot === 'pink') el.style.setProperty('--slot-color', SLOT_COLORS[el.dataset.slot]);
      }
      const signFx = SIGN_FX.includes(look.signFx) ? look.signFx : 'none';
      if (!current || current.signFx !== signFx) {
        for (const f of SIGN_FX) svg.classList.remove(`signfx-${f}`);
        if (signFx !== 'none') svg.classList.add(`signfx-${signFx}`);
      }
      // number mode: a digit replaces the lamps
      const num = svg.querySelector('.sign-number');
      const numText = look.number == null ? '' : String(look.number);
      if (num.textContent !== numText) num.textContent = numText;
      svg.classList.toggle('number-mode', numText !== '');
      if (!current || current.lampFx !== fx) {
        for (const f of LAMP_FX) svg.classList.remove(`lampfx-${f}`);
        if (fx !== 'none') svg.classList.add(`lampfx-${fx}`);
      }
      svg.style.setProperty('--lamp-on', color || 'var(--lamp-off)');
      svg.style.setProperty('--lamp-glow', color ? hexToRgba(color, 0.85) : 'transparent');

      const eyes = look.eyes || 'default';
      svg.classList.toggle('eyes-closed', eyes === 'closed');
      for (const m of EYE_MOODS) svg.classList.toggle(`eyes-${m}`, eyes === m);
      svg.style.setProperty('--eye-color', /^#/.test(eyes) ? eyes : eyes === 'laser' ? '#ff3b30' : '#211f1c');

      const body = BODIES.includes(look.body) ? look.body : 'claude';
      for (const b of BODIES) svg.classList.toggle(`body-${b}`, body === b);
      svg.style.setProperty('--body-color', /^#[0-9a-f]{6}$/i.test(look.bodyColor || '') ? look.bodyColor : '#da7756');
      const effect = EFFECTS.includes(look.effect) ? look.effect : 'none';
      for (const e of EFFECTS) svg.classList.toggle(`effect-${e}`, effect === e);
      svg.dataset.gardenSpeed = String(look.gardenSpeed || 1);
      if (effect === 'garden' && (!current || current.effect !== 'garden')) plantGarden();
      if (effect !== 'garden' && current && current.effect === 'garden') clearGarden();
      const pet = PETS.includes(look.pet) ? look.pet : 'none';
      for (const pp of PETS) svg.classList.toggle(`pet-${pp}`, pet === pp);
      // Beard length follows how long you've kept Claude waiting (0–30 min).
      const wait = Math.max(0, Math.min(30, Number(look.waitMinutes) || 0));
      svg.style.setProperty('--beard', String(0.3 + (wait / 30) * 2.2));

      const pose = POSES.includes(look.pose) ? look.pose : 'none';
      // Only touch pose classes on a real change so a poll doesn't restart
      // an infinite animation mid-swing (visible stutter).
      if (!current || current.pose !== pose) {
        for (const p of POSES) svg.classList.remove(`pose-${p}`);
        if (pose !== 'none') svg.classList.add(`pose-${pose}`);
        scheduleFlips(pose === 'kickflip');
        scheduleLines(pose === 'line');
      }
      // Garden actions on the real screen are driven by the main process.
      const act = look.gardenAct || null;
      for (const a of ['walking', 'carrying', 'pouring', 'watering', 'processing', 'smashing', 'lounging']) svg.classList.toggle(a, act === a);
      if (act === 'eating') { svg.classList.add('eating', look.facing === 'left' ? 'eat-left' : 'eat-right'); } else if (!garden) svg.classList.remove('eating', 'eat-left', 'eat-right');
      svg.classList.toggle('grumpy', !!look.grumpy);
      // Gardening needs room: the view widens to three widths, Claude centred.
      const wide = effect === 'garden';
      const vb = wide ? '-64 0 192 82' : '0 0 64 82';
      if (svg.getAttribute('viewBox') !== vb) svg.setAttribute('viewBox', vb);
      if (!wide) svg.classList.toggle('face-left', look.facing === 'left');
      // Gun elevation toward the cursor, degrees, positive = downward.
      const aim = Math.max(-35, Math.min(35, Number(look.aimAngle) || 0));
      svg.style.setProperty('--aim', `${look.facing === 'left' ? -aim : aim}deg`);
      const costume = COSTUMES.includes(look.costume) ? look.costume : 'none';
      if (!current || current.costume !== costume) {
        for (const c of COSTUMES) svg.classList.remove(`costume-${c}`);
        if (costume !== 'none') svg.classList.add(`costume-${costume}`);
      }
      const text = (look.text || DEFAULT_TEXT).toUpperCase().slice(0, 24);
      const t = svg.querySelector('.banner-text');
      if (t.textContent !== text) t.textContent = text;
      const tl = svg.querySelector('.tasks-label');
      const tasksText = look.tasks && look.tasks.created > 0 ? `${look.tasks.done}/${look.tasks.created}` : '';
      if (tl.textContent !== tasksText) tl.textContent = tasksText;
      // Chips for every other agent; the roster only while you're hovering,
      // so it never sits on top of Claude.
      drawMinions(look.minions, !!look.showRoster);
      const bt = svg.querySelector('.bubble-text');
      const btext = (look.text || 'BRB').toUpperCase().slice(0, 12);
      if (bt.textContent !== btext) bt.textContent = btext;
      current = { ...look, pose, costume, lampFx: fx, signFx };
    }

    let eventTimer = null;
    // One-shot rare event: plays its animation once then clears.
    function playEvent(name, ms = 4200) {
      if (!EVENTS.includes(name)) return;
      for (const e of EVENTS) svg.classList.remove(`event-${e}`);
      void svg.getBoundingClientRect();
      svg.classList.add(`event-${name}`);
      clearTimeout(eventTimer);
      eventTimer = setTimeout(() => svg.classList.remove(`event-${name}`), ms);
    }
    let reactTimer = null;
    // Short reaction that temporarily overrides the look (poke, pet, feed).
    function react(patch, ms = 1600) {
      const base = current;
      if (!base) return;
      setLook({ ...base, ...patch });
      clearTimeout(reactTimer);
      reactTimer = setTimeout(() => { if (current) setLook({ ...current, ...base, aimAngle: current.aimAngle, facing: current.facing }); }, ms);
    }
    // ── Garden: a staged lifecycle. Times are real; `speed` multiplies the
    // clock (the editor previews at 30x).
    //   fetch (2 min): walk off-screen, come back with a pot, place it; ×5
    //   plant (3 min): per pot — pour dirt, drop a seed, water it
    //   grow: sprouts → full crop; then eat one edible piece every 20 s
    //   rotate: 10 min after the first bite, pull the crops and replant
    const G = { FETCH: 120000, PLANT: 180000, GROW: 120000, EAT_EVERY: 20000, ROTATE: 600000, POTS: 5 };
    const POT_X = [-50, -26, 40, 66, 92];
    const CROPS = [
      { kind: 'carrot', edible: 3, color: '#f28c28', draw: (g, x, k) => { g.appendChild(mk('path', { d: `M${x - 2} 56 h4 l-2 6 z`, fill: '#f28c28', class: `crop edible bite bite-${k}` })); g.appendChild(mk('path', { d: `M${x} 56 l-2.5 -4 M${x} 56 l2.5 -4 M${x} 56 v-4.5`, stroke: '#2fae3e', 'stroke-width': 0.9, fill: 'none', class: 'crop' })); } },
      { kind: 'tomato', edible: 3, color: '#e2231a', draw: (g, x, k) => { g.appendChild(mk('rect', { x: x - 0.5, y: 44, width: 1, height: 14, fill: '#2f8a3a', class: 'crop' })); [[-2.5, 48], [2.5, 51], [0, 45]].forEach(([dx, dy], i) => g.appendChild(mk('circle', { cx: x + dx, cy: dy, r: 1.6, fill: '#e2231a', class: `crop edible bite bite-${k}-${i}` }))); } },
      { kind: 'berries', edible: 3, color: '#5b3fb8', draw: (g, x, k) => { g.appendChild(mk('ellipse', { cx: x, cy: 53, rx: 4, ry: 3.5, fill: '#2f8a3a', class: 'crop' })); [[-1.8, -1], [1.8, 0], [0, 1.4]].forEach(([dx, dy], i) => g.appendChild(mk('circle', { cx: x + dx, cy: 53 + dy, r: 1, fill: '#5b3fb8', class: `crop edible bite bite-${k}-${i}` }))); } },
      { kind: 'sunflower', edible: 1, color: '#f2a200', draw: (g, x, k) => { g.appendChild(mk('rect', { x: x - 0.5, y: 42, width: 1, height: 16, fill: '#2fae3e', class: 'crop' })); for (let i = 0; i < 8; i += 1) { const a = (i / 8) * Math.PI * 2; g.appendChild(mk('ellipse', { cx: x + Math.cos(a) * 2.8, cy: 42 + Math.sin(a) * 2.8, rx: 1.3, ry: 0.8, fill: '#f2a200', transform: `rotate(${(a * 180) / Math.PI} ${x + Math.cos(a) * 2.8} ${42 + Math.sin(a) * 2.8})`, class: 'crop' })); } g.appendChild(mk('circle', { cx: x, cy: 42, r: 1.9, fill: '#5a3a1a', class: `crop edible bite bite-${k}` })); } },
      { kind: 'apple', edible: 4, color: '#e2231a', draw: (g, x, k) => { g.appendChild(mk('rect', { x: x - 1, y: 46, width: 2, height: 12, fill: '#6b4420', class: 'crop' })); g.appendChild(mk('circle', { cx: x, cy: 44, r: 6, fill: '#2f8a3a', class: 'crop' })); [[-3, 42], [2.5, 41], [3, 46], [-1.5, 47]].forEach(([dx, dy], i) => g.appendChild(mk('circle', { cx: x + dx, cy: dy, r: 1.1, fill: '#e2231a', class: `crop edible bite bite-${k}-${i}` }))); } },
      { kind: 'flowers', edible: 0, color: '#f472b6', draw: (g, x) => { const c = ['#f472b6', '#38bdf8', '#a78bfa'][Math.floor(Math.random() * 3)]; g.appendChild(mk('rect', { x: x - 0.5, y: 50, width: 1, height: 8, fill: '#2fae3e', class: 'crop' })); [[-2, -1], [2, -1], [0, -3], [0, 1]].forEach(([dx, dy]) => g.appendChild(mk('circle', { cx: x + dx, cy: 50 + dy, r: 1.5, fill: c, class: 'crop' }))); g.appendChild(mk('circle', { cx: x, cy: 50, r: 1.1, fill: '#f2d16b', class: 'crop' })); } },
    ];
    const ns = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };

    // ── Other agents ────────────────────────────────────────────────────────
    // One 12px mini rig per live agent, in a row under Claude's feet, coloured
    // by what that agent is doing. Eight is the most that fits; the rest
    // collapse into a "+N". Each chip carries its name so the widget can show
    // a bubble on click.
    const MINION_FILL = { working: '#2fae3e', waiting: '#f2a200', done: '#726c62' };
    const MINION_MAX = 5;
    const ROSTER_MAX = 5;
    const MINION_SCALE = 1.35;
    // "3m", "48s", "1h12m" — short enough for the roster's fixed-width column.
    function elapsed(since, now) {
      if (!since) return '';
      const ms = Math.max(0, now - new Date(since).getTime());
      const s = Math.floor(ms / 1000);
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m`;
      return `${Math.floor(m / 60)}h${m % 60}m`;
    }
    let minionKey = null;
    function drawMinions(list, showRoster) {
      const now = Date.now();
      const arr = (Array.isArray(list) ? list : []).slice(0, 32);
      // Elapsed time is bucketed to the minute (seconds while under a minute)
      // so the roster's "since" column keeps ticking without redrawing the
      // whole row on every 2s poll.
      const key = `${showRoster ? 1 : 0}|${arr.map((a) => `${a.name}:${a.status}:${elapsed(a.since, now)}`).join(',')}`;
      if (key === minionKey) return;
      minionKey = key;
      const g = svg.querySelector('.minions');
      const r = svg.querySelector('.agents-label');
      while (g.firstChild) g.removeChild(g.firstChild);
      while (r.firstChild) r.removeChild(r.firstChild);
      if (!arr.length) return;
      const shown = arr.slice(0, MINION_MAX);
      const extra = arr.length - shown.length;
      const pitch = 6.9 * MINION_SCALE + 1.6;
      const width = shown.length * pitch - 1.6 + (extra > 0 ? pitch : 0);
      const x0 = 32 - width / 2;
      // A translucent backdrop so the row reads clearly over any desktop
      // background instead of blending into it.
      g.appendChild(mk('rect', {
        x: x0 - 2.5, y: 69.2, width: width + 5, height: 6.9 * MINION_SCALE + 3.6, rx: 2.4,
        fill: '#151517', 'fill-opacity': 0.55,
      }));
      shown.forEach((a, i) => {
        const fill = MINION_FILL[a.status] || MINION_FILL.working;
        const chip = mk('g', {
          class: `minion minion-${a.status}`,
          transform: `translate(${x0 + i * pitch} 71) scale(${MINION_SCALE})`,
          'data-name': a.name, 'data-status': a.status, style: 'pointer-events:auto;cursor:pointer',
        });
        const inner = mk('g', { class: 'minion-in' });
        inner.appendChild(mk('rect', { x: 0.7, y: 0, width: 5.5, height: 4, rx: 1, fill }));
        inner.appendChild(mk('rect', { x: 2, y: 1.3, width: 1.1, height: 1.5, fill: '#211f1c' }));
        inner.appendChild(mk('rect', { x: 3.8, y: 1.3, width: 1.1, height: 1.5, fill: '#211f1c' }));
        inner.appendChild(mk('rect', { x: 0, y: 4.5, width: 6.9, height: 1.6, fill }));
        inner.appendChild(mk('rect', { x: 1.2, y: 6.1, width: 1.4, height: 1.4, fill }));
        inner.appendChild(mk('rect', { x: 4.3, y: 6.1, width: 1.4, height: 1.4, fill }));
        chip.appendChild(inner);
        const title = mk('title', {});
        title.textContent = `${a.name} — ${a.status}${a.since ? ` (${elapsed(a.since, now)})` : ''}`;
        chip.appendChild(title);
        g.appendChild(chip);
      });
      if (extra > 0) {
        const more = mk('text', { class: 'minion-more', x: x0 + shown.length * pitch + 2.4, y: 75.6, 'text-anchor': 'middle' });
        more.textContent = `+${extra}`;
        g.appendChild(more);
      }
      if (!showRoster) return;
      // The roster: who is doing what and for how long, capped at five lines,
      // over the torso.
      const lines = arr.slice(0, ROSTER_MAX);
      const rows = lines.length + (arr.length > ROSTER_MAX ? 1 : 0);
      r.appendChild(mk('rect', { x: 5, y: 39.5, width: 54, height: rows * 4.6 + 1.8, rx: 1.5, fill: '#151517', 'fill-opacity': 0.82 }));
      lines.forEach((a, i) => {
        const t = mk('text', { class: 'agent-line', x: 7.5, y: 44.2 + i * 4.6 });
        t.textContent = `${a.name}`.slice(0, 11).toUpperCase();
        r.appendChild(t);
        const time = mk('text', { class: 'agent-line agent-time', x: 51.5, y: 44.2 + i * 4.6, 'text-anchor': 'end' });
        time.textContent = elapsed(a.since, now);
        r.appendChild(time);
        r.appendChild(mk('rect', { x: 54.5, y: 41.2 + i * 4.6, width: 2.6, height: 2.6, rx: 0.7, fill: MINION_FILL[a.status] || MINION_FILL.working }));
      });
      if (arr.length > ROSTER_MAX) {
        const t = mk('text', { class: 'agent-line agent-more', x: 7.5, y: 44.2 + ROSTER_MAX * 4.6 });
        t.textContent = `+${arr.length - ROSTER_MAX} MORE`;
        r.appendChild(t);
      }
    }

    if (!svg.querySelector('.tools')) svg.querySelector('.mover').appendChild(drawTools());
    let garden = null;       // { t0, speed, pots:[{x, crop, planted, grown}], firstBite, lastBite, rotateAt, timer }
    const gardenEl = () => svg.querySelector('.garden');

    function drawPot(x) {
      const g = mk('g', { class: 'pot', style: `transform-origin:${x}px 68px` });
      g.appendChild(mk('path', { d: `M${x - 6} 58 h12 l-1.5 10 h-9 z`, fill: '#b8683a' }));
      g.appendChild(mk('rect', { x: x - 7, y: 57, width: 14, height: 2.4, rx: 0.8, fill: '#c9784a' }));
      g.appendChild(mk('path', { class: 'dirt', d: `M${x - 5.2} 59.5 h10.4 l-0.6 3 h-9.2 z`, fill: '#4a3222' }));
      g.appendChild(mk('circle', { class: 'seed', cx: x, cy: 60.5, r: 0.7, fill: '#f2d16b' }));
      const sp = mk('g', { class: 'sprout' }); sp.style.setProperty('--ox', `${x}px`); g.appendChild(sp);
      return g;
    }
    function drawTools() {
      const t = mk('g', { class: 'tools' });
      // carried pot (in hand), dirt bag, watering can — shown by phase classes
      const carry = mk('g', { class: 'carry-pot' }); carry.appendChild(mk('path', { d: 'M48 46 h9 l-1.2 7 h-6.6 z', fill: '#b8683a' })); carry.appendChild(mk('rect', { x: 47.2, y: 45.2, width: 10.6, height: 1.8, rx: 0.6, fill: '#c9784a' })); t.appendChild(carry);
      const bag = mk('g', { class: 'bag' }); bag.appendChild(mk('rect', { x: 47, y: 42, width: 9, height: 11, rx: 1.5, fill: '#8a5a2b' })); bag.appendChild(mk('rect', { x: 49, y: 45, width: 5, height: 2, fill: '#f2efe8' })); t.appendChild(bag);
      const can = mk('g', { class: 'can' }); can.appendChild(mk('rect', { x: 47, y: 45, width: 8, height: 7, rx: 1, fill: '#38bdf8' })); can.appendChild(mk('path', { d: 'M55 47 l6 -3', stroke: '#38bdf8', 'stroke-width': 1.6, 'stroke-linecap': 'round', fill: 'none' })); can.appendChild(mk('rect', { x: 49, y: 42.5, width: 4, height: 2.5, rx: 1.2, fill: '#38bdf8' })); t.appendChild(can);
      for (let i = 0; i < 3; i += 1) t.appendChild(mk('rect', { class: `waterdrop w${i}`, x: 61 + i * 1.6, y: 45, width: 1, height: 2.2, rx: 0.5, fill: '#7dd3fc' }));
      for (let i = 0; i < 4; i += 1) t.appendChild(mk('circle', { class: `dirtbit d${i}`, cx: 58, cy: 52, r: 0.8, fill: '#4a3222' }));
      return t;
    }
    function startGarden(speed = 1) {
      const g = gardenEl();
      g.innerHTML = '';
      g.appendChild(mk('rect', { class: 'bed', x: -60, y: 67.5, width: 184, height: 2, fill: '#3a2a1a' }));
      if (!svg.querySelector('.tools')) svg.querySelector('.mover').appendChild(drawTools());
      garden = { t0: performance.now(), speed, pots: [], firstBite: null, lastBite: 0, rotateAt: null, phase: 'fetch', step: -1 };
      svg.classList.add('gardening');
      clearInterval(garden.timer);
      garden.timer = setInterval(gardenTick, 250);
      gardenTick();
    }
    function stopGarden() {
      if (!garden) return;
      clearInterval(garden.timer);
      garden = null;
      gardenEl().innerHTML = '';
      svg.classList.remove('gardening', 'walking', 'phase-fetch', 'phase-plant', 'phase-grow', 'eating', 'eat-left', 'eat-right', 'carrying', 'pouring', 'watering', 'face-left');
      svg.style.removeProperty('--walk');
    }
    // Walk Claude to x (rig units, 32 = home). Legs run while moving.
    function walkTo(x) {
      const cur = Number(svg.style.getPropertyValue('--walk-target') || 0);
      const dx = x - 32;
      svg.style.setProperty('--walk', `${dx}px`);
      svg.style.setProperty('--walk-target', String(dx));
      svg.classList.toggle('face-left', dx < cur);
      svg.classList.add('walking');
      clearTimeout(garden.walkTimer);
      garden.walkTimer = setTimeout(() => svg.classList.remove('walking'), Math.max(300, 2600 / garden.speed));
    }
    function gardenTick() {
      if (!garden) return;
      const el = (performance.now() - garden.t0) * garden.speed;
      const g = gardenEl();
      const potSlot = (i) => POT_X[i];
      // ── fetch: 5 pots, each = walk out (edge), walk back, place
      if (el < G.FETCH) {
        setPhase('fetch');
        const per = G.FETCH / G.POTS;
        const i = Math.min(G.POTS - 1, Math.floor(el / per));
        const sub = (el - i * per) / per;   // 0..1 within this pot's cycle
        const edge = i % 2 ? -62 : 126;
        if (sub < 0.4) { svg.classList.remove('carrying'); if (garden.step !== i * 3) { garden.step = i * 3; walkTo(edge); } }
        else if (sub < 0.85) { svg.classList.add('carrying'); if (garden.step !== i * 3 + 1) { garden.step = i * 3 + 1; walkTo(potSlot(i) + (potSlot(i) < 32 ? 14 : -14)); } }
        else if (garden.step !== i * 3 + 2) { garden.step = i * 3 + 2; svg.classList.remove('carrying'); g.appendChild(drawPot(potSlot(i))); garden.pots.push({ x: potSlot(i), crop: null, planted: false }); }
        return;
      }
      // ── plant: per pot — walk over, pour dirt, seed, water
      if (el < G.FETCH + G.PLANT) {
        setPhase('plant');
        while (garden.pots.length < G.POTS) { const x = potSlot(garden.pots.length); g.appendChild(drawPot(x)); garden.pots.push({ x, crop: null, planted: false }); }
        const per = G.PLANT / G.POTS;
        const t = el - G.FETCH;
        const i = Math.min(G.POTS - 1, Math.floor(t / per));
        const sub = (t - i * per) / per;
        const pot = g.querySelectorAll('.pot')[i];
        if (garden.step !== 100 + i) { garden.step = 100 + i; walkTo(potSlot(i) + (potSlot(i) < 32 ? 14 : -14)); svg.classList.remove('pouring', 'watering'); }
        if (pot) {
          pot.classList.toggle('has-dirt', sub > 0.2);
          pot.classList.toggle('has-seed', sub > 0.55);
          pot.classList.toggle('watered', sub > 0.8);
        }
        svg.classList.toggle('pouring', sub > 0.1 && sub < 0.5);
        svg.classList.toggle('watering', sub > 0.6 && sub < 0.95);
        if (sub > 0.8 && !garden.pots[i].planted) garden.pots[i].planted = true;
        return;
      }
      // ── grow / eat / rotate
      setPhase('grow');
      svg.classList.remove('pouring', 'watering', 'carrying');
      if (garden.step < 1000) { garden.step = 1000; walkTo(32); g.querySelectorAll('.pot').forEach((p) => p.classList.add('has-dirt', 'has-seed', 'watered')); }
      const cycleStart = garden.rotateAt ?? (G.FETCH + G.PLANT);
      const gt = el - cycleStart;
      garden.pots.forEach((pot, i) => {
        const potEl = g.querySelectorAll('.pot')[i];
        if (!potEl) return;
        if (!pot.crop) {
          pot.crop = CROPS[Math.floor(Math.random() * CROPS.length)];
          const sp = potEl.querySelector('.sprout'); sp.innerHTML = ''; pot.crop.draw(sp, pot.x, `${i}`);
        }
        const growth = Math.min(1, gt / G.GROW);
        potEl.style.setProperty('--growth', String(growth));
        potEl.classList.toggle('mature', growth >= 1);
      });
      if (gt >= G.GROW) {
        const bites = Array.from(g.querySelectorAll('.pot.mature .bite:not(.eaten)'));
        if (bites.length && el - garden.lastBite >= G.EAT_EVERY) {
          garden.lastBite = el;
          if (garden.firstBite == null) garden.firstBite = el;
          const bite = bites[Math.floor(Math.random() * bites.length)];
          const bx = Number(bite.getAttribute('cx') ?? (bite.getAttribute('d') || '').match(/M(-?[\d.]+)/)?.[1] ?? 32);
          walkTo(bx + (bx < 32 ? 9 : -9));
          setTimeout(() => { if (!garden) return; svg.classList.add('eating', bx < 32 ? 'eat-left' : 'eat-right'); bite.classList.add('eaten'); setTimeout(() => svg.classList.remove('eating', 'eat-left', 'eat-right'), Math.max(300, 900 / garden.speed)); }, Math.max(200, 1800 / garden.speed));
        }
        // rotate crops 10 min after the first bite (and every 10 min after)
        if (garden.firstBite != null && el - garden.firstBite >= G.ROTATE * ((garden.rotations || 0) + 1)) {
          garden.rotations = (garden.rotations || 0) + 1;
          garden.rotateAt = el;
          garden.pots.forEach((pot, i) => { pot.crop = null; const potEl = g.querySelectorAll('.pot')[i]; potEl.classList.remove('mature'); potEl.style.setProperty('--growth', '0'); });
          walkTo(32);
        }
      }
    }
    function setPhase(p) {
      if (garden.phase === p && svg.classList.contains(`phase-${p}`)) return;
      garden.phase = p;
      for (const q of ['fetch', 'plant', 'grow']) svg.classList.toggle(`phase-${q}`, q === p);
    }
    // legacy names used by setLook
    function plantGarden() { startGarden(Number(svg.dataset.gardenSpeed) || 1); }
    function clearGarden() { stopGarden(); }

    // Kickflip: stands on the board, tricks once every 30 s.
    let flipTimer = null;
    function scheduleFlips(on) {
      clearInterval(flipTimer); flipTimer = null;
      svg.classList.remove('flip');
      if (!on) return;
      const flip = () => { svg.classList.remove('flip'); void svg.getBoundingClientRect(); svg.classList.add('flip'); setTimeout(() => svg.classList.remove('flip'), 1700); };
      flip();
      flipTimer = setInterval(flip, 30000);
    }
    // Line: does one every 40 s while the pose holds.
    let lineTimer = null;
    function scheduleLines(on) {
      clearInterval(lineTimer); lineTimer = null;
      svg.classList.remove('rail');
      if (!on) return;
      const go = () => { svg.classList.remove('rail'); void svg.getBoundingClientRect(); svg.classList.add('rail'); setTimeout(() => svg.classList.remove('rail'), 5200); };
      go();
      lineTimer = setInterval(go, 40000);
    }
    // Poke the pet: it reacts for a second and a half.
    let petTimer = null;
    function pokePet() {
      if (!current || !current.pet || current.pet === 'none') return false;
      svg.classList.remove('pet-react'); void svg.getBoundingClientRect(); svg.classList.add('pet-react');
      clearTimeout(petTimer); petTimer = setTimeout(() => svg.classList.remove('pet-react'), 1500);
      return true;
    }
    let flashTimer = null;
    // Sound-reactive: the lamps flicker for a beat when a sound fires.
    function flash(ms = 600) {
      svg.classList.remove('sound-flash');
      void svg.getBoundingClientRect();
      svg.classList.add('sound-flash');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => svg.classList.remove('sound-flash'), ms);
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

    return { svg, setLook, celebrate, burst, playEvent, react, flash, pokePet, get look() { return current; } };
  }

  window.mountRig = mountRig;
  window.RIG_POSES = POSES;
  window.RIG_COSTUMES = COSTUMES;
  window.RIG_BODIES = BODIES;
  window.RIG_EFFECTS = EFFECTS;
  window.RIG_PETS = PETS;
  window.RIG_EYE_MOODS = EYE_MOODS;
  window.RIG_EVENTS = EVENTS;
  window.RIG_LAMP_FX = LAMP_FX;
  window.RIG_SIGNS = SIGNS;
  window.RIG_LAMP_SHAPES = LAMP_SHAPES;
  window.RIG_SIGN_FX = SIGN_FX;
  window.RIG_DEFAULT_TEXT = DEFAULT_TEXT;
})();
