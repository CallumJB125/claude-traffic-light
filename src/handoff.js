'use strict';

// "Hand to Codex / Claude": continue a session's work in another AI tool,
// starting from that session's handover (src/session-handover.js, which
// already carries the provider resume commands).
//   free (handoff.copy):   the handover, as a ready-to-paste prompt, goes on the clipboard.
//   Plus (handoff.launch): Plexiform starts an owned session in the target tool
//     (src/codex-app-server.js, src/claude-code-session.js: text-only, in a new
//     empty temporary folder, the same as an owned session started from
//     Overview) and sends the handover as its first message. Replies stream
//     back to the page that asked; the person can answer or end it there.
// Without the plan, or without the target CLI, it falls back to the copy.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SessionHandover = require('./session-handover.js');

const TARGETS = { codex: 'Codex', claude: 'Claude Code' };
const MAX_REPLY = 4000;
const MAX_LIVE = 4;

function defaultAdapters({ version = '0' } = {}) {
  return {
    codex: () => {
      const C = require('./codex-app-server.js');
      const bin = C.findCodexBin();
      return Object.assign(C.createCodexAppServer({ bin, clientVersion: version }), bin ? {} : { available: false });
    },
    claude: () => {
      const C = require('./claude-code-session.js');
      const bin = C.findClaudeBin();
      return Object.assign(C.createClaudeCodeSession({ bin }), bin ? {} : { available: false });
    },
  };
}
const tempFolder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plexiform-owned-'));

// docFor(key) → the session's handover markdown, or null.
function create({ entitlements, clipboard, docFor, adapters = defaultAdapters(), workspace = tempFolder, log = () => {} }) {
  const made = new Map(); // target tool -> adapter (one each, started on first use)
  const live = new Map(); // handoff id -> { adapter, target, off, folder, to }
  const adapterFor = (to) => { if (!made.has(to)) made.set(to, adapters[to]()); return made.get(to); };

  async function copy(key) {
    if (!entitlements.has('handoff.copy')) return { ok: false, error: 'Copying a handover is not available.' };
    const doc = await docFor(key);
    if (!doc) return { ok: false, error: 'No handover could be built for this session.' };
    clipboard.writeText(SessionHandover.asPrompt(doc));
    return { ok: true, mode: 'copied' };
  }

  function end(id) {
    const h = live.get(id);
    if (!h) return { ok: false, error: 'That hand-off has already ended.' };
    live.delete(id);
    h.off();
    try { h.adapter.release({ target: h.target }); } catch { /* gone */ }
    if (h.folder) fs.rmSync(h.folder, { recursive: true, force: true });
    return { ok: true };
  }

  async function hand(key, to, onEvent = () => {}) {
    if (!Object.hasOwn(TARGETS, to)) return { ok: false, error: 'Choose Codex or Claude.' };
    const fallback = async (note) => { const c = await copy(key); return c.ok ? { ...c, note } : c; };
    if (!entitlements.has('handoff.launch')) return { ...(await fallback(`Copied. Paste it into ${TARGETS[to]}. One-click launch is part of Plus.`)), upgrade: true };
    if (live.size >= MAX_LIVE) return { ok: false, error: 'End one of the running hand-offs first.' };
    const doc = await docFor(key);
    if (!doc) return { ok: false, error: 'No handover could be built for this session.' };
    const adapter = adapterFor(to);
    if (adapter.available === false) return fallback(`${TARGETS[to]} is not installed here, so the handover was copied instead.`);
    const id = crypto.randomUUID();
    let folder = null, target = null, off = () => {};
    try {
      folder = workspace();
      ({ target } = await adapter.open({ cwd: folder }));
      off = adapter.on((e) => {
        // Codex's process exit names no thread: every hand-off on it has ended.
        if (e && e.kind === 'exit') { onEvent({ id, kind: 'closed' }); end(id); return; }
        if (!e || e.target !== target) return;
        if (e.kind === 'delta') onEvent({ id, kind: 'delta', text: String(e.text).slice(0, MAX_REPLY) });
        else if (e.kind === 'message') onEvent({ id, kind: 'message', text: String(e.text).slice(0, MAX_REPLY * 4) });
        else if (e.kind === 'turn-completed') onEvent({ id, kind: 'done', status: e.status, error: e.error ?? null });
        else if (e.kind === 'refused-request') onEvent({ id, kind: 'refused' });
        else if (e.kind === 'closed') { onEvent({ id, kind: 'closed' }); end(id); }
      });
      live.set(id, { adapter, target, off, folder, to });
      await adapter.send({ target, text: SessionHandover.asPrompt(doc), clientId: crypto.randomUUID() });
      return { ok: true, mode: 'launched', id, to, label: TARGETS[to] };
    } catch (e) {
      log(`[handoff] launch in ${to} failed: ${e && e.message}`);
      if (live.has(id)) end(id); else { off(); if (folder) fs.rmSync(folder, { recursive: true, force: true }); }
      return fallback(`${TARGETS[to]} did not start, so the handover was copied instead.`);
    }
  }

  async function reply(id, text) {
    const h = live.get(id);
    if (!h) return { ok: false, error: 'That hand-off has ended.' };
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) return { ok: false, error: 'Write a message first.' };
    try { await h.adapter.send({ target: h.target, text, clientId: crypto.randomUUID() }); return { ok: true }; } catch { return { ok: false, error: `${TARGETS[h.to]} is busy or stopped. Wait for its reply, then try again.` }; }
  }

  function stop() {
    for (const id of [...live.keys()]) end(id);
    for (const a of made.values()) { try { a.stop(); } catch { /* gone */ } }
    made.clear();
  }

  return { copy, hand, reply, end, stop, live: () => live.size };
}

module.exports = { create, defaultAdapters, TARGETS };
