'use strict';

// The words for where each project's work goes (organised views PR 7), shared by the Sessions page strip and the
// This Mac "Automatic work cards" table so both say the same thing. Pure: rows come from work-capture's routing()
// and teams from session-boards' teams(); out come display strings and opaque keys, never a path or a hub id.
//
// Out: {repo, short, state, text, label (text without the arrow), goesTo, note, choices, change, link, ask}.
// rows:  [{repo, short, state:'set'|'single'|'ask'|'unlinked'|'read_only', destination:{kind:'local'}|{kind:'team',key,team,board},
//          matches:[{key, team, board, read_only}]}]
// teams: [{key, name, role:'owner'|'admin'|'member'|'viewer', boards:[{key, name}]}]

const MY_BOARD = 'My board (private)';
const MAX_ROWS = 20;
const named = (m) => `${m.team} / ${m.board}`;
const list = (items) => (items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

function rowFor(r, teams) {
  const writable = (r.matches || []).filter((m) => !m.read_only);
  const current = r.destination?.kind === 'team' ? r.destination.key : 'local';
  const goesTo = r.destination?.kind === 'team' ? named(r.destination) : MY_BOARD;
  // Every board new work could go to, the current one marked: for the Change control and the This Mac table.
  const change = writable.length ? [...writable.map((m) => ({ key: m.key, label: named(m), current: m.key === current })), { key: 'local', label: MY_BOARD, current: current === 'local' }] : [];
  // label: the same sentence for a screen reader, which would read the arrow glyph oddly or not at all.
  const out = { repo: r.repo, short: r.short, state: r.state, text: `${r.short} → ${goesTo}`, label: `${r.short} goes to ${goesTo}`, goesTo, note: null, choices: null, change, link: null, ask: null };
  if (r.state === 'ask') {
    out.text = out.label = `${r.short} is linked to ${list(r.matches.map(named))}. Where should its new work go?`;
    out.goesTo = 'Not chosen yet (My board until you pick)';
    // A board name two teams share says which team's it is.
    const shared = (m) => writable.some((o) => o !== m && o.board === m.board);
    out.choices = [...writable.map((m) => ({ key: m.key, label: shared(m) ? `${m.team} · ${m.board}` : m.board })), { key: 'local', label: 'Keep on My board' }];
  } else if (r.state === 'single') {
    out.note = 'Its only team board, so new work goes there.';
  } else if (r.state === 'set' && current === 'local' && writable.length) {
    // Kept on My board, but a team board is there now (say an admin linked it after Ask an admin): say so plainly.
    const boardsNow = writable.map((m) => `${m.team} · ${m.board}`);
    out.note = `Kept on My board. ${list(boardsNow)} ${boardsNow.length > 1 ? 'are' : 'is'} available: use Change to send new work there.`;
  } else if (r.state === 'read_only') {
    const ro = (r.matches || []).find((m) => m.read_only);
    out.note = ro ? `Your role on ${named(ro)} is read-only, so its work stays on My board.` : null;
  }
  // No team board yet: an admin can link it, a member can ask an admin. The first time it is a question with
  // "Keep on My board" to settle it; once kept, Link or Ask stays on offer without asking again.
  const unlinked = r.state === 'unlinked', kept = r.state === 'set' && !(r.matches || []).length;
  if (unlinked || kept) {
    const admin = teams.filter((t) => t.role === 'owner' || t.role === 'admin');
    const member = teams.filter((t) => t.role === 'member');
    if (admin.length) out.link = admin.flatMap((t) => (t.boards || []).map((b) => ({ key: b.key, label: `${t.name} / ${b.name}` })));
    else if (member.length) out.ask = member.map((t) => ({ key: t.key, label: t.name }));
    else if (!teams.length) return null;
    if (unlinked && (out.link || out.ask)) {
      out.note = out.link ? 'Put it on a team board?' : 'Put it on a team board? Only a team admin can link it, so Plexiform can ask them for you.';
      out.choices = [{ key: 'local', label: 'Keep on My board' }];
    }
  }
  return out;
}

function rowsFor(rows, { teams = [] } = {}) {
  const t = Array.isArray(teams) ? teams : [];
  return (Array.isArray(rows) ? rows : []).map((r) => rowFor(r, t)).filter(Boolean).slice(0, MAX_ROWS);
}

module.exports = { rowsFor, MY_BOARD, MAX_ROWS };
