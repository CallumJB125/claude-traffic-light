// Appearance options: the colour scheme and the board background. Both are
// per-browser (localStorage) and applied as attributes on <html>; the colours
// themselves live in app.css so a background can never ship a pixel request.
export const THEMES = [
  { id: 'system', label: 'Match system', icon: 'auto' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
  { id: 'light', label: 'Light', icon: 'sun' },
];

export const BACKGROUNDS = [
  { id: 'none', label: 'Plain' },
  { id: 'dusk', label: 'Dusk' },
  { id: 'ember', label: 'Ember' },
  { id: 'tide', label: 'Tide' },
  { id: 'moss', label: 'Moss' },
  { id: 'grid', label: 'Grid' },
  { id: 'dots', label: 'Dots' },
];

export const normalizeBg = (v) => (BACKGROUNDS.some((b) => b.id === v) ? v : 'none');
export const normalizeTheme = (v) => (THEMES.some((t) => t.id === v) ? v : 'system');
