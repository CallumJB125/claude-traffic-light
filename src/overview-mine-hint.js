'use strict';
// QoL4a: a notification's "Show in Overview" lands on its session. Main holds one pending hint, the session's
// folder name, for 10 s; the Overview document takes it once (overview:mine-hint) and puts it in My sessions' search.
// Only the basename of a local row's folder is ever stored: never ids, a title or a notification's text (review A4-S1).

const HINT_MS = 10000;
const MAX = 100;
// Control characters and the direction overrides/isolates, which could make a folder name read as something else.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/** The search text for a folder path: its last segment, cleaned, at most 100 characters; '' when there is none. */
function queryOf(cwd) {
  if (typeof cwd !== 'string') return '';
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  return base.replace(UNSAFE, '').trim().slice(0, MAX).trim();
}

function createMineHint({ now = Date.now } = {}) {
  let hint = null;
  return {
    /** Arms the hint from a local row's folder; answers whether anything was armed. */
    set(cwd) {
      const query = queryOf(cwd);
      hint = query ? { query, at: now() } : null;
      return !!hint;
    },
    /** Once: the query while it is fresh, else null. */
    take() {
      const h = hint;
      hint = null;
      return h && now() - h.at <= HINT_MS ? { query: h.query } : null;
    },
    clear() { hint = null; },
  };
}

module.exports = { HINT_MS, MAX, queryOf, createMineHint };
