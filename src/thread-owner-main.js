'use strict';
// T4 (plan-t4 Rev 3): owner controls in my own thread, for the one Plexiform-held session it shows: share it with a
// team, Allow sending, Stop sharing, and a teammate's proposal (approve on a review card, reject, revoke).
// thread-main owns Guard T; this file holds the rest, per thread document.
//
// - The session is resolved fresh at every read and effect (owner.target: overview-service ownerTarget, read-only).
// - The remote host is called directly, never interaction-main's actorOf, so nothing here reaps or replaces the
//   Overview document's actor (parent M3).
// - Every effect re-checks share.session === that session on a fresh listShares; approve, reject and revoke resolve
//   the proposal on a fresh proposalList, never the poll cache.
// - Keys are per-document HMACs; no share, team or proposal id ever reaches the page.
// - Share, Allow sending and approve take a review card: a one-use selection main armed 600 ms after it delivered
//   the card, binding everything the effect needs. Stop, reject and revoke only narrow access: one click.
// - The proposal poll (Rev 2 Q4, Rev 3 R2-S2) runs in main, per share across documents, every 15 s, only while the
//   thread that asked is the bound, visible, unminimised one, and only for its live interact shares. Main checks
//   that before every pass; the page's reads can only keep its interest alive for a short lease, never past a hide.
const crypto = require('node:crypto');

const ARM_MS = 600;
const SELECTION_MS = 45_000;
const STATE_MIN_MS = 5000;
const CATALOG_MS = 15_000;
const POLL_MS = 15_000;
const TICK_MS = 1000;
const LEASE_MS = 20_000;
const POLL_CAP = 8;
const MAX_PER_DOC = 8;
const APPROVE_S = 600;
// T4d: how long the owner may let one teammate send (host remote-interaction.js ALLOW_SECONDS).
const ALLOW_FOR = Object.freeze({ 900: '15 min', 1800: '30 min', 3600: '1 hour', 14400: '4 hours' });
const EARLIER_MAX = 20;
const GROUPS_MAX = 10;
const KEY = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Overview's own choices (overview-share.js EXPIRY), keyed by what the page sends.
const EXPIRY = Object.freeze({ 3600: 'For 1 hour', 28800: 'For 8 hours', 86400: 'For 1 day', 604800: 'For 7 days', '': 'Until you stop it' });
const SCOPES = Object.freeze({ watch: 'Watch only', interact: 'Watch and send' });
// The hub's proposal statuses, as the owner sees them (board/hub/interaction-proposals.js).
const PROPOSAL_STATUS = Object.freeze({ pending: 'awaiting', approved: 'approved', expired: 'expired', superseded: 'expired', revoked: 'rejected', dispatching: 'sending', sent: 'sent', refused: 'refused', unconfirmed: 'unconfirmed' });
const TEXT = Object.freeze({
  NOT_HELD: 'This session is no longer held by Plexiform, so it can’t be shared.',
  NO_SHARING: 'To share, sign in to your team hub and turn on team sharing in Preferences.',
  NO_TEAMS: 'You are not in a team you can share with.',
  WATCH: 'Members see messages sent since now and the replies, and whether this computer is online.',
  SOON: 'This share is about to end. Share again to choose a new time.',
  MOVED: 'This changed since you looked. Look at it again.',
  NOT_READY: 'Take a moment to read the card, then confirm.',
  BUSY: 'Still working on your last choice.',
  INVALID: 'That choice could not be used. Look at it again.',
  UNAVAILABLE: 'Sharing is unavailable right now.',
  SHARED: 'Shared. Members see what happens from now on.',
  ALLOWED: 'Sending allowed. The time left is unchanged.',
  ALLOWED_ONE: 'Allowed. They can send until the time shown.',
  ALLOW_STOPPED: 'Stopped. They can only watch now.',
  OLD_HUB: 'Your team hub needs an update before you can allow one teammate to send.',
  APPROVED: 'Decision acknowledged. The requester can send this exact message once before expiry.',
  STOPPED: 'Stopped sharing. Teammates can no longer see or send to this session.',
  REJECTED: 'Proposal rejected.',
  REVOKED: 'Grant revoked. A send already started cannot be undone.',
  RETIRED: 'This request already started or was retired. Check its current receipt; it cannot be undone here.',
});

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const line = (v, max) => (typeof v === 'string' ? v.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const prose = (v, max) => (typeof v === 'string' ? v.replace(CONTROL, '').slice(0, max) : '');
const fail = (status, error) => ({ ok: false, status, error });
const exact = (req, keys) => plain(req) && Object.keys(req).sort().join(',') === [...keys].sort().join(',');
const hostError = (r, fallback = TEXT.UNAVAILABLE) => fail(r?.status === 'stale' || r?.status === 'gone' ? 'stale' : 'unavailable', line(r?.error, 300) || fallback);

function createOwnerThreadActions({ owner = null, now = Date.now, timers = { setInterval, clearInterval } } = {}) {
  const docs = new Map(); // `${wcId}:${generation}` → { boundId, secret, last, held, interest, busy }
  const selections = new Map(); // selection → record
  const polls = new Map(); // share id → { at, host, proposals }: the poll cache, main memory only
  // The per-share floor outlives the cache: a hide drops what was read, but a show inside 15 s can't read again.
  const floors = new Map(); // share id → last proposalList time (no data)
  let catalog = null; // { host, at, pending, value }: listShares, shared across documents for reads
  let ticker = null, polling = false, stopped = false, current = () => null;
  const docKey = (c) => `${c.contents.id}:${c.generation}`;
  const safe = (fn, fallback = null) => { try { return fn() ?? fallback; } catch { return fallback; } };
  const targetOf = (rowId) => { const t = safe(() => owner?.target?.(rowId)); return t && typeof t.session === 'string' && UUID.test(t.session) ? t : null; };
  const hostNow = () => safe(() => owner?.host?.());
  const accountNow = () => safe(() => owner?.account?.());
  const automatic = (id) => safe(() => owner?.automatic?.(id), false) === true;

  function docOf(c) {
    const key = docKey(c);
    let d = docs.get(key);
    if (d && d.boundId !== c.boundId) { forget(key); d = null; }
    if (!d) {
      for (const k of [...docs.keys()]) if (k.startsWith(`${c.contents.id}:`)) forget(k);
      d = { boundId: c.boundId, secret: crypto.randomBytes(32), last: null, held: false, interest: null, busy: false, rejects: new Map() };
      docs.set(key, d);
    }
    return d;
  }
  const mac = (d, ...parts) => crypto.createHmac('sha256', d.secret).update(parts.join('\n')).digest('hex').slice(0, 32);
  function forget(key) {
    docs.delete(key);
    for (const [s, rec] of selections) if (rec.doc === key) selections.delete(s);
    sweep();
  }
  const live = (s, t = now()) => s && (s.expiresAt === null || (Number.isFinite(s.expiresAt) && s.expiresAt > t));
  const sharesOf = (host, session) => (safe(() => host.shared(), []) || []).filter((s) => plain(s) && typeof s.id === 'string' && s.session === session && live(s));

  // A fresh listShares for an effect (never the read catalog).
  async function freshList(host) {
    let r = null;
    try { r = await host.listShares(); } catch { r = null; }
    return r?.ok === true && Array.isArray(r.shares) && Array.isArray(r.teams) ? r : null;
  }
  // Reads: at most one listShares per host every 15 s, for the teams and the members; the shares come from host.shared().
  async function readCatalog(host) {
    const t = now();
    if (catalog && catalog.host === host && (catalog.pending || t - catalog.at < CATALOG_MS)) return catalog.pending ?? catalog.value;
    const entry = { host, at: t, pending: null, value: null };
    catalog = entry;
    entry.pending = freshList(host).then((v) => { entry.value = v; entry.pending = null; return v; });
    return entry.pending;
  }

  // ── thread:owner-state ──
  async function state(c, still) {
    const d = docOf(c), t0 = now();
    if (d.last && t0 - d.last.at < STATE_MIN_MS) return d.last.pending ?? d.last.result;
    const entry = { at: t0, pending: null, result: null };
    d.last = entry;
    entry.pending = (async () => {
      const r = await stateNow(c, d, still);
      entry.pending = null;
      if (r === null) { if (d.last === entry) d.last = null; return null; }
      entry.result = r;
      return r;
    })();
    return entry.pending;
  }
  async function stateNow(c, d, still) {
    const tgt = targetOf(c.boundId);
    if (!tgt) { const was = d.held; d.held = false; dropInterest(d); return { shareable: false, reason: was ? TEXT.NOT_HELD : '' }; }
    d.held = true;
    const host = hostNow();
    if (!host) { dropInterest(d); return { shareable: true, available: false, reason: TEXT.NO_SHARING }; }
    // L32 (D4): the catalog's listShares also brings who is watching, so it is fetched only while main sees this
    // thread shown (visible, not minimised). A hidden thread reuses what it has; its viewers age out (35 s).
    const shown = safe(() => c.window.isVisible(), false) === true && safe(() => c.window.isMinimized(), true) === false;
    const cat = shown ? await readCatalog(host) : catalog && catalog.host === host ? catalog.value : null;
    if (!still(c) || docs.get(docKey(c)) !== d) return null;
    if (targetOf(c.boundId)?.session !== tgt.session || hostNow() !== host) return null;
    // The poll's interest: this document, this session, this host and account. Main re-checks all of it every pass.
    d.interest = { host, account: accountNow(), session: tgt.session, at: now() };
    ensureTicker(); void tick();
    const t = now(), mine = sharesOf(host, tgt.session);
    const shares = mine.slice(0, 8).map((s) => ({
      key: mac(d, 's', s.id), team: line(s.team?.name, 120) || 'Team', scope: s.scope === 'interact' ? 'interact' : 'watch',
      expiresAt: s.expiresAt, automatic: automatic(s.id), members: Array.isArray(s.members) ? s.members.length : 0,
      viewers: Array.isArray(s.viewers) ? s.viewers.slice(0, 50).map((n) => line(n, 80) || 'Teammate') : [],
      ...allowView(d, s),
    }));
    const { groups, others } = groupsOf(d, tgt.session, mine, host);
    const teams = cat ? cat.teams.filter((x) => plain(x) && typeof x.id === 'string').slice(0, 40).map((x) => ({ key: mac(d, 't', x.id), name: line(x.name, 120) || 'Team' })) : [];
    return { shareable: true, available: true, provider: tgt.provider, teams, shares, groups, others, reason: cat && !teams.length ? TEXT.NO_TEAMS : '', observedAt: t };
  }
  // T4d: on a watch share, each acting teammate can be allowed to send for a while. `allowNote` (main's own words) says Allow can't be offered yet.
  function allowView(d, s) {
    if (s.scope === 'interact') return {};
    if (s.allowOk !== true) return { allowNote: TEXT.OLD_HUB, allowed: [], allowable: [] };
    const members = Array.isArray(s.members) ? s.members.filter((m) => plain(m) && typeof m.id === 'string' && m.acts === true).slice(0, 50) : [];
    const entry = (m) => ({ key: mac(d, 'm', s.id, m.id), name: line(m.name, 80) || 'Teammate' });
    return {
      allowNote: '',
      allowed: members.filter((m) => Number.isFinite(m.allowedUntil)).map((m) => ({ ...entry(m), until: m.allowedUntil })),
      allowable: members.filter((m) => !Number.isFinite(m.allowedUntil)).map(entry),
    };
  }
  // Rev 4 (Callum, ledger 36): one card per teammate per session, not per proposal. The newest pending proposal from
  // that teammate is the card; their older pending ones fold under it, with Reject all. Approved and finished ones are
  // plain lines. Reject all names a snapshot main keeps of exactly what it rendered (R4-S1).
  function groupsOf(d, session, mine, host) {
    const pending = new Map(), others = [];
    for (const s of mine) {
      if (s.scope !== 'interact') continue;
      const cached = polls.get(s.id);
      if (!cached || cached.host !== host || !Array.isArray(cached.proposals)) continue;
      for (const p of cached.proposals) {
        if (!plain(p) || typeof p.id !== 'string' || !plain(p.requester) || typeof p.requester.id !== 'string') continue;
        if (p.status !== 'pending') { if (others.length < 20) others.push(proposalView(d, s, p)); continue; }
        const list = pending.get(p.requester.id) ?? [];
        list.push({ s, p });
        pending.set(p.requester.id, list);
      }
    }
    const at = (x) => { const t = Date.parse(x.p.createdAt); return Number.isFinite(t) ? t : 0; };
    d.rejects.clear();
    const groups = [];
    for (const [requester, list] of [...pending].slice(0, GROUPS_MAX)) {
      list.sort((a, b) => at(b) - at(a));
      const [latest, ...rest] = list;
      let rejectAll = null;
      if (rest.length) {
        rejectAll = crypto.randomBytes(16).toString('hex');
        d.rejects.set(rejectAll, { session, requester, items: list.map(({ s, p }) => ({ share: s.id, id: p.id, version: p.version, digest: p.digest })) });
      }
      groups.push({ requester: line(latest.p.requester?.name, 80) || 'A teammate', latest: proposalView(d, latest.s, latest.p), earlier: rest.slice(0, EARLIER_MAX).map(({ s, p }) => proposalView(d, s, p)), more: Math.max(0, rest.length - EARLIER_MAX), rejectAll });
    }
    return { groups, others };
  }
  // A proposal's key binds its share, id, version and digest: Approve and Reject act on the one shown (R4-S2).
  const proposalKey = (d, s, p) => mac(d, 'p', s.id, p.id, String(p.version), String(p.digest));
  function proposalView(d, s, p) {
    return {
      key: proposalKey(d, s, p), share: mac(d, 's', s.id), requester: line(p.requester?.name, 80) || 'A teammate', title: line(p.title, 120),
      text: prose(p.text, 4000), version: p.version, status: PROPOSAL_STATUS[p.status] ?? 'unconfirmed',
      expiresAt: typeof p.expiresAt === 'string' && Number.isFinite(Date.parse(p.expiresAt)) ? Date.parse(p.expiresAt) : null,
    };
  }

  // ── selections ──
  function mint(c, rec) {
    const key = docKey(c), t = now();
    for (const [s, r] of selections) if (r.expires < t) selections.delete(s);
    const mine = [...selections].filter(([, r]) => r.doc === key);
    for (const [s] of mine.slice(0, Math.max(0, mine.length - MAX_PER_DOC + 1))) selections.delete(s);
    const selection = crypto.randomUUID();
    selections.set(selection, { ...rec, doc: key, boundId: c.boundId, deliveredAt: t, expires: t + SELECTION_MS });
    return selection;
  }
  const card = (op, title, text, notes, confirm, extra = {}) => ({ op, title, text, notes, confirm, armMs: ARM_MS, ...extra });
  const interactLine = (provider) => `They can also send, steer and stop, using your ${provider} account and quota.`;
  // What every effect is checked against, immediately before and after each await.
  function fenceOf(c, still, session, host, account) {
    return () => !stopped && still(c, true) && targetOf(c.boundId)?.session === session && hostNow() === host && accountNow() === account;
  }

  // ── thread:owner-review [boundId, {op, …}] ──
  async function review(c, req, still) {
    const op = plain(req) ? req.op : null;
    if (!(op === 'share' ? exact(req, ['op', 'team', 'scope', 'expiry']) && KEY.test(req.team) && Object.hasOwn(SCOPES, req.scope) && typeof req.expiry === 'string' && Object.hasOwn(EXPIRY, req.expiry)
      : op === 'allow-sending' ? exact(req, ['op', 'share']) && KEY.test(req.share)
        : op === 'allow-send' ? exact(req, ['op', 'share', 'member', 'seconds']) && KEY.test(req.share) && KEY.test(req.member) && Object.hasOwn(ALLOW_FOR, req.seconds)
        : op === 'approve' ? exact(req, ['op', 'proposal']) && KEY.test(req.proposal) : false)) return fail('invalid', TEXT.INVALID);
    const d = docOf(c);
    if (d.busy) return fail('busy', TEXT.BUSY);
    const tgt = targetOf(c.boundId);
    if (!tgt) return fail('stale', TEXT.NOT_HELD);
    const host = hostNow(), account = accountNow();
    if (!host) return fail('unavailable', TEXT.NO_SHARING);
    const fence = () => !stopped && still(c) && docs.get(docKey(c)) === d && targetOf(c.boundId)?.session === tgt.session && hostNow() === host && accountNow() === account;
    d.busy = true;
    try {
      const list = await freshList(host);
      if (!fence()) return null;
      if (!list) return fail('unavailable', TEXT.UNAVAILABLE);
      const mine = list.shares.filter((s) => plain(s) && s.session === tgt.session && live(s));
      if (op === 'share') {
        const team = list.teams.find((x) => plain(x) && typeof x.id === 'string' && mac(d, 't', x.id) === req.team);
        if (!team) return fail('stale', TEXT.MOVED);
        const name = line(team.name, 120) || 'Team', expiresInS = req.expiry === '' ? null : Number(req.expiry);
        const notes = [TEXT.WATCH, ...(req.scope === 'interact' ? [interactLine(tgt.provider)] : []), EXPIRY[req.expiry]];
        const replaces = mine.find((s) => s.team?.id === team.id);
        if (replaces) notes.push(`This replaces the current share with ${name}.`);
        const selection = mint(c, { op, session: tgt.session, host, account, team: team.id, scope: req.scope, expiresInS });
        return { ok: true, status: 'review', selection, card: card(op, `Share this session with ${name}`, '', notes, 'Share', { scope: SCOPES[req.scope] }) };
      }
      if (op === 'allow-sending') {
        const s = mine.find((x) => mac(d, 's', x.id) === req.share);
        if (!s || s.scope !== 'watch') return fail('stale', TEXT.MOVED);
        const left = s.expiresAt === null ? null : Math.floor((s.expiresAt - now()) / 1000);
        if (left !== null && left < 60) return fail('refused', TEXT.SOON);
        const name = line(s.team?.name, 120) || 'Team';
        const selection = mint(c, { op, session: tgt.session, host, account, share: s.id, team: s.team?.id });
        return { ok: true, status: 'review', selection, card: card(op, `Allow ${name} to send`, '', [interactLine(tgt.provider)], 'Allow sending', { keeps: s.expiresAt }) };
      }
      if (op === 'allow-send') {
        const s = mine.find((x) => mac(d, 's', x.id) === req.share);
        if (!s || s.scope !== 'watch') return fail('stale', TEXT.MOVED);
        if (s.allowOk !== true) return fail('unavailable', TEXT.OLD_HUB);
        const m = Array.isArray(s.members) ? s.members.find((x) => plain(x) && typeof x.id === 'string' && x.acts === true && mac(d, 'm', s.id, x.id) === req.member) : null;
        if (!m) return fail('stale', TEXT.MOVED);
        const who = line(m.name, 80) || 'A teammate', secs = Number(req.seconds);
        const left = s.expiresAt === null ? null : Math.floor((s.expiresAt - now()) / 1000);
        if (left !== null && left < 60) return fail('refused', TEXT.SOON);
        const until = now() + Math.min(secs, left ?? secs) * 1000;
        const selection = mint(c, { op, session: tgt.session, host, account, share: s.id, team: s.team?.id, user: m.id, seconds: secs });
        return { ok: true, status: 'review', selection, card: card(op, `Allow ${who} to send`, '', [`${who} can send, steer and stop in this session for ${ALLOW_FOR[secs]}, using your ${tgt.provider} account and quota.`, 'You can stop it any time. It also ends when Plexiform quits on your Mac.'], `Allow · ${ALLOW_FOR[secs]}`, { until }) };
      }
      // approve: a fresh proposalList of this session's live interact shares, never the poll cache.
      const found = await findProposal(d, host, mine, req.proposal, fence);
      if (!fence()) return null;
      if (!found) return fail('stale', TEXT.MOVED);
      const { s, p } = found;
      if (p.status !== 'pending') return fail('stale', TEXT.MOVED);
      const who = line(p.requester?.name, 80) || 'A teammate';
      const selection = mint(c, { op, session: tgt.session, host, account, share: s.id, proposal: p.id, version: p.version, digest: p.digest, generation: p.generation });
      return { ok: true, status: 'review', selection, card: card(op, `${who} proposes a message`, prose(p.text, 4000), [`One send, within 10 minutes, on your ${tgt.provider} account. Decision version ${p.version}.`], 'Approve one send · 10 min') };
    } finally { d.busy = false; }
  }
  async function findProposal(d, host, mine, key, fence) {
    for (const s of mine.filter((x) => x.scope === 'interact').slice(0, POLL_CAP)) {
      let r = null;
      try { r = await host.proposalList(s.id, fence); } catch { r = null; }
      if (!fence()) return null;
      const p = r?.ok === true && Array.isArray(r.proposals) ? r.proposals.find((x) => plain(x) && typeof x.id === 'string' && proposalKey(d, s, x) === key) : null;
      if (p) return { s, p };
    }
    return null;
  }

  // ── thread:owner-confirm [boundId, {selection}] ──
  async function confirm(c, req, still) {
    if (!exact(req, ['selection']) || typeof req.selection !== 'string' || !UUID.test(req.selection)) return fail('invalid', TEXT.INVALID);
    const key = docKey(c), d = docs.get(key), rec = selections.get(req.selection);
    if (!d || !rec || rec.doc !== key || rec.boundId !== c.boundId || rec.expires < now()) { if (rec && rec.doc === key) selections.delete(req.selection); return fail('stale', TEXT.MOVED); }
    if (now() - rec.deliveredAt < ARM_MS) return fail('not-ready', TEXT.NOT_READY);
    if (d.busy) return fail('busy', TEXT.BUSY);
    // One use, before the first await.
    selections.delete(req.selection);
    const fence = fenceOf(c, still, rec.session, rec.host, rec.account);
    if (!fence()) return fail('stale', TEXT.MOVED);
    const host = rec.host;
    d.busy = true;
    try {
      if (rec.op === 'share') {
        let out = null;
        try { out = await host.shareSession({ session: rec.session, team: rec.team, scope: rec.scope, expiresInS: rec.expiresInS }); } catch { out = null; }
        afterEffect(d);
        return out?.ok === true ? { ok: true, status: 'shared', note: TEXT.SHARED } : hostError(out, 'Not shared. Try again.');
      }
      const list = await freshList(host);
      if (!fence()) return fail('stale', TEXT.MOVED);
      if (!list) return fail('unavailable', TEXT.UNAVAILABLE);
      const s = list.shares.find((x) => plain(x) && x.id === rec.share);
      if (!s || s.session !== rec.session || !live(s)) return fail('stale', TEXT.MOVED);
      if (rec.op === 'allow-sending') {
        if (s.scope !== 'watch' || s.team?.id !== rec.team) return fail('stale', TEXT.MOVED);
        // The time left, from the host's own record, again at confirm (T0: Allow sending keeps it).
        const left = s.expiresAt === null ? null : Math.floor((s.expiresAt - now()) / 1000);
        if (left !== null && left < 60) return fail('refused', TEXT.SOON);
        let out = null;
        try { out = await host.shareSession({ session: rec.session, team: rec.team, scope: 'interact', expiresInS: left }); } catch { out = null; }
        afterEffect(d);
        return out?.ok === true ? { ok: true, status: 'allowed', note: TEXT.ALLOWED } : hostError(out, 'Not changed. Try again.');
      }
      if (rec.op === 'allow-send') {
        const m = Array.isArray(s.members) ? s.members.find((x) => plain(x) && x.id === rec.user && x.acts === true) : null;
        if (s.scope !== 'watch' || s.team?.id !== rec.team || !m) return fail('stale', TEXT.MOVED);
        let out = null;
        try { out = await host.grantAllowance({ share: s.id, user: rec.user, seconds: rec.seconds }); } catch { out = null; }
        afterEffect(d, s.id);
        return out?.ok === true ? { ok: true, status: 'allowed-one', note: TEXT.ALLOWED_ONE } : hostError(out, 'Not changed. Try again.');
      }
      if (rec.op === 'approve') {
        if (s.scope !== 'interact') return fail('stale', TEXT.MOVED);
        let r = null;
        try { r = await host.proposalList(s.id, fence); } catch { r = null; }
        if (!fence()) return fail('stale', TEXT.MOVED);
        const p = r?.ok === true && Array.isArray(r.proposals) ? r.proposals.find((x) => plain(x) && x.id === rec.proposal) : null;
        if (!p || p.status !== 'pending' || p.version !== rec.version || p.digest !== rec.digest || p.generation !== rec.generation) return fail('stale', TEXT.MOVED);
        let out = null;
        try { out = await host.proposalApprove({ share: s.id, id: rec.proposal, version: rec.version, digest: rec.digest, expiresInS: APPROVE_S }, fence); } catch { out = null; }
        afterEffect(d, s.id);
        return out?.ok === true ? { ok: true, status: 'approved', note: TEXT.APPROVED } : hostError(out, TEXT.MOVED);
      }
      return fail('invalid', TEXT.INVALID);
    } finally { d.busy = false; }
  }

  // ── thread:owner-act [boundId, {op, key}]: stop, reject, revoke (only narrow access; one click) ──
  async function act(c, req, still) {
    if (!exact(req, ['op', 'key']) || !['stop', 'reject', 'revoke', 'reject-all', 'stop-allow'].includes(req.op) || typeof req.key !== 'string' || !KEY.test(req.key)) return fail('invalid', TEXT.INVALID);
    const d = docs.get(docKey(c));
    if (!d || d.boundId !== c.boundId) return fail('stale', TEXT.MOVED);
    if (d.busy) return fail('busy', TEXT.BUSY);
    const tgt = targetOf(c.boundId), host = hostNow(), account = accountNow();
    if (!tgt) return fail('stale', TEXT.NOT_HELD);
    if (!host) return fail('unavailable', TEXT.NO_SHARING);
    const fence = fenceOf(c, still, tgt.session, host, account);
    d.busy = true;
    try {
      const list = await freshList(host);
      if (!fence()) return fail('stale', TEXT.MOVED);
      if (!list) return fail('unavailable', TEXT.UNAVAILABLE);
      const mine = list.shares.filter((s) => plain(s) && s.session === tgt.session && live(s));
      if (req.op === 'stop') {
        const s = mine.find((x) => mac(d, 's', x.id) === req.key);
        if (!s) return fail('stale', TEXT.MOVED);
        let out = null;
        try { out = host.stopSharing(s.id); } catch { out = null; }
        afterEffect(d, s.id);
        return out?.ok === true ? { ok: true, status: 'stopped', note: TEXT.STOPPED } : hostError(out, 'Could not stop sharing. Try again.');
      }
      if (req.op === 'stop-allow') {
        for (const s of mine) {
          const m = Array.isArray(s.members) ? s.members.find((x) => plain(x) && typeof x.id === 'string' && mac(d, 'm', s.id, x.id) === req.key) : null;
          if (!m) continue;
          let out = null;
          try { out = await host.revokeAllowance({ share: s.id, user: m.id }); } catch { out = null; }
          afterEffect(d, s.id);
          return out?.ok === true ? { ok: true, status: 'allow-stopped', note: TEXT.ALLOW_STOPPED } : hostError(out, 'Could not stop that. Try again.');
        }
        return fail('stale', TEXT.MOVED);
      }
      if (req.op === 'reject-all') return await rejectAll(d, host, mine, req.key, tgt.session, fence);
      const found = await findProposal(d, host, mine, req.key, fence);
      if (!fence()) return fail('stale', TEXT.MOVED);
      if (!found || found.p.status !== (req.op === 'reject' ? 'pending' : 'approved')) return fail('stale', TEXT.MOVED);
      let out = null;
      try { out = await host.proposalRevoke({ share: found.s.id, id: found.p.id }, fence); } catch { out = null; }
      afterEffect(d, found.s.id);
      if (out?.ok !== true && !out?.proposal) return hostError(out);
      return { ok: true, status: req.op === 'reject' ? 'rejected' : 'revoked', note: out.proposal?.status === 'revoked' ? (req.op === 'reject' ? TEXT.REJECTED : TEXT.REVOKED) : TEXT.RETIRED };
    } finally { d.busy = false; }
  }
  // Reject all (R4-S1): only the proposals main rendered under that token, each still pending with the same version,
  // digest and requester on a fresh list. One that arrived after the render is never touched; the rest report stale.
  async function rejectAll(d, host, mine, token, session, fence) {
    const snap = d.rejects.get(token);
    if (!snap || snap.session !== session) return fail('stale', TEXT.MOVED);
    d.rejects.delete(token);
    let done = 0, stale = 0;
    const byShare = new Map();
    for (const it of snap.items) byShare.set(it.share, [...(byShare.get(it.share) ?? []), it]);
    for (const [shareId, items] of byShare) {
      const s = mine.find((x) => x.id === shareId);
      if (!s || s.scope !== 'interact') { stale += items.length; continue; }
      let r = null;
      try { r = await host.proposalList(s.id, fence); } catch { r = null; }
      if (!fence()) return fail('stale', TEXT.MOVED);
      const now = r?.ok === true && Array.isArray(r.proposals) ? r.proposals : [];
      for (const it of items) {
        const p = now.find((x) => plain(x) && x.id === it.id);
        if (!p || p.status !== 'pending' || p.version !== it.version || p.digest !== it.digest || p.requester?.id !== snap.requester) { stale++; continue; }
        let out = null;
        try { out = await host.proposalRevoke({ share: s.id, id: p.id }, fence); } catch { out = null; }
        if (out?.proposal?.status === 'revoked') done++; else stale++;
        if (!fence()) break;
      }
      afterEffect(d, s.id);
    }
    if (!done) return fail('stale', TEXT.MOVED);
    return { ok: true, status: 'rejected', note: stale ? `${done} rejected. ${stale} had already changed; look again.` : `${done === 1 ? 'Proposal' : `${done} proposals`} rejected.` };
  }
  // After an effect the next read is fresh, and that share's proposals are polled again at once.
  function afterEffect(d, shareId = null) {
    d.last = null;
    if (catalog) catalog.at = 0;
    // An effect of the owner's own lifts that share's floor once, so its card shows the result.
    if (shareId) floors.delete(shareId);
  }

  // ── the proposal poll (main-gated) ──
  function dropInterest(d) { if (d) d.interest = null; sweep(); }
  function ensureTicker() {
    if (ticker || stopped) return;
    ticker = timers.setInterval(() => { void tick(); }, TICK_MS);
    ticker?.unref?.();
  }
  // Which shares any document still has a live interest in; everything else leaves the cache.
  function wanted() {
    const out = new Map(); // share id → { host, fence }
    const c = safe(() => current());
    for (const [key, d] of docs) {
      const i = d.interest;
      if (!i) continue;
      // Main's own checks, every pass (R2-S2): the bound document, on screen, not minimised, same session, host, account.
      const ok = !stopped && !!c && docKey(c) === key && c.boundId === d.boundId && safe(() => c.window.isVisible(), false) === true && safe(() => c.window.isMinimized(), true) === false
        && now() - i.at <= LEASE_MS && hostNow() === i.host && safe(() => i.host.connected(), false) === true && accountNow() === i.account && targetOf(d.boundId)?.session === i.session;
      if (!ok) { d.interest = null; continue; }
      const fence = () => { const n = safe(() => current()); return !stopped && d.interest === i && !!n && docKey(n) === key && n.boundId === d.boundId && safe(() => n.window.isVisible(), false) === true && safe(() => n.window.isMinimized(), true) === false && hostNow() === i.host; };
      for (const s of sharesOf(i.host, i.session)) if (s.scope === 'interact' && !out.has(s.id)) out.set(s.id, { host: i.host, fence });
    }
    return out;
  }
  function sweep() {
    const want = wanted();
    for (const id of [...polls.keys()]) if (!want.has(id)) polls.delete(id);
    if (!want.size && ![...docs.values()].some((d) => d.interest) && ticker) { timers.clearInterval(ticker); ticker = null; }
    return want;
  }
  async function tick() {
    if (polling || stopped) return;
    const want = sweep(), t = now();
    for (const [id, at] of floors) if (t - at >= POLL_MS) floors.delete(id);
    const due = [...want].filter(([id]) => !floors.has(id)).slice(0, POLL_CAP);
    if (!due.length) return;
    polling = true;
    try {
      // One in flight; the per-share floor is taken before the call, so a show/hide burst can't repeat it.
      for (const [id, w] of due) {
        if (!w.fence()) continue;
        const entry = { at: now(), host: w.host, proposals: polls.get(id)?.host === w.host ? polls.get(id).proposals : null };
        polls.set(id, entry); floors.set(id, entry.at);
        while (floors.size > 64) floors.delete(floors.keys().next().value);
        let r = null;
        try { r = await w.host.proposalList(id, w.fence); } catch { r = null; }
        if (!w.fence() || polls.get(id) !== entry) continue;
        entry.proposals = r?.ok === true && Array.isArray(r.proposals) ? r.proposals.filter((p) => plain(p) && typeof p.id === 'string').slice(0, 64) : entry.proposals;
      }
    } finally { polling = false; }
    sweep();
    for (const d of docs.values()) if (d.interest) d.last = null;
  }

  return {
    state, review, confirm, act, tick,
    // thread-main's ctx(): the poll's view of which document is on screen. Never the page's say-so.
    bind(fn) { current = typeof fn === 'function' ? fn : () => null; },
    retire(wcId) { for (const k of [...docs.keys()]) if (k.startsWith(`${wcId}:`)) forget(k); sweep(); },
    stop() { stopped = true; docs.clear(); selections.clear(); polls.clear(); floors.clear(); catalog = null; if (ticker) { timers.clearInterval(ticker); ticker = null; } },
    size: () => ({ selections: selections.size, polls: polls.size, docs: docs.size }),
  };
}

module.exports = { createOwnerThreadActions, EARLIER_MAX, ARM_MS, SELECTION_MS, STATE_MIN_MS, POLL_MS, POLL_CAP, LEASE_MS, APPROVE_S, EXPIRY, SCOPES, TEXT, PROPOSAL_STATUS };
