// The account flow's state machine, Electron-free: which account screen is
// showing and which hub it is about, an invite waiting on confirmation or
// sign-in, what signing out must undo, and every action the account page can
// ask for. index.js injects the Electron side (views, sessions, safeStorage,
// forks) through `ui` and friends; tests drive it against the mock hub.
'use strict';

const crypto = require('node:crypto');
const { parseInvite, routeInvite } = require('./accounts');
const { hostOf, partitionFor, integrationPartitionFor } = require('./workspaces');
const BRAND = require('./brand');

// Screens the page itself may ask for; the rest (`confirm`, `code`) are
// reached only through the flow (e.g. `confirm` after an invite link).
const PAGE_SCREENS = new Set(['hub', 'email', 'create-team', 'join', 'team', 'thismac', 'account', 'invites']);

// Argument types per action; the IPC layer refuses anything else before it runs.
const ACCT_ARGS = {
  state: [], go: ['string'], hub: ['string'], confirm: ['boolean'], email: ['string'], code: ['string'], resend: [], createTeam: ['string'],
  invite: ['string', 'string', 'string'], resendInvite: ['string', 'string'], revokeInvite: ['string', 'string'], setRole: ['string', 'string', 'string'], removeMember: ['string', 'string'],
  joinCode: ['string'], accept: ['string'], notNow: [], acceptPending: ['string'], switchAccount: [], skipInvites: [], openTeam: ['string'], signOut: ['string'], deleteStart: ['string'],
  deleteConfirm: ['string'], cancelDelete: [], runner: ['string', 'boolean'], presence: ['string', 'boolean'],
};

const TEAM_CHANGED = { ok: false, error: 'The team changed while this page was open. Look again, then try once more.' };
// Runner states that mean the hub stopped accepting this Mac's token.
const TOKEN_TROUBLE = new Set(['unauthenticated', 'revoked']);

/** A hub's storage after sign-out: its board partition and its Integrations sign-in partition. */
async function clearHubSessions(origin, fromPartition) {
  const parts = [partitionFor(origin), integrationPartitionFor(origin)];
  await Promise.allSettled(parts.flatMap((p) => {
    const s = fromPartition(p);
    return [s.clearStorageData(), s.clearCache(), s.clearAuthCache()];
  }));
  return parts;
}

/**
 * createAccountFlow({store, clientFor, signedIn, userOf, normHub, normLink, probe,
 *   makeDevice, hasDeviceFile, discardDeviceFiles, deviceInfo, ui, log})
 *   ui: {show(screen), select(pageId), switchWorkspace(id, {show}), pushState(),
 *        forgetHub(), hubSignedOut(origin), isOpen(), onHubPage(), devicesChanged()}
 */
function createAccountFlow({ store, clientFor, signedIn, userOf, normHub, normLink, probe, makeDevice, hasDeviceFile = () => false, discardDeviceFiles = () => {}, deviceInfo = () => ({}), ui, log = () => {} }) {
  const acct = { screen: null, hub: null, notice: null, deleting: false };
  let pendingInvite = null; // {hub|null, token, previewId?}
  // A hub named by an invite link must be confirmed by the member before any
  // request goes to it; a hub they typed themselves counts as confirmed.
  let trustedHub = null;
  let awaitingConfirm = null; // the hub the confirm screen is asking about
  const accounts = new Map(); // origin → last GET /api/account (teams, pending_invites)
  const devices = new Map(); // workspace id → {hub, name, d}
  let lastSessions = [];
  const checks = new Map(); // origin → in-flight "still signed in?" check
  const outs = new Map(); // origin → in-flight sign-out cleanup

  const hubTrusted = (h) => !!h && (store.knows(h) || trustedHub === h);
  const activeTeam = () => { const w = store.active(); return w.kind === 'team' ? w : null; };
  // A team action carries the team the page rendered; it runs only on that one.
  const renderedTeam = (wsId) => { const w = activeTeam(); return w && w.id === wsId ? w : null; };
  const hubByHost = (host) => store.hubs().find((h) => hostOf(h) === host) ?? null;
  // A bare host reads back as https; anything else (the dev mock) needs its scheme.
  const prefill = (origin) => (!origin ? '' : origin.startsWith('https://') ? hostOf(origin) : origin);

  function show(screen, { notice = null } = {}) {
    acct.screen = screen;
    acct.notice = notice;
    ui.show(screen);
  }

  async function refreshAccount(origin) {
    const r = await clientFor(origin).me();
    if (r.ok) { accounts.set(origin, r); store.setTeams(origin, r); ui.pushState(); }
    return r;
  }

  // ── this Mac as a runner, per team ──────────────────────────────────────

  function deviceFor(ws) {
    const e = devices.get(ws.id);
    if (e) return e.d;
    const d = makeDevice(ws, {
      onStatus: (st) => {
        if (TOKEN_TROUBLE.has(st?.runner?.state)) checkSignedIn(ws.hub);
        ui.devicesChanged();
      },
    });
    d.setPresence(store.sharesPresence(ws.hub), lastSessions);
    devices.set(ws.id, { hub: ws.hub, name: ws.name, d });
    return d;
  }

  /**
   * Every runner for a hub stops and its sealed enrolment is deleted, loaded
   * this run or not. `revoke` also unenrols on the hub, so it must run while
   * the account token still works.
   */
  async function dropDevices(origin, { revoke = false } = {}) {
    if (revoke) for (const w of store.list()) if (w.kind === 'team' && w.hub === origin && hasDeviceFile(w)) deviceFor(w);
    const mine = [...devices].filter(([, e]) => e.hub === origin);
    for (const [id] of mine) devices.delete(id);
    await Promise.all(mine.map(([, e]) => (revoke ? e.d.remove() : e.d.discard()).catch((err) => log('runner stop failed', err.message))));
    discardDeviceFiles(origin);
    ui.devicesChanged();
  }

  // ── signed in / signed out ──────────────────────────────────────────────

  async function signedOutNow(origin, { tell }) {
    // By id: the token is already gone, so the hub's teams have left list().
    const wasActive = store.activeId().startsWith(`team:${hostOf(origin)}:`);
    accounts.delete(origin);
    store.forgetTeams(origin);
    if (pendingInvite?.hub === origin) pendingInvite = null;
    if (trustedHub === origin) trustedHub = null;
    if (awaitingConfirm === origin) awaitingConfirm = null;
    if (acct.hub === origin) acct.deleting = false;
    await dropDevices(origin);
    await ui.hubSignedOut(origin);
    ui.pushState();
    if (tell && wasActive && ui.isOpen()) { acct.hub = origin; show('email', { notice: 'You’ve been signed out. Sign in again to open your team.' }); } else if (wasActive && ui.isOpen() && ui.onHubPage()) ui.select('board');
  }

  /** Everything a hub's sign-in held goes: teams, runners, sealed files, partitions, pending state. */
  function signedOutOf(origin, { tell = false } = {}) {
    if (outs.has(origin)) return outs.get(origin);
    const p = signedOutNow(origin, { tell }).finally(() => outs.delete(origin));
    outs.set(origin, p);
    return p;
  }

  /**
   * Something said this hub may have revoked us (a 401 in the board view, a
   * runner reporting its token refused, a socket closed 4401): ask the hub
   * once. Only a 401 on /api/account itself signs the member out.
   */
  function checkSignedIn(origin) {
    if (checks.has(origin)) return checks.get(origin);
    if (!signedIn(origin)) return Promise.resolve({ ok: false, signedOut: true });
    const p = (async () => {
      const r = await clientFor(origin).me();
      if (r.ok) { accounts.set(origin, r); store.setTeams(origin, r); ui.pushState(); } else if (r.signedOut) await signedOutOf(origin, { tell: true });
      return r;
    })().finally(() => checks.delete(origin));
    checks.set(origin, p);
    return p;
  }

  // After any sign-in: an invite waiting on it, else invites addressed to
  // this email, else the team board, else "create a team".
  async function afterSignIn(origin) {
    store.addHub(origin);
    trustedHub = null;
    const r = await refreshAccount(origin);
    if (pendingInvite && (pendingInvite.hub ?? origin) === origin) { pendingInvite.hub = origin; acct.hub = origin; show('join'); return; }
    if (r.ok && r.pending_invites?.length) { acct.hub = origin; show('invites'); return; }
    const first = store.list().find((w) => w.kind === 'team' && w.hub === origin);
    if (first) { ui.switchWorkspace(first.id); return; }
    acct.hub = origin;
    show('create-team');
  }

  function routePending() {
    const r = routeInvite(pendingInvite, { knownHubs: store.hubs(), signedIn });
    if (r.action === 'need-hub') { acct.hub = null; show('hub'); return r; }
    pendingInvite.hub = r.hub;
    acct.hub = r.hub;
    if (r.action === 'confirm') { awaitingConfirm = r.hub; show('confirm'); } else show(r.action === 'signin' ? 'email' : 'join');
    return r;
  }

  /** A deep link or universal link. Anything that isn't a valid invite is dropped without a word. */
  function openInvite(link) {
    const inv = parseInvite(link, { normalizeHub: normLink });
    if (!inv) { log('ignored a link that is not a valid invite'); return false; }
    pendingInvite = inv;
    routePending();
    return true;
  }

  /**
   * A hub the member typed: an accounts hub goes to email sign-in; one still
   * behind Access (the hidden fallback) becomes an Access workspace and signs
   * in inside the board view as before.
   */
  async function connectHub(origin) {
    const pr = await probe(origin);
    if (!pr.ok) return pr;
    if (pr.accessTeam || pr.auth === 'access') {
      store.addAccess({ url: origin, name: hostOf(origin), accessTeam: pr.accessTeam ?? null });
      log('connected team hub (access)', { host: hostOf(origin) });
      ui.forgetHub();
      ui.select('board');
      return { ok: true };
    }
    trustedHub = origin;
    acct.hub = origin;
    if (signedIn(origin)) { await afterSignIn(origin); return { ok: true }; }
    show('email');
    return { ok: true };
  }

  async function joined(origin, r) {
    if (r.ok) {
      pendingInvite = null;
      await refreshAccount(origin);
      const ws = store.list().find((w) => w.kind === 'team' && w.hub === origin && w.teamId === String(r.team?.id));
      if (ws) ui.switchWorkspace(ws.id); else ui.select('board');
      return { ok: true };
    }
    if (r.wrongAccount) return { ok: false, wrongAccount: true, error: r.error };
    if (r.alreadyMember) {
      pendingInvite = null;
      await refreshAccount(origin);
      const ws = store.list().find((w) => w.kind === 'team' && w.hub === origin && w.teamId === r.team.id);
      return { ok: false, alreadyIn: ws?.id ?? null, error: r.error };
    }
    if (r.gone) pendingInvite = null;
    return r;
  }

  // ── what each screen shows ──────────────────────────────────────────────

  async function screenState() {
    const screen = acct.screen;
    const base = { ok: true, brand: { name: BRAND.NAME, copy: BRAND.COPY }, screen, notice: acct.notice, host: acct.hub ? hostOf(acct.hub) : null, lastHub: prefill(store.lastHub()), signedInHubs: store.hubs().filter(signedIn).map(hostOf) };
    acct.notice = null;
    if (screen === 'hub') return { ...base, forInvite: !!pendingInvite };
    if (screen === 'email') return { ...base, forInvite: !!pendingInvite, email: acct.hub ? (userOf(acct.hub)?.email ?? '') : '' };
    if (screen === 'code') return { ...base, email: acct.hub ? clientFor(acct.hub).pendingEmail() : null };
    if (screen === 'create-team') {
      const hub = acct.hub && signedIn(acct.hub) ? acct.hub : (activeTeam()?.hub ?? store.hubs().find(signedIn) ?? null);
      acct.hub = hub;
      return { ...base, host: hub ? hostOf(hub) : null };
    }
    if (screen === 'invites') {
      const list = accounts.get(acct.hub)?.pending_invites ?? [];
      return { ...base, invites: list.map((i) => ({ id: String(i.id), team: String(i.team_name ?? ''), inviter: String(i.inviter_first_name ?? ''), role: String(i.role ?? '') })) };
    }
    if (screen === 'join') {
      const inv = pendingInvite;
      // Nothing is asked of a hub the member hasn't confirmed (or used before).
      if (!inv?.hub || !hubTrusted(inv.hub)) return { ...base, invite: null };
      const pv = await clientFor(inv.hub).previewInvite(inv.token);
      if (pendingInvite !== inv) return { ...base, invite: null };
      if (!pv.ok) { pendingInvite = null; return { ...base, invite: null, error: pv.error }; }
      inv.previewId ??= crypto.randomUUID();
      return { ...base, host: hostOf(inv.hub), email: userOf(inv.hub)?.email ?? null, invite: { id: inv.previewId, team: String(pv.team_name ?? ''), inviter: String(pv.inviter_first_name ?? ''), role: String(pv.role ?? '') } };
    }
    if (screen === 'team') {
      const ws = activeTeam();
      if (!ws) return { ...base, team: null, hasTeams: store.list().some((w) => w.kind === 'team') };
      const c = clientFor(ws.hub);
      const m = await c.listMembers(ws.teamId);
      const canManage = ['owner', 'admin'].includes(ws.role);
      const inv = canManage ? await c.listInvites(ws.teamId) : { ok: true, invites: [] };
      const meId = userOf(ws.hub)?.id ?? null;
      const members = (m.members ?? []).map((x) => ({ id: String(x.member_id ?? x.id), name: String(x.display_name ?? ''), email: String(x.email ?? ''), role: String(x.role), you: meId != null && String(x.user_id) === String(meId) }));
      return { ...base, host: hostOf(ws.hub), team: { id: ws.id, name: ws.name, role: ws.role }, canManage, isOwner: ws.role === 'owner', members, invites: (inv.invites ?? []).map((i) => ({ id: String(i.id), email: String(i.email), role: String(i.role), expires: String(i.expires_at ?? '') })), error: m.ok ? (inv.ok ? null : inv.error) : m.error };
    }
    if (screen === 'account') {
      return { ...base, deleting: acct.deleting && acct.hub ? hostOf(acct.hub) : null, accounts: store.hubs().filter(signedIn).map((h) => { const u = userOf(h) ?? {}; return { host: hostOf(h), name: String(u.display_name ?? ''), email: String(u.email ?? '') }; }) };
    }
    if (screen === 'thismac') {
      const hubs = store.hubs().filter(signedIn).map((h) => ({
        host: hostOf(h),
        share: store.sharesPresence(h),
        teams: store.list().filter((w) => w.kind === 'team' && w.hub === h).map((w) => {
          const st = devices.has(w.id) || hasDeviceFile(w) ? deviceFor(w).status() : { enrolled: false, enabled: false, runner: { state: 'off' }, parked: 0 };
          return { id: w.id, name: w.name, role: w.role, enabled: st.enabled, enrolled: st.enrolled, state: st.runner.state, detail: st.runner.detail, parked: st.parked };
        }),
      }));
      return { ...base, hubs };
    }
    return base;
  }

  // ── actions (one per account-page button or form) ───────────────────────

  const ACCT = {
    state: () => screenState(),
    go(screen) {
      if (!PAGE_SCREENS.has(screen)) return { ok: false };
      if (screen === 'hub' || screen === 'email') acct.deleting = false;
      if (screen === 'join') {
        if (pendingInvite && !hubTrusted(pendingInvite.hub)) pendingInvite = null;
        if (!pendingInvite) acct.hub = null;
      }
      show(screen);
      return { ok: true };
    },
    async hub(input) {
      let origin;
      try { origin = normHub(input); } catch (e) { return { ok: false, error: e.message }; }
      // An invite without a hub, and a hub we have never used: confirm it first.
      if (pendingInvite && !store.knows(origin)) { pendingInvite.hub = origin; acct.hub = origin; awaitingConfirm = origin; show('confirm'); return { ok: true }; }
      return connectHub(origin);
    },
    async confirm(yes) {
      // Only an answer to the question on screen, about the hub it named.
      if (acct.screen !== 'confirm' || !awaitingConfirm || acct.hub !== awaitingConfirm) return { ok: false, error: 'Not allowed.' };
      const hub = awaitingConfirm;
      awaitingConfirm = null;
      if (!yes) { pendingInvite = null; acct.hub = null; ui.select('board'); return { ok: true }; }
      trustedHub = hub;
      if (pendingInvite) pendingInvite.hub = hub;
      show(signedIn(hub) ? 'join' : 'email');
      return { ok: true };
    },
    async email(email) {
      const origin = acct.hub;
      if (!hubTrusted(origin)) return { ok: false, error: 'Start again: enter the team hub address.' };
      const r = await clientFor(origin).startEmail(email, deviceInfo());
      if (!r.ok) return r;
      show('code');
      return { ok: true };
    },
    async code(code) {
      const origin = acct.hub;
      if (!hubTrusted(origin)) return { ok: false, error: 'Start again: enter the team hub address.' };
      const r = await clientFor(origin).verifyCode(code, deviceInfo());
      if (!r.ok) return r;
      log('signed in to team hub', { host: hostOf(origin) });
      await afterSignIn(origin);
      return { ok: true };
    },
    async resend() {
      const c = hubTrusted(acct.hub) ? clientFor(acct.hub) : null;
      const email = c?.pendingEmail();
      if (!email) return { ok: false, error: 'Start again: enter your email.' };
      const r = await c.startEmail(email, deviceInfo());
      return r.ok ? { ok: true, notice: `We sent a new code to ${email}.` } : r;
    },
    async createTeam(name) {
      const origin = acct.hub;
      if (!origin || !signedIn(origin)) return { ok: false, error: 'Sign in to a team hub first.' };
      const r = await clientFor(origin).createTeam(name);
      if (!r.ok) return r;
      await refreshAccount(origin);
      ui.switchWorkspace(store.list().find((w) => w.kind === 'team' && w.hub === origin && w.teamId === String(r.team?.id))?.id, { show: false });
      show('team', { notice: `${r.team.name} is ready. Invite your team.` });
      return { ok: true };
    },
    async invite(wsId, email, role) {
      const ws = renderedTeam(wsId);
      if (!ws) return TEAM_CHANGED;
      const r = await clientFor(ws.hub).invite(ws.teamId, email, role);
      if (!r.ok) return r;
      const to = r.invite?.email ?? email;
      return { ok: true, link: r.link, email: to, notice: `Invite sent to ${to}.` };
    },
    async resendInvite(wsId, id) {
      const ws = renderedTeam(wsId);
      if (!ws) return TEAM_CHANGED;
      const c = clientFor(ws.hub);
      const list = await c.listInvites(ws.teamId);
      const inv = list.invites?.find((i) => String(i.id) === id);
      if (!inv) return { ok: false, error: 'That invite is gone.' };
      const r = await c.invite(ws.teamId, inv.email, inv.role);
      return r.ok ? { ok: true, link: r.link, email: inv.email, notice: `Sent a new link to ${inv.email}. The old one no longer works.` } : r;
    },
    async revokeInvite(wsId, id) {
      const ws = renderedTeam(wsId);
      return ws ? clientFor(ws.hub).revokeInvite(ws.teamId, id) : TEAM_CHANGED;
    },
    async setRole(wsId, memberId, role) {
      const ws = renderedTeam(wsId);
      if (!ws) return TEAM_CHANGED;
      const r = await clientFor(ws.hub).setRole(ws.teamId, memberId, role);
      if (r.ok) await refreshAccount(ws.hub);
      return r;
    },
    async removeMember(wsId, memberId) {
      const ws = renderedTeam(wsId);
      if (!ws) return TEAM_CHANGED;
      const r = await clientFor(ws.hub).removeMember(ws.teamId, memberId);
      if (r.ok) await refreshAccount(ws.hub);
      return r;
    },
    async joinCode(code) {
      const inv = parseInvite(code, { normalizeHub: normLink });
      if (!inv) return { ok: false, error: 'That doesn’t look like an invite. Paste the whole link or code.' };
      pendingInvite = inv;
      routePending();
      return { ok: true };
    },
    async accept(previewId) {
      const inv = pendingInvite;
      // Only the invite the page previewed: a link that arrived since doesn't ride on this click.
      if (!inv?.previewId || inv.previewId !== previewId) return { ok: false, error: 'That invite changed. Look again before you join.' };
      if (!hubTrusted(inv.hub) || !signedIn(inv.hub)) return { ok: false, error: 'Sign in first.' };
      return joined(inv.hub, await clientFor(inv.hub).acceptInvite({ t: inv.token }));
    },
    async notNow() {
      pendingInvite = null;
      acct.hub = null;
      ui.select('board');
      return { ok: true };
    },
    async acceptPending(id) {
      const origin = acct.hub;
      if (!origin || !signedIn(origin)) return { ok: false, error: 'Sign in first.' };
      if (!(accounts.get(origin)?.pending_invites ?? []).some((i) => String(i.id) === id)) return { ok: false, error: 'That invite is gone.' };
      return joined(origin, await clientFor(origin).acceptInvite({ inviteId: id }));
    },
    async switchAccount() {
      const inv = pendingInvite;
      const origin = inv?.hub;
      if (!origin || !hubTrusted(origin) || !signedIn(origin)) return { ok: false };
      await dropDevices(origin, { revoke: true });
      await clientFor(origin).signOut();
      await signedOutOf(origin);
      // Signing out drops the invite and trust for this hub; this sign-out is for the invite.
      pendingInvite = inv;
      trustedHub = origin;
      acct.hub = origin;
      show('email');
      return { ok: true };
    },
    async skipInvites() {
      const origin = acct.hub;
      const first = origin && store.list().find((w) => w.kind === 'team' && w.hub === origin);
      if (first) ui.switchWorkspace(first.id); else show('create-team');
      return { ok: true };
    },
    async openTeam(wsId) {
      if (store.get(wsId)?.kind !== 'team') return { ok: false };
      pendingInvite = null;
      ui.switchWorkspace(wsId);
      return { ok: true };
    },
    async signOut(host) {
      const origin = hubByHost(host);
      if (!origin) return { ok: false };
      await dropDevices(origin, { revoke: true });
      await clientFor(origin).signOut();
      await signedOutOf(origin);
      show('account', { notice: `Signed out of ${host}.` });
      return { ok: true };
    },
    async deleteStart(host) {
      const origin = hubByHost(host);
      if (!origin || !signedIn(origin)) return { ok: false };
      const r = await clientFor(origin).startDelete();
      if (!r.ok) return r;
      acct.hub = origin;
      acct.deleting = true;
      return { ok: true, email: r.email };
    },
    async deleteConfirm(code) {
      const origin = acct.hub;
      if (!origin || !acct.deleting) return { ok: false, error: 'Ask for a new code first.' };
      const r = await clientFor(origin).deleteAccount(code);
      if (!r.ok) return r;
      acct.deleting = false;
      await signedOutOf(origin);
      show('account', { notice: 'Your account was deleted.' });
      return { ok: true };
    },
    async cancelDelete() { acct.deleting = false; return { ok: true }; },
    async runner(wsId, on) {
      const ws = store.get(wsId);
      if (ws?.kind !== 'team' || !signedIn(ws.hub)) return { ok: false };
      const d = deviceFor(ws);
      if (on && !d.status().enrolled) return d.enroll({ name: deviceInfo().deviceName ?? 'Mac' });
      return d.setEnabled(on);
    },
    async presence(host, on) {
      const origin = hubByHost(host);
      if (!origin || !store.setSharesPresence(origin, on)) return { ok: false };
      for (const e of devices.values()) if (e.hub === origin) e.d.setPresence(on, lastSessions);
      return { ok: true };
    },
  };

  return {
    ACCT,
    acct,
    show,
    hubTrusted,
    openInvite,
    connectHub,
    signedOutOf,
    checkSignedIn,
    dropDevices,
    refreshAccount,
    /** The sidebar's workspace-menu actions. */
    startFlow(which) {
      if (which === 'signin' || which === 'join') { pendingInvite = null; acct.hub = null; }
      show(which === 'signin' ? 'hub' : which);
    },
    /** App start: runners the member left on come back without opening the window. */
    resumeDevices() {
      for (const w of store.list()) if (w.kind === 'team' && hasDeviceFile(w)) deviceFor(w).resume();
    },
    /** The widget's live sessions changed: hubs sharing presence get the new list. */
    sessionsChanged(sessions) {
      lastSessions = Array.isArray(sessions) ? sessions : [];
      for (const e of devices.values()) e.d.setPresence(store.sharesPresence(e.hub), lastSessions);
    },
    /** Names of the teams this Mac is running cards for right now. */
    runningTeams: () => [...devices.entries()].filter(([, e]) => e.d.running()).map(([id, e]) => store.get(id)?.name ?? e.name),
    stopDevices: () => Promise.all([...devices.values()].map((e) => e.d.stop())),
  };
}

module.exports = { createAccountFlow, clearHubSessions, PAGE_SCREENS, ACCT_ARGS };
