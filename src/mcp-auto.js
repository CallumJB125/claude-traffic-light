'use strict';
// Plexiform's agent bus tools, registered by Plexiform itself for Claude Code
// and Codex (plan-agent-awareness §3.9, AW6, AW15): the bus-only profile
// (`mcp-server.js --profile bus`) under the name plexiform-bus, marked with
// PLEXIFORM_MCP=bus-v1:<channel>, recorded, and undone on request.
//
// - On while (agentAwareness.enabled || agentBus.enabled) && !mcpBusUserOff.
// - Claude Code: one key in ~/.claude.json through mcp-install.js (its
//   compare-and-swap write; sync fs, about 100 KB, once per start, deferred).
//   Skipped when Plexiform's full server is registered: it carries the same tools.
// - Codex: `codex mcp add` through its own CLI, re-read with `codex mcp get`,
//   plus the separate bus_session SessionStart hook in ~/.codex/hooks.json
//   (adapters/codex.js; sync fs, a few KB). Codex runs that hook only once the
//   person approves it in Codex; Plexiform never writes hook trust.
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

const NAME = McpInstall.BUS_NAME;
const hashOf = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const effective = (c) => !!c && (c.agentAwareness?.enabled !== false || c.agentBus?.enabled !== false) && c.mcpBusUserOff !== true;

/**
 * config(): the app config. launch: McpInstall.launch options ({packaged, execPath, appPath, dir, root}).
 * home: where ~/.claude.json and ~/.codex live (a sandbox in dev runs). codexBin(): findCodexBin().
 * codexEnv: the environment `codex` runs with (CODEX_HOME set to the sandbox in dev runs).
 */
function create({ rootDir, home, config, launch, codexBin, codexEnv = process.env, execFile, fsp = fs.promises, mcpInstall = McpInstall, codexAdapter = Codex, now = () => Date.now(), log = () => {} }) {
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

  async function addCodex(rec) {
    const bin = codexBin();
    if (!bin) return { state: 'missing' };
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
    if (r.changed || !rec.codexHook) rec.codexHook = { added_at: rec.codexHook?.added_at || new Date(now()).toISOString() };
    return { state: rec.codexHookSeenAt ? 'approved' : 'needs-approval', changed: !!r.changed };
  }

  async function removeAll(rec) {
    if (rec.claude) { try { mcpInstall.uninstall({ home, name: NAME, marker: marker() }); rec.claude = null; } catch { /* unreadable: kept, retried next time */ } }
    if (rec.codexHook) { const r = codexAdapter.uninstallBusHook({ home }); if (r.ok) rec.codexHook = null; }
    if (rec.codex) {
      const bin = codexBin();
      if (bin) {
        const cli = CodexMcp.create({ bin, env: codexEnv, ...(execFile ? { execFile } : {}) });
        const got = await cli.get();
        if (got.ok && (!got.spec || McpInstall.markerOf(got.spec) !== marker())) rec.codex = null;
        else if (got.ok && (await cli.remove()).ok) rec.codex = null;
      }
    }
  }

  let running = null;
  let again = false;
  async function syncOnce() {
    const rec = await readRecord();
    const had = !!(rec.claude || rec.codex);
    if (effective(config())) {
      let claude;
      try { claude = addClaude(rec); } catch { claude = { state: 'error' }; }
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
    running = syncOnce().catch((e) => { log(`[mcp-auto] failed: ${e && e.code ? e.code : 'error'}`); return state; })
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
    if (r.codexHook && !r.codexHookSeenAt && !r.hookNoticeDismissed) {
      out.push({ handle: 'bus-codex-hook', action: 'dismiss', title: "Approve Plexiform's Codex hook in Codex (/hooks)",
        meta: 'Codex runs a new hook only after you approve it. Until then a Codex session joins the agent bus at its first bus tool call, not when it starts.' });
    }
    return out;
  }
  async function act(handle, action, { undo } = {}) {
    const rec = await readRecord();
    if (handle === 'bus-added' && (action === 'undo' || action === 'dismiss') && rec.notice) {
      rec.notice.dismissed = true;
      record = rec;
      await writeRecord(rec);
      if (action === 'undo' && undo) await undo();
      return { ok: true, ...(action === 'undo' ? { note: 'Removed. Plexiform will not add them again; turn them back on in Preferences.' } : {}) };
    }
    if (handle === 'bus-codex-hook' && action === 'dismiss') { rec.hookNoticeDismissed = true; record = rec; await writeRecord(rec); return { ok: true }; }
    return { ok: false, error: 'That card has changed. Home refreshes in a moment.' };
  }
  // A Codex session bound through bus_session: the hook is approved and runs.
  async function codexHookSeen() {
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

module.exports = { create, effective, NAME };
