'use strict';
// Plexiform's agent bus tools, registered by Plexiform itself for Claude Code
// and Codex (plan-agent-awareness §3.9, AW6, AW15): the bus-only profile
// (`mcp-server.js --profile bus`) under the name plexiform-bus, marked with
// PLEXIFORM_MCP=bus-v1:<channel>, recorded, and undone on request.
//
// - On while (agentAwareness.enabled || agentBus.enabled) && !mcpBusUserOff;
//   for Claude Code also only while the person has not turned Plexiform's
//   Claude integration off (mcpUserOff): that opt-out covers this entry too.
// - Claude Code: one key in ~/.claude.json through mcp-install.js (its
//   compare-and-swap write; sync fs, about 100 KB, once per start, deferred).
//   Skipped when Plexiform's full server is registered: it carries the same tools.
// - Codex: `codex mcp add` through its own CLI, re-read with `codex mcp get`,
//   plus the separate bus_session SessionStart hook in ~/.codex/hooks.json
//   (adapters/codex.js; sync fs, a few KB). Codex runs that hook only once the
//   person approves it in Codex; Plexiform never writes hook trust. Codex is
//   run only when it is OpenAI's signed binary (trustedCodex).
// - A same-named entry that is not ours, or another copy's, is reported and
//   never touched. Off removes only what the record says we added and that
//   still carries our marker.
// - The record (mcp-auto.json, 0600) holds names, times and a hash of our own
//   entry: never a copy of either config file, which can hold credentials.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const McpInstall = require('../mcp-install.js');
const CodexMcp = require('../adapters/codex-mcp.js');
const Codex = require('../adapters/codex.js');
const PeerPid = require('./peer-pid.js');
const { allowedExe } = require('./agent-awareness.js');

const NAME = McpInstall.BUS_NAME;
const hashOf = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const effective = (c) => !!c && (c.agentAwareness?.enabled !== false || c.agentBus?.enabled !== false) && c.mcpBusUserOff !== true;
const claudeOn = (c) => effective(c) && c.mcpUserOff !== true;

// The codex main runs (findCodexBin()), only when it is the real, signed binary: ~/.local/bin and Homebrew's
// bin are writable by any program running as the person, and main runs it outside any agent sandbox.
// ChatGPT.app's bin/codex is a shell script that execs the CodexCLI.app binary beside it; that binary runs instead.
async function trustedCodex(bin, { home, codexHome, run, platform = process.platform, fsp = fs.promises }) {
  if (typeof bin !== 'string' || !bin) return null;
  let real = await fsp.realpath(bin).catch(() => null);
  const launcher = real && /^(.*\/codex-cli)\/bin\/codex$/.exec(real);
  if (launcher) real = await fsp.realpath(path.join(launcher[1], 'CodexCLI.app', 'Contents', 'MacOS', 'codex')).catch(() => null);
  if (!real || !allowedExe('codex', real, { home, codexHome })) return null;
  return (await PeerPid.signedAs(run, real, 'codex', platform)) ? real : null;
}

/**
 * config(): the app config. launch: McpInstall.launch options ({packaged, execPath, appPath, dir, root}).
 * home: where ~/.claude.json and ~/.codex live (a sandbox in dev runs). codexBin(): findCodexBin().
 * codexEnv: the environment `codex` runs with (CODEX_HOME set to the sandbox in dev runs).
 */
function create({ rootDir, home, config, launch, codexBin, codexEnv = process.env, execFile, fsp = fs.promises, mcpInstall = McpInstall, codexAdapter = Codex, now = () => Date.now(), log = () => {},
  trustCodexBin = (bin) => trustedCodex(bin, { home, codexHome: codexEnv.CODEX_HOME || path.join(home, '.codex'), fsp,
    run: (file, args) => new Promise((resolve, reject) => { require('child_process').execFile(file, args, { timeout: 5000, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(String(out)))); }) }) }) { // privacy-flow: agent-bus-tools-local
  const recordFile = path.join(rootDir, 'mcp-auto.json');
  const entry = () => mcpInstall.launch({ ...launch, profile: 'bus' });
  const marker = () => McpInstall.markerOf(entry());
  let state = { claude: { state: 'unknown' }, codex: { state: 'unknown' }, codexHook: { state: 'unknown' } };
  let record = null;

  async function readRecord() {
    try {
      const r = JSON.parse(await fsp.readFile(recordFile, 'utf8'));
      return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
    } catch { return {}; }
  }
  async function writeRecord(r) {
    await fsp.mkdir(rootDir, { recursive: true });
    const tmp = `${recordFile}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try { await fsp.writeFile(tmp, JSON.stringify(r, null, 2), { flag: 'wx', mode: 0o600 }); await fsp.rename(tmp, recordFile); }
    finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
  }

  // Plexiform's full server exactly as this copy wrote it before it added --disable-sigusr1 (step 3): main never
  // binds a caller to a server started that way, so it is rewritten with the flag. Anything else under that name
  // (another copy's, or the person's own edit) is left as it is.
  const canon = (e) => JSON.stringify({ type: e.type || 'stdio', command: e.command, args: e.args, env: Object.fromEntries(Object.entries(e.env && typeof e.env === 'object' ? e.env : {}).sort()) });
  function upgradeFull() {
    const want = mcpInstall.launch(launch);
    const cur = mcpInstall.status({ home, entry: want });
    if (cur.error || !cur.installed || cur.current || !cur.entry || !Array.isArray(cur.entry.args)) return false;
    if (!McpInstall.NODE_FLAGS.every((f) => want.args.includes(f))) return false;
    const before = { ...want, args: want.args.filter((a) => !McpInstall.NODE_FLAGS.includes(a)) };
    if (canon(cur.entry) !== canon(before)) return false;
    return !!mcpInstall.install({ home, entry: want }).changed;
  }

  function addClaude(rec) {
    const want = entry();
    const full = mcpInstall.status({ home });
    if (full.error) return { state: 'error', error: 'unreadable' };
    // Plexiform's full server is there: it already has the bus tools, so ours would only duplicate them.
    if (full.installed) {
      if (rec.claude) { mcpInstall.uninstall({ home, name: NAME, marker: marker() }); rec.claude = null; }
      return { state: 'full' };
    }
    try {
      const r = mcpInstall.install({ home, entry: want, name: NAME });
      if (r.changed || !rec.claude || rec.claude.entry_hash !== hashOf(want)) rec.claude = { name: NAME, added_at: rec.claude?.added_at || new Date(now()).toISOString(), entry_hash: hashOf(want) };
      return { state: 'ours', changed: !!r.changed };
    } catch (e) {
      return { state: e.code === 'FOREIGN' ? 'foreign' : e.code === 'OTHER_CHANNEL' ? 'other-channel' : 'error', error: e.code === 'FOREIGN' || e.code === 'OTHER_CHANNEL' ? undefined : 'write' };
    }
  }

  // → { bin } of a trusted codex, or the state to report.
  async function codexCli() {
    const found = codexBin();
    if (!found) return { state: 'missing' };
    const bin = await trustCodexBin(found).catch(() => null);
    return bin ? { bin } : { state: 'untrusted' };
  }

  async function addCodex(rec) {
    const { bin, state: why } = await codexCli();
    if (!bin) return { state: why };
    const cli = CodexMcp.create({ bin, env: codexEnv, ...(execFile ? { execFile } : {}) });
    const want = (({ command, args, env }) => ({ command, args, env }))(entry());
    const got = await cli.get();
    if (!got.ok) return { state: 'error', error: got.error };
    if (got.spec && !McpInstall.markerOf(got.spec)) return { state: 'foreign' };
    if (got.spec && McpInstall.markerOf(got.spec) !== McpInstall.markerOf(want)) return { state: 'other-channel' };
    let changed = false;
    if (!CodexMcp.sameSpec(got.spec, want)) {
      const added = await cli.add(want);
      if (!added.ok) return { state: 'error', error: added.error };
      changed = true;
      // Codex (or ChatGPT.app, which manages the same file) may not have kept it as written.
      const again = await cli.get();
      if (!again.ok || !CodexMcp.sameSpec(again.spec, want)) return { state: 'mismatch' };
    }
    if (changed || !rec.codex || rec.codex.entry_hash !== hashOf(want)) rec.codex = { name: NAME, added_at: rec.codex?.added_at || new Date(now()).toISOString(), entry_hash: hashOf(want) };
    return { state: 'ours', changed };
  }

  function addHook(rec) {
    const r = codexAdapter.installBusHook({ home });
    if (!r.ok) return { state: 'error' };
    if (r.changed || !rec.codexHook || rec.codexHook.kept) rec.codexHook = { added_at: rec.codexHook?.added_at || new Date(now()).toISOString() };
    return { state: rec.codexHookSeenAt ? 'approved' : 'needs-approval', changed: !!r.changed };
  }

  function removeClaude(rec) {
    if (rec.claude) { try { mcpInstall.uninstall({ home, name: NAME, marker: marker() }); rec.claude = null; } catch { /* unreadable: kept, retried next time */ } }
  }

  async function removeAll(rec) {
    removeClaude(rec);
    if (rec.codexHook) {
      const r = codexAdapter.uninstallBusHook({ home });
      // Kept where removing it would cost later hooks their approval: the person removes it (notices()).
      if (r.ok && r.kept) rec.codexHook = { ...rec.codexHook, kept: true };
      else if (r.ok) rec.codexHook = null;
    }
    if (rec.codex) {
      const { bin } = await codexCli();
      if (bin) {
        const cli = CodexMcp.create({ bin, env: codexEnv, ...(execFile ? { execFile } : {}) });
        const got = await cli.get();
        if (got.ok && (!got.spec || McpInstall.markerOf(got.spec) !== marker())) rec.codex = null;
        else if (got.ok && (await cli.remove()).ok) rec.codex = null;
      }
    }
  }

  // sync(), act() and codexHookSeen() each read, change and write the record: one at a time, so none loses another's change.
  let tail = Promise.resolve();
  const exclusive = (fn) => { const p = tail.then(fn, fn); tail = p.catch(() => {}); return p; };

  let running = null;
  let again = false;
  async function syncOnce() {
    const rec = await readRecord();
    const had = !!(rec.claude || rec.codex);
    const c = config();
    // Whatever the bus switches: it is the person's own Claude integration, only made safe to bind.
    if (c && c.mcpUserOff !== true) {
      try { if (upgradeFull()) log('[mcp-auto] the full server re-registered with --disable-sigusr1'); } catch { /* unreadable or changing: next start */ }
    }
    if (effective(c)) {
      let claude;
      if (claudeOn(c)) {
        try { claude = addClaude(rec); } catch { claude = { state: 'error' }; }
      } else {
        removeClaude(rec);
        claude = { state: 'off' };
      }
      const codex = await addCodex(rec).catch(() => ({ state: 'error' }));
      const codexHook = codex.state === 'ours' ? addHook(rec) : { state: rec.codexHook ? 'error' : 'off' };
      state = { claude, codex, codexHook };
      // The first automatic add, ever: one Home notice with Undo (AW15). Earlier opt-outs left no record, so this is how they get honoured.
      if (!had && (rec.claude || rec.codex) && !rec.notice) rec.notice = { added_at: new Date(now()).toISOString(), dismissed: false };
    } else {
      await removeAll(rec);
      state = { claude: { state: 'off' }, codex: { state: 'off' }, codexHook: { state: 'off' } };
    }
    record = rec;
    await writeRecord(rec);
    log(`[mcp-auto] claude=${state.claude.state} codex=${state.codex.state} hook=${state.codexHook.state}`);
    return state;
  }
  function sync() {
    if (running) { again = true; return running; }
    running = exclusive(syncOnce).catch((e) => { log(`[mcp-auto] failed: ${e && e.code ? e.code : 'error'}`); return state; })
      .finally(() => { running = null; if (again) { again = false; sync(); } });
    return running;
  }

  // The Home notices (src/home-alerts.js): what was added, with Undo; and the one Codex approval Plexiform cannot give.
  function notices() {
    const r = record || {};
    const out = [];
    const where = [r.claude ? 'Claude Code' : null, r.codex ? 'Codex' : null].filter(Boolean);
    if (r.notice && !r.notice.dismissed && where.length) {
      out.push({ handle: 'bus-added', action: 'undo', title: `Plexiform added its agent bus tools to ${where.join(' and ')}`,
        meta: `So your AI sessions can see each other and hand work to each other.${r.codex ? ' Codex asks you before each bus_handoff, unless you allow plexiform-bus in Codex.' : ''}` });
    }
    if (r.codexHook && r.codexHook.kept) {
      if (!r.keptNoticeDismissed) out.push({ handle: 'bus-codex-hook-kept', action: 'dismiss', title: 'Plexiform left its bus_session hook in Codex',
        meta: 'Removing it would make Codex ask you again about the hooks after it. Remove it from ~/.codex/hooks.json yourself if you like, then approve those hooks again in Codex (/hooks).' });
    } else if (r.codexHook && !r.codexHookSeenAt && !r.hookNoticeDismissed) {
      out.push({ handle: 'bus-codex-hook', action: 'dismiss', title: "Approve Plexiform's Codex hook in Codex (/hooks)",
        meta: 'Codex runs a new hook only after you approve it. Until then a Codex session joins the agent bus at its first bus tool call, not when it starts.' });
    }
    return out;
  }
  // Undo runs after the record is written and outside the queue: it changes the config, which syncs again.
  async function act(handle, action, { undo } = {}) {
    const r = await exclusive(() => actOnce(handle, action));
    if (r.ok && handle === 'bus-added' && action === 'undo' && undo) await undo();
    return r;
  }
  async function actOnce(handle, action) {
    const rec = await readRecord();
    if (handle === 'bus-added' && (action === 'undo' || action === 'dismiss') && rec.notice) {
      rec.notice.dismissed = true;
      record = rec;
      await writeRecord(rec);
      return { ok: true, ...(action === 'undo' ? { note: 'Removed. Plexiform will not add them again; turn them back on in Preferences.' } : {}) };
    }
    if (handle === 'bus-codex-hook' && action === 'dismiss') { rec.hookNoticeDismissed = true; record = rec; await writeRecord(rec); return { ok: true }; }
    if (handle === 'bus-codex-hook-kept' && action === 'dismiss') { rec.keptNoticeDismissed = true; record = rec; await writeRecord(rec); return { ok: true }; }
    return { ok: false, error: 'That card has changed. Home refreshes in a moment.' };
  }
  // A Codex session bound through a hook-shaped bus_session call: the hook is approved and runs.
  const codexHookSeen = () => exclusive(codexHookSeenOnce);
  async function codexHookSeenOnce() {
    if (record && record.codexHookSeenAt) return;
    const rec = await readRecord();
    if (rec.codexHookSeenAt) { record = rec; return; }
    rec.codexHookSeenAt = new Date(now()).toISOString();
    record = rec;
    if (state.codexHook.state === 'needs-approval') state = { ...state, codexHook: { state: 'approved' } };
    await writeRecord(rec);
  }

  return {
    sync, notices, act, codexHookSeen, recordFile,
    status: () => state,
    // Which providers have the bus tools (the roster's caps.mcp, so the hook's Tools line is true).
    caps: () => ({ claude: ['ours', 'full'].includes(state.claude.state), codex: state.codex.state === 'ours' }),
  };
}

module.exports = { create, effective, claudeOn, trustedCodex, NAME };
