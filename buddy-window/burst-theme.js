'use strict';

// Applies burst-theme.css to the Usage optimiser's dashboard view with
// insertCSS. Inserted CSS is dropped by a navigation, so it is re-applied on
// dom-ready and on both kinds of navigation, removing the previous key after
// the new sheet is in, so there is no unstyled flash and sheets never pile up. Every failure is swallowed: a page that could
// not be themed is simply left as Burst drew it.

const fs = require('node:fs');
const path = require('node:path');

const CSS_FILE = path.join(__dirname, 'burst-theme.css');

function createThemeInjector({ css = () => fs.readFileSync(CSS_FILE, 'utf8') } = {}) {
  return {
    attach(wc) {
      let key = null;
      let chain = Promise.resolve();
      const alive = () => !wc.isDestroyed();
      const apply = () => {
        chain = chain.then(async () => {
          if (!alive()) return;
          const old = key;
          try { key = await wc.insertCSS(css()); } catch { key = null; }
          if (old !== null && old !== key && alive()) { try { await wc.removeInsertedCSS(old); } catch { /* dropped by the navigation */ } }
        });
        return chain;
      };
      for (const ev of ['dom-ready', 'did-navigate', 'did-navigate-in-page']) wc.on(ev, apply);
      return { apply, key: () => key };
    },
  };
}

module.exports = { createThemeInjector, CSS_FILE };
