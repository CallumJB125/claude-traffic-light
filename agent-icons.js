'use strict';
// Find agents glyphs. Hand-drawn on the sidebar's 16px grid with a 1.5 stroke
// (buddy-window/sidebar.js), stroked only, so they read as one family with
// the app's own icons. The catalogue names a glyph id per agent
// (catalog/agents/icon-rules.json); an unknown id falls back to `sparkle`.
(function (root) {
  const GLYPHS = Object.freeze({
    code: ['M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3L7 13'],
    server: ['M2.75 2.75h10.5v4.5H2.75zM2.75 8.75h10.5v4.5H2.75z', 'M5 5h.01M5 11h.01M8.5 5h2.5M8.5 11h2.5'],
    layout: ['M2.75 2.75h10.5v10.5H2.75zM2.75 6h10.5M6.5 6v7.25'],
    phone: ['M4.75 1.75h6.5v12.5h-6.5z', 'M7.25 12h1.5'],
    cloud: ['M4.75 12.25a2.75 2.75 0 0 1-.4-5.47A3.75 3.75 0 0 1 11.6 6a3.13 3.13 0 0 1-.1 6.25z'],
    database: ['M2.75 4c0-1 2.35-1.75 5.25-1.75s5.25.75 5.25 1.75-2.35 1.75-5.25 1.75S2.75 5 2.75 4z', 'M2.75 4v8c0 1 2.35 1.75 5.25 1.75s5.25-.75 5.25-1.75V4M2.75 8c0 1 2.35 1.75 5.25 1.75S13.25 9 13.25 8'],
    shield: ['M8 1.75l5.25 2v4c0 3.1-2.2 5.35-5.25 6.5-3.05-1.15-5.25-3.4-5.25-6.5v-4z', 'M5.75 8l1.6 1.6 3-3.1'],
    bug: ['M5.25 6.5a2.75 2.75 0 0 1 5.5 0v3.25a2.75 2.75 0 0 1-5.5 0z', 'M6 3.25l1 1.25M10 3.25l-1 1.25M2.5 7.5h2.75M10.75 7.5h2.75M2.75 11.5l2.6-1M13.25 11.5l-2.6-1M8 7v5.5'],
    flask: ['M6.25 1.75h3.5M6.75 1.75v4.5L2.9 12.6a1.1 1.1 0 0 0 .95 1.65h8.3a1.1 1.1 0 0 0 .95-1.65L9.25 6.25v-4.5', 'M4.5 10h7'],
    chart: ['M2.75 13.25h10.5M4.5 11V8M8 11V4.5M11.5 11V6.5'],
    megaphone: ['M2.75 6.25h2.5L11.5 3v10L5.25 9.75h-2.5z', 'M5.5 9.75l1 3.5h1.75l-.75-3', 'M13.25 6.5v3'],
    pen: ['M10.5 2.5l3 3-7.75 7.75-3.75.75.75-3.75z', 'M9 4l3 3'],
    palette: ['M8 1.75a6.25 6.25 0 1 0 0 12.5c1 0 1.5-.6 1.5-1.35 0-.95-.85-1.4-.85-2.15 0-.7.55-1.25 1.35-1.25h1.5a2.75 2.75 0 0 0 2.75-2.75c0-2.75-2.8-5-6.25-5z', 'M4.75 7.5h.01M6.5 4.75h.01M9.75 4.5h.01M11.75 6.75h.01'],
    gamepad: ['M4.5 4.75h7a3 3 0 0 1 2.9 2.2l.6 2.3a1.7 1.7 0 0 1-2.85 1.6L10.5 9.25h-5L3.85 10.85A1.7 1.7 0 0 1 1 9.25l.6-2.3a3 3 0 0 1 2.9-2.2z', 'M5 6.25v2M4 7.25h2M10.5 6.75h.01M11.75 7.75h.01'],
    globe: ['M8 1.75a6.25 6.25 0 1 1 0 12.5A6.25 6.25 0 0 1 8 1.75z', 'M1.75 8h12.5M8 1.75c1.75 1.8 2.5 3.9 2.5 6.25S9.75 12.45 8 14.25C6.25 12.45 5.5 10.35 5.5 8S6.25 3.55 8 1.75z'],
    map: ['M1.75 3.75l4-1.5 4.5 1.5 4-1.5v10l-4 1.5-4.5-1.5-4 1.5z', 'M5.75 2.25v10M10.25 3.75v10'],
    cube: ['M8 1.75l5.5 3v6.5L8 14.25l-5.5-3v-6.5z', 'M2.5 4.75L8 7.75l5.5-3M8 7.75v6.5'],
    briefcase: ['M2.25 5h11.5v8.25H2.25z', 'M5.75 5V3.25h4.5V5M2.25 8.75h11.5'],
    dollar: ['M8 1.75v12.5', 'M11.25 4.5c-.5-.9-1.7-1.5-3.25-1.5-1.8 0-3.25.85-3.25 2.25S6 7.3 8 7.75s3.25 1 3.25 2.5S9.8 12.75 8 12.75c-1.65 0-2.9-.65-3.35-1.75'],
    'heart-pulse': ['M8 13.5C3.75 10.75 1.75 8.5 1.75 6a3.25 3.25 0 0 1 6.25-1.25A3.25 3.25 0 0 1 14.25 6c0 2.5-2 4.75-6.25 7.5z', 'M3 7.75h2.25l1.25-2 2 4 1.25-2H13'],
    'graduation-cap': ['M8 3L1.5 6.25 8 9.5l6.5-3.25z', 'M4.25 7.75v3.25c1 .9 2.35 1.5 3.75 1.5s2.75-.6 3.75-1.5V7.75', 'M14.5 6.25V10'],
    headset: ['M2.75 10V8a5.25 5.25 0 0 1 10.5 0v2', 'M2.75 9.25h2v3.5h-2zM11.25 9.25h2v3.5h-2z', 'M13.25 12.75c0 .9-1.6 1.5-3.75 1.5H8.5'],
    kanban: ['M2.75 2.75h10.5v10.5H2.75z', 'M5 5.25v3.5M8 5.25v6M11 5.25v2'],
    robot: ['M3.25 5.25h9.5v7.5h-9.5z', 'M8 5.25v-2.5M7.25 2.75h1.5M1.5 8.25v2M14.5 8.25v2', 'M6 8.5h.01M10 8.5h.01M6.25 10.75h3.5'],
    terminal: ['M2.25 2.75h11.5v10.5H2.25z', 'M4.75 6l2 2-2 2M8.25 10.25h3'],
    'git-branch': ['M4.5 2.25v8.5', 'M4.5 10.75a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM11.5 3.25a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z', 'M11.5 6.25c0 2.5-2.5 3.25-7 4.5'],
    lock: ['M3.25 7.25h9.5v6.5h-9.5z', 'M5.25 7.25V5a2.75 2.75 0 0 1 5.5 0v2.25M8 9.75v1.5'],
    search: ['M7 2.25a4.75 4.75 0 1 1 0 9.5 4.75 4.75 0 0 1 0-9.5zM10.5 10.5l3.25 3.25'],
    sparkle: ['M8 1.75c.4 3.15 1.6 4.85 4.75 5.25-3.15.4-4.35 2.1-4.75 5.25-.4-3.15-1.6-4.85-4.75-5.25C6.4 6.6 7.6 4.9 8 1.75z', 'M12.75 11.5v2.75M11.4 12.9h2.75'],
    'find-agents': ['M6.5 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM2.5 11.25c.4-2.1 1.9-3.25 4-3.25 1 0 1.85.25 2.5.7', 'M11.5 8.25a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5zM13.1 12.35l1.4 1.4'],
  });
  const FALLBACK = 'sparkle';
  const SVG = 'http://www.w3.org/2000/svg';

  function paths(id) { return GLYPHS[Object.hasOwn(GLYPHS, id) ? id : FALLBACK]; }

  // DOM builder for the page; never parses markup.
  function element(doc, id, cls = 'agent-icon') {
    const svg = doc.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const d of paths(id)) {
      const p = doc.createElementNS(SVG, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }

  const api = Object.freeze({ GLYPHS, FALLBACK, paths, element });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformAgentIcons = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
