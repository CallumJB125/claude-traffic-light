// "Send feedback" from the desktop app: the app opens this page with the report
// in the URL fragment (never sent to the hub). Nothing is posted until the
// person has seen the exact text and clicked Send. Pure, so it is unit tested.
export const FRAGMENT_PREFIX = '#plexiform-feedback=';
export const FEEDBACK_BOARD = 'Plexiform feedback';
export const MAX_FRAGMENT = 32 * 1024;
export const MAX_TITLE = 200;
export const MAX_BODY = 20_000;

// A page that opened this one could swap the fragment just before a second
// click (double-clickjacking), so Send waits, and only works in a focused, visible page.
export const ARM_MS = 800;
export const canSend = ({ armedAt, now, focused, visible }) => now >= armedAt && !!focused && visible === 'visible';

export const SENT_TEXT = 'Sent. Thanks!';
export const NO_BOARD_TEXT = 'This team has no “Plexiform feedback” board yet. Ask an admin to create one.';
export const FAILED_TEXT = 'Couldn’t send. It’s saved on the reporter’s computer.';
export const VIEWER_TEXT = 'Viewers can’t add cards. Your report is saved on the reporter’s computer.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// null for anything that is not exactly a v1 report; never throws.
export function decodeFeedback(hash) {
  if (typeof hash !== 'string' || !hash.startsWith(FRAGMENT_PREFIX)) return null;
  const b64 = hash.slice(FRAGMENT_PREFIX.length);
  if (!b64 || hash.length > MAX_FRAGMENT || !/^[A-Za-z0-9_-]+$/.test(b64)) return null;
  let v;
  try {
    const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.v !== 1) return null;
  if (v.kind !== 'bug' && v.kind !== 'idea') return null;
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > MAX_TITLE) return null;
  if (typeof v.body !== 'string' || v.body.length > MAX_BODY) return null;
  if (typeof v.requestId !== 'string' || !UUID.test(v.requestId)) return null;
  return { kind: v.kind, title: v.title, body: v.body, requestId: v.requestId };
}

export const findFeedbackBoard = (boards) => (boards ?? []).find((b) => b?.name === FEEDBACK_BOARD) ?? null;

// Always resolves to { ok:true, cardId, boardId } | { ok:false, text }. The
// hub's own error text is never shown.
export async function sendFeedback({ api, boards, payload }) {
  const board = findFeedbackBoard(boards);
  if (!board) return { ok: false, text: NO_BOARD_TEXT };
  try {
    const res = await api.createCard(board.id, { request_id: payload.requestId, title: payload.title, body: payload.body, labels: ['feedback', payload.kind] });
    const cardId = res?.card?.id;
    return cardId ? { ok: true, cardId, boardId: board.id } : { ok: false, text: FAILED_TEXT };
  } catch { return { ok: false, text: FAILED_TEXT }; }
}
