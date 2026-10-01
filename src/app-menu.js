// The "whole app" half of the menu that the tray and the widget's right-click
// share, so they cannot drift: Open Plexiform, then every page of the Plexiform
// window. Pages the sidebar marks 'soon' stay visible but disabled. Pure:
// main passes the actions in and adds the widget-only items around it.
// `popOuts`: page ids whose menu entry opens a small pop-out instead of the
// page (Usage); the sidebar still opens the page itself.
'use strict';

const ACCELERATORS = Object.freeze({ lights: 'CmdOrCtrl+L', settings: 'CmdOrCtrl+,' });

// Where "Something's off / Idea…" slots in once a feedback window exists.
// `feedback`: an item ({label, click}) or null.
function appItems({ pages, groups, open, openLabel, openAccelerator = 'CmdOrCtrl+B', feedback = null, popOuts = {} }) {
  const out = [{ label: openLabel, accelerator: openAccelerator, click: () => open() }, { type: 'separator' }];
  for (const g of groups) {
    const ps = pages.filter((p) => p.group === g.id);
    if (!ps.length) continue;
    for (const p of ps) {
      if (p.kind === 'soon') { out.push({ label: `Open ${p.title}… (soon)`, enabled: false }); continue; }
      const item = { label: `Open ${p.title}…`, click: () => (popOuts[p.id] || (() => open(p.id)))() };
      if (ACCELERATORS[p.id]) item.accelerator = ACCELERATORS[p.id];
      out.push(item);
    }
    out.push({ type: 'separator' });
  }
  if (feedback) out.push(feedback, { type: 'separator' });
  return out;
}

module.exports = { appItems, ACCELERATORS };
