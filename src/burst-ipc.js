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
const Codex = require('./burst-codex.js');
const Route = require('./burst-route.js');
const Requests = require('./burst-requests.js');
const Inspect = require('./burst-inspect.js');
const Snapshot = require('./burst-snapshot.js');
const ContextBreakdown = require('./context-breakdown.js');
const Tools = require('./optimiser-tools.js');

const POLL_BASE_MS = 5000;
const POLL_MAX_MS = 60000;
const TRAY_REFRESH_MS = 30000;
const HANDOVER_TTL_MS = 60000;
const BOARD_TICK_MS = 60000;
const SNAPSHOT_TICK_MS = 30000;
const EXTRA_TTL_MS = 30000;

const short = (s) => String(s).slice(0, 8);
// Consent text for every allow-listed mutation, fixed here in main. Args reach it only
// after burst-client has validated them; the renderer never supplies any wording.
const ACTIONS = Object.freeze({
  reset: { consent: () => ({ title: 'Back to Claude now', detail: 'Burst stops sending requests to your secondary provider and sends the next one to Claude (your primary). If Claude is still at its limit, Burst may move to the secondary again.' }) },
  'compaction-drop': { consent: (a) => ({ title: 'Send full history again', detail: `Burst stops using its summary for session ${short(a.session)}. That session's next request sends the whole conversation again, which uses more tokens.` }) },
  'inspect-remove': {
    consent: (a) => (a.restore === true
      ? { title: 'Put item back', detail: `This item goes back into session ${short(a.session)}'s next request.` }
      : { title: 'Leave item out', detail: `Session ${short(a.session)}'s next request leaves this item out, with a one-line note in its place. You can put it back later.` }),
  },
  'coord-message': { consent: (a) => ({ title: 'Send message', detail: `Burst queues this message for session ${short(a.session)}, which sees it at its next tool call or prompt:\n\n${a.message}` }) },
  'coord-release': { consent: (a) => ({ title: 'Hand on', detail: `${a.release}\n\nThe session that most recently changed this file now commits it, or it is free.` }) },
  trace: { consent: () => ({ title: 'Send test message', detail: 'Burst sends one tiny real request through each step (DNS, redirect, TLS, credential, route) and reports where it stops. It uses a very small part of your Claude subscription.' }) },
  'console-restart': { console: true, consent: () => ({ title: 'Restart Burst', detail: 'Burst\'s support console restarts its gateway through launchd, or starts it if it is stopped; if Burst was turned off, this turns it back on. A request in flight may fail once.' }) },
  'codex-enable': { consent: () => ({ title: 'Route Codex through Burst', detail: 'Burst adds its own block to ~/.codex/config.toml, after saving a copy of the file, so Codex sessions you start from now on send their requests through Burst. Running Codex sessions are not changed.' }) },
  'codex-disable': { consent: () => ({ title: 'Stop routing Codex through Burst', detail: 'Burst removes its block from ~/.codex/config.toml, after saving a copy of the file. Codex sessions you start from now on talk to OpenAI directly again.' }) },
  'console-diagnose': { console: true, consent: () => ({ title: 'Diagnose Burst', detail: 'Burst\'s support console opens a Terminal window and writes a diagnose report you can copy.' }) },
  // Burst v0.20 (lane C). `capability` is the detect() flag the running Burst must report; without it
  // the action answers "not supported" before any dialog. Each sentence says what changes on the Mac.
  'keep-awake': {
    capability: 'keepAwake',
    consent: (a) => (a.mode === 'off'
      ? { title: 'Let this Mac sleep', detail: 'Burst turns its keep-awake setting off in ~/.config/claude-burst/config.json and opens a Terminal window that asks for your password to put the Mac\'s power settings back (lid-awake-root.sh remove). The Mac sleeps again when the lid is shut.' }
      : { title: 'Keep this Mac awake', detail: `Burst saves keep-awake "${a.mode === 'always' ? 'always' : 'plugged in only'}"${a.idleMinutes ? ` with a ${a.idleMinutes}-minute idle limit` : ''} in ~/.config/claude-burst/config.json, turns App Nap off for Ghostty, and opens a Terminal window that asks for your password to apply the machine-wide half (lid-awake-root.sh): the Mac then stays awake with the lid shut, ${a.mode === 'always' ? 'on battery too' : 'while plugged in'}. "Let this Mac sleep" undoes it.` }),
  },
  'mod-action': {
    capability: 'mods',
    consent: (a) => ({
      install: { title: 'Install Burst\'s session mod', detail: 'Burst runs its update-mod.sh: it copies the burst-session mod into ~/.local/share/claude-burst/marketplace and installs or updates it as a Claude Code plugin (the band above the prompt and its toasts). Sessions you start from now on load it; running ones are not changed. Burst reports progress under mod status.' },
      remove: { title: 'Remove Burst\'s session mod', detail: 'Burst runs its update-mod.sh uninstall: the burst-session plugin is removed from Claude Code. Sessions you start from now on have no Burst band; running ones keep it until they end.' },
      toasts: { title: a.on ? 'Turn session toasts on' : 'Turn session toasts off', detail: `Burst saves toasts=${a.on === true} in its mod settings file (~/.config/claude-burst). Only the mod's own pop-ups inside Claude Code change; nothing else on the Mac.` },
      handoff: { title: a.on ? 'Let the mod hand off summaries' : 'Stop the mod handing off summaries', detail: `Burst saves handoff=${a.on === true} in its mod settings file (~/.config/claude-burst). This decides whether the band passes Burst's compaction summary into a session; nothing else on the Mac changes.` },
      handoff_in_path: { title: a.on ? 'Write handoffs in the repository' : 'Stop writing handoffs in the repository', detail: `Burst saves handoff_in_path=${a.on === true} in its mod settings file (~/.config/claude-burst). It decides whether the mod writes its handoff note inside the repository; nothing else on the Mac changes.` },
    }[a.action] || { title: 'Change Burst\'s mod', detail: 'Burst changes its session mod.' }),
  },
  'panel-install': {
    capability: 'mods',
    consent: (a) => (a.action === 'remove'
      ? { title: 'Remove the usage panel', detail: 'Burst runs the usage panel\'s own claude-panel-uninstall.sh from its checkout, which removes the panel\'s hooks and files from this Mac. Running Claude Code sessions keep it until they end.' }
      : { title: 'Install the usage panel', detail: 'Burst installs the Claude Code usage panel (claude-code-cost-sidebar): if no checkout exists it fetches the latest signed release into ~/.local/share/claude-burst, then runs its claude-panel-setup.sh, which adds the panel\'s hooks to Claude Code and its settings file under ~/.config. It can take a few minutes; Burst reports progress under mod status.' }),
  },
  'finder-install': {
    capability: 'finder',
    consent: (a) => (a.action === 'remove'
      ? { title: 'Remove Finder shortcuts', detail: `Burst deletes ${a.keys ? `the ${a.keys.length} ticked` : 'its'} Quick Action${a.keys && a.keys.length === 1 ? '' : 's'} from ~/Library/Services and the matching launcher scripts under ~/.local/bin. Only shortcuts Burst itself made are removed.` }
      : a.action === 'bypass'
        ? { title: a.on ? 'Skip permission prompts from these shortcuts' : 'Ask permission again from these shortcuts', detail: `Burst saves bypass ${a.on ? 'on' : 'off'} for ${(a.keys || []).join(', ')} in ~/.config/claude-burst. ${a.on ? 'Sessions started from those Finder shortcuts then run with permission prompts skipped (the tool\'s own bypass flag).' : 'Sessions started from those Finder shortcuts ask for permission as usual again.'}` }
        : { title: 'Add Finder shortcuts', detail: `Burst writes ${a.keys ? `${a.keys.length} ticked` : 'its'} Quick Action${a.keys && a.keys.length === 1 ? '' : 's'} into ~/Library/Services (they appear in Finder\'s right-click menu) and the launcher script each one runs under ~/.local/bin. They open Ghostty in the chosen folder and start the tool; nothing runs until you use one.` }),
  },
  'console-repair': { console: true, capability: 'consoleRepair', consent: () => ({ title: 'Repair Burst', detail: 'Burst\'s support console opens a Terminal window running its repair.sh: it syncs the checkout, stops stale processes on Burst\'s ports, reinstalls Burst in the mode it was in, re-arms the watchdog and the CA, and asks for your password where /etc/hosts and pf change. It asks before stopping any session.' }) },
  'console-restore-config': { console: true, capability: 'consoleRepair', consent: () => ({ title: 'Restore last good config', detail: 'Burst\'s support console puts back the last ~/.config/claude-burst/config.json that loaded, keeping the file that would not load next to it. Nothing changes if the current file loads. Restart Burst afterwards if its checks stay red.' }) },
});

// `burst:action` kinds (the renderer's vocabulary) that map onto the allow-listed mutations above.
const ACTION_KINDS = Object.freeze({
  'keep-awake': (a) => ['keep-awake', { mode: a.mode, idleMinutes: a.idleMinutes }],
  'mod-install': () => ['mod-action', { action: 'install' }],
  'mod-update': () => ['mod-action', { action: 'install' }], // Burst's install also updates
  'mod-remove': () => ['mod-action', { action: 'remove' }],
  'panel-install': () => ['panel-install', { action: 'install' }],
  'panel-update': () => ['panel-install', { action: 'install' }],
  'panel-remove': () => ['panel-install', { action: 'remove' }],
  'finder-install': (a) => ['finder-install', { action: 'install', ...(a.keys !== undefined ? { keys: a.keys } : {}) }],
  'finder-remove': (a) => ['finder-install', { action: 'remove', ...(a.keys !== undefined ? { keys: a.keys } : {}) }],
  'console-repair': () => ['console-repair', {}],
  'console-restore-config': () => ['console-restore-config', {}],
});

function register({ utilityHandle, settingsOnly, chipAllowed = () => false, usageAllowed = () => false, sessionsAllowed = () => false, accountAllowed = () => false, optimiserAllowed = () => false, aitoolsAllowed = () => false, stateFile = null, snapshotFile = null, transcriptFor = () => null, hubSend = null, runner = null, isMac, dialog, shell, scriptDir, home = os.homedir(), launch, client: injected, onView = () => {}, log = () => {} }) {
  const platform = isMac ? 'darwin' : 'other';
  const client = isMac ? (injected || require('./burst-client.js').createBurstClient({ home })) : null;
  const backoff = createProbeBackoff({ base: POLL_BASE_MS, max: POLL_MAX_MS });
  let last = { kind: isMac ? 'checking' : 'unsupported' };
  let misses = 0;
  let lastView = View.statusView(last, { platform });
  let inflight = null;
  let trayAt = -Infinity;
  let opener = null;

  async function refresh(force = false) {
    if (!isMac) return lastView;
    if (!force && !backoff.due(Date.now())) return lastView;
    inflight = inflight || client.detect().then((d) => {
      misses = d.kind === 'unreachable' ? misses + 1 : 0;
      last = d.kind === 'unreachable' ? { ...d, misses } : d;
      lastView = View.statusView(last, { platform });
      try { onView(lastView); } catch (e) { log('[burst] onView failed', e && e.message); }
      writeSnapshot().catch((e) => log('[burst] snapshot failed', e && (e.code || e.message)));
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

  async function act(kind, mode, args) {
    if (!isMac) return { ok: false, error: View.MAC_ONLY };
    if (typeof kind === 'string' && Object.prototype.hasOwnProperty.call(ACTION_KINDS, kind)) {
      const [id, input] = ACTION_KINDS[kind](args && typeof args === 'object' && !Array.isArray(args) ? args : {});
      return runAction(id, input);
    }
    // The dashboard lives in Plexiform's Usage optimiser page; the browser is the secondary way in.
    if (kind === 'retry') { backoff.reset(); await refresh(true); return { ok: true, retried: true }; }
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
  utilityHandle('burst:action', (e) => card(e) || optimiserAllowed(e), async (e, req) => (card(e) || (req && Object.prototype.hasOwnProperty.call(ACTION_KINDS, req.kind)) ? act(req && req.kind, req && req.mode, req && req.args) : { ok: false, error: 'Not available.' }));
  utilityHandle('burst:test', card, async () => {
    if (!isMac || last.kind !== 'present' || !last.capabilities.testConnection) return { ok: false, detail: 'Not available.' };
    try { return await client.testConnection(); } catch { return { ok: false, detail: 'Burst did not answer.' }; }
  });

  // Pauseless compaction switch. Turning it on needs the renderer's inline confirm (`confirmed`),
  // which is re-checked here; turning it off or changing mode never does.
  utilityHandle('burst:set-compaction', (e) => card(e) || optimiserAllowed(e), async (_e, req) => {
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

  // Usage optimiser tool list: status facts only, never the card's actions or anything raw.
  utilityHandle('burst:tools', optimiserAllowed, async () => {
    if (!isMac) return { kind: 'unsupported' };
    const v = await refresh();
    let band = null;
    let compactionVerdict = '';
    if (present()) {
      try { band = Tools.bandStatus(await fresh('modStatus', () => client.modStatus())); } catch { band = null; }
      try { const l = Spend.learnedThresholds(await fresh('intelligentCompaction', () => client.intelligentCompaction())); compactionVerdict = (l && l.repos.find((r) => r.reason) || {}).reason || ''; } catch { compactionVerdict = ''; }
    }
    return { compactionVerdict, kind: v.kind, detected: last.kind, misses: last.misses || 0, version: v.version, route: v.route, updateAvailable: v.updateAvailable, compaction: v.compaction, secondaryReady: present() ? last.state.secondaryReady === true : null, band };
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
    let codex = null;
    if (client.codex) { try { codex = Codex.codexView(await client.codex()); } catch { codex = null; } }
    let history = null;
    if (client.history) { try { history = Requests.historyView(await fresh('history', () => client.history({ days: 14 }))); } catch { history = null; } }
    try { return { view: Spend.throughBurstView(await client.usage({ range })), codex, history, nextPollMs: backoff.gap }; } catch { return { view: null, nextPollMs: backoff.gap }; }
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

  let coord = { at: -Infinity, data: null };
  async function warmCoord() {
    if (!client.coordination || Date.now() - coord.at < HANDOVER_TTL_MS) return;
    coord = { ...coord, at: Date.now() };
    try { coord = { at: Date.now(), data: await client.coordination() }; } catch { coord = { at: Date.now(), data: null }; }
  }

  // Cached extras: the support console (answers when the gateway is down), the audit,
  // settings and request metadata. Each is refreshed in the background at most every 30 s.
  const extras = new Map(); // name -> { at, value }
  function cached(name, load) {
    const c = extras.get(name);
    if (!c || Date.now() - c.at >= EXTRA_TTL_MS) {
      extras.set(name, { at: Date.now(), value: c ? c.value : null });
      Promise.resolve().then(load).then((value) => extras.set(name, { at: Date.now(), value }), (e) => { log(`[burst] ${name} failed`, e && e.code); extras.set(name, { at: Date.now(), value: null }); });
    }
    return c ? c.value : null;
  }
  async function fresh(name, load) {
    const c = extras.get(name);
    if (c && c.value !== null && Date.now() - c.at < EXTRA_TTL_MS) return c.value;
    const value = await load();
    extras.set(name, { at: Date.now(), value });
    return value;
  }

  let lastSnapshot = null;
  async function writeSnapshot() {
    if (!isMac || !snapshotFile) return;
    let requests = null;
    if (present()) { try { requests = await fresh('requests50', () => client.requests({ limit: 50 })); } catch { requests = null; } }
    if (present()) warmCoord();
    lastSnapshot = Snapshot.buildSnapshot({ detection: last, coordination: present() ? coord.data : null, requests, now: Date.now() });
    Snapshot.writeSnapshot(snapshotFile, lastSnapshot);
  }
  if (isMac && snapshotFile) setInterval(() => { refresh().catch(() => {}); }, SNAPSHOT_TICK_MS).unref();

  // Allow-listed mutations: one native consent dialog each, then exactly one POST through burst-client.
  const actions = new Map();
  function registerAction(id, { consent, run, console: viaConsole = false, capability = null }) {
    if (typeof id !== 'string' || typeof consent !== 'function' || typeof run !== 'function') throw new Error('bad action');
    actions.set(id, { consent, run, viaConsole, capability });
  }
  for (const [id, a] of Object.entries(ACTIONS)) registerAction(id, { consent: a.consent, console: a.console === true, capability: a.capability, run: (args) => client.mutate(id, args) });

  async function runAction(id, args) {
    if (!isMac) return { ok: false, error: View.MAC_ONLY };
    const a = typeof id === 'string' ? actions.get(id) : null;
    if (!a) return { ok: false, error: 'Unknown action.' };
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const spec = require('./burst-client.js').MUTATE_ALLOW[id];
    if (spec) { try { spec.body(input); } catch { return { ok: false, error: 'Bad request.' }; } }
    if (!a.viaConsole && !present()) return { ok: false, error: 'Burst is not answering.' };
    // Gateway actions are gated on the last detection; console ones are re-checked by burst-client
    // against the console's own version, since the console answers when the gateway is down.
    if (a.capability && !a.viaConsole && !present()[a.capability]) return { ok: false, unsupported: true, error: 'This Burst does not support that. Update Burst first.' };
    const c = a.consent(input);
    const r = await dialog.showMessageBox({ type: 'warning', title: c.title, message: c.title, detail: c.detail, buttons: ['Cancel', c.title], defaultId: 0, cancelId: 0, noLink: true });
    if (r.response !== 1) return { ok: false, cancelled: true };
    try {
      const out = await a.run(input);
      backoff.reset();
      refresh(true);
      return { ok: true, data: out && out.data !== undefined ? out.data : null };
    } catch (e) {
      log('[burst] action failed', id, e && e.code);
      if (e.code === 'unsupported') return { ok: false, unsupported: true, error: 'This Burst does not support that. Update Burst first.' };
      return { ok: false, error: e.code === 'http' && e.detail ? `Burst refused it: ${e.detail}` : e.code === 'timeout' ? 'Burst did not answer in time.' : e.code === 'pid_changed' ? 'Burst restarted; nothing was sent. Try again.' : 'Burst did not do that. Nothing was changed.' };
    }
  }
  const anyPage = (e) => card(e) || usageAllowed(e) || sessionsAllowed(e) || optimiserAllowed(e);
  const CODEX_ACTIONS = new Set(['codex-enable', 'codex-disable']);
  utilityHandle('burst-action', (e) => anyPage(e) || aitoolsAllowed(e), async (e, id, args) => (anyPage(e) || CODEX_ACTIONS.has(id) ? runAction(id, args) : { ok: false, error: 'Not available.' }));

  // AI tools page, Codex row: whether Codex goes through Burst. Null whenever Burst is not present.
  utilityHandle('burst:codex-routing', aitoolsAllowed, async () => {
    if (!present()) return { view: null };
    try { return { view: await client.codexRouting() }; } catch (err) { log('[burst] codex routing failed', err && err.code); return { view: null }; }
  });

  // Read-only views for the Usage optimiser and Sessions pages. Each name has its own senders.
  const optimiserOrUsage = (e) => optimiserAllowed(e) || usageAllowed(e);
  const int = (v, d) => (Number.isInteger(v) ? v : d);
  const VIEWS = {
    route: { allowed: optimiserOrUsage, get: async () => Route.routeView(last.state, await fresh('settings', () => client.settings()).catch(() => null), { now: Date.now() }) },
    requests: { allowed: (e) => optimiserOrUsage(e) || sessionsAllowed(e), get: async (a) => Requests.requestsView(await client.requests({ limit: int(a.limit, 200) }), { limit: int(a.limit, 200) }) },
    history: { allowed: optimiserOrUsage, get: async (a) => Requests.historyView(await client.history({ days: int(a.days, 14) })) },
    inspect: { allowed: sessionsAllowed, get: async (a) => Inspect.inspectView(await client.inspect({ session: a.session, engine: a.engine }), { engine: a.engine === 'codex' ? 'codex' : 'claude' }) },
    coordination: { allowed: sessionsAllowed, get: async (a) => client.coordination({ days: int(a.days, 1) }) },
    // Burst v0.20 (lane C): whitelisted by burst-client's normalizers; `{kind:'unsupported'}` on an older Burst.
    'loose-ends': { allowed: anyPage, get: () => fresh('looseEnds', () => client.looseEnds()) },
    'keep-awake': { allowed: anyPage, get: () => client.keepAwake() },
    mods: { allowed: anyPage, get: () => fresh('mods', () => client.mods()) },
    finder: { allowed: anyPage, get: () => fresh('finder', () => client.finder()) },
  };
  utilityHandle('burst:view', (e) => anyPage(e), async (e, name, args) => {
    const v = typeof name === 'string' && Object.prototype.hasOwnProperty.call(VIEWS, name) ? VIEWS[name] : null;
    if (!v || !v.allowed(e)) return { ok: false, view: null, error: 'Not available.' };
    if (!present()) return { ok: false, view: null, error: 'Burst is not answering.' };
    try {
      const view = await v.get(args && typeof args === 'object' ? args : {});
      if (view && view.kind === 'unsupported') return { ok: false, view, unsupported: true, error: 'This Burst does not support that. Update Burst first.' };
      return { ok: true, view };
    } catch (err) { log('[burst] view failed', name, err && err.code); return { ok: false, view: null, error: 'Burst did not answer.' }; }
  });

  // Standalone (any platform, no Burst): the transcript breakdown of one Claude Code session.
  utilityHandle('burst:context-breakdown', sessionsAllowed, async (_e, sessionId) => {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(sessionId)) return { view: null };
    const file = transcriptFor(sessionId);
    if (!file) return { view: null };
    try { return { view: await ContextBreakdown.breakdownFile(file) }; } catch { return { view: null }; }
  });

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
    const ctx = Codex.contextFor(last.state.contextFill, row.sessionId);
    if (ctx) out.context = ctx;
    warmCoord();
    const co = Codex.coordinationFor(coord.data, row.sessionId);
    if (co) out.coordination = co;
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
    runner.send({ ...Snapshot.boardFacts(lastSnapshot), active: last.state.active, route: last.state.route, secondaryReady: last.state.secondaryReady, sessions });
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
    // Health fix: the support console's fixed loopback address, usable even when Burst is untrusted.
    async openConsole() { if (!isMac) return { ok: false, error: View.MAC_ONLY }; await shell.openExternal('http://127.0.0.1:7789/'); /* privacy-flow: burst-dashboard */ return { ok: true }; },
    setOpener(fn) { opener = typeof fn === 'function' ? fn : null; },
    enrichSession,
    pushBoardFacts,
    registerAction,
    runAction,
    // Health (synchronous, from caches warmed in the background): the last detection and the
    // support console's status. Burst's audit stays in its own console.
    healthFacts() {
      if (!isMac || last.kind === 'unsupported' || last.kind === 'not_installed') return { detection: last, console: null };
      return { detection: last, console: cached('console', () => client.consoleDetect()) };
    },
    // This Mac and notices: scrubbed raw reads for their own normalizers; null when Burst is not present.
    async read(name) {
      const READS = { mac: () => client.mac(), automask: () => client.automask(), settings: () => client.settings(), modStatus: () => client.modStatus(), intelligentCompaction: () => client.intelligentCompaction() };
      if (!present() || !Object.prototype.hasOwnProperty.call(READS, name)) return null;
      try { return await fresh(name, READS[name]); } catch (e) { log('[burst] read failed', name, e && e.code); return null; }
    },
    compactionActive: () => !!(present() && last.state.compaction.active),
    compactionNote: () => (present() && last.state.compaction.active ? Spend.COMPACTION_NOTE : ''),
  };
}

module.exports = { register, scriptDirFor: (userData) => path.join(userData, 'burst-scripts') };
