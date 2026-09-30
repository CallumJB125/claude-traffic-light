// Drawn icons, one 16px grid, 1.5 stroke, currentColor. The pill glyphs from
// cardface.js (⏳ ✋ ✖ …) keep their meaning here as shapes, so state never
// rests on colour alone.
import { h } from './h.js';

const P = (d, extra = {}) => h('path', { d, ...extra });
const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

const SHAPES = {
  clock: () => [h('circle', { cx: 8, cy: 8, r: 5.75 }), P('M8 5v3.2l2 1.3')],
  ring: () => [h('circle', { cx: 8, cy: 8, r: 5.25, 'stroke-dasharray': '2.2 2.2' })],
  lamp: () => [h('rect', { x: 3, y: 3, width: 10, height: 10, rx: 2.5, fill: 'currentColor' })],
  half: () => [h('rect', { x: 3.25, y: 3.25, width: 9.5, height: 9.5, rx: 2.5 }), P('M8 3.5v9h2.5a2.2 2.2 0 0 0 2.2-2.2V5.7a2.2 2.2 0 0 0-2.2-2.2z', { fill: 'currentColor', stroke: 'none' })],
  hand: () => [P('M5.5 8.5V4.25a1 1 0 0 1 2 0V8M7.5 7.5V3.25a1 1 0 0 1 2 0V8M9.5 7.5V4a1 1 0 0 1 2 0v5.5c0 2.5-1.6 4.25-3.9 4.25-1.7 0-2.6-.9-3.5-2.3L2.9 9.4a1 1 0 0 1 1.7-1l.9 1.1')],
  pause: () => [P('M6 4.5v7M10 4.5v7')],
  moon: () => [P('M12.5 9.8A5 5 0 0 1 6.2 3.5a5 5 0 1 0 6.3 6.3z')],
  sync: () => [P('M12.5 6.5A4.75 4.75 0 0 0 4 5.2M3.5 9.5A4.75 4.75 0 0 0 12 10.8'), P('M4 2.8v2.6h2.6M12 13.2v-2.6H9.4')],
  cross: () => [h('rect', { x: 3, y: 3, width: 10, height: 10, rx: 2.5 }), P('M6.2 6.2l3.6 3.6M9.8 6.2l-3.6 3.6')],
  swap: () => [P('M3 5.5h9l-2.2-2.2M13 10.5H4l2.2 2.2')],
  diamond: () => [P('M8 2.8l5.2 5.2L8 13.2 2.8 8z')],
  check: () => [P('M3.5 8.5l3 3 6-7')],
  warn: () => [P('M8 2.75l5.75 10.25H2.25z'), P('M8 6.75v2.75M8 11.2v.05')],
  search: () => [h('circle', { cx: 7, cy: 7, r: 4.25 }), P('M10.3 10.3l3 3')],
  plus: () => [P('M8 3.5v9M3.5 8h9')],
  close: () => [P('M4.5 4.5l7 7M11.5 4.5l-7 7')],
  sun: () => [h('circle', { cx: 8, cy: 8, r: 2.75 }), P('M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1')],
  auto: () => [h('circle', { cx: 8, cy: 8, r: 5.75 }), P('M8 2.25v11.5a5.75 5.75 0 0 0 0-11.5z', { fill: 'currentColor', stroke: 'none' })],
  branch: () => [h('circle', { cx: 4.75, cy: 3.75, r: 1.5 }), h('circle', { cx: 4.75, cy: 12.25, r: 1.5 }), h('circle', { cx: 11.25, cy: 5.25, r: 1.5 }), P('M4.75 5.25v5.5M11.25 6.75c0 2.5-2 3-6.5 4')],
  eye: () => [P('M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z'), h('circle', { cx: 8, cy: 8, r: 1.9 })],
  stop: () => [h('rect', { x: 4, y: 4, width: 8, height: 8, rx: 1.5 })],
  external: () => [P('M9.5 2.75h3.75V6.5M13.25 2.75L7.5 8.5M11.5 9.5v3a.75.75 0 0 1-.75.75h-7.5a.75.75 0 0 1-.75-.75v-7.5a.75.75 0 0 1 .75-.75h3')],
  chevron: () => [P('M6 3.5L10.5 8 6 12.5')],
  person: () => [h('circle', { cx: 8, cy: 5.5, r: 2.5 }), P('M3.25 13.25c.6-2.4 2.4-3.75 4.75-3.75s4.15 1.35 4.75 3.75')],
  terminal: () => [h('rect', { x: 2.25, y: 3, width: 11.5, height: 10, rx: 2 }), P('M5 6.5l2 1.75L5 10M8.5 10.25h2.5')],
  queue: () => [P('M3 4.5h10M3 8h10M3 11.5h6')],
  dot: () => [h('circle', { cx: 8, cy: 8, r: 2.5, fill: 'currentColor', stroke: 'none' })],
  plug: () => [P('M6 2.5v3M10 2.5v3M4.25 5.5h7.5v2.25a3.75 3.75 0 0 1-7.5 0zM8 11.5v2.25')],
  columns: () => [h('rect', { x: 2.75, y: 3, width: 3, height: 10, rx: 1 }), h('rect', { x: 6.5, y: 3, width: 3, height: 7, rx: 1 }), h('rect', { x: 10.25, y: 3, width: 3, height: 8.5, rx: 1 })],
  chart: () => [P('M2.75 2.75v10.5h10.5'), P('M5.25 10.25l2.5-3.25 2.25 2 3-4.25')],
  rows: () => [h('rect', { x: 2.75, y: 3, width: 10.5, height: 10, rx: 1.5 }), P('M2.75 6.5h10.5M2.75 9.75h10.5M6.25 3v10')],
};

// cardface PILLS key → icon
export const PILL_ICON = {
  queued: 'clock', claimed: 'ring', running: 'lamp', quiet: 'half', blocked: 'hand', parked: 'pause',
  suspended: 'moon', reconnecting: 'sync', unresponsive: 'ring', orphaned: 'cross', handing_over: 'swap',
  handed_over: 'swap', failed: 'cross', failed_limit: 'cross', in_review: 'diamond', done: 'check',
};

export const ALERT_ICON = { blocked: 'hand', overlap: 'warn', orphaned: 'cross', failed: 'cross' };

export function icon(name, cls = '') {
  const shape = SHAPES[name] ?? SHAPES.dot;
  return h('svg', { class: `icon ${cls}`.trim(), viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true', focusable: 'false', ...stroke }, shape());
}

// The pixel Claude from rig.js (body + sign), scaled down. `lamps` lights the
// sign like the widget does: {red, amber, green} booleans.
export function pixelClaude({ lamps = {}, eyes = 'open', cls = '' } = {}) {
  const lamp = (slot, x) => h('rect', { class: `px-lamp${lamps[slot] ? ` lit lit-${slot}` : ''}`, x, y: 6.5, width: 16, height: 16, rx: 2.5 });
  const eye = eyes === 'shut'
    ? [h('rect', { class: 'px-eye', x: 21, y: 45.25, width: 6.5, height: 1.6, rx: 0.8 }), h('rect', { class: 'px-eye', x: 36.5, y: 45.25, width: 6.5, height: 1.6, rx: 0.8 })]
    : [h('rect', { class: 'px-eye', x: 22, y: 43.5, width: 4.5, height: 4.5 }), h('rect', { class: 'px-eye', x: 37.5, y: 43.5, width: 4.5, height: 4.5 })];
  return h('svg', { class: `pixel-claude ${cls}`.trim(), viewBox: '0 0 64 70', 'aria-hidden': 'true', focusable: 'false', 'shape-rendering': 'crispEdges' },
    h('rect', { class: 'px-post', x: 4, y: 24, width: 56, height: 5 }),
    lamp('red', 6.5), lamp('amber', 24), lamp('green', 41.5),
    h('rect', { class: 'px-body', x: 0, y: 29, width: 9, height: 10 }),
    h('g', { class: 'px-body' },
      h('rect', { x: 17, y: 39, width: 30, height: 13 }),
      h('rect', { x: 4, y: 52, width: 56, height: 7 }),
      h('rect', { x: 15, y: 59, width: 7, height: 9 }),
      h('rect', { x: 28.5, y: 59, width: 7, height: 9 }),
      h('rect', { x: 42, y: 59, width: 7, height: 9 })),
    eye);
}
