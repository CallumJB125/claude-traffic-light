// Only explicit admin-entered routing/preferences reach the existing PATCH.
export const SENTRY_LEVELS = Object.freeze(['fatal', 'error', 'warning', 'info', 'debug']);
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function sentrySettings(form, boards) {
  const fd = new form.ownerDocument.defaultView.FormData(form);
  const active = new Set(boards.filter(b => !b.archived_at).map(b => b.id));
  const board = String(fd.get('default_board') ?? '');
  if (!active.has(board)) throw new Error('Choose an active default board.');
  const slugs = fd.getAll('project_slug'), targets = fd.getAll('project_board');
  if (slugs.length !== targets.length || slugs.length > 33) throw new Error('Use at most 32 project routes.');
  const project_boards = Object.create(null);
  for (let i = 0; i < slugs.length; i++) {
    const slug = String(slugs[i]).trim(), target = String(targets[i]);
    if (!slug && !target) continue;
    if (!SLUG.test(slug) || ['__proto__', 'constructor', 'prototype'].includes(slug)) throw new Error('Use the exact Sentry project slug (up to 64 lower-case letters, digits, _ or -).');
    if (Object.hasOwn(project_boards, slug)) throw new Error('Each project can have one route.');
    if (!active.has(target)) throw new Error('Choose an active board for each project route.');
    project_boards[slug] = target;
  }
  if (Object.keys(project_boards).length > 32) throw new Error('Use at most 32 project routes.');
  const min_level = String(fd.get('min_level') ?? '');
  const raw = String(fd.get('cooldown_minutes') ?? '');
  if (!SENTRY_LEVELS.includes(min_level) || !/^[0-9]{1,4}$/.test(raw) || Number(raw) < 1 || Number(raw) > 1440) throw new Error('Choose a severity and an incident cooldown between 1 and 1440 minutes.');
  return { target_board_id: board, config: { default_board_id: board, project_boards, min_level, include_message: fd.get('include_message') === 'on', cooldown_minutes: Number(raw) } };
}

const scopeKey = s => JSON.stringify([s.org, s.member, s.user, s.role, s.generation, s.auth]);
export async function saveSentrySettings({ form, connection, boards, getScope, patch, saved }) {
  const scope = getScope();
  if (scope.auth !== 'ok' || !scope.org || !scope.member || !['owner', 'admin'].includes(scope.role) || connection.provider !== 'sentry' || connection.status !== 'active') return false;
  let body;
  try { body = sentrySettings(form, boards); }
  catch (error) { throw Object.assign(error, { code: 'VALIDATION' }); }
  const key = scopeKey(scope);
  let result;
  try { result = await patch(connection.id, body); }
  catch (error) { if (scopeKey(getScope()) !== key) return false; throw error; }
  if (scopeKey(getScope()) !== key) return false;
  if (result?.connection?.id !== connection.id || result.connection.provider !== 'sentry') throw new Error('The integration response did not match this connection.');
  saved(result.connection);
  return true;
}
