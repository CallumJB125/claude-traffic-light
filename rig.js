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
    <filter id="cig-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="0.7" /></filter>
    <linearGradient id="cig-wisp-fade" gradientUnits="userSpaceOnUse" x1="0" y1="46.6" x2="0" y2="34"><stop offset="0" stop-color="#e4e4ea" stop-opacity="0.85" /><stop offset="1" stop-color="#e4e4ea" stop-opacity="0" /></linearGradient>
    <filter id="cameo-seam" x="-50%" y="-100%" width="200%" height="300%"><feGaussianBlur stdDeviation="1" /></filter>
  </defs>
  <g class="scene">
  <g class="mover">
  <!-- sign-swing: the pendulum (rig.swing/lean) rotates the whole sign about
       its grip, on top of whatever the pose does to the sign itself -->
  <g class="sign-swing">
  <g class="sign-assembly">
    <!-- lamp-bloom: a glow that blooms off a newly lit lamp (behind the sign) -->
    <circle class="lamp-bloom" cx="0" cy="0" r="0" />
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
  </g><!-- /sign-swing -->
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
    <!-- cameos (back layer): hair, facial hair and collar, under the eyes so they stay alive -->
    <g class="cameo cameo-neo">
      <path d="M4 52h24l4 6 4-6h24v7H4z" fill="#2a2a33" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" /><path d="M28 52l4 6 4-6z" fill="#0c0c10" /><path d="M4.6 52.8h22.6l3.8 5.6M59.4 52.8H36.8l-3.8 5.6" stroke="#5a5a6a" stroke-width="0.7" fill="none" />
      <polygon points="14,53 14,47.5 18,47.5 21,53" fill="#2a2a33" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" /><polygon points="50,53 50,47.5 46,47.5 43,53" fill="#2a2a33" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
      <rect x="14.6" y="48.2" width="0.9" height="4.4" fill="#5a5a6a" /><rect x="48.5" y="48.2" width="0.9" height="4.4" fill="#5a5a6a" />
      <polygon points="15,51 15,38 16,38 16,36 18,36 18,35 46,35 46,36 48,36 48,38 49,38 49,51 46,51 46,43 44.5,43 44.5,41.5 40,41.5 40,40.5 34,40.5 34,42 31.5,42 31.5,40 28,40 28,41.5 23,41.5 23,42 19.5,42 19.5,43 18,43 18,51" fill="#15151b" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
      <rect x="21" y="36" width="8" height="1" fill="#3a3a46" /><rect x="35" y="36.5" width="7" height="0.8" fill="#3a3a46" /><rect x="16" y="40" width="0.8" height="8" fill="#3a3a46" />
    </g>
    <g class="cameo cameo-alfred">
      <rect x="4" y="52" width="56" height="7" fill="#3a3a42" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" /><path d="M4.6 52.8h21M38.4 52.8h21" stroke="#62626e" stroke-width="0.7" />
      <polygon points="26,52 38,52 35,59 29,59" fill="#f2efe8" />
      <polygon points="26.5,52 31,52 29,54" fill="#ffffff" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" /><polygon points="37.5,52 33,52 35,54" fill="#ffffff" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
      <polygon points="27.5,52.6 31.4,54 27.5,55.4" fill="#15151b" /><polygon points="36.5,52.6 32.6,54 36.5,55.4" fill="#15151b" /><rect x="31.2" y="53.2" width="1.6" height="1.6" fill="#15151b" />
      <rect x="31.6" y="56.4" width="0.8" height="0.8" fill="#211f1c" />
      <polygon points="15,47 15,39 16,39 16,37.5 19.5,37.5 19.5,38.5 21.5,38.5 21.5,40 19,40 19,45 18,45 18,47" fill="#e8e5de" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
      <polygon points="49,47 49,39 48,39 48,37.5 44.5,37.5 44.5,38.5 42.5,38.5 42.5,40 45,40 45,45 46,45 46,47" fill="#e8e5de" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
      <rect x="16" y="41" width="1" height="4" fill="#b9b4aa" /><rect x="47" y="41" width="1" height="4" fill="#b9b4aa" />
      <rect x="23" y="38.2" width="6" height="0.9" fill="#e8e5de" opacity="0.85" /><rect x="31" y="37.9" width="10" height="1" fill="#e8e5de" opacity="0.85" />
      <rect x="20.5" y="41.8" width="3" height="1.1" fill="#e8e5de" /><rect x="23.3" y="41.1" width="3.7" height="1.1" fill="#e8e5de" />
      <rect x="37" y="41.1" width="3.7" height="1.1" fill="#e8e5de" /><rect x="40.5" y="41.8" width="3" height="1.1" fill="#e8e5de" />
      <rect x="27" y="49.1" width="10" height="1.4" fill="#dcd8cf" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" /><rect x="26.2" y="49.9" width="1.4" height="1.2" fill="#dcd8cf" /><rect x="36.4" y="49.9" width="1.4" height="1.2" fill="#dcd8cf" />
    </g>
    <g class="cameo cameo-mcafee">
      <polygon points="24,52 30,52 32,56 28,55.2" fill="#f2efe8" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" /><polygon points="40,52 34,52 32,56 36,55.2" fill="#f2efe8" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
      <polygon points="15,45 15,38.5 12.5,36.5 15.8,35.6 14.6,31.8 19,33.6 18.8,29.4 23,32.4 24.8,27.6 28,32 31,26.6 33.6,31.4 37.2,27.2 38.6,32 42.4,28.8 42.6,33 47.4,31.2 46.2,35 50.4,35 48,38.4 49,38.6 49,45 47,45 47,40.2 44,39.6 20,39.6 17,40.2 17,45" fill="#cfcbc3" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
      <path d="M21 34.5l2 3.5M27.5 31.5l1 5M34 31l0.2 5.5M39.5 32l-1 4.5M44.5 34l-1.8 3.5M16 39.5v4.5M48 39.5v4.5" stroke="#8e8a82" stroke-width="0.9" fill="none" />
      <rect x="36.8" y="42.8" width="5.9" height="5.9" fill="#f2efe8" />
      <rect x="20.8" y="41.4" width="6.4" height="1.1" fill="#8e8a82" /><rect x="36.6" y="39.6" width="6.4" height="1.1" fill="#8e8a82" /><rect x="42.2" y="40.4" width="1.2" height="1" fill="#8e8a82" />
      <g fill="#8e8a82" opacity="0.85"><rect x="20" y="49.5" width="1" height="1" /><rect x="22" y="50.8" width="1" height="1" /><rect x="24" y="49.6" width="1" height="1" /><rect x="25.6" y="51" width="1" height="1" /><rect x="38.4" y="51" width="1" height="1" /><rect x="40" y="49.6" width="1" height="1" /><rect x="42" y="50.8" width="1" height="1" /><rect x="44" y="49.5" width="1" height="1" /></g>
      <rect x="27.5" y="48.6" width="9" height="1.4" fill="#9a958d" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
      <rect x="29.5" y="50.4" width="5" height="4.6" fill="#9a958d" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" /><rect class="cameo-lips" x="30.3" y="50.4" width="3.4" height="0.7" fill="#211f1c" /><rect x="30.4" y="52.2" width="1" height="2.2" fill="#bdb9b1" /><rect x="32.6" y="52.6" width="1" height="2" fill="#6f6b64" />
    </g>
    <g class="cameo cameo-spagni">
      <rect x="4" y="52" width="56" height="7" fill="#5b5e66" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
      <polygon points="26,52 38,52 34.5,59 29.5,59" fill="#22232a" /><polygon class="cameo-skin" points="29.6,52 34.4,52 32,54.6" fill="var(--body-color, #da7756)" />
      <path d="M26 52l3.5 7M38 52l-3.5 7" stroke="#44474e" stroke-width="0.8" fill="none" />
      <circle cx="42" cy="55" r="1.6" fill="#f26822" stroke="#211f1c" stroke-width="0.35" /><rect x="40.6" y="55.4" width="2.8" height="1" fill="#4c4c4c" /><path d="M41 55.4v-1.2l1 0.8l1-0.8v1.2" stroke="#f2efe8" stroke-width="0.35" fill="none" />
      <rect class="cameo-skin" x="15" y="44.5" width="3" height="7" rx="1.2" fill="var(--body-color, #da7756)" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" /><rect class="cameo-skin" x="46" y="44.5" width="3" height="7" rx="1.2" fill="var(--body-color, #da7756)" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
      <rect class="cameo-skin" x="17" y="45" width="1.4" height="6.2" fill="var(--body-color, #da7756)" /><rect class="cameo-skin" x="45.6" y="45" width="1.4" height="6.2" fill="var(--body-color, #da7756)" />
      <polygon points="16,44 16,38 17,38 17,35 19,35 19,33.5 22,33.5 22,32.6 24.5,32.6 25.5,30.6 27,32.4 28.5,30.2 30,32.2 31.5,30 33,32.2 35,30.8 36,32.6 41,32.6 41,33.5 45,33.5 45,35 47,35 47,38 48,38 48,44 46.6,44 46.6,40.2 44,39.6 20,39.6 17.4,40.2 17.4,44" fill="#2e2019" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
      <rect x="22" y="34.6" width="10" height="0.8" fill="#4f3a2c" /><rect x="33" y="35.2" width="8" height="0.8" fill="#4f3a2c" /><rect x="26" y="32.8" width="7" height="0.7" fill="#4f3a2c" />
      <g class="cameo-lips" fill="#211f1c"><rect x="29" y="50.2" width="5.2" height="0.8" /><rect x="34" y="49.5" width="1.4" height="0.8" /></g>
    </g>
    <g class="cameo cameo-powell">
      <rect x="4" y="52" width="56" height="7" fill="#1e2a44" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
      <polygon points="26.5,52 37.5,52 32,59" fill="#f7f5f0" />
      <polygon points="30.8,52.2 33.2,52.2 32.8,53.9 31.2,53.9" fill="#8f1219" /><polygon points="31.2,53.9 32.8,53.9 33.4,57.6 32,58.8 30.6,57.6" fill="#c8202a" />
      <path d="M26.5 52l5.5 7M37.5 52l-5.5 7" stroke="#131b2e" stroke-width="0.7" fill="none" />
      <polygon points="16,44 16,38 17,38 17,36.5 19,36.5 19,35.5 45,35.5 45,36.5 47,36.5 47,38 48,38 48,44 46.5,44 46.5,40.6 44,40.6 26,40.6 26,39.6 24.4,39.6 24.4,40.2 19.5,40.2 17.5,40.6 17.5,44" fill="#eeece6" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
      <rect x="23.8" y="36" width="0.9" height="3.8" fill="#a9a59c" />
      <rect x="26.5" y="37.2" width="15" height="0.8" fill="#d2cec6" /><rect x="28" y="39" width="13" height="0.7" fill="#d2cec6" /><rect x="16.6" y="40.5" width="0.8" height="3" fill="#c3bfb6" />
    </g>
    <g class="cameo cameo-baker">
      <rect x="4" y="52" width="56" height="7" fill="#b9d3ec" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
      <polygon class="cameo-skin" points="29,52 35,52 32,55.6" fill="var(--body-color, #da7756)" />
      <polygon points="24.5,52 29,52 32,55.6 28.4,54.9" fill="#dbe8f5" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" /><polygon points="39.5,52 35,52 32,55.6 35.6,54.9" fill="#dbe8f5" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
      <rect x="31.6" y="55.6" width="0.8" height="3.4" fill="#8fb3d9" /><rect x="10" y="52.5" width="0.8" height="6" fill="#8fb3d9" /><rect x="53.2" y="52.5" width="0.8" height="6" fill="#8fb3d9" />
      <polygon points="16,45 16,38 17,38 17,35.5 19,35.5 19,34 23,34 23,32.8 36,32.8 36,33.5 42,33.5 42,34.6 45,34.6 45,36 47,36 47,38 48,38 48,45 46.4,45 46.4,40 44,39.4 31,39.4 31,40.4 25,40.4 25,39.4 20,39.4 17.6,40 17.6,45" fill="#4a3a2c" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
      <rect x="21" y="35.2" width="9" height="0.8" fill="#6a5646" /><rect x="31" y="34.4" width="8" height="0.8" fill="#6a5646" /><rect x="24" y="37" width="15" height="0.7" fill="#6a5646" />
      <rect x="16.4" y="38.5" width="1.4" height="6.2" fill="#9a938a" /><rect x="46.2" y="38.5" width="1.4" height="6.2" fill="#9a938a" /><rect x="17.6" y="37" width="2.4" height="1.6" fill="#9a938a" /><rect x="44" y="37" width="2.4" height="1.6" fill="#9a938a" />
      <g fill="#8a7f73" opacity="0.8"><rect x="19.5" y="49" width="1" height="1" /><rect x="21" y="50.6" width="1" height="1" /><rect x="23" y="49.4" width="1" height="1" /><rect x="25" y="50.8" width="1" height="1" /><rect x="27" y="49.4" width="1" height="1" /><rect x="29" y="50.6" width="1" height="1" /><rect x="31" y="49.2" width="1" height="1" /><rect x="33" y="50.6" width="1" height="1" /><rect x="35" y="49.4" width="1" height="1" /><rect x="37" y="50.8" width="1" height="1" /><rect x="39" y="49.4" width="1" height="1" /><rect x="41" y="50.6" width="1" height="1" /><rect x="43" y="49" width="1" height="1" /></g>
      <g fill="#c9c2b8" opacity="0.8"><rect x="22" y="49.2" width="1" height="1" /><rect x="26" y="49.9" width="1" height="1" /><rect x="30" y="49.8" width="1" height="1" /><rect x="34" y="49.9" width="1" height="1" /><rect x="38" y="49.9" width="1" height="1" /><rect x="42" y="49.2" width="1" height="1" /></g>
      <rect class="cameo-lips" x="28.5" y="50.6" width="7" height="0.8" fill="#211f1c" opacity="0.7" />
    </g>
    <!-- photo cameo: the user's own face (cameos.js), a real photo in the head
         box (17,30)–(47,60), untouched but for its cut-out, with a soft
         shadow where the chin meets the body; mouth props and hats go on top -->
    <g class="cameo-photo">
      <ellipse class="cameo-photo-seam" cx="32" cy="58" rx="9" ry="1.8" fill="#211f1c" opacity="0.3" filter="url(#cameo-seam)" />
      <image class="cameo-photo-img" x="17" y="30" width="30" height="30" preserveAspectRatio="xMidYMid slice" />
    </g>
    <!-- knock: a fist that raps forward; used when Claude walks to your terminal -->
    <g class="knock-fist"><rect x="50" y="46" width="6" height="6" rx="1.5" fill="#da7756" stroke="#211f1c" stroke-width="0.5" /></g>
    <!-- cookie: the token treat you feed him (⌥-click) -->
    <g class="cookie"><circle cx="54" cy="46" r="3.6" fill="#c98a4b" /><circle cx="52.8" cy="45" r="0.8" fill="#5a3a1a" /><circle cx="55.4" cy="47.2" r="0.8" fill="#5a3a1a" /><circle cx="54.6" cy="44.4" r="0.6" fill="#5a3a1a" /></g>
    <!-- big toothy grin -->
    <g class="mouth-anchor"><g class="grin"><rect x="23" y="48.5" width="18" height="3.6" rx="1.8" fill="#211f1c" /><rect x="24.5" y="49.2" width="15" height="1.6" fill="#f2efe8" /><rect x="28" y="49.2" width="0.6" height="1.6" fill="#211f1c" /><rect x="31.5" y="49.2" width="0.6" height="1.6" fill="#211f1c" /><rect x="35" y="49.2" width="0.6" height="1.6" fill="#211f1c" /></g></g>
    <!-- selfie: phone held out, flash burst -->
    <g class="selfie"><rect x="50" y="40" width="7" height="11" rx="1.5" fill="#1a1a1e" stroke="#9aa3ad" stroke-width="0.6" /><circle class="flashbulb" cx="53.5" cy="42.3" r="1.1" fill="#fff5d6" /></g>
    <!-- cigarette: held at the mouth, smoke drifts up. It burns down over a
         real SMOKE_CYCLE_MS (the tip slides back as the paper shortens), then
         gets flicked, stomped (.cig-butt, on the ground) and replaced from the
         pack at the hip (.cig-pack) -->
    <g class="mouth-anchor"><g class="cig">
      <g class="cig-held"><g transform="translate(0 0.8) rotate(-10 33 50)">
        <rect class="cig-paper" x="36.8" y="48.7" width="10.8" height="2.6" fill="#f7f5ef" stroke="#211f1c" stroke-width="0.4" />
        <g class="cig-tip">
          <rect x="47.3" y="48.7" width="1.3" height="2.6" fill="#a39d94" stroke="#211f1c" stroke-width="0.4" />
          <circle class="cig-glow" cx="49.2" cy="50" r="2.4" fill="#ff7a2f" filter="url(#cig-glow)" />
          <rect class="ember" x="48.4" y="48.7" width="1.5" height="2.6" rx="0.5" fill="#ff5a1f" stroke="#211f1c" stroke-width="0.4" />
          <path class="cig-flame" d="M51.4 51.4 q-1.9 -1.6 0 -4.9 q1.9 3.3 0 4.9 z" fill="#ffb02e" /><path class="cig-flame" d="M51.4 51 q-0.9 -0.9 0 -2.6 q0.9 1.7 0 2.6 z" fill="#fff3b0" />
        </g>
        <rect x="32.4" y="48.7" width="4.8" height="2.6" rx="0.6" fill="#d9a066" stroke="#211f1c" stroke-width="0.4" />
        <g fill="#b37a3e"><rect x="33.4" y="49.3" width="0.5" height="0.5" /><rect x="34.8" y="50.2" width="0.5" height="0.5" /><rect x="35.9" y="49.4" width="0.5" height="0.5" /></g>
        <rect x="36.7" y="48.9" width="0.5" height="2.2" fill="#e8c77a" />
        <rect x="37.6" y="48" width="3.8" height="4" rx="1.3" fill="var(--body-color, #da7756)" stroke="#211f1c" stroke-width="0.5" />
      </g></g>
      <g class="cig-smoke wisps">
        <path class="wisp-line" d="M48.9 46.6 c-1.3 -1.5 1.3 -3 0 -4.5 s1.3 -3 0 -4.5 s1 -2.4 0 -3.6" fill="none" stroke="url(#cig-wisp-fade)" stroke-width="0.5" stroke-linecap="round" />
        <g fill="#c9c9d1"><circle class="wisp s1" cx="48.9" cy="46.4" r="0.7" /><circle class="wisp s2" cx="48.9" cy="46.4" r="0.9" /><circle class="wisp s3" cx="48.9" cy="46.4" r="0.6" /><circle class="wisp s4" cx="48.9" cy="46.4" r="1" /></g>
      </g>
      <g class="exhale" fill="#d7d7de"><circle class="ex e1" cx="33" cy="51" r="1.4" /><circle class="ex e2" cx="33" cy="51" r="1.9" /><circle class="ex e3" cx="33" cy="51" r="1.2" /></g>
    </g></g>
    <!-- the pack a fresh cigarette comes out of, at the hip -->
    <g class="cig-pack">
      <g class="cig-pack-stick"><rect x="52.7" y="42.4" width="1.5" height="4.6" fill="#f7f5ef" stroke="#211f1c" stroke-width="0.35" /><rect x="52.7" y="42.4" width="1.5" height="1.6" fill="#d9a066" stroke="#211f1c" stroke-width="0.35" /></g>
      <rect x="50.4" y="44.6" width="6.2" height="8.4" rx="0.6" fill="#f7f5ef" stroke="#211f1c" stroke-width="0.45" />
      <rect x="50.4" y="44.6" width="6.2" height="3" fill="#c8202a" stroke="#211f1c" stroke-width="0.45" />
      <rect x="51.4" y="49.2" width="4.2" height="0.8" fill="#e8c77a" />
    </g>
    <!-- zyn tin + pouch; the mouth opens for it and it ends up as a bump under the upper lip -->
    <g class="mouth-anchor"><g class="zyn"><rect class="zyn-mouth" x="29" y="49.4" width="6" height="1.2" rx="0.6" fill="#211f1c" /><path class="lip-bump" d="M29.8 49.5 q2.2 -3 4.4 0 z" fill="var(--body-color, #da7756)" stroke="#211f1c" stroke-width="0.45" /><rect class="tin" x="49" y="46" width="8" height="8" rx="4" fill="#f2efe8" stroke="#211f1c" stroke-width="0.5" /><text class="tin-text" x="53" y="51.2" text-anchor="middle" font-size="3" font-weight="700" font-family="-apple-system, system-ui, sans-serif" fill="#211f1c">ZYN</text><rect class="pouch" x="53" y="49" width="3" height="1.6" rx="0.8" fill="#f2efe8" stroke="#211f1c" stroke-width="0.4" /></g></g>
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
    <!-- syringe: a fist on the plunger drives it into the right arm; the clip hides the needle under the skin -->
    <clipPath id="rig-juice-skin"><rect x="36" y="16" width="34" height="36" /></clipPath>
    <g class="needle" clip-path="url(#rig-juice-skin)"><g transform="rotate(15 55 52)"><g class="syringe">
      <rect x="54.7" y="44" width="0.6" height="6" fill="#9aa3ad" />
      <rect x="53.2" y="37" width="3.6" height="8.2" rx="0.5" fill="#d7ded6" stroke="#211f1c" stroke-width="0.4" />
      <rect class="juice-fill" x="53.7" y="38.5" width="2.6" height="6.2" fill="#6fdc3a" />
      <rect x="51.8" y="36.4" width="6.4" height="1" rx="0.3" fill="#9aa3ad" stroke="#211f1c" stroke-width="0.3" />
      <g class="plunger"><rect x="54.5" y="32.2" width="1" height="5.6" fill="#9aa3ad" /><rect x="53.7" y="37.6" width="2.6" height="0.9" fill="#211f1c" /><rect x="53" y="31.2" width="4" height="1" fill="#e2231a" /><rect x="52.8" y="27.6" width="4.4" height="3.6" rx="1.2" fill="var(--body-color, #da7756)" stroke="#211f1c" stroke-width="0.45" /></g>
    </g></g></g>
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
    <!-- cheer: both arms thrown up in a V -->
    <g class="cheer-arms" fill="var(--body-color, #da7756)" stroke="#211f1c" stroke-width="0.5">
      <rect x="6" y="40" width="5" height="15" rx="2.5" transform="rotate(-28 8.5 54)" /><rect x="53" y="40" width="5" height="15" rx="2.5" transform="rotate(28 55.5 54)" />
      <circle cx="4.5" cy="40" r="2.6" transform="rotate(-28 8.5 54)" /><circle cx="59.5" cy="40" r="2.6" transform="rotate(28 55.5 54)" />
    </g>
    <!-- facepalm: a hand drawn flat over the face -->
    <g class="facepalm-hand">
      <rect x="23" y="41" width="18" height="11" rx="3" fill="var(--body-color, #da7756)" stroke="#211f1c" stroke-width="0.5" />
      <path d="M27 41.5v10M31 41v10.5M35 41v10.5M39 41.5v10" stroke="#b85f3c" stroke-width="0.7" />
    </g>
    <!-- everything at the eyes: moves onto a photo cameo's own eyes -->
    <g class="eye-anchor">
    <!-- eye-track: the plain eyes follow the cursor by whole units (rig.lookAt) -->
    <g class="eye-track">
    <rect class="eye-open" x="22" y="43.5" width="4.5" height="4.5" />
    <rect class="eye-open" x="37.5" y="43.5" width="4.5" height="4.5" />
    <rect class="eye-closed" x="21" y="45.25" width="6.5" height="1.6" rx="0.8" />
    <rect class="eye-closed" x="36.5" y="45.25" width="6.5" height="1.6" rx="0.8" />
    </g>
    <!-- zyn: catchlights on the dilated pupils -->
    <g class="zyn-glints" fill="#f2efe8"><rect x="21.3" y="42.7" width="1.6" height="1.6" /><rect x="36.8" y="42.7" width="1.6" height="1.6" /></g>
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
    <!-- loading: spinner rings where the eyes are -->
    <g class="eyefx eyefx-loading" fill="none" stroke="#211f1c" stroke-width="1.2" stroke-linecap="round">
      <path class="spin-eye" d="M24.25 43.4 a2.35 2.35 0 1 1 -2.05 1.2" /><path class="spin-eye" d="M39.75 43.4 a2.35 2.35 0 1 1 -2.05 1.2" />
    </g>
    <!-- scan: dark robotic eyes with a sweeping bar -->
    <g class="eyefx eyefx-scan">
      <rect x="21" y="43.5" width="6.5" height="4.5" rx="0.6" fill="#0a1a2a" /><rect x="36.5" y="43.5" width="6.5" height="4.5" rx="0.6" fill="#0a1a2a" />
      <rect class="scanbar" x="21" y="43.5" width="6.5" height="1.1" fill="#38bdf8" /><rect class="scanbar" x="36.5" y="43.5" width="6.5" height="1.1" fill="#38bdf8" />
    </g>
    <!-- wide: big alarmed eyes -->
    <g class="eyefx eyefx-wide">
      <circle cx="24.25" cy="45.75" r="3.7" fill="#f2efe8" stroke="#211f1c" stroke-width="0.5" /><circle cx="39.75" cy="45.75" r="3.7" fill="#f2efe8" stroke="#211f1c" stroke-width="0.5" />
      <circle cx="24.25" cy="45.75" r="1.9" fill="#211f1c" /><circle cx="39.75" cy="45.75" r="1.9" fill="#211f1c" />
    </g>
    <!-- content: calm closed upward eyes (peaceful) -->
    <g class="eyefx eyefx-content" fill="none" stroke="#211f1c" stroke-width="1.3" stroke-linecap="round">
      <path d="M21.5 44.5 q2.8 3 5.6 0" /><path d="M37 44.5 q2.8 3 5.6 0" />
    </g>
    <!-- side: side-eye, pupils cut to one side (skeptical) -->
    <g class="eyefx eyefx-side">
      <rect x="22" y="43.5" width="4.5" height="4.5" fill="#f2efe8" /><rect x="37.5" y="43.5" width="4.5" height="4.5" fill="#f2efe8" />
      <rect x="24.4" y="44.6" width="2" height="2.4" fill="#211f1c" /><rect x="39.9" y="44.6" width="2" height="2.4" fill="#211f1c" />
    </g>
    <!-- glow: luminous eyes that softly pulse -->
    <g class="eyefx eyefx-glow" fill="#38bdf8">
      <circle class="glow-eye" cx="24.25" cy="45.75" r="2.6" /><circle class="glow-eye" cx="39.75" cy="45.75" r="2.6" />
    </g>
    </g><!-- /eye-anchor -->
    <!-- cameos (front layer): eyewear, over the eyes -->
    <g class="cameo cameo-neo">
      <rect x="18" y="44.4" width="3.2" height="0.7" fill="#0a0a0d" /><rect x="42.8" y="44.4" width="3.2" height="0.7" fill="#0a0a0d" /><rect x="27.2" y="44.6" width="9.6" height="0.8" fill="#0a0a0d" />
      <g class="cameo-lens">
        <rect x="20.8" y="43.4" width="6.8" height="4.4" rx="1.8" fill="#0a0a0d" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" /><rect x="36.4" y="43.4" width="6.8" height="4.4" rx="1.8" fill="#0a0a0d" stroke="#211f1c" stroke-width="0.5" stroke-linejoin="round" />
        <rect x="22" y="44.2" width="2.2" height="0.8" fill="#7cf29a" opacity="0.75" /><rect x="37.6" y="44.2" width="2.2" height="0.8" fill="#7cf29a" opacity="0.75" />
      </g>
    </g>
    <g class="cameo cameo-powell" fill="none" stroke="#d5dbe0" stroke-width="0.6">
      <rect x="20.8" y="42.6" width="7" height="6.2" rx="1" /><rect x="36.2" y="42.6" width="7" height="6.2" rx="1" /><path d="M27.8 44.4h8.4M20.8 44.2h-2.6M43.2 44.2h2.6" />
    </g>
    <circle class="think-dot d1" cx="24" cy="34" r="2" />
    <circle class="think-dot d2" cx="32" cy="34" r="2" />
    <circle class="think-dot d3" cx="40" cy="34" r="2" />
    <g class="thumbs-up">
      <rect x="50" y="48" width="8" height="7" rx="1" />
      <rect x="48" y="42" width="4" height="8" rx="1.5" />
    </g>
    <g class="mouth-anchor"><rect class="grumpy-mouth" x="26" y="49" width="12" height="1.8" rx="0.9" /></g>
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
  <g class="eye-anchor"><g class="costume costume-shades">
    <rect x="19.5" y="42.5" width="9" height="5.5" rx="1.5" fill="#111" />
    <rect x="35.5" y="42.5" width="9" height="5.5" rx="1.5" fill="#111" />
    <rect x="28.5" y="44" width="7" height="1.4" fill="#111" />
    <rect x="21" y="43.5" width="3" height="1" fill="#fff" opacity="0.5" /><rect x="37" y="43.5" width="3" height="1" fill="#fff" opacity="0.5" />
  </g></g>
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
  <!-- headphones: over-ear cups on a band, a focus LED that pulses -->
  <g class="costume costume-headphones">
    <path d="M16 46 q0 -15 16 -15 q16 0 16 15" fill="none" stroke="#2a2a33" stroke-width="3" stroke-linecap="round" />
    <rect x="12" y="42" width="6" height="10" rx="2" fill="#2a2a33" stroke="#211f1c" stroke-width="0.4" /><rect x="13.4" y="44" width="3.2" height="6" rx="1.4" fill="#5a5a6a" />
    <rect x="46" y="42" width="6" height="10" rx="2" fill="#2a2a33" stroke="#211f1c" stroke-width="0.4" /><rect x="47.4" y="44" width="3.2" height="6" rx="1.4" fill="#5a5a6a" />
    <circle class="hp-led" cx="15" cy="50.4" r="0.9" fill="#2fae3e" />
  </g>
  <!-- graduate: mortarboard with a swinging tassel -->
  <g class="costume costume-graduate">
    <path d="M24 33 h16 v3 q-8 4 -16 0 z" fill="#1a1a1e" />
    <polygon points="32,25 48,31 32,37 16,31" fill="#22222a" stroke="#211f1c" stroke-width="0.4" stroke-linejoin="round" />
    <circle cx="32" cy="31" r="1.2" fill="#f2d16b" />
    <path class="tassel-string" d="M32 31 L45 32" fill="none" stroke="#f2d16b" stroke-width="0.8" />
    <g class="tassel"><rect x="44" y="31.5" width="2" height="5.5" rx="0.6" fill="#f2d16b" /><rect x="43.6" y="36.6" width="2.8" height="2" rx="0.6" fill="#e0b040" /></g>
  </g>
  <!-- chef: a puffed white toque on a band -->
  <g class="costume costume-chef">
    <circle cx="25" cy="31" r="5.2" fill="#f2efe8" /><circle cx="32" cy="28" r="6" fill="#f2efe8" /><circle cx="39" cy="31" r="5.2" fill="#f2efe8" />
    <rect x="22" y="34.5" width="20" height="4.5" rx="1" fill="#f2efe8" stroke="#211f1c" stroke-width="0.4" />
    <path d="M25 35.4h2M31 35.4h2M37 35.4h2" stroke="#cfccc3" stroke-width="0.6" />
  </g>
  <!-- cowboy: wide-brim hat with a dented crown and band -->
  <g class="costume costume-cowboy">
    <ellipse cx="32" cy="38.4" rx="19" ry="3.4" fill="#8a5a2b" stroke="#211f1c" stroke-width="0.4" />
    <path d="M23 38 q1 -12 9 -12 q8 0 9 12 z" fill="#a06a34" stroke="#211f1c" stroke-width="0.4" stroke-linejoin="round" />
    <path d="M26 30 q6 -3 12 0" fill="none" stroke="#7a4a20" stroke-width="0.8" />
    <rect x="23.5" y="34" width="17" height="2.4" fill="#5a3a1a" />
  </g>
  <!-- propeller beanie: a spinning two-blade prop on a bright cap -->
  <g class="costume costume-propeller">
    <path d="M21 39 q0 -12 11 -12 q11 0 11 12 z" fill="#38bdf8" stroke="#211f1c" stroke-width="0.4" stroke-linejoin="round" />
    <path d="M32 27 v12" stroke="#f2efe8" stroke-width="0.6" opacity="0.55" /><path d="M26 28 v11 M38 28 v11" stroke="#f2efe8" stroke-width="0.5" opacity="0.4" />
    <g class="propeller"><rect x="24" y="25.2" width="16" height="2" rx="1" fill="#f472b6" stroke="#211f1c" stroke-width="0.35" /></g>
    <circle cx="32" cy="26.2" r="1.5" fill="#f2d16b" stroke="#211f1c" stroke-width="0.35" />
  </g>
  <!-- detective: a tweed deerstalker with brims and ear flaps -->
  <g class="costume costume-detective">
    <ellipse cx="32" cy="38.8" rx="16" ry="2.6" fill="#6a5a42" />
    <path d="M19 39 q1 -12 13 -12 q12 0 13 12 z" fill="#7a6a52" stroke="#211f1c" stroke-width="0.4" stroke-linejoin="round" />
    <rect x="14.5" y="37" width="5.5" height="6.5" rx="2.2" fill="#6a5a42" /><rect x="44" y="37" width="5.5" height="6.5" rx="2.2" fill="#6a5a42" />
    <g fill="#5a4a34" opacity="0.6"><rect x="23" y="31" width="1" height="1" /><rect x="27" y="34" width="1" height="1" /><rect x="31" y="30" width="1" height="1" /><rect x="35" y="34" width="1" height="1" /><rect x="39" y="31" width="1" height="1" /><rect x="27" y="30" width="1" height="1" /><rect x="35" y="30" width="1" height="1" /></g>
  </g>
  <!-- flower crown: a vine of little blooms across the hairline -->
  <g class="costume costume-flowercrown">
    <path d="M15 40 q17 -8 34 0" fill="none" stroke="#4a7a3a" stroke-width="1.4" stroke-linecap="round" />
    <g class="fc-flower" fill="#f472b6"><circle cx="18" cy="37.5" r="1.4" /><circle cx="15.6" cy="37.5" r="1.4" /><circle cx="20.4" cy="37.5" r="1.4" /><circle cx="18" cy="35.5" r="1.4" /><circle cx="18" cy="39.5" r="1.4" /><circle cx="18" cy="37.5" r="1.1" fill="#f2d16b" /></g>
    <g class="fc-flower" fill="#f2efe8"><circle cx="28" cy="35" r="1.4" /><circle cx="25.6" cy="35" r="1.4" /><circle cx="30.4" cy="35" r="1.4" /><circle cx="28" cy="33" r="1.4" /><circle cx="28" cy="37" r="1.4" /><circle cx="28" cy="35" r="1.1" fill="#f2d16b" /></g>
    <g class="fc-flower" fill="#a78bfa"><circle cx="37" cy="35" r="1.4" /><circle cx="34.6" cy="35" r="1.4" /><circle cx="39.4" cy="35" r="1.4" /><circle cx="37" cy="33" r="1.4" /><circle cx="37" cy="37" r="1.4" /><circle cx="37" cy="35" r="1.1" fill="#f2d16b" /></g>
    <g class="fc-flower" fill="#f28c28"><circle cx="46" cy="37.5" r="1.4" /><circle cx="43.6" cy="37.5" r="1.4" /><circle cx="48.4" cy="37.5" r="1.4" /><circle cx="46" cy="35.5" r="1.4" /><circle cx="46" cy="39.5" r="1.4" /><circle cx="46" cy="37.5" r="1.1" fill="#f2d16b" /></g>
  </g>
  <!-- beanie: a knit winter cap with a bobbing pom-pom -->
  <g class="costume costume-beanie">
    <path d="M20 39 q0 -13 12 -13 q12 0 12 13 z" fill="#3a6ea5" stroke="#211f1c" stroke-width="0.4" stroke-linejoin="round" />
    <path d="M24 27 v11 M28 26 v12 M32 26 v12 M36 26 v12 M40 27 v11" stroke="#2f5a8a" stroke-width="0.5" opacity="0.6" />
    <rect x="19" y="36" width="26" height="4" rx="2" fill="#dbe8f5" stroke="#211f1c" stroke-width="0.4" />
    <path d="M22 37.8h22" stroke="#b8cee0" stroke-width="0.6" />
    <circle class="pom" cx="32" cy="24" r="3" fill="#dbe8f5" stroke="#211f1c" stroke-width="0.4" />
  </g>
  <!-- the finished cigarette: flicked from the mouth, lands on the ground, gets
       stomped flat; one element, reused every cycle -->
  <g class="cig-butt">
    <ellipse class="cig-scuff" cx="52.3" cy="68.1" rx="3.8" ry="0.7" fill="#211f1c" />
    <g class="cig-butt-fly"><g class="cig-butt-body">
      <rect x="49.6" y="66.5" width="2.9" height="1.7" rx="0.4" fill="#d9a066" stroke="#211f1c" stroke-width="0.35" />
      <rect x="52.4" y="66.5" width="2.2" height="1.7" fill="#f2efe8" stroke="#211f1c" stroke-width="0.35" />
      <rect x="54.5" y="66.5" width="0.7" height="1.7" fill="#6b625c" stroke="#211f1c" stroke-width="0.35" />
    </g></g>
    <g class="cig-dust" fill="#b9b2a6"><circle class="dust d1" cx="48.6" cy="67.4" r="0.9" /><circle class="dust d2" cx="56" cy="67.4" r="0.9" /><circle class="dust d3" cx="52.3" cy="66.4" r="0.7" /></g>
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
  <!-- stars: a night sky twinkling above -->
  <g class="effect effect-stars" fill="#f2efe8">
    <g class="twinkle sx1"><rect x="8" y="4" width="1" height="1" /><rect x="7.2" y="4.4" width="2.6" height="0.2" /><rect x="8.4" y="3.6" width="0.2" height="2.6" /></g>
    <g class="twinkle sx2"><rect x="22" y="2" width="1" height="1" /><rect x="21.2" y="2.4" width="2.6" height="0.2" /><rect x="22.4" y="1.6" width="0.2" height="2.6" /></g>
    <g class="twinkle sx3"><rect x="40" y="3" width="1" height="1" /><rect x="39.2" y="3.4" width="2.6" height="0.2" /><rect x="40.4" y="2.6" width="0.2" height="2.6" /></g>
    <g class="twinkle sx4"><rect x="53" y="6" width="1" height="1" /><rect x="52.2" y="6.4" width="2.6" height="0.2" /><rect x="53.4" y="5.6" width="0.2" height="2.6" /></g>
    <g class="twinkle sx5"><rect x="31" y="8" width="0.8" height="0.8" /></g><g class="twinkle sx2"><rect x="15" y="9" width="0.8" height="0.8" /></g><g class="twinkle sx4"><rect x="47" y="10" width="0.8" height="0.8" /></g>
  </g>
  <!-- bubbles: soap bubbles drifting up -->
  <g class="effect effect-bubbles" fill="#9fd3ff" fill-opacity="0.25" stroke="#7dc0f5" stroke-width="0.5">
    <circle class="bubble bu1" cx="14" cy="72" r="2.4" /><circle class="bubble bu2" cx="30" cy="72" r="1.6" /><circle class="bubble bu3" cx="46" cy="72" r="3" /><circle class="bubble bu4" cx="22" cy="72" r="1.9" /><circle class="bubble bu5" cx="52" cy="72" r="1.4" />
  </g>
  <!-- leaves: autumn leaves tumbling down -->
  <g class="effect effect-leaves">
    <path class="leaf lf1" d="M0 0 q3 -2 4 1 q-1 3 -4 3 q-2 -2 0 -4 z" fill="#d97a2b" /><path class="leaf lf2" d="M0 0 q3 -2 4 1 q-1 3 -4 3 q-2 -2 0 -4 z" fill="#c8202a" /><path class="leaf lf3" d="M0 0 q3 -2 4 1 q-1 3 -4 3 q-2 -2 0 -4 z" fill="#f2a200" /><path class="leaf lf4" d="M0 0 q3 -2 4 1 q-1 3 -4 3 q-2 -2 0 -4 z" fill="#b8571f" />
  </g>
  <!-- matrix: a thin rain of green code -->
  <g class="effect effect-matrix" fill="#2fae3e" font-family="ui-monospace, Menlo, monospace" font-size="4" font-weight="700">
    <text class="glyph gm1" x="10" y="0">1</text><text class="glyph gm2" x="20" y="0">0</text><text class="glyph gm3" x="31" y="0">1</text><text class="glyph gm4" x="42" y="0">0</text><text class="glyph gm5" x="52" y="0">1</text>
  </g>
  <!-- hearts: little hearts floating up -->
  <g class="effect effect-hearts" fill="#f472b6">
    <path class="floatheart fh1" d="M2.4 4.6 L0 2.2 A1.4 1.4 0 0 1 2.4 0.6 A1.4 1.4 0 0 1 4.8 2.2 Z" /><path class="floatheart fh2" d="M2.4 4.6 L0 2.2 A1.4 1.4 0 0 1 2.4 0.6 A1.4 1.4 0 0 1 4.8 2.2 Z" /><path class="floatheart fh3" d="M2.4 4.6 L0 2.2 A1.4 1.4 0 0 1 2.4 0.6 A1.4 1.4 0 0 1 4.8 2.2 Z" />
  </g>
  <!-- fireflies: warm glowing dots drifting -->
  <g class="effect effect-fireflies" fill="#f2d16b">
    <circle class="firefly ffa" cx="12" cy="30" r="1.1" /><circle class="firefly ffb" cx="50" cy="26" r="1.1" /><circle class="firefly ffc" cx="34" cy="20" r="1" /><circle class="firefly ffd" cx="20" cy="16" r="1" />
  </g>
  <!-- rainbow: a still arc over Claude -->
  <g class="effect effect-rainbow" fill="none" stroke-width="1.5">
    <path stroke="#e2231a" d="M4 34 a28 28 0 0 1 56 0" /><path stroke="#f28c28" d="M6 34 a26 26 0 0 1 52 0" /><path stroke="#f2d16b" d="M8 34 a24 24 0 0 1 48 0" /><path stroke="#2fae3e" d="M10 34 a22 22 0 0 1 44 0" /><path stroke="#38bdf8" d="M12 34 a20 20 0 0 1 40 0" /><path stroke="#8b5cf6" d="M14 34 a18 18 0 0 1 36 0" />
  </g>
  <!-- petals: cherry blossom drifting down -->
  <g class="effect effect-petals" fill="#f4a7c0">
    <path class="petal pt1" d="M2 0 q2.4 1.6 0 4 q-2.4 -2.4 0 -4 z" /><path class="petal pt2" d="M2 0 q2.4 1.6 0 4 q-2.4 -2.4 0 -4 z" fill="#f7c3d6" /><path class="petal pt3" d="M2 0 q2.4 1.6 0 4 q-2.4 -2.4 0 -4 z" /><path class="petal pt4" d="M2 0 q2.4 1.6 0 4 q-2.4 -2.4 0 -4 z" fill="#f7c3d6" /><path class="petal pt5" d="M2 0 q2.4 1.6 0 4 q-2.4 -2.4 0 -4 z" /></g>
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

  const POSES = ['none', 'think', 'wave', 'thumbs', 'sleep', 'blink', 'nod', 'bounce', 'look', 'spin', 'party', 'guitar', 'ak47', 'sniper', 'banner', 'bubble', 'tap', 'arms', 'run', 'knock', 'munch', 'kickflip', 'selfie', 'grin', 'smoke', 'zyn', 'line', 'juice', 'dead', 'cheer', 'facepalm'];
  const EVENTS = ['ufo', 'portal', 'meteor'];
  const LAMP_FX = ['none', 'pulse', 'strobe', 'breathe', 'flicker', 'chase', 'police', 'rainbow', 'all', 'sos'];
  const COSTUMES = ['none', 'dog', 'cat', 'unicorn', 'crown', 'partyhat', 'shades', 'halo', 'devil', 'wizard', 'tophat', 'santa', 'pumpkin', 'bunny', 'headphones', 'graduate', 'chef', 'cowboy', 'propeller', 'detective', 'flowercrown', 'beanie'];
  // Built-in slots. Most ship a photo (assets/cameos/built, delivered like a
  // user photo); the drawings below are the fallback, and alfred's the face.
  const CAMEOS = ['none', 'neo', 'alfred', 'mcafee', 'spagni', 'powell', 'baker', 'ellison', 'saylor'];
  // cameos whose eyewear is opaque: the eyes underneath are hidden, like the shades costume
  const CAMEOS_HIDE_EYES = new Set(['neo']);
  // Photo cameos: any id the user added (cameos.js). A built-in id with a
  // photo shows the photo instead of its drawing.
  const CAMEO_ID = /^[a-z0-9-]{1,32}$/;
  const PHOTO_BOX = { x: 17, y: 30, size: 30 };
  // Photos this window knows about: the Lights editor registers them all; the
  // widget and tray get the active one on the look (look.cameoPhoto).
  const PHOTOS = new Map();
  function setCameoPhotos(list) {
    PHOTOS.clear();
    for (const p of list || []) if (p && p.src && CAMEO_ID.test(p.id)) PHOTOS.set(p.id, { id: p.id, rev: p.rev ?? p.addedAt ?? 0, src: p.src, eyes: p.eyes, mouth: p.mouth, shape: p.shape });
  }
  // Claude's eyes centre on (32, 45.75), 15.5 apart; his mouth is at (32, 50);
  // hats sit on y 39. A photo's anchors (fractions of its square) map into the
  // head box; the face's scale comes from the eye-to-mouth gap, which on a real
  // face is close to the distance between the pupils.
  function photoAnchors(photo) {
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const at = (p, dx, dy) => ({
      x: PHOTO_BOX.x + clamp(Number.isFinite(p && p.x) ? p.x : dx, 0, 1) * PHOTO_BOX.size,
      y: PHOTO_BOX.y + clamp(Number.isFinite(p && p.y) ? p.y : dy, 0, 1) * PHOTO_BOX.size,
    });
    const eyes = at(photo.eyes, 0.5, 0.4);
    const mouth = at(photo.mouth, 0.5, 0.75);
    const gap = Math.max(2, mouth.y - eyes.y);
    const s = clamp((gap * 0.95) / 15.5, 0.4, 1);
    const top = clamp(eyes.y - gap * 1.3, PHOTO_BOX.y + 1, eyes.y - 3);
    // mouth to chin is about two-thirds of eyes to mouth
    const chin = clamp(mouth.y + gap * 0.7, mouth.y + 2, PHOTO_BOX.y + PHOTO_BOX.size);
    return {
      '--chin-dy': `${(chin - 58).toFixed(2)}px`,
      '--eye-dx': `${(eyes.x - 32).toFixed(2)}px`, '--eye-dy': `${(eyes.y - 45.75).toFixed(2)}px`, '--eye-s': s.toFixed(3),
      '--mouth-dx': `${(mouth.x - 32).toFixed(2)}px`, '--mouth-dy': `${(mouth.y - 50).toFixed(2)}px`, '--mouth-s': clamp(s * 1.25, 0.55, 1).toFixed(3),
      '--hat-dy': `${(top - 39).toFixed(2)}px`,
    };
  }
  // Each cigarette lasts this long while the smoke pose holds; the last few
  // seconds are the flick, the stomp and drawing a fresh one from the pack.
  const SMOKE_CYCLE_MS = 5 * 60 * 1000;
  const SMOKE_STEPS = [['flick', 1200], ['stomp', 1300], ['draw', 1800]];
  const SMOKE_MIN_CYCLE_MS = 8000;
  const BODIES = ['claude', 'dog', 'cat', 'frog', 'robot', 'ghost'];
  const EYE_MOODS = ['heart', 'happy', 'angry', 'sad', 'surprised', 'wink', 'star', 'money', 'sleepy', 'suspicious', 'roll', 'googly', 'dizzy', 'x', 'tears', 'laser', 'loading', 'scan', 'wide', 'content', 'side', 'glow'];
  const EFFECTS = ['none', 'rain', 'sun', 'snow', 'sparkles', 'fire', 'beard', 'garden', 'stars', 'bubbles', 'leaves', 'matrix', 'hearts', 'fireflies', 'rainbow', 'petals'];
  const PETS = ['none', 'duck', 'cat', 'blob', 'dog', 'bunny', 'parrot', 'frog', 'snail', 'dragon'];
  const DEFAULT_TEXT = 'INPUT NEEDED';
  // The three state lamps take the colour-vision-safe palette from tokens.css.
  const SLOT_COLORS = { red: 'var(--lamp-red)', amber: 'var(--lamp-amber)', green: 'var(--lamp-green)', blue: '#2f6bff', pink: '#f472b6' };
  const SIGNS = ['h3', 'v3', 'h1', 'h5'];
  const LAMP_SHAPES = ['square', 'round', 'heart', 'star', 'skull'];
  const SIGN_FX = ['none', 'wobble', 'spin', 'rattle', 'cracked', 'neon'];

  function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return `rgba(0,0,0,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  // opts.ambient: sample the rig's idle loops on a slow clock instead of every
  // display frame (the desk widget, which is on screen all day).
  function mountRig(container, opts = {}) {
    container.innerHTML = SVG;
    const svg = container.querySelector('.rig');
    const lamps = Array.from(svg.querySelectorAll('.lamp'));
    let current = null;
    const reduceMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const canAnimate = (el) => typeof el.animate === 'function' && typeof el.getAnimations === 'function' && !reduceMotion();
    // Motion constants live in motion.js (MOTION) and are read when used, so
    // the tuning playground can change them live. Where motion.js isn't
    // loaded, the old fixed curves stand in.
    const Mo = () => window.BuddyMotion || null;
    const cfg = (k) => (Mo() && Mo().MOTION && Mo().MOTION[k]) || {};
    const supportsLinear = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('animation-timing-function', 'linear(0, 1)');
    const curves = new Map();
    function springCurve(response, damping) {
      const M = Mo();
      if (!M || !supportsLinear) return null;
      const key = `${response}|${damping}`;
      if (!curves.has(key)) curves.set(key, M.springEasing(response, damping));
      return curves.get(key);
    }
    // One-shot pop-ins in rig.css (banner, bubble, pots, plants) ease on a
    // real spring; without linear() they keep their cubic-bezier fallback.
    const pop = springCurve(cfg('pop').response, cfg('pop').damping);
    if (pop) svg.style.setProperty('--ease-pop', pop.easing);

    // Pose changes: dropping a pose-* class ends its keyframes wherever they
    // were, which snapped the sign/body home mid-swing. Capture the on-screen
    // transform before the swap and ease from it to the new resting one —
    // unless the new pose brings its own animation or transition.
    const SETTLE_PARTS = ['.sign-assembly', '.claude-body'].map((q) => svg.querySelector(q));
    const settles = new Map();
    function captureSettle() {
      if (!SETTLE_PARTS.every(canAnimate)) return null;
      return SETTLE_PARTS.map((el) => {
        const cs = getComputedStyle(el);
        const from = { transform: cs.transform, transformOrigin: cs.transformOrigin };
        if (settles.has(el)) { settles.get(el).cancel(); settles.delete(el); }
        return { el, from };
      });
    }
    function runSettle(captured) {
      for (const { el, from } of captured) {
        const cs = getComputedStyle(el);
        if (el.getAnimations().length || cs.transform === from.transform) continue;
        const S = cfg('settle');
        const curve = springCurve(S.response, S.damping);
        const timing = curve ? { duration: curve.ms, easing: curve.easing } : { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1.2)' };
        const anim = el.animate([from, { transform: cs.transform, transformOrigin: cs.transformOrigin }], timing);
        settles.set(el, anim);
        anim.onfinish = () => { if (settles.get(el) === anim) settles.delete(el); };
      }
    }

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
        // …and red blinks, so the states differ in rhythm as well as colour
        el.classList.toggle('blink', !!on && fx === 'none' && lit === 'red' && !look.lampColor);
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
      svg.style.setProperty('--lamp-glow', !color ? 'transparent' : color.startsWith('#') ? hexToRgba(color, 0.85) : `color-mix(in srgb, ${color} 85%, transparent)`);

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
        const settle = current ? captureSettle() : null;
        for (const p of POSES) svg.classList.remove(`pose-${p}`);
        if (pose !== 'none') svg.classList.add(`pose-${pose}`);
        if (settle) runSettle(settle);
        scheduleFlips(pose === 'kickflip');
        scheduleLines(pose === 'line');
      }
      // The cigarette clock runs from look.smokeSince (the widget stamps it when
      // smoke starts), so a brief reaction that swaps the pose resumes the same
      // cigarette; without one (editor previews) it starts at the pose change.
      const smokeKey = pose === 'smoke' ? `${Number(look.smokeSince) || ''}:${Number(look.smokeCycleMs) || ''}` : '';
      if (!current || current.smokeKey !== smokeKey) scheduleSmoke(pose === 'smoke', Number(look.smokeSince), Number(look.smokeCycleMs));
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
      // A photo when one exists for the id (the look's own, else the registry),
      // else the drawing for a built-in, else nothing (a removed photo).
      const cameoId = typeof look.cameo === 'string' && CAMEO_ID.test(look.cameo) ? look.cameo : 'none';
      const photo = cameoId === 'none' ? null : (look.cameoPhoto && look.cameoPhoto.id === cameoId && look.cameoPhoto.src ? look.cameoPhoto : PHOTOS.get(cameoId)) || null;
      const cameo = photo || CAMEOS.includes(cameoId) ? cameoId : 'none';
      const photoKey = photo ? `${photo.id}:${photo.rev}:${photo.src.length}` : '';
      if (!current || current.cameo !== cameo || current.photoKey !== photoKey) {
        for (const c of CAMEOS) svg.classList.remove(`cameo-${c}`);
        if (!photo && cameo !== 'none') svg.classList.add(`cameo-${cameo}`);
        svg.classList.toggle('cameo-hides-eyes', !photo && CAMEOS_HIDE_EYES.has(cameo));
        wearPhoto(photo);
      }
      const text = (look.text || DEFAULT_TEXT).toUpperCase().slice(0, 24);
      const t = svg.querySelector('.banner-text');
      if (t.textContent !== text) t.textContent = text;
      const tl = svg.querySelector('.tasks-label');
      const tasksText = look.tasks && look.tasks.created > 0 ? `${look.tasks.done}/${look.tasks.created}` : '';
      if (tl.textContent !== tasksText) tl.textContent = tasksText;
      // Chips for every other agent; the roster only while you're hovering,
      // so it never sits on top of Claude.
      drawMinions(look.minions, !!look.showRoster, look.agentChipSize, look.agents, look.agentsColor);
      const bt = svg.querySelector('.bubble-text');
      const btext = (look.text || 'BRB').toUpperCase().slice(0, 12);
      if (bt.textContent !== btext) bt.textContent = btext;
      // A newly lit lamp (a different slot or colour) blooms; group effects
      // and number mode light no single lamp, so nothing blooms for them.
      const nextBloom = lit && !groupFx && numText === '' ? `${lit}|${color}|${sign}` : '';
      if (current && nextBloom && nextBloom !== bloomKey) bloom(svg.querySelector(`.sign.sign-${sign} .lamp.on`));
      bloomKey = nextBloom;
      current = { ...look, pose, costume, cameo, photoKey, lampFx: fx, signFx, smokeKey };
      if (ambient) ambient.scan();
    }

    function wearPhoto(photo) {
      svg.classList.toggle('has-photo', !!photo);
      const img = svg.querySelector('.cameo-photo-img');
      if (!photo) { img.removeAttribute('href'); return; }
      img.setAttribute('href', photo.src);
      for (const [k, v] of Object.entries(photoAnchors(photo))) svg.style.setProperty(k, v);
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
    // Squash-and-stretch against a surface: the floor (a press, or landing
    // after a hop or a throw) or a wall a glide bounced off. Strength 0..1.
    // It squashes fast, then a real spring carries it back through a stretch.
    // A new one starts from wherever the last one is, so rapid clicks
    // re-squash instead of restarting from rest.
    const SQUASH_ORIGIN = { bottom: '50% 83%', top: '50% 0%', left: '0% 50%', right: '100% 50%' }; // bottom: the feet (y 68 of 82)
    let squashAnim = null;
    function squash(strength = 1, side = 'bottom') {
      if (!canAnimate(svg)) return;
      const k = Math.max(0, Math.min(1, Number(strength) || 0));
      const from = squashAnim ? getComputedStyle(svg).transform : 'none';
      if (squashAnim) squashAnim.cancel();
      const Q = cfg('squash');
      const amount = Number.isFinite(Q.amount) ? Q.amount : 0.1;
      const wall = side === 'left' || side === 'right';
      svg.style.transformOrigin = SQUASH_ORIGIN[side] || SQUASH_ORIGIN.bottom;
      const along = 1 - amount * k;
      const across = 1 + amount * 0.8 * k;
      const squashed = wall ? `scale(${along.toFixed(3)}, ${across.toFixed(3)})` : `scale(${across.toFixed(3)}, ${along.toFixed(3)})`;
      const curve = springCurve(Q.response, Q.damping);
      const pressMs = Number.isFinite(Q.pressMs) ? Q.pressMs : 60;
      const frames = curve ? [
        { transform: from === 'none' ? 'scale(1, 1)' : from, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
        { transform: squashed, offset: pressMs / (pressMs + curve.ms), easing: curve.easing },
        { transform: 'scale(1, 1)' },
      ] : [
        { transform: from === 'none' ? 'scale(1, 1)' : from, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
        { transform: squashed, offset: 0.28, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' },
        { transform: 'scale(1, 1)' },
      ];
      squashAnim = svg.animate(frames, { duration: curve ? pressMs + curve.ms : 350 });
      const anim = squashAnim;
      anim.onfinish = () => { if (squashAnim === anim) squashAnim = null; };
    }

    // ── Sign pendulum ─────────────────────────────────────────────────────
    // The sign hangs on its grip: it trails the body's motion (lean, from the
    // drag velocity), swings when the body is kicked (swing, deg/s — a hop,
    // a landing, a wall), and settles on a damped spring. The rAF loop only
    // runs while it is moving.
    const swingEl = svg.querySelector('.sign-swing');
    const sway = { x: 0, v: 0, target: 0, raf: 0, last: 0 };
    const placeSwing = (deg) => {
      const P = cfg('pendulum');
      const M = Mo();
      const shown = M ? M.softLimit(deg, P.maxDeg || 6) : deg;
      const q = Math.round(shown * 4) / 4;
      swingEl.style.transform = q ? `rotate(${q}deg)` : '';
    };
    function swayFrame(now) {
      const M = Mo();
      const P = cfg('pendulum');
      const s = M.springStep(sway, sway.target, (now - sway.last) / 1000, M.springParams(P.response, P.damping));
      sway.last = now;
      sway.x = s.x; sway.v = s.v;
      if (M.springSettled(sway, sway.target, 0.05, 0.5)) {
        sway.x = sway.target; sway.v = 0; sway.raf = 0;
        placeSwing(sway.x);
        return;
      }
      placeSwing(sway.x);
      sway.raf = requestAnimationFrame(swayFrame);
    }
    function runSway() {
      if (!Mo() || typeof requestAnimationFrame !== 'function' || reduceMotion()) {
        if (sway.raf) cancelAnimationFrame(sway.raf);
        Object.assign(sway, { x: 0, v: 0, target: 0, raf: 0 });
        placeSwing(0);
        return;
      }
      if (!sway.raf) { sway.last = performance.now(); sway.raf = requestAnimationFrame(swayFrame); }
    }
    // The body is moving at vx px/s (0 = stopped): lean the sign against it.
    function lean(vx) {
      const M = Mo();
      if (!M) return;
      const P = cfg('pendulum');
      const target = M.swayTarget(vx, P.dragGain, P.maxDeg);
      if (Math.abs(target - sway.target) < 0.05 && !sway.raf && Math.abs(sway.x - target) < 0.05) return;
      sway.target = target;
      runSway();
    }
    // A knock to the body: angular velocity in deg/s (+ = clockwise). Called
    // with no argument it uses the configured kick.
    function swing(degPerSec) {
      const P = cfg('pendulum');
      const v = Number.isFinite(degPerSec) ? degPerSec : (P.kick || 70);
      sway.v += v;
      runSway();
    }

    // ── Eyes: follow the cursor, blink now and then ───────────────────────
    // Offsets are whole rig units, set only when they change, and the eyes
    // snap like a sprite frame. A pose that works the eyes itself (look)
    // overrides the tracking in rig.css.
    const eyeTrack = svg.querySelector('.eye-track');
    let lookAtKey = '0,0';
    function lookAt(x, y) {
      const dx = reduceMotion() ? 0 : Math.round(Number(x) || 0);
      const dy = reduceMotion() ? 0 : Math.round(Number(y) || 0);
      const key = `${dx},${dy}`;
      if (key === lookAtKey) return;
      lookAtKey = key;
      eyeTrack.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : '';
    }
    // Blink only while the plain eyes are what shows: not closed, not a mood,
    // not under shades or a photo, not a pose already animating them.
    const plainEye = svg.querySelector('.eye-track .eye-open');
    const plainLid = svg.querySelector('.eye-track .eye-closed');
    function canBlink() {
      if (reduceMotion() || typeof getComputedStyle !== 'function') return false;
      if (typeof plainEye.getAnimations === 'function' && plainEye.getAnimations().length) return false;
      return getComputedStyle(plainEye).opacity === '1' && getComputedStyle(plainLid).opacity === '0';
    }
    let blinkTimer = null;
    let blinking = false;
    function blinkOnce(then) {
      const B = cfg('blink');
      svg.classList.add('blinking');
      blinkTimer = setTimeout(() => { svg.classList.remove('blinking'); then(); }, B.closedMs || 110);
    }
    function scheduleBlink() {
      const M = Mo();
      const B = cfg('blink');
      if (!M || !blinking) return;
      blinkTimer = setTimeout(() => {
        if (!blinking) return;
        if (!canBlink()) { scheduleBlink(); return; }
        const twice = Math.random() < (B.doubleChance || 0);
        blinkOnce(() => {
          if (twice && blinking) blinkTimer = setTimeout(() => blinkOnce(scheduleBlink), (B.closedMs || 110) * 1.4);
          else scheduleBlink();
        });
      }, M.nextBlinkDelay(Math.random(), B.minMs, B.maxMs));
    }
    function blinks(on) {
      clearTimeout(blinkTimer);
      blinkTimer = null;
      svg.classList.remove('blinking');
      blinking = !!on && !reduceMotion();
      if (blinking) scheduleBlink();
    }

    // ── Lamp change: a glow blooms off the newly lit lamp ─────────────────
    // Colour comes from --lamp-on (whatever the look lit it with); only
    // transform and opacity animate.
    const bloomEl = svg.querySelector('.lamp-bloom');
    let bloomKey = null;
    let bloomAnim = null;
    function bloom(lamp) {
      if (!lamp || !canAnimate(bloomEl)) return;
      const B = cfg('bloom');
      const x = Number(lamp.getAttribute('x')) || 0;
      const y = Number(lamp.getAttribute('y')) || 0;
      const w = Number(lamp.getAttribute('width')) || 0;
      const h = Number(lamp.getAttribute('height')) || 0;
      bloomEl.setAttribute('cx', String(x + w / 2));
      bloomEl.setAttribute('cy', String(y + h / 2));
      bloomEl.setAttribute('r', String(Math.max(w, h) / 2));
      if (bloomAnim) bloomAnim.cancel();
      bloomAnim = bloomEl.animate([
        { opacity: B.opacity ?? 0.55, transform: 'scale(1)' },
        { opacity: 0, transform: `scale(${B.scale || 1.9})` },
      ], { duration: B.ms || 420, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    }

    // ── Ambient clock ─────────────────────────────────────────────────────
    // Infinite CSS loops (the idle bob, lamp pulse, thinking dots, Zs…) would
    // otherwise run the renderer, and in SVG a full style/layout/paint, every
    // display frame, all day. Each one is paused and moved by hand instead:
    // stepped loops exactly when their frame changes, smooth ones at
    // MOTION.ambient.fps. One timeout covers them all; nothing runs between.
    const ambient = opts.ambient && typeof svg.getAnimations === 'function' && typeof CSSAnimation === 'function' ? makeAmbient() : null;
    function makeAmbient() {
      const tracked = new Map(); // anim -> { base, plan, dur, delay, due }
      const frozen = new Set(); // paused while not rendered
      let timer = null;
      let paused = false;
      let scanQueued = false;
      const now = () => performance.now();
      function planFor(a) {
        const t = a.effect && typeof a.effect.getTiming === 'function' ? a.effect.getTiming() : null;
        if (!t || t.iterations !== Infinity || !(t.duration > 0)) return null;
        const kfs = a.effect.getKeyframes().map((k) => ({ offset: k.computedOffset ?? k.offset, easing: k.easing && k.easing !== 'linear' ? k.easing : t.easing }));
        return Mo().ambientPlan(kfs, t.duration, t.direction, cfg('ambient').minMs || 1000);
      }
      // Smooth loops share one frame grid, so however many there are, they
      // cost one wake-up (and one style/paint pass) per ambient frame.
      function dueAt(rec, t) {
        if (!rec.plan.stepped) {
          const frame = 1000 / Math.max(1, cfg('ambient').fps || 12);
          return (Math.floor(t / frame) + 1) * frame;
        }
        return rec.base + Mo().nextStepTime(rec.plan.points, rec.dur, rec.delay, t - rec.base);
      }
      function tick() {
        timer = null;
        if (paused) return;
        const t = now();
        // Read every state first, then write every time: reading playState
        // after a write would force a style pass per animation.
        const due = [];
        for (const [a, rec] of tracked) {
          // cancelled (class removed, or a screenshot tool froze it): let go
          if (a.playState === 'idle' || a.playState === 'finished' || !svg.isConnected) { tracked.delete(a); continue; }
          if (rec.due <= t + 2) due.push([a, rec]);
        }
        for (const [a, rec] of due) {
          a.currentTime = t - rec.base;
          rec.due = dueAt(rec, t);
        }
        schedule();
      }
      function schedule() {
        if (timer || paused || !tracked.size) return;
        let next = Infinity;
        for (const rec of tracked.values()) next = Math.min(next, rec.due);
        timer = setTimeout(tick, Math.max(8, next - now()));
      }
      function scan() {
        scanQueued = false;
        if (!Mo()) return;
        const t = now();
        for (const a of frozen) {
          const el = a.effect && a.effect.target;
          if (a.playState === 'idle' || !el || !el.isConnected) frozen.delete(a);
          else if (el.getClientRects().length) { frozen.delete(a); a.play(); }
        }
        for (const a of svg.getAnimations({ subtree: true })) {
          if (tracked.has(a) || frozen.has(a) || !(a instanceof CSSAnimation) || a.playState !== 'running') continue;
          // not rendered (a sign layout not in use): nothing to draw, so hold
          // it still; a later scan picks it up if it comes into view
          const el = a.effect && a.effect.target;
          if (el && typeof el.getClientRects === 'function' && !el.getClientRects().length) { a.pause(); frozen.add(a); continue; }
          const plan = planFor(a);
          if (!plan) continue;
          const timing = a.effect.getTiming();
          const rec = { base: t - (a.currentTime || 0), plan, dur: timing.duration, delay: timing.delay || 0, due: 0 };
          a.pause();
          rec.due = dueAt(rec, t);
          tracked.set(a, rec);
        }
        if (timer) { clearTimeout(timer); timer = null; }
        schedule();
      }
      function queueScan() {
        if (scanQueued) return;
        scanQueued = true;
        Promise.resolve().then(scan);
      }
      svg.addEventListener('animationstart', queueScan);
      return {
        scan: queueScan,
        setPaused(p) {
          paused = !!p;
          if (paused) { clearTimeout(timer); timer = null; return; }
          const t = now();
          for (const rec of tracked.values()) rec.due = Math.min(rec.due, t);
          schedule();
        },
        get size() { return tracked.size; },
      };
    }
    // The widget went off screen (hidden, minimised): stop every clock the rig
    // owns until it's back.
    let blinksWanted = false;
    function setHidden(hidden) {
      if (ambient) ambient.setPaused(!!hidden);
      if (hidden) { blinksWanted = blinksWanted || blinking; blinks(false); } else if (blinksWanted) { blinksWanted = false; blinks(true); }
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
    const ROSTER_MAX = 5;
    // Scale and most chips shown per size; normal is the original look.
    const MINION_SIZES = { small: { scale: 1.0, max: 7 }, normal: { scale: 1.35, max: 5 }, large: { scale: 1.7, max: 4 } };
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
    // Chip sprites, all inside the robot's 6.9×7.5 footprint so the row
    // spacing and backdrop hold for every style.
    const EYE = '#211f1c';
    const STAR = Array.from({ length: 10 }, (_, i) => {
      const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? 1.45 : 3.6;
      return `${(3.45 + Math.cos(a) * rr).toFixed(2)} ${(4.1 + Math.sin(a) * rr).toFixed(2)}`;
    }).join(' L');
    const MINION_SPRITES = {
      robot: (fill) => [
        ['rect', { x: 0.7, y: 0, width: 5.5, height: 4, rx: 1, fill }],
        ['rect', { x: 2, y: 1.3, width: 1.1, height: 1.5, fill: EYE }],
        ['rect', { x: 3.8, y: 1.3, width: 1.1, height: 1.5, fill: EYE }],
        ['rect', { x: 0, y: 4.5, width: 6.9, height: 1.6, fill }],
        ['rect', { x: 1.2, y: 6.1, width: 1.4, height: 1.4, fill }],
        ['rect', { x: 4.3, y: 6.1, width: 1.4, height: 1.4, fill }],
      ],
      duck: (fill) => [
        ['ellipse', { cx: 3.1, cy: 5.2, rx: 3.1, ry: 2.3, fill }],
        ['circle', { cx: 4.4, cy: 2.5, r: 1.9, fill }],
        ['path', { d: 'M6.1 2.1 l0.8 0.55 l-0.8 0.55 z', fill: '#f28c28' }],
        ['circle', { cx: 4.8, cy: 2.1, r: 0.5, fill: EYE }],
      ],
      blob: (fill) => [
        ['path', { d: 'M0.4 7.5 Q0.4 1 3.45 1 Q6.5 1 6.5 7.5 Z', fill }],
        ['rect', { x: 2.2, y: 3.6, width: 0.9, height: 1.2, fill: EYE }],
        ['rect', { x: 3.8, y: 3.6, width: 0.9, height: 1.2, fill: EYE }],
      ],
      ghost: (fill) => [
        ['path', { d: 'M0.6 7.5 V3.4 A2.85 2.85 0 0 1 6.3 3.4 V7.5 l-0.95 -0.9 l-0.95 0.9 l-0.95 -0.9 l-0.95 0.9 l-0.95 -0.9 z', fill }],
        ['rect', { x: 2, y: 2.8, width: 1, height: 1.4, fill: EYE }],
        ['rect', { x: 3.9, y: 2.8, width: 1, height: 1.4, fill: EYE }],
      ],
      cat: (fill) => [
        ['path', { d: 'M0.7 3.6 L1 0.6 L2.9 2.4 Z', fill }],
        ['path', { d: 'M6.2 3.6 L5.9 0.6 L4 2.4 Z', fill }],
        ['ellipse', { cx: 3.45, cy: 4.9, rx: 3.1, ry: 2.6, fill }],
        ['rect', { x: 2, y: 4, width: 0.9, height: 1.2, fill: EYE }],
        ['rect', { x: 4, y: 4, width: 0.9, height: 1.2, fill: EYE }],
      ],
      star: (fill) => [['path', { d: `M${STAR} Z`, fill }]],
      dot: (fill) => [['circle', { cx: 3.45, cy: 4.2, r: 3, fill }]],
    };
    let minionKey = null;
    function drawMinions(list, showRoster, size, style, color) {
      const { scale, max } = MINION_SIZES[size] || MINION_SIZES.normal;
      const sprite = MINION_SPRITES[style] || MINION_SPRITES.robot;
      const custom = /^#[0-9a-f]{6}$/i.test(color || '') ? color : null;
      const now = Date.now();
      const arr = (Array.isArray(list) ? list : []).slice(0, 32);
      // Elapsed time is bucketed to the minute (seconds while under a minute)
      // so the roster's "since" column keeps ticking without redrawing the
      // whole row on every 2s poll.
      const key = `${showRoster ? 1 : 0}|${scale}|${style}|${custom}|${arr.map((a) => `${a.name}:${a.status}:${elapsed(a.since, now)}`).join(',')}`;
      if (key === minionKey) return;
      minionKey = key;
      const g = svg.querySelector('.minions');
      const r = svg.querySelector('.agents-label');
      while (g.firstChild) g.removeChild(g.firstChild);
      while (r.firstChild) r.removeChild(r.firstChild);
      if (!arr.length) return;
      const pitch = 6.9 * scale + 1.6;
      // Slots that fit inside the 64-wide viewBox with the backdrop's 2.5
      // padding each side; the "+N" takes one of them.
      const fit = Math.min(max, Math.floor((64 - 5 + 1.6) / pitch));
      const shown = arr.length > fit ? arr.slice(0, fit - 1) : arr;
      const extra = arr.length - shown.length;
      const width = shown.length * pitch - 1.6 + (extra > 0 ? pitch : 0);
      const x0 = 32 - width / 2;
      // Chips grow upwards from a fixed baseline so large ones stay inside
      // the 82-tall viewBox.
      const y0 = 81.1 - 7.5 * scale;
      // A translucent backdrop so the row reads clearly over any desktop
      // background instead of blending into it.
      g.appendChild(mk('rect', {
        x: x0 - 2.5, y: y0 - 1.8, width: width + 5, height: 6.9 * scale + 3.6, rx: 2.4,
        fill: '#151517', 'fill-opacity': 0.55,
      }));
      shown.forEach((a, i) => {
        const st = MINION_FILL[a.status] ? a.status : 'working';
        const fill = st === 'working' && custom ? custom : MINION_FILL[st];
        const chip = mk('g', {
          class: `minion minion-${a.status}`,
          transform: `translate(${x0 + i * pitch} ${y0}) scale(${scale})`,
          'data-name': a.name, 'data-status': a.status, style: 'pointer-events:auto;cursor:pointer',
        });
        const inner = mk('g', { class: 'minion-in' });
        for (const [tag, attrs] of sprite(fill)) inner.appendChild(mk(tag, attrs));
        chip.appendChild(inner);
        const title = mk('title', {});
        title.textContent = `${a.name} — ${a.status}${a.since ? ` (${elapsed(a.since, now)})` : ''}`;
        chip.appendChild(title);
        g.appendChild(chip);
      });
      if (extra > 0) {
        const more = mk('text', { class: 'minion-more', x: x0 + shown.length * pitch + 2.4, y: y0 + 3.4 * scale + 0.2, 'text-anchor': 'middle' });
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
      svg.style.removeProperty('--walk-target');
      moveTo(0, 1);
    }
    // The mover's x rides a spring on rAF, so a new target mid-walk bends the
    // path instead of restarting the ease from a standstill. Whole rig units
    // only, so the pixel art never sits between pixels; the loop stops once
    // settled.
    const mover = svg.querySelector('.mover');
    const walk = { x: 0, v: 0, target: 0, speed: 1, raf: 0, last: 0 };
    const placeMover = (x) => { mover.style.transform = x ? `translateX(${x}px)` : ''; };
    function walkFrame(now) {
      const M = window.BuddyMotion;
      const W = cfg('walk');
      const s = M.springStep(walk, walk.target, (now - walk.last) / 1000, M.springParams((W.response || 2.2) / walk.speed, W.damping ?? 1));
      walk.last = now;
      walk.x = s.x; walk.v = s.v;
      if (M.springSettled(walk, walk.target, 0.3, 1)) {
        walk.x = walk.target; walk.v = 0; walk.raf = 0;
        placeMover(walk.target);
        return;
      }
      placeMover(Math.round(walk.x));
      walk.raf = requestAnimationFrame(walkFrame);
    }
    function moveTo(dx, speed) {
      walk.target = dx;
      walk.speed = Math.max(0.01, Number(speed) || 1);
      if (!window.BuddyMotion || typeof requestAnimationFrame !== 'function' || reduceMotion()) {
        if (walk.raf) cancelAnimationFrame(walk.raf);
        walk.raf = 0; walk.x = dx; walk.v = 0;
        placeMover(dx);
        return;
      }
      if (!walk.raf) { walk.last = performance.now(); walk.raf = requestAnimationFrame(walkFrame); }
    }
    // Walk Claude to x (rig units, 32 = home). Legs run while moving.
    function walkTo(x) {
      const cur = Number(svg.style.getPropertyValue('--walk-target') || 0);
      const dx = x - 32;
      moveTo(dx, garden.speed);
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
        // At preview speeds a trip's drop can fall between two ticks; its pot
        // still has to be down before the next trip.
        while (garden.pots.length < i) { const x = potSlot(garden.pots.length); g.appendChild(drawPot(x)); garden.pots.push({ x, crop: null, planted: false }); }
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
    // Smoke: every cigarette lasts SMOKE_CYCLE_MS of real time. It burns down
    // for most of it; the tail end is flicked away, stomped out, and a new one
    // comes out of the pack and gets lit, all as classes CSS animates. Stages
    // are derived from the clock on every tick, so nothing drifts or piles up.
    let smoke = null;        // { since, cycle, key, timer }
    function scheduleSmoke(on, since, cycleMs) {
      if (smoke) clearTimeout(smoke.timer);
      smoke = null;
      svg.classList.remove('cig-lit', ...SMOKE_STEPS.map(([name]) => `smoke-${name}`));
      if (!on) return;
      const now = Date.now();
      smoke = {
        since: since > 0 && since <= now ? since : now,
        cycle: cycleMs > 0 ? Math.max(SMOKE_MIN_CYCLE_MS, cycleMs) : SMOKE_CYCLE_MS,
        key: null, timer: null,
      };
      smokeTick();
    }
    function smokeTick() {
      if (!smoke) return;
      // Reduced motion: no flick or stomp, the cigarette just renews in place.
      const steps = matchMedia('(prefers-reduced-motion: reduce)').matches ? [] : SMOKE_STEPS;
      const lit = smoke.cycle - steps.reduce((n, [, ms]) => n + ms, 0);
      const elapsed = Math.max(0, Date.now() - smoke.since);
      const t = elapsed % smoke.cycle;
      let stage = 'lit', end = lit;
      if (t >= lit) {
        let at = lit;
        for (const [name, ms] of steps) { if (t < at + ms) { stage = name; end = at + ms; break; } at += ms; }
      }
      const key = `${Math.floor(elapsed / smoke.cycle)}:${stage}`;
      if (smoke.key !== key) {
        smoke.key = key;
        for (const [name] of SMOKE_STEPS) svg.classList.toggle(`smoke-${name}`, stage === name);
        svg.style.setProperty('--cig-burn', `${lit}ms`);
        if (stage === 'lit' || (stage === 'flick' && !svg.classList.contains('cig-lit'))) {
          // restart the burn-down, part-way through if we joined late
          svg.classList.remove('cig-lit'); void svg.getBoundingClientRect();
          svg.style.setProperty('--cig-at', `${-Math.min(t, lit)}ms`);
          svg.classList.add('cig-lit');
        } else if (stage !== 'flick') svg.classList.remove('cig-lit');
      }
      // a rig thrown away mid-smoke (editor thumbnails re-render) stops here
      smoke.timer = setTimeout(() => { if (svg.isConnected) smokeTick(); else smoke = null; }, end - t + 20);
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

    return { svg, setLook, celebrate, burst, playEvent, react, flash, pokePet, squash, lean, swing, lookAt, blinks, setHidden, get look() { return current; } };
  }

  window.mountRig = mountRig;
  window.RIG_POSES = POSES;
  window.RIG_COSTUMES = COSTUMES;
  window.RIG_CAMEOS = CAMEOS;
  window.RIG_CAMEO_ID = CAMEO_ID;
  window.rigSetCameoPhotos = setCameoPhotos;
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
