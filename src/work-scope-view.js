// What the widget, the Waiting page and the tray show for a session's work
// scope (accounts contract §C2). `scope` comes from main (src/work-scope.js,
// the core's module); null or missing means no hub or enrolment, and then
// nothing at all is shown. Pure; the renderers load it as window.WorkScopeView.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkScopeView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const STATES = new Set(['outside', 'watching', 'counting', 'personal']);
  const TRAY_LABEL = 'This session is personal — don’t track';

  // → null (show nothing) or { state, label, tone, markPersonal, undo, repoUrl }
  function scopeView(scope) {
    if (!scope || typeof scope !== 'object' || !STATES.has(scope.state) || scope.state === 'outside') return null;
    const url = scope.repo && typeof scope.repo.canonicalUrl === 'string' && scope.repo.canonicalUrl.length <= 300 ? scope.repo.canonicalUrl : null;
    if (scope.state === 'personal') return { state: 'personal', label: 'personal', tone: 'personal', markPersonal: false, undo: true, repoUrl: null };
    // Only a write makes a session count: until then it is watched locally, never "counting".
    if (scope.state === 'watching') return { state: 'watching', label: 'watching locally', tone: 'muted', markPersonal: true, undo: false, repoUrl: url };
    const board = scope.board && typeof scope.board.name === 'string' && scope.board.name.trim() ? scope.board.name.trim().slice(0, 60) : 'your team';
    return { state: 'counting', label: `counting for ${board}`, tone: 'count', markPersonal: true, undo: false, repoUrl: url };
  }

  const folder = (cwd) => String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'session';

  // The tray's toggle for the most recently active session that has a scope.
  // → null (hidden), or { label, enabled, checked, sessionId }
  function trayItem(sessions, { available = true } = {}) {
    if (!available) return null;
    const list = (Array.isArray(sessions) ? sessions : []).filter((s) => s && !s.remote && typeof s.sessionId === 'string');
    if (!list.length) return { label: TRAY_LABEL, enabled: false, checked: false, sessionId: null };
    const scoped = list.filter((s) => s.scope && STATES.has(s.scope.state));
    if (!scoped.length) return null;
    const t = (s) => Date.parse(s.updatedAt) || 0;
    const s = scoped.slice().sort((a, b) => t(b) - t(a))[0];
    return { label: `${TRAY_LABEL} (${folder(s.cwd).slice(0, 40)})`, enabled: true, checked: s.scope.state === 'personal', sessionId: s.sessionId };
  }

  // sessionId → scope, for the rows of the bubble and the Waiting page.
  function scopesBySession(sessions) {
    const out = {};
    for (const s of Array.isArray(sessions) ? sessions : []) if (s && typeof s.sessionId === 'string' && s.scope) out[s.sessionId] = s.scope;
    return out;
  }

  return { TRAY_LABEL, scopeView, trayItem, scopesBySession };
});
