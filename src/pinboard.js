'use strict';
// "Pin to project" from one of your own sessions: posts one pin to the team board
// the session's folder is linked to, with the signed-in identity for that hub
// (the same route the work capture and agent mail use). Only label/value text
// the person typed leaves this computer; the session's path never does.
const KINDS = new Set(['link', 'command', 'note', 'priority']);
const MOMENTS = new Set(['moment', 'ship', 'decision', 'demo']);
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
  // "Mark a moment" from a session: a ship, decision or demo for the team's timeline
  // (board.settings.moments). Only the kind, label and note typed leave this computer.
  async function moment({ cwd, kind, label, note }) {
    if (!MOMENTS.has(kind)) return { ok: false, error: 'Choose moment, ship, decision or demo.' };
    const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
    const l = text(label, 120), n = text(note, 500);
    if (!l) return { ok: false, error: 'Say what the moment was.' };
    let link = null;
    try { link = await resolve({ cwd }); } catch { link = null; }
    if (!link?.route?.board_id || !link.route.hub) return { ok: false, error: 'This folder is not linked to a team board in Plexiform.' };
    const tok = typeof link.token === 'function' ? link.token() : null;
    if (!tok) return { ok: false, error: 'Sign in to your team in Plexiform first.' };
    try {
      const res = await fetch(`${link.route.hub}/api/boards/${encodeURIComponent(link.route.board_id)}/moments`, { method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ request_id: require('node:crypto').randomUUID(), moment: { kind, label: l, note: n } }), redirect: 'error' }); // privacy-flow: pinboard
      let json = null; try { json = await res.json(); } catch { json = null; }
      if (res.status !== 200 || !Array.isArray(json?.moments)) return { ok: false, error: json?.error?.message || 'The team hub refused that moment.' };
      return { ok: true, count: json.moments.length, board: link.route.board_id, moment_id: typeof json.moments[0]?.id === 'string' ? json.moments[0].id : null };
    } catch (e) { log('[pinboard] moment failed', e && e.code); return { ok: false, error: 'The team hub could not be reached. Try again.' }; }
  }
  // "Share view" from Team sessions: a saved filter set for everyone on that team's board
  // (board.settings.views). Only the view's name and filter values travel.
  async function view({ link, name, values }) {
    const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
    const n = text(name, 60);
    const vals = values && typeof values === 'object' && !Array.isArray(values) ? Object.fromEntries(Object.entries(values).filter(([k, v]) => /^[a-z][a-z0-9_-]{0,23}$/i.test(k) && text(v, 80)).slice(0, 8).map(([k, v]) => [k, text(v, 80)])) : {};
    if (!n) return { ok: false, error: 'Name the view.' };
    if (!Object.keys(vals).length) return { ok: false, error: 'Set at least one filter first.' };
    if (!link?.route?.board_id || !link.route.hub) return { ok: false, error: 'This team has no board linked in Plexiform.' };
    const tok = typeof link.token === 'function' ? link.token() : null;
    if (!tok) return { ok: false, error: 'Sign in to your team in Plexiform first.' };
    try {
      const res = await fetch(`${link.route.hub}/api/boards/${encodeURIComponent(link.route.board_id)}/views`, { method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ request_id: require('node:crypto').randomUUID(), view: { name: n, values: vals } }), redirect: 'error' }); // privacy-flow: pinboard
      let json = null; try { json = await res.json(); } catch { json = null; }
      if (res.status !== 200 || !Array.isArray(json?.views)) return { ok: false, error: json?.error?.message || 'The team hub refused that view.' };
      return { ok: true, count: json.views.length, board: link.route.board_id };
    } catch (e) { log('[pinboard] view failed', e && e.code); return { ok: false, error: 'The team hub could not be reached. Try again.' }; }
  }
  // "Comment" on a card or a moment of the linked board (team depth lane A): the
  // typed text only, to the hub's comment route for that target; the hub parses
  // @mentions itself. The session's path never leaves this computer.
  async function comment({ cwd, target, body }) {
    const id = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
    const cardId = id(target?.card_id), momentId = id(target?.moment_id);
    if (!cardId && !momentId) return { ok: false, error: 'Choose a card or a moment to comment on.' };
    const text = typeof body === 'string' ? body.replace(/\r\n?/g, '\n').trim().slice(0, 10_000) : '';
    if (!text) return { ok: false, error: 'Write the comment first.' };
    let link = null;
    try { link = await resolve({ cwd }); } catch { link = null; }
    if (!link?.route?.board_id || !link.route.hub) return { ok: false, error: 'This folder is not linked to a team board in Plexiform.' };
    const tok = typeof link.token === 'function' ? link.token() : null;
    if (!tok) return { ok: false, error: 'Sign in to your team in Plexiform first.' };
    const path = cardId ? `/api/cards/${encodeURIComponent(cardId)}/comments` : `/api/boards/${encodeURIComponent(link.route.board_id)}/moments/${encodeURIComponent(momentId)}/comments`;
    try {
      const res = await fetch(`${link.route.hub}${path}`, { method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ request_id: require('node:crypto').randomUUID(), body: text }), redirect: 'error' }); // privacy-flow: pinboard
      let json = null; try { json = await res.json(); } catch { json = null; }
      if (res.status !== 200 || typeof json?.comment?.id !== 'string') return { ok: false, error: res.status === 404 ? 'That moment or card is no longer on the board (or the hub does not take comments there yet).' : json?.error?.message || 'The team hub refused that comment.' };
      return { ok: true, comment_id: json.comment.id, mentions: Array.isArray(json.comment.mentions) ? json.comment.mentions.length : 0, board: link.route.board_id };
    } catch (e) { log('[pinboard] comment failed', e && e.code); return { ok: false, error: 'The team hub could not be reached. Try again.' }; }
  }
  return { add, moment, view, comment };
}
function register({ ipcMain, allowed, pinboard, cwdFor }) {
  ipcMain.handle('pins:add', async (e, key, kind, label, value) => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed.' };
    const cwd = typeof key === 'string' && key.length <= 260 ? await cwdFor(key) : null;
    if (!cwd) return { ok: false, error: 'No folder is known for this session.' };
    try { return await pinboard.add({ cwd, kind, label, value }); } catch { return { ok: false, error: 'Something went wrong. Nothing was pinned.' }; }
  });
  ipcMain.handle('moments:mark', async (e, key, kind, label, note) => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed.' };
    const cwd = typeof key === 'string' && key.length <= 260 ? await cwdFor(key) : null;
    if (!cwd) return { ok: false, error: 'No folder is known for this session.' };
    try { return await pinboard.moment({ cwd, kind, label, note }); } catch { return { ok: false, error: 'Something went wrong. Nothing was marked.' }; }
  });
  ipcMain.handle('comments:add', async (e, key, target, body) => {
    if (!allowed(e)) return { ok: false, error: 'Not allowed.' };
    const cwd = typeof key === 'string' && key.length <= 260 ? await cwdFor(key) : null;
    if (!cwd) return { ok: false, error: 'No folder is known for this session.' };
    const t = target && typeof target === 'object' ? { card_id: target.card_id, moment_id: target.moment_id } : {};
    try { return await pinboard.comment({ cwd, target: t, body }); } catch { return { ok: false, error: 'Something went wrong. Nothing was posted.' }; }
  });
}
module.exports = { createPinboard, register, KINDS, MOMENTS };
