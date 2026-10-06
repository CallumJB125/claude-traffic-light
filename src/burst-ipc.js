'use strict';

// All Burst wiring for main.js: IPC handlers, the cached status the tray menu
// reads, and the consent dialog that guards every action. burst-client is
// required only on macOS, so Windows and Linux never load it.

const path = require('node:path');
const os = require('node:os');
const { createProbeBackoff } = require('./probe-backoff.js');
const View = require('./burst-view.js');
const Actions = require('./burst-actions.js');

const POLL_BASE_MS = 5000;
const POLL_MAX_MS = 60000;
const TRAY_REFRESH_MS = 30000;

function register({ utilityHandle, settingsOnly, chipAllowed = () => false, accountAllowed = () => false, isMac, dialog, shell, scriptDir, home = os.homedir(), launch, client: injected, log = () => {} }) {
  const platform = isMac ? 'darwin' : 'other';
  const client = isMac ? (injected || require('./burst-client.js').createBurstClient({ home })) : null;
  const backoff = createProbeBackoff({ base: POLL_BASE_MS, max: POLL_MAX_MS });
  let last = { kind: isMac ? 'unreachable' : 'unsupported' };
  let lastView = View.statusView(last, { platform });
  let inflight = null;
  let trayAt = -Infinity;

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
    if (kind === 'open-dashboard') {
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

  // Widget and Usage header: the chip only, never the card's actions or anything raw. Null on other platforms.
  utilityHandle('burst:chip', chipAllowed, async () => {
    if (!isMac) return { chip: null, nextPollMs: 0 };
    const v = await refresh();
    return { chip: v.chip, nextPollMs: backoff.gap };
  });

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
  };
}

module.exports = { register, scriptDirFor: (userData) => path.join(userData, 'burst-scripts') };
