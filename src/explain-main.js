'use strict';
// Explain mode's main-process side (off unless config.explainMode === true):
//   explain:status     {on}: whether to show the Explain buttons at all
//   explain:input      "Explain this" on a permission prompt (widget bubble, Waiting page)
//   explain:recaps     Home: "What did my AI just do?" recaps + stuck help
//   explain:copy       Home: copies one suggested prompt to the clipboard
//   explain:open-test  Home: opens the localhost address a recap found
// Local rules answer first (src/explain.js); only what they don't know goes to
// the user's own claude (src/explain-ai.js), scrubbed, one call at a time.

const crypto = require('node:crypto');
const path = require('node:path');
const Explain = require('./explain.js');
const ExplainAi = require('./explain-ai.js');

const MAX_RECAPS = 10;
const NOTIFY_GAP_MS = 2 * 60 * 1000;
const FAIL_FRESH_MS = 15 * 60 * 1000;
const ID_RE = /^[\w.:-]{1,100}$/;

function readFacts({ locator, Transcripts, adapter, sessionId }) {
  const file = locator?.find(adapter, sessionId);
  if (!file) return { facts: null, ports: [] };
  const facts = Transcripts.factsFrom(file, { adapter, sessionId });
  let ports = [];
  try { ports = Explain.portsIn(Transcripts.readBounded(file).lines.slice(-400).join('\n')); } catch { ports = []; }
  return { facts, ports };
}

function create({ config, inputs = () => [], sessions = () => [], runner = ExplainAi.createRunner(), home = null, clipboard = null, openUrl = null, notify = null, now = Date.now, log = () => {},
  readSession = () => ({ facts: null, ports: [] }), turnFiles = async () => null } = {}) {
  const on = () => { try { return config()?.explainMode === true; } catch { return false; } };
  const cache = new Map();
  const recaps = [];
  const lastNotified = new Map();
  const handles = new Map();
  const handle = (value) => { const h = crypto.randomBytes(9).toString('base64url'); handles.set(h, value); while (handles.size > 200) handles.delete(handles.keys().next().value); return h; };

  async function explainInput(id) {
    if (!on()) return { ok: false, reason: 'off' };
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, reason: 'invalid' };
    const input = (inputs() || []).find((i) => i && i.id === id);
    if (!input || input.kind !== 'permission') return { ok: false, reason: 'gone' };
    const key = `${id}:${input.tool}:${input.text || input.headline}`;
    if (cache.has(key)) return cache.get(key);
    const local = Explain.explainLocal(input);
    if (local) { const r = { ok: true, ...local }; cache.set(key, r); return r; }
    const out = await runner.ask(Explain.explainPrompt(input, { home }));
    if (!out.ok) return { ok: false, reason: out.reason };
    const parsed = Explain.parseReply(out.text);
    const r = parsed ? { ok: true, ...parsed } : { ok: false, reason: 'failed' };
    if (parsed) { cache.set(key, r); while (cache.size > 50) cache.delete(cache.keys().next().value); }
    return r;
  }

  async function turnEnded({ sessionId, cwd, source }) {
    if (!on() || typeof sessionId !== 'string') return null;
    const adapter = source === 'codex' ? 'codex' : 'claude-code';
    let read = { facts: null, ports: [] };
    try { read = readSession({ adapter, sessionId }) || read; } catch (e) { log(`[explain] transcript: ${e?.message ?? e}`); }
    let files = null;
    try { files = await turnFiles(sessionId); } catch { files = null; }
    const project = path.basename(String(cwd || read.facts?.cwd || '')) || 'your project';
    const recap = { ...Explain.buildRecap({ project, facts: read.facts, turnFiles: files, ports: read.ports }), sessionId, at: now(),
      failed: !!read.facts?.lastToolFailed };
    const i = recaps.findIndex((r) => r.sessionId === sessionId);
    if (i >= 0) recaps.splice(i, 1);
    recaps.unshift(recap);
    recaps.length = Math.min(recaps.length, MAX_RECAPS);
    if (notify && (!lastNotified.has(sessionId) || now() - lastNotified.get(sessionId) >= NOTIFY_GAP_MS)) {
      lastNotified.set(sessionId, now());
      try { notify({ title: recap.headline, body: recap.lines.slice(0, 2).join(' ').slice(0, 240) }); } catch { /* no notifications */ }
    }
    return recap;
  }

  function view() {
    if (!on()) return { on: false, recaps: [], help: [] };
    const out = recaps.map((r) => ({ headline: r.headline, lines: r.lines, risky: r.risky, at: r.at, test: r.testUrl ? { label: `Test it now (${r.testUrl.replace(/\/$/, '')})`, handle: handle({ url: r.testUrl }) } : null }));
    const help = [];
    const t = now();
    for (const s of sessions() || []) {
      if (!s || !s.stuck) continue;
      help.push({ project: path.basename(String(s.cwd || '')) || 'A session', why: 'This session has gone quiet. It may be stuck.', prompts: Explain.stuckHelp({ stuck: s.stuck }).map((p) => ({ label: p.label, handle: handle({ prompt: p.id }) })) });
    }
    for (const r of recaps) {
      if (!r.failed || t - r.at > FAIL_FRESH_MS || help.length >= 5) continue;
      help.push({ project: r.headline.replace(/^What your AI just did in /, ''), why: 'A command failed in the last turn.', prompts: Explain.stuckHelp({ failed: true }).map((p) => ({ label: p.label, handle: handle({ prompt: p.id }) })) });
    }
    return { on: true, recaps: out, help: help.slice(0, 5) };
  }

  function copy(h) {
    const v = typeof h === 'string' ? handles.get(h) : null;
    const p = v?.prompt ? Explain.promptById(v.prompt) : null;
    if (!p || !clipboard) return { ok: false };
    clipboard.writeText(p.text);
    return { ok: true, text: p.text };
  }

  function openTest(h) {
    const v = typeof h === 'string' ? handles.get(h) : null;
    if (!v?.url || !/^http:\/\/localhost:\d{2,5}\/$/.test(v.url) || !openUrl) return { ok: false };
    openUrl(v.url);
    return { ok: true };
  }

  return { explainInput, turnEnded, view, copy, openTest, on };
}

// Wires the channels and the turn watcher into the app. main.js calls this once.
function install({ ipcMain, rootDir, home, config, inputs, sessions, inputAllowed, homeAllowed, clipboard, shell, Notification, openHome, onQuit, log = () => {} }) {
  const Transcripts = require('./handover-transcripts.js');
  const locator = Transcripts.createLocator({ home });
  let cps = null;
  const svc = create({
    config, inputs, sessions, home, clipboard, log,
    openUrl: (url) => shell.openExternal(url), // privacy-flow: explain-mode
    notify: Notification && Notification.isSupported?.() ? ({ title, body }) => { const n = new Notification({ title, body }); n.on('click', () => openHome?.()); n.show(); } : null,
    readSession: ({ adapter, sessionId }) => readFacts({ locator, Transcripts, adapter, sessionId }),
    turnFiles: async (sid) => {
      cps = cps || require('./checkpoints.js').createCheckpoints({ rootDir, entitlements: require('./entitlements') });
      const t = (await cps.turns(sid)).turns?.[0];
      return t && !t.running && Array.isArray(t.files) ? t.files : null;
    },
  });
  const watcher = require('./checkpoints.js').createTurnWatcher({ dir: path.join(rootDir, 'sessions'), log,
    onEvent: (ev, s) => { if (ev === 'end' && svc.on()) svc.turnEnded(s).catch((e) => log(`[explain] recap: ${e?.message ?? e}`)); } });
  onQuit?.(() => watcher.close());
  ipcMain.handle('explain:input', (e, id) => (inputAllowed(e) ? svc.explainInput(id) : { ok: false, reason: 'not allowed' }));
  ipcMain.handle('explain:status', (e) => (inputAllowed(e) || homeAllowed(e) ? { on: svc.on() } : null));
  ipcMain.handle('explain:recaps', (e) => (homeAllowed(e) ? svc.view() : null));
  ipcMain.handle('explain:copy', (e, h) => (homeAllowed(e) ? svc.copy(h) : { ok: false }));
  ipcMain.handle('explain:open-test', (e, h) => (homeAllowed(e) ? svc.openTest(h) : { ok: false }));
  return svc;
}

module.exports = { create, install, readFacts };
