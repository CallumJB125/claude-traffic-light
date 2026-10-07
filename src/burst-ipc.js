'use strict';

// All Burst wiring for main.js: IPC handlers, the cached status the tray menu
// reads, and the consent dialog that guards every action. burst-client is
// required only on macOS, so Windows and Linux never load it.

const path = require('node:path');
const os = require('node:os');
const { createProbeBackoff } = require('./probe-backoff.js');
const fs = require('node:fs');
const View = require('./burst-view.js');
const Spend = require('./burst-spend.js');
const Handover = require('./burst-handover.js');
const Actions = require('./burst-actions.js');

const POLL_BASE_MS = 5000;
const POLL_MAX_MS = 60000;
const TRAY_REFRESH_MS = 30000;
const HANDOVER_TTL_MS = 60000;
const BOARD_TICK_MS = 60000;

function register({ utilityHandle, settingsOnly, chipAllowed = () => false, usageAllowed = () => false, sessionsAllowed = () => false, accountAllowed = () => false, stateFile = null, hubSend = null, runner = null, isMac, dialog, shell, scriptDir, home = os.homedir(), launch, client: injected, log = () => {} }) {
  const platform = isMac ? 'darwin' : 'other';
  const client = isMac ? (injected || require('./burst-client.js').createBurstClient({ home })) : null;
  const backoff = createProbeBackoff({ base: POLL_BASE_MS, max: POLL_MAX_MS });
  let last = { kind: isMac ? 'unreachable' : 'unsupported' };
  let lastView = View.statusView(last, { platform });
  let inflight = null;
  let trayAt = -Infinity;
  let opener = null;

  async function refresh(force = false) {
    if (!isMac) return lastView;
    if (!force && !backoff.due(Date.now())) return lastView;
    inflight = inflight || client.detect().then((d) => {
      last = d;
      lastView = View.statusView(d, { platform });
      backoff.probed({ ok: d.kind === 'present' || d.kind === 'not_installed', why: d.kind }, Date.now());
      return lastView;
    }).catch((e) => { log('[burst] detect failed', e && e.code); return lastView; }).finally(() => { inflight = null; });
    return inflight;
  }

  const modeOf = (mode) => (Actions.MODES.includes(mode) ? mode : (last.state && last.state.mode) || 'base-url');

  async function consentFor(kind, mode) {
    const m = modeOf(mode);
    const { display } = kind === 'update' && viaApi() ? { display: 'Burst opens its own Terminal window and updates itself.' } : Actions.buildScript(kind, { home, mode: m });
    return View.consent(kind, { mode: m, command: display });
  }

  const viaApi = () => !!(last.kind === 'present' && last.capabilities && last.capabilities.upgradeStatus && last.upgrade && last.upgrade.canUpgrade);

  // Native dialog, in main: the renderer cannot skip it.
  async function confirm(c) {
    const lines = [...c.what, '', ...(c.changes.length ? [c.changesHeading, ...c.changes.map((x) => `- ${x}`), ''] : []), ...(c.terms ? [c.terms, `Anthropic Consumer Terms: ${c.termsUrl}`, ''] : []), c.undo, '', `Terminal will run: ${c.command}`];
    const r = await dialog.showMessageBox({ type: 'warning', title: c.title, message: c.title, detail: lines.join('\n'), buttons: ['Cancel', c.title], defaultId: 0, cancelId: 0, noLink: true });
    return r.response === 1;
  }

  async function act(kind, mode) {
    if (!isMac) return { ok: false, error: View.MAC_ONLY };
    // The dashboard lives in Plexiform's Usage optimiser page; the browser is the secondary way in.
    if (kind === 'open-dashboard' && opener) { opener(); return { ok: true }; }
    if (kind === 'open-dashboard' || kind === 'open-browser') {
      const url = last.kind === 'present' ? client.adminUrl() : null;
      if (!url) return { ok: false, error: 'Burst is not answering.' };
      await shell.openExternal(url); // privacy-flow: burst-dashboard
      return { ok: true };
    }
    if (!Actions.KINDS.includes(kind)) return { ok: false, error: 'Unknown action.' };
    // `kind` was just matched against the list, so a bad mode only falls back to the current one.
    const m = modeOf(mode);
    let c;
    try { c = await consentFor(kind, m); } catch (e) { return { ok: false, error: e.code === 'no_checkout' ? 'Plexiform could not find a Claude Burst checkout in ~/claude-burst.' : 'Could not prepare that action.' }; }
    if (!await confirm(c)) return { ok: false, cancelled: true };
    try {
      if (kind === 'update' && viaApi()) await client.requestUpgrade();
      else await Actions.runInTerminal(kind, { home, mode: m, dir: scriptDir, launch });
    } catch (e) { return { ok: false, error: 'Could not start Terminal.' }; }
    backoff.reset();
    return { ok: true };
  }

  const card = (e) => settingsOnly(e) || accountAllowed(e);
  utilityHandle('burst:status', card, async () => ({ ...(await refresh()), nextPollMs: isMac ? backoff.gap : 0 }));
  utilityHandle('burst:consent-text', card, async (_e, kind, mode) => {
    if (!isMac) return null;
    try { return await consentFor(kind, mode); } catch { return null; }
  });
  utilityHandle('burst:action', card, async (_e, req) => act(req && req.kind, req && req.mode));
  utilityHandle('burst:test', card, async () => {
    if (!isMac || last.kind !== 'present' || !last.capabilities.testConnection) return { ok: false, detail: 'Not available.' };
    try { return await client.testConnection(); } catch { return { ok: false, detail: 'Burst did not answer.' }; }
  });

  // Pauseless compaction switch. Turning it on needs the renderer's inline confirm (`confirmed`),
  // which is re-checked here; turning it off or changing mode never does.
  utilityHandle('burst:set-compaction', card, async (_e, req) => {
    if (!isMac) return { ok: false, error: View.MAC_ONLY };
    const r = req && typeof req === 'object' ? req : {};
    const cur = last.kind === 'present' && last.state.compaction.pauseless;
    if (!cur) return { ok: false, error: 'Burst is not answering with a compaction setting.' };
    if (typeof r.enabled !== 'boolean' || (r.mode !== undefined && r.mode !== 'fixed' && r.mode !== 'intelligent')) return { ok: false, error: 'Bad request.' };
    if (r.enabled && !cur.enabled && r.confirmed !== true) return { ok: false, needsConfirm: true, text: View.COMPACTION_ON_CONFIRM };
    try { await client.setCompaction({ enabled: r.enabled, mode: r.mode }); } catch (e) {
      log('[burst] set compaction failed', e && e.code);
      const why = e.code === 'http' && e.detail ? `Burst refused it: ${e.detail}` : e.code === 'timeout' ? 'Burst did not answer in time.' : e.code === 'bad_config' ? `${e.message}. Nothing was changed.` : 'Could not change Burst\'s compaction setting. Nothing was changed.';
      return { ok: false, error: why };
    }
    backoff.reset();
    const view = await refresh(true);
    return { ok: true, view, note: r.enabled ? View.COMPACTION_OWN_OFF : '' };
  });

  // Widget and Usage header: the chip only, never the card's actions or anything raw. Null on other platforms.
  utilityHandle('burst:chip', chipAllowed, async () => {
    if (!isMac) return { chip: null, nextPollMs: 0 };
    const v = await refresh();
    return { chip: v.chip, nextPollMs: backoff.gap };
  });

  // Usage page: the "Through Burst" view model only, never a raw response.
  utilityHandle('burst:usage', usageAllowed, async (_e, range) => {
    if (!isMac || last.kind !== 'present' || !last.capabilities.usage) return { view: null, nextPollMs: isMac ? backoff.gap : 0 };
    try { return { view: Spend.throughBurstView(await client.usage({ range })), nextPollMs: backoff.gap }; } catch { return { view: null, nextPollMs: backoff.gap }; }
  });

  // Sessions page: per-session compaction stats and the handover of observed Claude sessions.
  let shared = {};
  try { if (stateFile) shared = JSON.parse(fs.readFileSync(stateFile, 'utf8')).share || {}; } catch { shared = {}; }
  const handovers = new Map(); // root -> { at, content, sent }
  let audit = { at: -Infinity, roots: [] };
  const present = () => isMac && last.kind === 'present' && last.capabilities;

  async function warmHandover(root) {
    const h = handovers.get(root);
    if (h && Date.now() - h.at < HANDOVER_TTL_MS) return;
    handovers.set(root, { at: Date.now(), content: h ? h.content : '', sent: h ? h.sent : '' });
    try {
      const content = await client.handoverFile(root);
      const cur = { at: Date.now(), content, sent: h ? h.sent : '' };
      handovers.set(root, cur);
      const date = Handover.newestSection(content).date;
      if (date !== cur.sent) {
        const r = await Handover.shareToHub({ root, content, shared, send: hubSend, home });
        if (r.ok) cur.sent = date;
      }
    } catch (e) { log('[burst] handover read failed', e && e.code); }
  }
  async function warmAudit() {
    if (Date.now() - audit.at < HANDOVER_TTL_MS) return;
    audit = { ...audit, at: Date.now() };
    try { audit = { at: Date.now(), roots: await client.handoverAudit() }; } catch (e) { log('[burst] handover audit failed', e && e.code); }
  }

  utilityHandle('burst:handover-share', sessionsAllowed, async (_e, repo, on) => {
    if (typeof repo !== 'string' || !/^[0-9a-f]{16}$/.test(repo)) return { ok: false };
    if (on === true) shared = { ...shared, [repo]: true }; else { shared = { ...shared }; delete shared[repo]; }
    try { if (stateFile) fs.writeFileSync(stateFile, JSON.stringify({ share: shared }), { mode: 0o600 }); } catch (e) { log('[burst] could not save the share choice'); }
    return { ok: true };
  });

  // Synchronous, from caches: called once per Sessions snapshot row.
  function enrichSession(row) {
    const c = present();
    if (!c || !row || typeof row.sessionId !== 'string') return null;
    const out = {};
    const stat = last.state.compaction.sessions.find((x) => x.session === row.sessionId);
    if (stat) out.compaction = { compactions: stat.compactions, savedUsd: stat.savedUsd, netUsd: stat.netUsd, savedTokens: stat.savedTokens };
    const claude = row.source == null && row.ownership !== 'plexiform-owned';
    if (claude && c.handoverAudit) {
      warmAudit();
      const root = Handover.matchRoot(row.cwd, audit.roots);
      if (root) {
        warmHandover(root);
        const h = handovers.get(root);
        const view = h && Handover.localView(h.content);
        if (view) out.handover = { ...view, repo: Handover.repoKey(root), shared: shared[Handover.repoKey(root)] === true };
      }
    }
    return Object.keys(out).length ? out : null;
  }

  // Board runner: secondary spend and readiness, only while a runner is running cards.
  async function pushBoardFacts() {
    if (!isMac || !runner || !runner.live()) return;
    await refresh(true);
    if (last.kind !== 'present') { runner.send({ active: false, route: 'PRIMARY', secondaryReady: false, sessions: {} }); return; }
    let sessions = {};
    if (last.capabilities.usage) { try { sessions = Spend.secondaryBySession(await client.usage({ range: '24h' })); } catch (e) { log('[burst] board usage failed', e && e.code); } }
    runner.send({ active: last.state.active, route: last.state.route, secondaryReady: last.state.secondaryReady, sessions });
  }
  if (isMac && runner) setInterval(() => { pushBoardFacts().catch(() => {}); }, BOARD_TICK_MS).unref();

  if (isMac) refresh(true);

  return {
    // Tray: "Turn Burst off" in every state where Burst may be in Claude Code's path.
    trayItems() {
      if (!isMac) return [];
      if (Date.now() - trayAt > TRAY_REFRESH_MS) { trayAt = Date.now(); refresh(true); }
      const off = lastView.actions.find((a) => a.kind === 'off');
      if (!off) return [];
      return [{ label: 'Turn Burst off…', click: () => { act('off').then((r) => { if (r && r.error) log('[burst]', r.error); }); } }, { type: 'separator' }];
    },
    status: () => lastView,
    // For the Usage optimiser page: the last detection (version+pid handshake result) and the trusted address.
    snapshot: () => ({ d: last, url: isMac && last.kind === 'present' ? client.adminUrl() : null }),
    refresh,
    act,
    setOpener(fn) { opener = typeof fn === 'function' ? fn : null; },
    enrichSession,
    pushBoardFacts,
    compactionActive: () => !!(present() && last.state.compaction.active),
    compactionNote: () => (present() && last.state.compaction.active ? Spend.COMPACTION_NOTE : ''),
  };
}

module.exports = { register, scriptDirFor: (userData) => path.join(userData, 'burst-scripts') };
