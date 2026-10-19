// Main-process hook for the seasonal pack: main.js calls apply() on every
// resolved look (one line), so the date logic stays in src/seasonal.js.
const Seasonal = require('./seasonal.js');

function apply(look, owned, config, now = Date.now()) {
  return Seasonal.overlay(look, owned, config, new Date(now));
}

module.exports = { apply };
