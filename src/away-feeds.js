// The background feeds (spend, GitHub, busy/Focus) on one tick that holds
// only while the machine is asleep. Locked or with its displays off it keeps
// going: lock-and-walk-away is exactly when a runaway spend alert matters.
// Waking catches up at once rather than waiting out the interval.
const { createMotionGate } = require('./motion-gate.js');

const AWAY_REASONS = new Set(['suspended']);

function createAwayFeeds({ feeds = () => [], busyWatch }) {
  const gate = createMotionGate((away) => {
    if (away) { busyWatch.stop(); return; }
    busyWatch.start();
    tick();
  });
  function tick() {
    if (gate.paused) return;
    for (const feed of feeds()) feed();
  }
  return {
    tick,
    // Every machine-wide reason comes through here; only sleep holds feeds.
    power(reason, on) { if (AWAY_REASONS.has(reason)) gate.set(reason, on); },
    get away() { return gate.paused; },
  };
}

module.exports = { createAwayFeeds, AWAY_REASONS };
