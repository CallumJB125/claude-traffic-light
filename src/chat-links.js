'use strict';
// Chat-first deep links (redesign R2a, plan-r2.md §5; labfix-review S4a).
// Navigation only:
//   plexiform://open/<pageId>   a page in PAGES, shown through route()
//   plexiform://thread/<rowId>  a row's thread, if main resolves the row
// Never an account flow: sign-in, join and create-team (FLOW_IDS) are not
// pages and are refused here, so a web page can't start one with a link.
// The link form is provisional, awaiting Callum (§7 item 3), and is read only
// with the chat-first preview on; invites are handled first, unchanged.
const Pages = require('../buddy-window/pages.js');
const BRAND = require('../brand.js');

const SCHEMES = [BRAND.scheme, ...BRAND.legacySchemes].map((s) => s.toLowerCase());
const LINK = /^([a-z][a-z0-9+.-]*):\/\/(open|thread)\/([A-Za-z0-9:_-]{1,80})\/?$/i;
const ROW_ID = /^[0-9a-f]{64}$/;
const COALESCE_MS = 1000;

function parse(url) {
  if (typeof url !== 'string' || url.length > 2048) return null;
  const m = LINK.exec(url.trim());
  if (!m || !SCHEMES.includes(m[1].toLowerCase())) return null;
  const action = m[2].toLowerCase(), id = m[3];
  if (action === 'thread') return ROW_ID.test(id) ? { kind: 'thread', id } : null;
  if (Pages.FLOW_IDS.includes(id) || !Pages.pageById(id)) return null;
  return { kind: 'page', id };
}

// The same target again within a second is the same request (a double click, a
// page firing a link twice): one navigation.
function coalescer(now = Date.now) {
  const seen = new Map(); // target → when it last navigated
  return (target) => {
    const key = `${target.kind}:${target.id}`, t = now();
    for (const [k, at] of seen) if (t - at >= COALESCE_MS) seen.delete(k);
    if (seen.has(key)) return false;
    if (seen.size >= 32) seen.delete(seen.keys().next().value);
    seen.set(key, t);
    return true;
  };
}

module.exports = { parse, coalescer, COALESCE_MS };
