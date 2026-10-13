// The tray/widget menu's usage lines: today's spend and the model that cost
// the most today, read from Usage.modelMix's `today` window. Pure; click opens
// the Usage page. No turns priced today → no lines.
'use strict';

const money = (v) => (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`);

function items(today, open) {
  if (!today || !(today.cost > 0)) return [];
  const top = (today.models || [])[0];
  const lines = [{ label: `Spent today: ${money(today.cost)}`, click: () => open() }];
  if (top) lines.push({ label: `Busiest model: ${top.name} (${Math.round((top.share || 0) * 100)}% of turns)`, click: () => open() });
  return [...lines, { type: 'separator' }];
}

module.exports = { items, money };
