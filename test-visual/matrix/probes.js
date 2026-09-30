// Test-only characters that push the contract's edges: they exist so the
// matrix exercises fitting and every fallback before a real character does.
// Deliberately plain shapes; registered as imports would be (not built-in).
(function () {
  const C = window.BuddyCharacters;
  const probes = [
    {
      // tall and thin, arms up, two marked legs
      id: 'u-probe-tall', name: 'Tall probe', contract: 1, legs: true,
      anchors: {
        head: { x: 23, y: 22, w: 18, h: 24 }, hatLine: 22, ground: 68,
        eyes: { left: { x: 28, y: 31 }, right: { x: 36, y: 31 } }, mouth: { x: 32, y: 37 },
        hands: { left: { x: 4.5, y: 34 }, right: { x: 50, y: 42 } },
        faceBox: { x: 23, y: 22, w: 18, h: 24 }, skinParts: ['body'],
      },
      sprite: { body: '<rect x="23" y="22" width="18" height="38" rx="4" /><rect x="15" y="30" width="5" height="16" rx="2" /><rect x="44" y="30" width="5" height="16" rx="2" /><rect x="18" y="44" width="6" height="4" /><rect x="40" y="44" width="6" height="4" /><rect class="cp-leg-a" x="25" y="60" width="5" height="8" /><rect class="cp-leg-b" x="34" y="60" width="5" height="8" />' },
    },
    {
      // round, no hands, no legs, no mouth, one eye
      id: 'u-probe-blob', name: 'Blob probe', contract: 1, legs: false, color: '#7fbf6a',
      anchors: {
        head: { x: 14, y: 40, w: 36, h: 26 }, hatLine: 41, ground: 68,
        eyes: { single: { x: 32, y: 50 } }, mouth: null, hands: null,
        faceBox: { x: 14, y: 36, w: 36, h: 32 }, skinParts: [],
      },
      sprite: { body: '<path d="M14 68 Q14 40 32 40 Q50 40 50 68 Z" /><ellipse cx="26" cy="46" rx="4" ry="2" fill="#a8dc96" />' },
    },
    {
      // wide and low, big eyes far apart, short legs
      id: 'u-probe-wide', name: 'Wide probe', contract: 1, legs: true, color: '#a77b52',
      anchors: {
        head: { x: 8, y: 44, w: 48, h: 16 }, hatLine: 44, ground: 68,
        eyes: { left: { x: 20, y: 50 }, right: { x: 44, y: 50 } }, mouth: { x: 32, y: 56 },
        hands: { left: { x: 4.5, y: 36 }, right: { x: 56, y: 54 } },
        faceBox: { x: 12, y: 38, w: 40, h: 24 }, skinParts: [],
      },
      sprite: { body: '<rect x="8" y="44" width="48" height="18" rx="6" /><rect x="4" y="52" width="4" height="6" /><rect x="56" y="52" width="4" height="6" /><rect class="cp-leg-a" x="12" y="62" width="6" height="6" /><rect class="cp-leg-b" x="24" y="62" width="6" height="6" /><rect class="cp-leg-a" x="34" y="62" width="6" height="6" /><rect class="cp-leg-b" x="46" y="62" width="6" height="6" />' },
    },
    {
      // a screen: the face (and a photo) goes on it; no eyes or mouth of its own
      id: 'u-probe-screen', name: 'Screen probe', contract: 1, legs: true, color: '#c9c2b0',
      anchors: {
        head: { x: 12, y: 28, w: 40, h: 32 }, hatLine: 28, ground: 68,
        eyes: 'none', mouth: null,
        hands: { left: { x: 4.5, y: 34 }, right: { x: 55, y: 50 } },
        faceBox: { x: 17, y: 32, w: 30, h: 24 }, skinParts: [],
      },
      sprite: {
        body: '<rect x="12" y="28" width="40" height="32" rx="3" /><rect x="26" y="60" width="12" height="4" /><rect x="18" y="64" width="28" height="4" /><rect x="4" y="44" width="8" height="4" /><rect x="52" y="44" width="8" height="4" />',
        front: '<rect x="17" y="32" width="30" height="24" rx="2" fill="#2a3a32" /><rect x="19" y="34" width="8" height="2" fill="#4a6a58" />',
      },
    },
  ];
  for (const p of probes) C.register(p);
})();
