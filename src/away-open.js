// The "While you were away" click: jump to the item's session the way any
// other session click does. Folder-title window raising is not used: it picks
// a window by guessing, and the user's current one may be the one it raises.
async function openAway({ item, sessions, jump, isRemote }) {
  if (!item) return { opened: 'none' };
  const folder = item.folder;
  const target = (sessions || []).find((s) => s.sessionId === item.sessionId);
  if (!target) return { opened: 'none-found', folder, note: 'That session has ended.' };
  if (isRemote(target)) return { opened: 'none-found', folder, note: 'That session is on another machine.' };
  const r = await jump(target, folder, item.hostApp || undefined);
  return {
    opened: (r && r.app) || 'none-found',
    folder,
    ...(r && r.cant ? { note: r.cant, command: r.command || null } : {}),
  };
}

module.exports = { openAway };
