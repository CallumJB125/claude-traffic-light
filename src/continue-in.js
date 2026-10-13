'use strict';
// "Continue in another tool" from any surface that has a session's handover:
// a Sessions row, an observed-work board card, a Search result. The menu
// lists only the AI tools src/ai-tools.js found on this Mac, plus "Copy as
// prompt". Codex and Claude Code launch through src/handoff.js (its Plus
// gate, its text-only owned session in an empty temporary folder, its copy
// fallback); every other tool gets the handover on the clipboard. The page
// only ever names a tool id: main loads the handover itself.

const Handoff = require('./handoff.js');
const Packet = require('./handoff-packet.js');
const SessionHandover = require('./session-handover.js');

const TOOLS = Object.freeze([
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'hermes', label: 'Hermes' },
]);
const LAUNCH = new Set(Object.keys(Handoff.TARGETS));
const COPY = Object.freeze({ id: 'copy', label: 'Copy as prompt', mode: 'copy' });
const ID = /^[a-z]{2,12}$/;
const ASK_MAX = 8000;
// What the recipient's own AI is told around a teammate's (already framed) question: it answers from the text alone.
const ASK_HEAD = 'A teammate asked the question below through Plexiform. Answer it from the question alone: this session has no access to their code, files or repository, or to yours. Reply with the answer only, in plain text, for your person to read and edit before it is sent.';

// rows: AiTools.quick(). Installed tools in a fixed order, then the copy fallback.
function choices(rows, { canLaunch = false } = {}) {
  const found = new Set((Array.isArray(rows) ? rows : []).filter((r) => r && r.installed === true && typeof r.id === 'string').map((r) => r.id));
  return [...TOOLS.filter((t) => found.has(t.id)).map((t) => ({ id: t.id, label: t.label, mode: canLaunch && LAUNCH.has(t.id) ? 'launch' : 'copy' })), { ...COPY }];
}

const SOURCE = { 'claude-code': 'claude' };

// The stored handover document → a scrubbed packet for `to`. Null when it is not one of ours.
function packetFromDoc(doc, to, home) {
  const facts = SessionHandover.factsFromDoc(doc);
  if (!facts) return null;
  const line = (prefix) => { const l = String(doc).split('\n').find((x) => x.startsWith(prefix)); return l ? l.slice(prefix.length).trim() : ''; };
  const adapter = line('- Adapter: ');
  const branch = line('- Branch: ');
  return Packet.build({
    from: SOURCE[adapter] || adapter, to, goal: facts.lastPrompt, files: Object.keys(facts.files), summary: facts.lastAssistant,
    branch: branch.startsWith('unknown') ? '' : branch,
  }, { home });
}

// confirm({ to, label, text }) → true only when the person pressed Confirm on the native preview.
function create({ entitlements, clipboard, tools = () => [], adapters = null, confirm = async () => false, home = null, log = () => {} }) {
  const h = Handoff.create({ entitlements, clipboard, log, ...(adapters ? { adapters } : {}), docFor: async (k) => (k && typeof k.load === 'function' ? (await k.load()) || null : null) });
  function menu() {
    let rows = [];
    try { rows = tools(); } catch { rows = []; }
    return choices(rows, { canLaunch: entitlements.has('handoff.launch') });
  }
  // load() → the handover markdown, or null.
  async function run(load, to, onEvent = () => {}) {
    const pick = typeof to === 'string' && ID.test(to) ? menu().find((c) => c.id === to) : null;
    if (!pick) return { ok: false, error: 'That tool was not found on this Mac.' };
    const key = { load };
    if (LAUNCH.has(pick.id)) {
      const r = await h.hand(key, pick.id, (ev) => onEvent({ ...ev, label: pick.label }));
      return r.ok && r.mode === 'launched' ? { ...r, label: pick.label } : r;
    }
    const r = await h.copy(key);
    if (!r.ok) return r;
    return { ...r, to: pick.id, note: pick.id === 'copy' ? 'Copied as a prompt. Paste it into any AI tool.' : `Copied as a prompt. Paste it into ${pick.label}.` };
  }
  // Hand off: build the packet, show exactly what would be shared, and only on
  // Confirm release it and go through run (a visible, text-only owned session
  // or the clipboard). Cancel returns before anything is launched or copied.
  async function handoff(load, to, onEvent = () => {}) {
    const pick = typeof to === 'string' && ID.test(to) && to !== COPY.id ? menu().find((c) => c.id === to) : null;
    if (!pick) return { ok: false, error: 'That tool was not found on this Mac.' };
    const doc = await load();
    const packet = doc ? packetFromDoc(doc, pick.id, home) : null;
    if (!packet) return { ok: false, error: 'No handover could be built for this session.' };
    const v = Packet.validate(packet);
    if (!v.ok) return { ok: false, error: v.errors[0] };
    if ((await confirm({ to: pick.id, label: pick.label, text: Packet.toPrompt(packet) })) !== true) return { ok: false, cancelled: true };
    const text = Packet.release(packet, Packet.confirmation(packet));
    return run(async () => text, pick.id, onEvent);
  }
  // "Ask my AI": the same text-only owned session as a hand-off (Plus, Codex or
  // Claude Code), started with the question instead of a handover. It cannot see
  // any repository. Without the plan or the CLI, the question goes on the clipboard.
  async function ask(text, to, onEvent = () => {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > ASK_MAX) return { ok: false, error: 'That question is empty or too long.' };
    const pick = typeof to === 'string' && ID.test(to) ? menu().find((c) => c.id === to) : null;
    if (!pick) return { ok: false, error: 'That tool was not found on this Mac.' };
    const prompt = `${ASK_HEAD}\n\n${text.trim()}`;
    if (LAUNCH.has(pick.id)) {
      const r = await h.hand(null, pick.id, (ev) => onEvent({ ...ev, label: pick.label }), prompt);
      if (r.ok && r.mode === 'launched') return { ...r, label: pick.label };
      return r.ok ? { ...r, note: String(r.note || '').replace('the handover', 'the question') } : r;
    }
    if (!entitlements.has('handoff.copy')) return { ok: false, error: 'Copying is not available.' };
    clipboard.writeText(prompt);
    return { ok: true, mode: 'copied', to: pick.id, note: pick.id === 'copy' ? 'Copied the question. Paste it into any AI tool.' : `Copied the question. Paste it into ${pick.label}.` };
  }
  return { menu, run, handoff, ask, reply: (id, text) => h.reply(id, text), end: (id) => h.end(id), stop: () => h.stop() };
}

// Sessions and Search ask for the menu; Sessions also runs it by handover key
// and is where every launched hand-off's replies show (a board launch opens it).
function register({ ipcMain, allowed, continueIn, writer, sendToSessions = () => {} }) {
  const on = (channel, pages, fn) => ipcMain.handle(channel, async (e, ...args) => {
    if (!pages.some((p) => allowed(e, p))) return { ok: false, error: 'Not allowed.' };
    try { return await fn(...args); } catch { return { ok: false, error: 'Something went wrong. Try again.' }; }
  });
  on('continue:menu', ['sessions', 'memory'], () => ({ ok: true, choices: continueIn.menu() }));
  on('continue:run', ['sessions'], (key, to) => {
    if (typeof key !== 'string' || key.length > 260) return { ok: false, error: 'Unknown session.' };
    return continueIn.run(() => writer()?.text(key) ?? null, to, sendToSessions);
  });
  on('continue:handoff', ['sessions'], (key, to) => {
    if (typeof key !== 'string' || key.length > 260) return { ok: false, error: 'Unknown session.' };
    return continueIn.handoff(() => writer()?.text(key) ?? null, to, sendToSessions);
  });
  on('continue:reply', ['sessions'], (id, text) => continueIn.reply(String(id), text));
  on('continue:end', ['sessions'], (id) => continueIn.end(String(id)));
}

// The board card's menu, as a native menu over the board. Resolves to the
// run's result, or null when it was closed without a choice.
function popup({ Menu, continueIn, window, load, showSessions = () => {}, onEvent = () => {} }) {
  return new Promise((resolve) => {
    let picked = false;
    const items = continueIn.menu().map((c) => ({
      label: c.id === 'copy' || c.mode === 'launch' ? c.label : `${c.label} (copies the prompt)`,
      click: () => {
        picked = true;
        resolve(continueIn.run(load, c.id, onEvent).then((r) => { if (r.ok && r.mode === 'launched') showSessions(); return r; }));
      },
    }));
    const handoffItems = continueIn.menu().filter((c) => c.id !== 'copy').map((c) => ({
      label: c.label,
      click: () => { picked = true; resolve(continueIn.handoff(load, c.id, onEvent).then((r) => { if (r.ok && r.mode === 'launched') showSessions(); return r; })); },
    }));
    if (handoffItems.length) items.push({ type: 'separator' }, { label: 'Hand off to another AI…', submenu: handoffItems });
    // A click arrives just after the menu closes on some platforms.
    Menu.buildFromTemplate([{ label: 'Continue in', enabled: false }, { type: 'separator' }, ...items])
      .popup({ window, callback: () => setTimeout(() => { if (!picked) resolve(null); }, 150) });
  });
}

module.exports = { create, register, popup, choices, packetFromDoc, TOOLS };
