// The B3 compatibility matrix: one character against every costume, cameo,
// eye mood, mouth item, pose, sign and routine, one rig per cell.
// matrix.html?body=<id>&axis=<axis>. Every animation is paused at a fixed
// time before the page reports ready, so a screenshot is deterministic.
(function () {
  const q = new URLSearchParams(location.search);
  const body = q.get('body') || 'claude';
  const axis = q.get('axis') || 'costume';

  // A drawn face, not anyone's photo: the "user photo" cameo sample.
  const FACE = 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" fill="#7fa7c9"/><ellipse cx="50" cy="55" rx="30" ry="38" fill="#e8b894"/>
    <path d="M20 40 q30 -40 60 0 v-12 q-30 -30 -60 0 z" fill="#4a3222"/>
    <circle cx="38" cy="50" r="4" fill="#211f1c"/><circle cx="62" cy="50" r="4" fill="#211f1c"/>
    <path d="M40 74 q10 7 20 0" stroke="#8a3a2a" stroke-width="3" fill="none"/></svg>`);
  const PHOTO = { id: 'sample', rev: 1, src: FACE, eyes: { x: 0.5, y: 0.5 }, mouth: { x: 0.5, y: 0.74 } };

  const base = { lamp: 'green', eyes: 'default', pose: 'none', body };
  const MINIONS = [
    { name: 'explore', status: 'working' }, { name: 'review', status: 'waiting' }, { name: 'tests', status: 'done' },
  ];
  const cells = {
    costume: () => window.RIG_COSTUMES.map((c) => ({ label: c, look: { costume: c } })),
    cameo: () => [...window.RIG_CAMEOS.map((c) => ({ label: c, look: { cameo: c } })),
      { label: 'photo', look: { cameo: 'sample', cameoPhoto: PHOTO } },
      { label: 'photo+hat', look: { cameo: 'sample', cameoPhoto: PHOTO, costume: 'tophat' } },
      { label: 'photo+smoke', look: { cameo: 'sample', cameoPhoto: PHOTO, pose: 'smoke' } }],
    eyes: () => ['default', 'closed', ...window.RIG_EYE_MOODS].map((e) => ({ label: e, look: { eyes: e } })),
    pose: () => window.RIG_POSES.map((p) => ({ label: p, look: { pose: p }, freeze: 400 })),
    mouth: () => ['grin', 'smoke', 'zyn', 'munch', 'selfie'].flatMap((p) => [
      { label: p, look: { pose: p }, freeze: 4500 },
      { label: `${p}+photo`, look: { pose: p, cameo: 'sample', cameoPhoto: PHOTO }, freeze: 4500 },
    ]).concat([{ label: 'talking', look: {}, talking: true, freeze: 120 }, { label: 'grumpy', look: { grumpy: true } }]),
    sign: () => window.RIG_SIGNS.flatMap((s) => ['red', 'amber', 'green'].map((l) => ({ label: `${s} ${l}`, look: { sign: s, lamp: l } })))
      .concat([{ label: 'number', look: { number: 7 } }, { label: 'banner', look: { pose: 'banner', text: 'TESTS' }, freeze: 600 }, { label: 'bubble', look: { pose: 'bubble', text: 'BRB' }, freeze: 600 }]),
    routine: () => [
      { label: 'celebrate', look: {}, celebrate: true, freeze: 300 },
      { label: 'knock', look: { pose: 'knock' }, freeze: 250 },
      { label: 'minions', look: { minions: MINIONS } },
      { label: 'roster', look: { minions: MINIONS, showRoster: true } },
      { label: 'walking', look: { gardenAct: 'walking' }, freeze: 150 },
      { label: 'carrying', look: { gardenAct: 'carrying' } },
      { label: 'watering', look: { gardenAct: 'watering' } },
      { label: 'lounging', look: { gardenAct: 'lounging' }, freeze: 1200 },
      { label: 'eating', look: { gardenAct: 'eating', facing: 'right' }, freeze: 300 },
      { label: 'face-left', look: { facing: 'left' } },
      { label: 'tinted', look: { bodyColor: '#3a6ea5' } },
      { label: 'tint+juice', look: { bodyColor: '#3a6ea5', pose: 'juice' }, freeze: 3000 },
    ],
  };

  const grid = document.getElementById('grid');
  const rigs = [];
  for (const c of (cells[axis] || cells.costume)()) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.label = c.label;
    const stage = document.createElement('div');
    stage.className = 'stage';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = c.label;
    cell.append(stage, label);
    grid.appendChild(cell);
    const rig = window.mountRig(stage);
    rig.setLook({ ...base, ...c.look });
    if (c.talking) rig.talking(true);
    if (c.celebrate) rig.celebrate();
    rigs.push({ rig, freeze: c.freeze || 0 });
  }
  // Two frames so class-triggered animations have started, then pin them.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const { rig, freeze } of rigs) {
      for (const a of rig.svg.getAnimations({ subtree: true })) { a.pause(); a.currentTime = freeze; }
    }
    document.body.dataset.ready = '1';
  }));
})();
