// @mentions in a comment (team depth lane A, CONTRACT §5.3): which org
// members a body names, and where. A mention is `@` followed by a member's
// display name or the local part of their email (or their login), compared
// without case; the longest name wins where one is a prefix of another
// ("@Ana Lima" before "@Ana"). Text is untrusted: nothing here is executed,
// looked up or rewritten, only matched. At most MAX_MENTIONS per body, each
// member once (its first occurrence).
//
// Browser-safe, dependency-free: the hub parses on write, the web parses the
// composer for the `@` picker, both with the same member list shape
// ({id|member_id, display_name|name, email?, github_login|login?}).

export const MAX_MENTIONS = 10;

const WORD = /[\p{L}\p{N}_]/u;

function handlesOf(m) {
  const out = new Set();
  const add = (v) => { if (typeof v === 'string' && v.trim()) out.add(v.trim().toLowerCase()); };
  add(m.display_name ?? m.name);
  add(m.github_login ?? m.login);
  const email = typeof m.email === 'string' ? m.email : null;
  if (email && email.includes('@')) add(email.slice(0, email.indexOf('@')));
  return [...out];
}

// Candidates sorted longest first so "@ana lima" is not read as "@ana" + " lima".
export function mentionCandidates(members) {
  const list = [];
  for (const m of members || []) {
    const id = m?.id ?? m?.member_id;
    if (!id) continue;
    for (const handle of handlesOf(m)) list.push({ member_id: id, handle, name: m.display_name ?? m.name ?? handle });
  }
  return list.sort((a, b) => b.handle.length - a.handle.length || a.handle.localeCompare(b.handle));
}

// → [{member_id, start, end}] with `start` the index of the `@` and `end`
// exclusive, in order of appearance; one entry per member, at most MAX_MENTIONS.
export function parseMentions(body, members, { max = MAX_MENTIONS } = {}) {
  if (typeof body !== 'string' || !body.includes('@')) return [];
  const candidates = mentionCandidates(members);
  if (!candidates.length) return [];
  const lower = body.toLowerCase();
  const seen = new Set();
  const out = [];
  for (let i = lower.indexOf('@'); i !== -1 && out.length < max; i = lower.indexOf('@', i + 1)) {
    if (i > 0 && WORD.test(body[i - 1])) continue;          // an email address is not a mention
    for (const c of candidates) {
      const end = i + 1 + c.handle.length;
      if (end > lower.length || lower.slice(i + 1, end) !== c.handle) continue;
      if (end < lower.length && WORD.test(body[end])) continue; // "@ann" inside "@anna"
      if (!seen.has(c.member_id)) { seen.add(c.member_id); out.push({ member_id: c.member_id, start: i, end }); }
      i = end - 1;
      break;
    }
  }
  return out;
}

// The `@` the caret is in, if any: {start, query} where start is the `@`'s
// index and query the text typed after it (no whitespace yet). Powers the
// picker in the web composer; null when the caret is not in a mention.
export function mentionQuery(text, caret) {
  if (typeof text !== 'string') return null;
  const at = Math.min(Math.max(0, caret | 0), text.length);
  const start = text.lastIndexOf('@', at - 1);
  if (start === -1) return null;
  if (start > 0 && WORD.test(text[start - 1])) return null;
  const query = text.slice(start + 1, at);
  if (/\s/.test(query) || query.length > 40) return null;
  return { start, query };
}

// Members whose name, login or email local part starts with `query`
// (case-insensitive), at most `limit`, each member once.
export function mentionMatches(query, members, { limit = 5 } = {}) {
  const q = String(query ?? '').toLowerCase();
  const out = [];
  const seen = new Set();
  for (const c of mentionCandidates(members).sort((a, b) => a.handle.localeCompare(b.handle))) {
    if (seen.has(c.member_id) || !c.handle.startsWith(q)) continue;
    seen.add(c.member_id);
    out.push({ member_id: c.member_id, name: c.name, handle: c.handle });
    if (out.length >= limit) break;
  }
  return out;
}

// Replace the mention being typed with the chosen member's name; returns the
// new text and where the caret goes (after the inserted name and a space).
export function applyMention(text, start, caret, member) {
  const name = member.display_name ?? member.name ?? member.handle ?? '';
  const head = text.slice(0, start);
  const tail = text.slice(caret);
  const inserted = `@${name} `;
  return { text: head + inserted + tail, caret: head.length + inserted.length };
}

// Split a body into text and mention segments for rendering chips. `mentions`
// is the stored member-id list (the hub's shape), so the spans are re-derived
// from the member list the browser already holds: an id that no longer
// matches (renamed, removed) renders as plain text.
export function segmentMentions(body, mentionIds, members) {
  const text = typeof body === 'string' ? body : '';
  const ids = new Set(Array.isArray(mentionIds) ? mentionIds : []);
  if (!ids.size) return [{ text }];
  const spans = parseMentions(text, members, { max: ids.size }).filter((s) => ids.has(s.member_id));
  const out = [];
  let pos = 0;
  for (const s of spans) {
    if (s.start > pos) out.push({ text: text.slice(pos, s.start) });
    out.push({ mention: s.member_id, text: text.slice(s.start, s.end) });
    pos = s.end;
  }
  if (pos < text.length || !out.length) out.push({ text: text.slice(pos) });
  return out;
}
