// The account flow's state machine, Electron-free: which account screen is
// showing and which hub it is about, an invite waiting on confirmation or
// sign-in, what signing out must undo, and every action the account page can
// ask for. index.js injects the Electron side (views, sessions, safeStorage,
// forks) through `ui` and friends; tests drive it against the mock hub.
'use strict';

const crypto = require('node:crypto');
const { parseInvite, routeInvite, inviteMailto, INVITE_CODE_RE, SLUG_MISMATCH } = require('./accounts');
const { hostOf, partitionFor, integrationPartitionFor } = require('./workspaces');
const { startProviderSignIn, PROVIDERS, PROVIDER_NAME } = require('./oauth');
const BRAND = require('./brand');
const { connectorRows } = require('./connectors');

// Screens the page itself may ask for; the rest (`confirm`, `code`, `browser`)
// are reached only through the flow (e.g. `confirm` after an invite link).
const PAGE_SCREENS = new Set(['hub', 'email', 'create-team', 'join', 'team', 'thismac', 'account', 'invites', 'integrations']);

// Argument types per action; the IPC layer refuses anything else before it runs.
const ACCT_ARGS = {
  state: [], go: ['string'], hub: ['string'], confirm: ['boolean'], email: ['string'], code: ['string'], resend: [], createTeam: ['string'],
  oauth: ['string'], signInWith: ['string'], cancelOAuth: [],
  invite: ['string', 'string', 'string'], resendInvite: ['string', 'string'], emailInvite: ['string', 'string'], revokeInvite: ['string', 'string'], setRole: ['string', 'string', 'string'], removeMember: ['string', 'string'],
  renameTeam: ['string', 'string'], addBoard: ['string', 'string'],
  teamDeleteStart: ['string', 'string'], teamDeleteCode: ['string', 'string'], teamDeleteResend: ['string'], teamDeleteOAuth: ['string', 'string'], deleteTeam: ['string'],
  joinCode: ['string'], acceptCode: ['string'], accept: ['string'], notNow: [], acceptPending: ['string'], switchAccount: [], skipInvites: [], openTeam: ['string'], signOut: ['string'], deleteStart: ['string'],
  deleteConfirm: ['string'], cancelDelete: [], deleteOAuth: ['string'], cancelDeleteOAuth: [], runner: ['string', 'boolean'], revokeRunner: ['string', 'string'], presence: ['string', 'boolean'], summaries: ['string', 'boolean'],
};

const TEAM_CHANGED = { ok: false, error: 'The team changed while this page was open. Look again, then try once more.' };

/** Providers that can confirm a deletion: those the hub offers, cut to the ones the account says it signs in with. */
function deleteProviders(methods, account) {
  const on = PROVIDERS.filter((p) => methods[p]);
  const raw = Array.isArray(account?.identities) ? account.identities : [];
  const linked = new Set(raw.map((i) => (typeof i === 'string' ? i : i?.provider)).filter((p) => PROVIDERS.includes(p)));
  return linked.size ? on.filter((p) => linked.has(p)) : on;
}

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
 *   makeDevice, hasDeviceFile, discardDeviceFiles, deviceInfo, openBrowser,
 *   oauthAllowOrigins, ui, log})
 *   ui: {show(screen), select(pageId), switchWorkspace(id, {show}), pushState(),
 *        forgetHub(), hubSignedOut(origin), isOpen(), onHubPage(), devicesChanged(),
 *        openMail(mailtoUrl)}
 */
function createAccountFlow({ store, clientFor, signedIn, userOf, normHub, normLink, probe, makeDevice, hasDeviceFile = () => false, discardDeviceFiles = () => {}, deviceInfo = () => ({}), openBrowser = () => {}, oauthAllowOrigins = [], oauthTimeoutMs, ui, log = () => {}, now = () => Date.now() }) {
  const acct = { screen: null, hub: null, notice: null, alert: null, deleting: false };
  let oauthRun = null; // {hub, provider, run, done}: the one provider sign-in waiting on the browser
  // The check before a deletion: for the account on a hub with no mailer (Google/GitHub), or for one
  // team (its emailed `delete_team` code, or Google/GitHub without a mailer). `confirmed` is held only
  // here, in memory, and only the run that is still current may set it. A step made for one team (or
  // for the account) is never spent on anything else.
  let delStep = null; // {hub, team: {wsId, teamId, slug, user} | null, via: 'provider'|'email', providers, flowId?, email?, confirmed: {provider?, flowId, until} | null}
  let delRun = null; // {hub, step, provider, run, done}: the check waiting on the browser
  let pendingInvite = null; // {hub|null, token, previewId?}
  // A hub named by an invite link must be confirmed by the member before any
  // request goes to it; a hub they typed themselves counts as confirmed.
  let trustedHub = null;
  let awaitingConfirm = null; // the hub the confirm screen is asking about
  const accounts = new Map(); // origin → last GET /api/account (teams, pending_invites)
  const devices = new Map(); // workspace id → {hub, name, d}
  let lastSessions = [];
  const checks = new Map(); // origin → in-flight "still signed in?" check
  // The last invite made or resent per team, in memory only: "Email it" drafts from this, not from the page.
  const minted = new Map(); // workspace id → {id, email, link, code, team}
  const outs = new Map(); // origin → in-flight sign-out cleanup

  const hubTrusted = (h) => !!h && (store.knows(h) || trustedHub === h);
  const activeTeam = () => { const w = store.active(); return w.kind === 'team' ? w : null; };
  // A team action carries the team the page rendered; it runs only on that one.
  const renderedTeam = (wsId) => { const w = activeTeam(); return w && w.id === wsId ? w : null; };
  const hubByHost = (host) => store.hubs().find((h) => hostOf(h) === host) ?? null;
  // A bare host reads back as https; anything else (the dev mock) needs its scheme.
  const prefill = (origin) => (!origin ? '' : origin.startsWith('https://') ? hostOf(origin) : origin);

  function show(screen, { notice = null, alert = null } = {}) {
    if (delStep?.team && screen !== 'team') dropDeleteStep();
    acct.screen = screen;
    acct.notice = notice;
    acct.alert = alert;
    ui.show(screen);
  }

  function cancelOAuth() {
    const r = oauthRun;
    oauthRun = null;
    r?.run.cancel();
  }

  function cancelDeleteRun() {
    const r = delRun;
    delRun = null;
    r?.run.cancel();
  }

  function dropDeleteStep() {
    cancelDeleteRun();
    delStep = null;
  }

  /** "Confirm it's you with Google/GitHub" before deleting: one at a time; a new one replaces the old. */
  function beginDeleteCheck(step, provider) {
    cancelDeleteRun();
    step.confirmed = null;
    // A team's check names its team, so the hub spends it on that team only (and never on the account).
    const run = startProviderSignIn({ client: clientFor(step.hub), provider, ...(step.team ? { purpose: 'delete_team', teamId: step.team.teamId } : { purpose: 'delete' }), openExternal: openBrowser, brand: BRAND.NAME, allowOrigins: oauthAllowOrigins, log, ...(oauthTimeoutMs ? { timeoutMs: oauthTimeoutMs } : {}) });
    const me = { hub: step.hub, step, provider, run };
    const screen = step.team ? 'team' : 'account';
    me.done = run.done.then((r) => {
      if (delRun !== me) return r;
      delRun = null;
      if (r.ok && delStep === step) step.confirmed = { provider, flowId: r.flowId, until: r.stepupUntil };
      if (acct.screen === screen && !r.cancelled) show(screen, r.ok ? { notice: `Confirmed with ${PROVIDER_NAME[provider]}.` } : { alert: r.error });
      return r;
    });
    delRun = me;
    return me.done;
  }

  /** Where a check stands; an expired confirmation is dropped here. */
  function checkState(step) {
    const base = { providers: step.providers.map((p) => ({ id: p, name: PROVIDER_NAME[p] })) };
    if (delRun?.step === step) return { ...base, phase: 'browser', provider: PROVIDER_NAME[delRun.provider] };
    const c = step.confirmed;
    if (c && now() < c.until) return { ...base, phase: 'confirmed', provider: c.provider ? PROVIDER_NAME[c.provider] : 'the emailed code', secondsLeft: Math.ceil((c.until - now()) / 1000) };
    if (c) { step.confirmed = null; return { ...base, phase: 'choose', expired: true }; }
    return { ...base, phase: 'choose' };
  }

  /** The account page's check. */
  function deleteCheckState() {
    if (!delStep || delStep.team || delStep.hub !== acct.hub) return null;
    return checkState(delStep);
  }

  /** The step for this team as the page should draw it; one for another team, hub or person is dropped. Expiry starts over. */
  function teamDeleteState(ws) {
    const st = delStep;
    if (!st?.team) return null;
    if (st.hub !== ws.hub || st.team.wsId !== ws.id || st.team.user !== (userOf(ws.hub)?.id ?? null)) { dropDeleteStep(); return null; }
    const c = checkState(st);
    if (c.expired) { dropDeleteStep(); return { expired: true }; }
    if (st.via === 'email') return { via: 'email', email: st.email, phase: c.phase === 'confirmed' ? 'confirmed' : 'code', ...(c.phase === 'confirmed' ? { provider: c.provider, secondsLeft: c.secondsLeft } : {}) };
    return { via: 'provider', ...c };
  }

  /** The step an action on the team screen may use: only one made for the team the page rendered. */
  function teamStepFor(wsId) {
    const ws = renderedTeam(wsId);
    if (!ws) return { ws: null, st: null };
    const d = teamDeleteState(ws);
    return { ws, st: d && !d.expired ? delStep : null, expired: !!d?.expired };
  }

  /** "Continue with Google/GitHub": one at a time; a new one (or leaving the screen) cancels the old. */
  function beginOAuth(origin, provider) {
    cancelOAuth();
    const run = startProviderSignIn({ client: clientFor(origin), provider, device: deviceInfo(), openExternal: openBrowser, brand: BRAND.NAME, allowOrigins: oauthAllowOrigins, log, ...(oauthTimeoutMs ? { timeoutMs: oauthTimeoutMs } : {}) });
    const me = { hub: origin, provider, run };
    me.done = run.done.then(async (r) => {
      if (oauthRun !== me) return r;
      oauthRun = null;
      if (r.ok) {
        log('signed in to team hub', { host: hostOf(origin), via: provider });
        await afterSignIn(origin);
      } else if (!r.cancelled) show('email', { alert: r.error });
      return r;
    });
    oauthRun = me;
    show('browser');
    return me.done;
  }

  // A fresh GET /api/account: the switcher's teams, and a runner only where this Mac may still run one.
  function accountSeen(origin, r) {
    accounts.set(origin, r);
    store.setTeams(origin, r);
    pruneDevices(origin);
    ui.pushState();
  }

  async function refreshAccount(origin) {
    const r = await clientFor(origin).me();
    if (r.ok) accountSeen(origin, r);
    return r;
  }

  // ── this Mac as a runner, per team ──────────────────────────────────────

  function deviceFor(ws) {
    const e = devices.get(ws.id);
    if (e) return e.d;
    const d = makeDevice(ws, {
      onStatus: (st) => {
        // 4401 may mean this install was signed out, 4403 that the team or our place in it changed: ask the hub.
        if (st?.ended) checkSignedIn(ws.hub);
        ui.devicesChanged();
      },
    });
    d.setPresence(store.sharesPresence(ws.hub), lastSessions, { shareSummaries: store.sharesSummaries(ws.hub) });
    devices.set(ws.id, { hub: ws.hub, name: ws.name, d });
    return d;
  }

  /**
   * A team that left the account (deleted, or we were removed) or where we are now a viewer: its runner
   * stops and its sealed token goes, loaded this run or not. The hub has already revoked or refused it.
   */
  function pruneDevices(origin) {
    const runs = (w) => w && w.kind === 'team' && w.hub === origin && w.role !== 'viewer';
    for (const [id, e] of [...devices]) {
      if (e.hub !== origin || runs(store.get(id))) continue;
      devices.delete(id);
      e.d.discard().catch((err) => log('runner stop failed', err.message));
    }
    discardDeviceFiles(origin, { keep: store.list().filter(runs).map((w) => w.teamId) });
    ui.devicesChanged();
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
    if (delStep?.hub === origin) dropDeleteStep();
    for (const id of minted.keys()) if (id.startsWith(`team:${hostOf(origin)}:`)) minted.delete(id);
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
      if (r.ok) accountSeen(origin, r); else if (r.signedOut) await signedOutOf(origin, { tell: true });
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
    const base = { ok: true, brand: { name: BRAND.NAME, copy: BRAND.COPY, defaultHost: hostOf(BRAND.DEFAULT_HUB) }, screen, notice: acct.notice, alert: acct.alert, host: acct.hub ? hostOf(acct.hub) : null, lastHub: prefill(store.lastHub() ?? BRAND.DEFAULT_HUB), signedInHubs: store.hubs().filter(signedIn).map(hostOf) };
    acct.notice = null;
    acct.alert = null;
    if (screen === 'hub') return { ...base, forInvite: !!pendingInvite };
    if (screen === 'email') {
      // Nothing is asked of a hub the member hasn't confirmed, this included.
      const m = hubTrusted(acct.hub) ? await clientFor(acct.hub).methods() : { ok: false, error: 'Start again: enter the team hub address.' };
      return { ...base, forInvite: !!pendingInvite, email: acct.hub ? (userOf(acct.hub)?.email ?? '') : '', methods: m.ok ? { google: m.google, github: m.github, email: m.email } : null, methodsError: m.ok ? null : m.error };
    }
    if (screen === 'integrations') return { ...base, connectors: connectorRows() };
    if (screen === 'browser') return { ...base, provider: oauthRun?.provider ?? null };
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
      const [m, t] = await Promise.all([c.listMembers(ws.teamId), c.getTeam(ws.teamId)]);
      const canManage = ['owner', 'admin'].includes(ws.role);
      const inv = canManage ? await c.listInvites(ws.teamId) : { ok: true, invites: [] };
      // Without a mailer the owner confirms it's them with Google/GitHub instead of an emailed code.
      const noMail = ws.role === 'owner' ? await c.methods().then((mm) => mm.ok && !mm.email) : false;
      const del = ws.role === 'owner' ? teamDeleteState(ws) : null;
      if (del?.expired) base.notice = 'That check ran out. Type the name and confirm it’s you again.';
      const meId = userOf(ws.hub)?.id ?? null;
      const members = (m.members ?? []).map((x) => ({ id: String(x.member_id ?? x.id), name: String(x.display_name ?? ''), email: String(x.email ?? ''), role: String(x.role), you: meId != null && String(x.user_id) === String(meId) }));
      const en = await c.listEnrolments(ws.teamId);
      // Who may revoke is the hub's rule (admins and owners, or your own); the page only hides what would be refused.
      const runners = en.ok ? en.enrolments.filter((e) => !e.revoked).slice(0, 20).map((e) => ({ id: e.id, name: e.name, person: e.userName, online: e.online, lastSeenAt: e.lastSeenAt, current: e.current, canRevoke: canManage || (meId != null && e.userId === String(meId)) })) : null;
      return { ...base, host: hostOf(ws.hub), team: { id: ws.id, name: ws.name, role: ws.role, slug: t.ok ? String(t.team?.slug ?? '') : null, boards: t.ok ? Number(t.counts?.boards ?? 0) : null, deleteVia: noMail ? 'provider' : 'email', deleteStep: del?.expired ? null : del }, canManage, isOwner: ws.role === 'owner', members, runners, invites: (inv.invites ?? []).map((i) => ({ id: String(i.id), email: String(i.email), role: String(i.role), expires: String(i.expires_at ?? '') })), error: m.ok ? (inv.ok ? null : inv.error) : m.error };
    }
    if (screen === 'account') {
      const check = acct.deleting ? deleteCheckState() : null;
      if (check?.expired) base.notice = 'That check ran out. Confirm it’s you again.';
      return { ...base, deleting: acct.deleting && acct.hub ? hostOf(acct.hub) : null, deleteCheck: check, accounts: store.hubs().filter(signedIn).map((h) => { const u = userOf(h) ?? {}; return { host: hostOf(h), name: String(u.display_name ?? ''), email: String(u.email ?? '') }; }) };
    }
    if (screen === 'thismac') {
      const hubs = store.hubs().filter(signedIn).map((h) => ({
        host: hostOf(h),
        share: store.sharesPresence(h),
        summaries: store.wantsSummaries(h),
        teams: store.list().filter((w) => w.kind === 'team' && w.hub === h).map((w) => {
          const st = devices.has(w.id) || hasDeviceFile(w) ? deviceFor(w).status() : { enrolled: false, enabled: false, runner: { state: 'off' }, parked: 0 };
          return { id: w.id, name: w.name, role: w.role, enabled: st.enabled, enrolled: st.enrolled, state: st.runner.state, detail: st.runner.detail, ended: st.ended ?? null, parked: st.parked, parkedPending: st.parkedPending ?? 0 };
        }),
      }));
      return { ...base, hubs };
    }
    return base;
  }

  function inviteMade(ws, r, notice) {
    const id = String(r.invite?.id ?? '');
    const email = String(r.invite?.email ?? '');
    minted.set(ws.id, { id, email, link: r.link, code: r.code, team: ws.name });
    return { ok: true, notice, invite: { id, email, link: r.link, code: r.code } };
  }

  // ── actions (one per account-page button or form) ───────────────────────

  const ACCT = {
    state: () => screenState(),
    go(screen) {
      if (!PAGE_SCREENS.has(screen)) return { ok: false };
      cancelOAuth();
      cancelDeleteRun();
      if (screen === 'hub' || screen === 'email') { acct.deleting = false; dropDeleteStep(); }
      if (screen === 'join') {
        if (pendingInvite && !hubTrusted(pendingInvite.hub)) pendingInvite = null;
        if (!pendingInvite) acct.hub = null;
      }
      show(screen);
      return { ok: true };
    },
    async hub(input) {
      cancelOAuth();
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
    async oauth(provider) {
      const origin = acct.hub;
      if (!hubTrusted(origin)) return { ok: false, error: 'Start again: enter the team hub address.' };
      if (!PROVIDERS.includes(provider)) return { ok: false, error: 'Pick Google or GitHub.' };
      beginOAuth(origin, provider);
      return { ok: true };
    },
    // The signed-out pages' "Continue with Google/GitHub": reach the default hub exactly as the hub
    // screen's Continue does, then start the same provider sign-in the email screen's button starts.
    async signInWith(provider) {
      if (!PROVIDERS.includes(provider)) return { ok: false, error: 'Pick Google or GitHub.' };
      const r = await ACCT.hub(BRAND.DEFAULT_HUB);
      if (!r.ok || acct.screen !== 'email' || !hubTrusted(acct.hub)) return r;
      beginOAuth(acct.hub, provider);
      return { ok: true };
    },
    async cancelOAuth() {
      cancelOAuth();
      show('email');
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
      return inviteMade(ws, r, 'Invite created. Share the link or the code.');
    },
    async resendInvite(wsId, id) {
      const ws = renderedTeam(wsId);
      if (!ws) return TEAM_CHANGED;
      const r = await clientFor(ws.hub).resendInvite(ws.teamId, id);
      if (!r.ok) return r;
      return inviteMade(ws, r, 'New link and code created. The old ones no longer work.');
    },
    async emailInvite(wsId, inviteId) {
      const ws = renderedTeam(wsId);
      if (!ws) return TEAM_CHANGED;
      const m = minted.get(ws.id);
      if (!m || m.id !== inviteId) return { ok: false, error: 'That link is no longer shown here. Make a new one with Resend.' };
      const url = inviteMailto({ to: m.email, team: m.team, link: m.link, code: m.code, brand: BRAND.NAME });
      if (!url) return { ok: false, error: 'Couldn’t start an email for that invite.' };
      ui.openMail(url);
      return { ok: true };
    },
    async renameTeam(wsId, name) {
      const ws = renderedTeam(wsId);
      if (!ws) return TEAM_CHANGED;
      const r = await clientFor(ws.hub).renameTeam(ws.teamId, name);
      if (!r.ok) return r;
      await refreshAccount(ws.hub);
      return { ok: true, notice: 'Team renamed.' };
    },
    /** Delete team, step 1: the owner types the slug, then an emailed code (or Google/GitHub without a mailer). */
    async teamDeleteStart(wsId, typed) {
      const ws = renderedTeam(wsId);
      if (!ws) return TEAM_CHANGED;
      if (ws.role !== 'owner') return { ok: false, error: 'Only an owner can delete the team.' };
      const c = clientFor(ws.hub);
      // Checked against the hub's slug, not the page's, before anything is asked of the hub.
      const t = await c.getTeam(ws.teamId);
      if (!t.ok) return t;
      const slug = String(t.team?.slug ?? '');
      if (!slug || String(typed).trim() !== slug) return { ok: false, error: SLUG_MISMATCH };
      const m = await c.methods();
      if (!m.ok) return m;
      const step = { hub: ws.hub, team: { wsId: ws.id, teamId: ws.teamId, slug, user: userOf(ws.hub)?.id ?? null }, via: m.email ? 'email' : 'provider', providers: [], confirmed: null };
      if (step.via === 'provider') {
        const a = await c.me();
        if (!a.ok) return a;
        step.providers = deleteProviders(m, a);
        if (!step.providers.length) return { ok: false, error: `${hostOf(ws.hub)} can’t check it’s you: it has no email, Google or GitHub sign-in. Ask whoever runs it to delete the team.` };
      } else {
        const r = await c.startTeamDelete();
        if (!r.ok) return r;
        step.flowId = r.flowId;
        step.email = r.email;
      }
      if (!renderedTeam(wsId) || (userOf(ws.hub)?.id ?? null) !== step.team.user) return TEAM_CHANGED;
      dropDeleteStep();
      acct.deleting = false;
      delStep = step;
      return step.via === 'email' ? { ok: true, email: step.email } : { ok: true, via: 'provider' };
    },
    async teamDeleteResend(wsId) {
      const { ws, st } = teamStepFor(wsId);
      if (!ws) return TEAM_CHANGED;
      if (!st || st.via !== 'email') return { ok: false, error: 'Start again: type the team’s name.' };
      const r = await clientFor(ws.hub).startTeamDelete();
      if (!r.ok) return r;
      if (delStep !== st) return { ok: false, error: 'Start again: type the team’s name.' };
      st.flowId = r.flowId;
      st.email = r.email;
      st.confirmed = null;
      return { ok: true, notice: `We sent a new code to ${r.email ?? 'your email'}.` };
    },
    async teamDeleteCode(wsId, code) {
      const { ws, st } = teamStepFor(wsId);
      if (!ws) return TEAM_CHANGED;
      if (!st || st.via !== 'email') return { ok: false, error: 'Start again: type the team’s name.' };
      const flowId = st.flowId;
      const r = await clientFor(ws.hub).verifyTeamDelete(flowId, code);
      if (!r.ok) return r;
      // A code verified for a step that has since been replaced or dropped confirms nothing.
      if (delStep !== st || st.flowId !== flowId) return { ok: false, error: 'Start again: type the team’s name.' };
      st.confirmed = { flowId, until: r.stepupUntil };
      return { ok: true };
    },
    async teamDeleteOAuth(wsId, provider) {
      const { ws, st } = teamStepFor(wsId);
      if (!ws) return TEAM_CHANGED;
      if (!st || st.via !== 'provider' || !signedIn(ws.hub)) return { ok: false, error: 'Start again: type the team’s name.' };
      if (!st.providers.includes(provider)) return { ok: false, error: 'Pick Google or GitHub.' };
      beginDeleteCheck(st, provider);
      return { ok: true };
    },
    /** Spends the confirmed step on this team only; a failed delete keeps it for another try. */
    async deleteTeam(wsId) {
      const { ws, st, expired } = teamStepFor(wsId);
      if (!ws) return TEAM_CHANGED;
      if (expired) return { ok: false, stepUp: true, error: 'That check ran out. Type the name and confirm it’s you again.' };
      const c = st?.confirmed;
      if (!c || delRun?.step === st) return { ok: false, stepUp: true, error: 'Confirm it’s you first.' };
      const r = await clientFor(ws.hub).deleteTeam(ws.teamId, { confirmSlug: st.team.slug, flowId: c.flowId });
      if (!r.ok) {
        if (r.stepUp && delStep === st) dropDeleteStep();
        return r;
      }
      if (delStep === st) dropDeleteStep();
      minted.delete(ws.id);
      // The hub revoked its runners; this Mac's stops now, not on the next look at the account.
      const e = devices.get(ws.id);
      devices.delete(ws.id);
      if (e) await e.d.discard().catch((err) => log('runner stop failed', err.message));
      else if (hasDeviceFile(ws)) await makeDevice(ws, { onStatus: () => {} }).discard().catch(() => {});
      await refreshAccount(ws.hub);
      show('account', { notice: `${ws.name} was deleted.` });
      return { ok: true };
    },
    async addBoard(wsId, name) {
      const ws = renderedTeam(wsId);
      if (!ws) return TEAM_CHANGED;
      const r = await clientFor(ws.hub).addBoard(ws.teamId, name);
      return r.ok ? { ok: true, notice: `Added the ${String(r.board?.name ?? name).slice(0, 60)} board.` } : r;
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
      if (INVITE_CODE_RE.test(String(code ?? '').trim())) return ACCT.acceptCode(code);
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
    // The mail's XXXX-XXXX code works only for the signed-in, verified address, so it goes to a hub already signed in to.
    async acceptCode(code) {
      const signedInHubs = store.hubs().filter(signedIn);
      const origin = [acct.hub, activeTeam()?.hub, store.lastHub()].find((h) => h && signedIn(h)) ?? (signedInHubs.length === 1 ? signedInHubs[0] : null);
      if (!origin) return { ok: false, error: 'Sign in first, then enter the code.' };
      return joined(origin, await clientFor(origin).acceptInvite({ code }));
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
      const c = clientFor(origin);
      const m = await c.methods();
      dropDeleteStep();
      // No mailer, no emailed code: Google or GitHub confirms it's you instead. A hub that can't say
      // keeps the emailed code, as before.
      if (m.ok && !m.email) {
        const a = await c.me();
        if (!a.ok) return a;
        const providers = deleteProviders(m, a);
        if (!providers.length) return { ok: false, error: `${host} can’t check it’s you: it has no email, Google or GitHub sign-in. Ask whoever runs it to delete your account.` };
        acct.hub = origin;
        acct.deleting = true;
        delStep = { hub: origin, providers, confirmed: null };
        return { ok: true, via: 'provider' };
      }
      const r = await c.startDelete();
      if (!r.ok) return r;
      acct.hub = origin;
      acct.deleting = true;
      return { ok: true, email: r.email };
    },
    async deleteOAuth(provider) {
      const st = delStep;
      if (!acct.deleting || !st || st.team || st.hub !== acct.hub || !signedIn(st.hub)) return { ok: false, error: 'Start again: choose Delete account.' };
      if (!st.providers.includes(provider)) return { ok: false, error: 'Pick Google or GitHub.' };
      beginDeleteCheck(st, provider);
      return { ok: true };
    },
    async cancelDeleteOAuth() { cancelDeleteRun(); return { ok: true }; },
    async deleteConfirm(code) {
      const origin = acct.hub;
      if (!origin || !acct.deleting) return { ok: false, error: 'Ask for a new code first.' };
      let r;
      if (delStep && !delStep.team && delStep.hub === origin) {
        const c = delStep.confirmed;
        if (!c || delRun) return { ok: false, stepUp: true, error: 'Confirm it’s you first.' };
        if (now() >= c.until) { delStep.confirmed = null; return { ok: false, stepUp: true, error: 'That check ran out. Confirm it’s you again.' }; }
        r = await clientFor(origin).deleteAccountWith(c.flowId);
        if (!r.ok && r.stepUp && delStep?.hub === origin) delStep.confirmed = null;
      } else r = await clientFor(origin).deleteAccount(code);
      if (!r.ok) return r;
      acct.deleting = false;
      dropDeleteStep();
      await signedOutOf(origin);
      show('account', { notice: 'Your account was deleted.' });
      return { ok: true };
    },
    async cancelDelete() { acct.deleting = false; dropDeleteStep(); return { ok: true }; },
    /** The This Mac switch for a team: on enrols this install (POST enrol), off unenrols it (DELETE enrol). */
    async runner(wsId, on) {
      const ws = store.get(wsId);
      if (ws?.kind !== 'team' || !signedIn(ws.hub)) return { ok: false };
      if (on && ws.role === 'viewer') return { ok: false, error: 'Viewers can’t run cards.' };
      const d = deviceFor(ws);
      const r = on ? await d.enable({ name: deviceInfo().deviceName ?? 'Mac' }) : await d.disable();
      ui.pushState();
      return r;
    },
    /** Remove one of the team's runners (the list on the team screen); this Mac's own stops here too. */
    async revokeRunner(wsId, enrollmentId) {
      const ws = renderedTeam(wsId);
      if (!ws) return TEAM_CHANGED;
      const c = clientFor(ws.hub);
      const list = await c.listEnrolments(ws.teamId);
      if (!list.ok) return list;
      const row = list.enrolments.find((e) => e.id === enrollmentId && !e.revoked);
      if (!row) return { ok: false, error: 'That runner is already gone.' };
      const r = await c.revokeEnrolment(ws.teamId, enrollmentId);
      if (!r.ok) return r;
      if (row.current && (devices.has(ws.id) || hasDeviceFile(ws))) await deviceFor(ws).discard();
      ui.devicesChanged();
      return { ok: true, notice: row.current ? 'This Mac no longer runs cards for this team.' : `${row.name || 'That Mac'} no longer runs cards for this team.` };
    },
    async presence(host, on) {
      const origin = hubByHost(host);
      if (!origin || !store.setSharesPresence(origin, on)) return { ok: false };
      for (const e of devices.values()) if (e.hub === origin) e.d.setPresence(on, lastSessions, { shareSummaries: store.sharesSummaries(origin) });
      return { ok: true };
    },
    async summaries(host, on) {
      const origin = hubByHost(host);
      if (!origin || !store.setSharesSummaries(origin, on)) return { ok: false };
      for (const e of devices.values()) if (e.hub === origin) e.d.setPresence(store.sharesPresence(origin), lastSessions, { shareSummaries: store.sharesSummaries(origin) });
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
    /** Tests and the dev walk: the provider sign-in in progress (its result), or null. */
    pendingOAuth: () => oauthRun?.done ?? null,
    /** Tests: the account- or team-deletion check in progress (its result), or null. */
    pendingDeleteCheck: () => delRun?.done ?? null,
    /** The window left the account pages (a board or another page): a team's delete check goes. */
    leftAccountPages() { if (delStep?.team) dropDeleteStep(); },
    /** The sidebar's workspace-menu actions. */
    startFlow(which) {
      cancelOAuth();
      cancelDeleteRun();
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
      for (const e of devices.values()) e.d.setPresence(store.sharesPresence(e.hub), lastSessions, { shareSummaries: store.sharesSummaries(e.hub) });
    },
    /** Names of the teams this Mac is running cards for right now. */
    runningTeams: () => [...devices.entries()].filter(([, e]) => e.d.running()).map(([id, e]) => store.get(id)?.name ?? e.name),
    stopDevices: () => { cancelOAuth(); cancelDeleteRun(); return Promise.all([...devices.values()].map((e) => e.d.stop())); },
  };
}

module.exports = { createAccountFlow, clearHubSessions, PAGE_SCREENS, ACCT_ARGS };
