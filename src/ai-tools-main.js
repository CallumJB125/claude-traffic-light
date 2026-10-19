'use strict';
// IPC for the AI tools page (aitools.html) and the first-run prompt in Help.
// Every channel is answered only to the page that owns it; renderers send tool
// ids and plain strings, never paths or commands.
const AiTools = require('./ai-tools.js');

const KNOWN = new Set(AiTools.TOOLS.map((t) => t.id));
const str = (v, max) => typeof v === 'string' && v.length <= max;

// Help links to the page as 'aitools', 'aitools:codex' (that row) or 'aitools:all' (the connect-all preview).
function parseDestination(d) {
  const m = /^aitools(?::([a-z]{2,12}))?$/.exec(typeof d === 'string' ? d : '');
  if (!m) return null;
  return { focus: !m[1] || m[1] === 'all' || KNOWN.has(m[1]) ? m[1] || null : null };
}

function register({ ipcMain, fromPage, shell, clipboard, tools }) {
  let focus = null;
  const on = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
    if (!fromPage(e)) return null;
    try { return await fn(...args); } catch { return { ok: false, error: 'Something went wrong; nothing was changed.' }; }
  });
  on('aitools:scan', () => tools.scan());
  on('aitools:focus', () => { const f = focus; focus = null; return f; });
  on('aitools:preview', (id) => (KNOWN.has(id) ? tools.preview(id) : { ok: false, error: 'Unknown tool.' }));
  on('aitools:connect', (id) => (KNOWN.has(id) ? tools.connect(id) : { ok: false, error: 'Unknown tool.' }));
  on('aitools:connect-all', () => tools.connectAll());
  on('aitools:disconnect', (id) => (KNOWN.has(id) ? tools.disconnect(id) : { ok: false, error: 'Unknown tool.' }));
  on('aitools:undo', (id) => (KNOWN.has(id) ? tools.undo(id) : { ok: false, error: 'Unknown tool.' }));
  on('aitools:add-custom', (name, command) => (str(name, 60) && str(command, 400) ? tools.addCustom(name, command) : { ok: false, error: 'Enter a name and the command you run.' }));
  on('aitools:remove-custom', (name) => (str(name, 60) ? tools.removeCustom(name) : { ok: false }));
  on('aitools:fix-runner', () => tools.fixRunner());
  on('aitools:copy', (text) => { if (!str(text, 500) || /[\0-\x1f\x7f]/.test(text)) return false; clipboard.writeText(text); return true; });
  on('aitools:open-install', (id) => {
    const url = KNOWN.has(id) ? tools.installUrl(id) : null;
    if (!url) return false;
    shell.openExternal(url); // privacy-flow: tool-install-link
    return true;
  });
  return { setFocus: (f) => { focus = f; } };
}

module.exports = { register, parseDestination };
