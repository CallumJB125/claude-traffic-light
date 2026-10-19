'use strict';
// Wires a window to the first-run tour: main's `tour:step` goes to the
// coachmark (tour-coachmark.js), and its Next / Skip / missing go back. The
// step is also re-dispatched as a `plexiform-tour` DOM event for the widget's
// demo question.
(function () {
  if (!window.tourApi || !window.TourCoachmark) return;
  const rm = window.matchMedia('(prefers-reduced-motion: reduce)');
  const cm = window.TourCoachmark.create(document, { onAction: (kind, id) => window.tourApi.action(kind, id), reducedMotion: () => rm.matches });
  window.tourApi.onStep((step) => {
    cm.show(step);
    document.dispatchEvent(new CustomEvent('plexiform-tour', { detail: step || null }));
  });
})();
