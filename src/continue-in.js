'use strict';
// "Continue in another tool" from any surface that has a session's handover:
// a Running now row, an observed-work board card, a Search result. The menu
// lists only the AI tools src/ai-tools.js found on this Mac, plus "Copy as
// prompt". Codex and Claude Code launch through src/handoff.js (its Plus
// gate, its text-only owned session in an empty temporary folder, its copy
// fallback); every other tool gets the handover on the clipboard. The page
// only ever names a tool id: main loads the handover itself.

const Handoff = require('./handoff.js');

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

// rows: AiTools.quick(). Installed tools in a fixed order, then the copy fallback.
function choices(rows, { canLaunch = false } = {}) {
  const found = new Set((Array.isArray(rows) ? rows : []).filter((r) => r && r.installed === true && typeof r.id === 'string').map((r) => r.id));
  return [...TOOLS.filter((t) => found.has(t.id)).map((t) => ({ id: t.id, label: t.label, mode: canLaunch && LAUNCH.has(t.id) ? 'launch' : 'copy' })), { ...COPY }];
}

function create({ entitlements, clipboard, tools = () => [], adapters = null, log = () => {} }) {
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
  return { menu, run, reply: (id, text) => h.reply(id, text), end: (id) => h.end(id), stop: () => h.stop() };
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
    // A click arrives just after the menu closes on some platforms.
    Menu.buildFromTemplate([{ label: 'Continue in', enabled: false }, { type: 'separator' }, ...items])
      .popup({ window, callback: () => setTimeout(() => { if (!picked) resolve(null); }, 150) });
  });
}

module.exports = { create, register, popup, choices, TOOLS };
