// Why a card is on the board it is on, in plain words, and the one fix that applies.
// Input is a work-capture snapshot row (src/work-capture.js snapshot(): why, pending_route,
// pointer, destination); the reasons are BOARD_WHY (src/bus-contract.js, AGENT-BUS.md §7.6).
// Pure. Main builds the chips and sends only these strings to a board page; the
// app's own renderers load it as window.BoardWhyView.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoardWhyView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // A fix is a place in the app where the person can change the rule, never an action taken for them.
  //   link: Sessions (each project's Link picker) · choose: This Mac (where each project's new work goes)
  //   exclude: Preferences (Never these repositories) · invite: Team · session: the card's own session controls
  const FIX_PAGE = Object.freeze({ link: 'sessions', choose: 'thismac', exclude: 'settings', invite: 'team' });
  const FIXES = Object.freeze({
    link: { id: 'link', label: 'Link to a team…' },
    choose: { id: 'choose', label: 'Pick a board…' },
    exclude: { id: 'exclude', label: 'Exclude folder…' },
    session: { id: 'session', label: 'Unmark…' },
  });
  const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
  const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '');

  // row → null (nothing worth saying) or { label, tone, title, fix, pointer?, pending? }
  //   tone: team | personal | warn | muted
  //   solo: the person is in no team, so "not linked" and "personal" say nothing and are not shown.
  function chip(row, { solo = false } = {}) {
    if (!row || typeof row !== 'object') return null;
    const onTeam = row.destination?.kind === 'team';
    const team = onTeam ? clip(row.destination.team_name, 40) || 'the team' : null;
    if (row.pointer) {
      return { label: 'Hand-off in another team’s repo', tone: 'muted', pointer: true, fix: null,
        title: 'A session on this board asked another AI for help, and that work runs in a repository another team owns. Its details stay with that person, so this card shows only that it is running.' };
    }
    if (row.pending_route || row.why === 'deferred') {
      return { label: 'Waiting to reach team board', tone: 'warn', pending: true, fix: null,
        title: 'The team board could not be reached, so Plexiform could not check which board this work belongs on. It waits here and moves by itself once it answers.' };
    }
    switch (row.why) {
      case 'linked_repo':
        return { label: `Linked repo → ${team ?? 'team'}`, tone: 'team', fix: null, title: `This repository is linked to ${team ?? 'a team'}’s board, so its work comes here.` };
      case 'repo_default':
        return { label: `Your default → ${team ?? 'this board'}`, tone: 'team', fix: FIXES.choose, title: 'This repository is linked to several boards, and you picked this one for its new work.' };
      case 'inherited':
        return onTeam
          ? { label: 'Asked by a teammate’s session', tone: 'team', fix: null, title: 'A session whose work goes to this board handed this task off, so it shows where the asker’s work does.' }
          : { label: 'Asked by one of your sessions', tone: 'personal', fix: null, title: 'A session whose work stays on My board handed this task off, so it stays here too.' };
      case 'withheld':
        return { label: 'Withheld: runs in another team’s repo', tone: 'warn', fix: null,
          title: 'This hand-off runs in a repository linked to another team (or one Plexiform could not read), so it stays on My board. The asker’s board shows only that it is running.' };
      case 'choose':
        return { label: 'Linked to several boards', tone: 'warn', fix: FIXES.choose, title: 'This repository is linked to more than one team board. Pick where its new work goes; until then it stays on My board.' };
      case 'read_only':
        return { label: 'Read-only on the team board', tone: 'muted', fix: null, title: 'Your role on the linked team board is read-only, so this work stays on My board.' };
      case 'personal_mark':
        return solo ? null : { label: 'Personal', tone: 'personal', fix: FIXES.session, title: 'You marked this session personal, so its work stays on My board and never goes to a team board.' };
      case 'no_link_suggested':
        return solo ? null : { label: 'Repo not linked · a team uses this org', tone: 'warn', fix: FIXES.link,
          title: 'This repository is not linked to a team board, but another repository from the same GitHub organisation is. Link it to send its work to that team.' };
      case 'no_link':
        return solo ? null : { label: 'Repo not linked', tone: 'muted', fix: FIXES.link, title: 'This repository is not linked to any team board, so its work stays on My board.' };
      case 'no_repo':
        return solo ? null : { label: 'Not a repo · stays here', tone: 'muted', fix: FIXES.exclude, title: 'This folder is not a git repository with a remote, so its work stays on My board. Exclude it to stop cards from it.' };
      default:
        return null;
    }
  }

  // Does a snapshot row belong on the board page that is showing? hub: null for My board, an origin for a team hub.
  function onBoard(row, { hub = null, team = null } = {}) {
    const d = row?.destination;
    if (!d) return false;
    if (hub === null) return d.kind === 'local';
    return d.kind === 'team' && d.hub === hub && (!team || d.team_id === team);
  }

  // The board page's answer: { cards: { card_id: chip }, pending } for its own cards only.
  function forBoard(rows, scope = {}, { solo = false } = {}) {
    const cards = {};
    let pending = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || !ID.test(r.card_id ?? '') || r.untracked || !onBoard(r, scope)) continue;
      const c = chip(r, { solo });
      if (!c) continue;
      if (c.pending) pending++;
      cards[r.card_id] = c;
    }
    return { cards, pending };
  }

  // The sidebar switcher: the live cards made here per workspace, and how many wait for a team hub.
  function workspaceCounts(rows, workspaces) {
    const out = {};
    for (const w of Array.isArray(workspaces) ? workspaces : []) out[w.id] = { cards: 0, pending: 0 };
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || r.untracked || r.pointer) continue;
      const d = r.destination;
      const w = (workspaces || []).find((x) => (d?.kind === 'team' ? x.kind === 'team' && x.hub === d.hub && x.teamId === d.team_id : x.kind === 'local'));
      if (!w) continue;
      if (r.card_id) out[w.id].cards++;
      if (r.pending_route) out[w.id].pending++;
    }
    return out;
  }

  // Solo: only the personal board, no team anywhere.
  const isSolo = (workspaces) => !(Array.isArray(workspaces) ? workspaces : []).some((w) => w && w.kind !== 'local');

  return { chip, forBoard, onBoard, workspaceCounts, isSolo, FIX_PAGE, FIXES };
});
