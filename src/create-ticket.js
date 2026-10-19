'use strict';

// Create ticket from a session (Wave 2 lane 6). Main-only: finds the team
// connections that create issues (Linear, Jira) on the signed-in hubs, drafts
// a title and description from the session's local handover, scrubbed
// (src/scrub.js: paths, names, hosts and anything shaped like a secret), and
// sends only the text the person approved, on their explicit Create, through
// the hub (which holds the tool's credentials). The page holds opaque refs.

const crypto = require('node:crypto');
const { scrub } = require('./scrub.js');

const TITLE_MAX = 200;
const BODY_MAX = 8000;
const TARGETS_TTL_MS = 5 * 60_000;
const MAX_HUBS = 8;
const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const NAMES = { linear: 'Linear', jira: 'Jira' };
const MARKER_RE = /^<!--[^\n]*-->\n?/gm;

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// The handover document → { title, description }, both scrubbed. Pure.
function draftFrom(doc, { home = null, user = null } = {}) {
  const text = String(doc || '').replace(MARKER_RE, '').trim();
  if (!text) return null;
  const clean = (s) => scrub(s, { home, user });
  const field = (prefix) => { const l = text.split('\n').find((x) => x.startsWith(prefix)); return l ? oneLine(l.slice(prefix.length)) : ''; };
  const raw = [field('- Latest prompt: '), field('- First prompt: ')].find((v) => v && v !== '(not seen)') || 'Follow-up from an AI session';
  const title = oneLine(clean(raw)).slice(0, TITLE_MAX) || 'Follow-up from an AI session';
  const description = `${clean(text).slice(0, BODY_MAX - 120)}\n\n(Drafted by Plexiform from a local session handover; reviewed before sending.)`.slice(0, BODY_MAX);
  return { title, description };
}

// hubs(): signed-in hub origins; clientFor(origin): the account client.
function create({ hubs, clientFor, handoverText = () => null, home = null, user = null, now = () => Date.now(), log = () => {} }) {
  const refs = new Map(); // ref -> { hub, team, id, provider }
  let cache = { at: 0, list: [] };
  let loading = null;

  async function load() {
    const out = [];
    refs.clear();
    for (const hub of (hubs() || []).slice(0, MAX_HUBS)) {
      const c = clientFor(hub);
      let me; try { me = await c.me(); } catch { continue; }
      for (const t of (me?.ok && Array.isArray(me.teams) ? me.teams : []).slice(0, 32)) {
        if (!ID.test(t?.id ?? '') || t.role === 'viewer') continue;
        let r; try { r = await c.integrations(t.id); } catch { continue; }
        for (const conn of (r?.ok && Array.isArray(r.connections) ? r.connections : [])) {
          if (conn?.creates_issues !== true || !NAMES[conn.provider] || !ID.test(conn.id ?? '') || conn.status !== 'active') continue;
          const ref = crypto.randomUUID();
          refs.set(ref, { hub, team: t.id, id: conn.id, provider: conn.provider });
          out.push({ ref, provider: conn.provider, label: `Create ${NAMES[conn.provider]} issue (${String(t.name ?? 'team').slice(0, 60)})` });
        }
      }
    }
    cache = { at: now(), list: out };
    return out;
  }

  async function targets({ fresh = false } = {}) {
    if (!fresh && cache.at && now() - cache.at < TARGETS_TTL_MS) return cache.list;
    if (!loading) loading = load().catch((e) => { log('[create-ticket] targets failed', e?.code); return []; }).finally(() => { loading = null; });
    return loading;
  }
  // Synchronous, for the Sessions row: the tools a team connection creates issues in (refreshes in the background).
  function available() {
    if (!cache.at || now() - cache.at >= TARGETS_TTL_MS) void targets();
    return [...new Set(cache.list.map((t) => NAMES[t.provider]))];
  }

  async function draft(row) {
    const doc = handoverText(row);
    const d = draftFrom(doc, { home, user });
    if (!d) return { ok: false, text: 'This session has no handover yet. Use Write now on its handover, then try again.' };
    const list = await targets({ fresh: true });
    if (!list.length) return { ok: false, text: 'No Linear or Jira connection on your teams can create issues. A team admin sets that up.' };
    return { ok: true, ...d, targets: list };
  }

  // Sends exactly what the person approved; nothing is kept here.
  async function send(ref, title, description) {
    const t = refs.get(ref);
    if (!t) return { ok: false, text: 'Choose where to create the issue again.' };
    const tt = oneLine(title).slice(0, TITLE_MAX);
    if (!tt) return { ok: false, text: 'Give the issue a title.' };
    const body = String(description ?? '').slice(0, BODY_MAX);
    const r = await clientFor(t.hub).createIssue(t.team, t.id, { title: tt, description: body }); // privacy-flow: create-ticket
    if (!r?.ok) return { ok: false, text: r?.status === 429 ? 'Too many issues this hour. Try again later.' : `${NAMES[t.provider]} did not create the issue. Try again, or ask a team admin to check the connection.` };
    const issue = r.issue || {};
    const url = typeof issue.url === 'string' && /^https:\/\//.test(issue.url) ? issue.url : null;
    return { ok: true, key: typeof issue.key === 'string' ? issue.key.slice(0, 40) : null, url, text: `Created ${issue.key || 'the issue'} in ${NAMES[t.provider]}.` };
  }

  return { targets, available, draft, send };
}

module.exports = { create, draftFrom, TITLE_MAX, BODY_MAX };
