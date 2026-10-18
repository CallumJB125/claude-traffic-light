'use strict';
// "Pin to project" from one of your own sessions: posts one pin to the team board
// the session's folder is linked to, with the signed-in identity for that hub
// (the same route the work capture and agent mail use). Only label/value text
// the person typed leaves this computer; the session's path never does.
const KINDS = new Set(['link', 'command', 'note', 'priority']);
function createPinboard({ resolve, fetch, log = () => {} }) {
  async function add({ cwd, kind, label, value }) {
    if (!KINDS.has(kind)) return { ok: false, error: 'Choose link, command, convention or priority.' };
    const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
    const l = text(label, 80), v = text(value, 500);
    if (!l) return { ok: false, error: 'Give the pin a label.' };
    if (kind === 'link' && !/^https:\/\/\S+$/i.test(v)) return { ok: false, error: 'A link pin needs an https:// address.' };
    if (kind !== 'priority' && !v) return { ok: false, error: 'Add the link, command or note to pin.' };
    let link = null;
    try { link = await resolve({ cwd }); } catch { link = null; }
    if (!link?.route?.board_id || !link.route.hub) return { ok: false, error: 'This folder is not linked to a team board in Plexiform.' };
    const tok = typeof link.token === 'function' ? link.token() : null;
    if (!tok) return { ok: false, error: 'Sign in to your team in Plexiform first.' };
    try {
      const res = await fetch(`${link.route.hub}/api/boards/${encodeURIComponent(link.route.board_id)}/pins`, { method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ request_id: require('node:crypto').randomUUID(), pin: { kind, label: l, value: v } }), redirect: 'error' }); // privacy-flow: pinboard
      let json = null; try { json = await res.json(); } catch { json = null; }
      if (res.status !== 200 || !Array.isArray(json?.pins)) return { ok: false, error: json?.error?.message || 'The team hub refused that pin.' };
      return { ok: true, count: json.pins.length, board: link.route.board_id };
    } catch (e) { log('[pinboard] add failed', e && e.code); return { ok: false, error: 'The team hub could not be reached. Try again.' }; }
  }
  return { add };
}
function register({ ipcMain, allowed, pinboard, cwdFor }) {
  ipcMain.handle('pins:add', async (e, key, kind, label, value) => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed.' };
    const cwd = typeof key === 'string' && key.length <= 260 ? await cwdFor(key) : null;
    if (!cwd) return { ok: false, error: 'No folder is known for this session.' };
    try { return await pinboard.add({ cwd, kind, label, value }); } catch { return { ok: false, error: 'Something went wrong. Nothing was pinned.' }; }
  });
}
module.exports = { createPinboard, register, KINDS };
