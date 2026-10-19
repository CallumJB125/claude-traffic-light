// Actionable phone notifications for waiting permission requests.
//
// SECURITY: a notification action NEVER approves or denies anything. The only
// action is "Review", which opens the approvals screen focused on that request;
// Allow there still needs the passkey (user verification) and the paired
// end-to-end channel (phone-approvals.js decide()). Lock-screen approve without
// the passkey is deliberately not built. Every waiting item the phone sees is a
// permission request (approvals.list), so no item gets answer buttons.
//
// The hub's push stays empty (phone-sw.js). These richer notifications are
// built here, on the phone, from requests the app already fetched end to end
// and verified against the computer's signing key. They show only what the
// in-app list's row title shows (tool name and computer name), never the
// command, file path or folder.

const MAX_TITLE = 60;
const MAX_BODY = 120;
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

export const REVIEW_ACTION = 'review';

const clip = (s, n) => {
  const t = String(s ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The notification for one verified waiting request: {title, options}. */
export function buildRequestNotification(item) {
  const n = item.notice;
  const tool = clip(n.toolName, 40) || 'A tool';
  const host = clip(item.hostName, 40) || 'your computer';
  return {
    title: clip('Plexiform: approval needed', MAX_TITLE),
    options: {
      body: clip(`${tool} on ${host}${n.deskOnly ? ' (desk only)' : ''}. Open to review.`, MAX_BODY),
      tag: `plexiform-req-${item.host}-${n.requestId}`,
      renotify: false,
      icon: '/web/phone-icon-192.png', badge: '/web/phone-icon-192.png',
      actions: [{ action: REVIEW_ACTION, title: 'Review' }],
      data: { kind: 'permission', host: item.host, requestId: n.requestId },
    },
  };
}

/**
 * Show a notification for each waiting request not shown before. reg: a
 * ServiceWorkerRegistration (or a fake); seen: a Set of keys, kept by the caller.
 * Returns how many were shown.
 */
export async function notifyNewRequests(reg, items, seen) {
  let shown = 0;
  for (const item of items ?? []) {
    const key = `${item.host}|${item.notice.requestId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { title, options } = buildRequestNotification(item);
    await reg.showNotification(title, options);
    shown++;
  }
  if (shown) for (const g of await reg.getNotifications?.({ tag: 'plexiform-needs-you' }) ?? []) g.close();
  return shown;
}

/** `#approvals=<host>|<requestId>` → {host, requestId}, or null. */
export function parseFocus(hash) {
  const m = /^#approvals=(.+)$/.exec(String(hash ?? ''));
  if (!m) return null;
  let v;
  try { v = decodeURIComponent(m[1]); } catch { return null; }
  const [host, requestId, extra] = v.split('|');
  if (extra !== undefined || !/^[A-Za-z0-9_-]{1,100}$/.test(host ?? '') || !/^[A-Za-z0-9_.:-]{1,200}$/.test(requestId ?? '')) return null;
  return { host, requestId };
}
