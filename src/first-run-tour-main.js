'use strict';
// Main side of the first-run tour (src/first-run-tour.js): starts it a few
// seconds after first-run setup closes, opens the window each step lives in
// and sends it `tour:step`; the windows answer with `tour:action`. With no AI
// tool connected it runs on the demo fixtures (src/demo-mode.js); nothing here
// reads a session, writes anything but config.tourState, or leaves the Mac.
const Tour = require('./first-run-tour.js');

// The made-up question the widget shows on the "waiting" step in the demo.
// Answering it never reaches a hook: the widget hands it back to the tour.
const DEMO_INPUT = Object.freeze({
  v: 1, id: 'tour-demo-permission', session: null, host: null, cwd: null, kind: 'permission', source: 'hook', tool: 'Bash',
  title: 'Claude Code (demo)', text: 'npm test -- --watch=false', headline: 'Claude Code wants to run: npm test -- --watch=false',
  options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }], created_at: null, expires_at: null, answerable: true, actions: ['answer'],
});
const ACTIONS = new Set(['next', 'skip', 'missing', 'answered']);

// windows: { widget() -> BrowserWindow|null, widgetShown() -> bool, lights() -> BrowserWindow|null, openLights(),
//            openPage(id), sendToPage(id, channel, payload) -> bool }
// allowed: { widget(e), lights(e), page(e, id) }
function install({ ipcMain, config, saveConfig, windows, allowed, demo, hasConnectedTool, now = Date.now, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout, log = () => {} }) {
  const read = () => Tour.parse(config().tourState);
  const write = (s) => { saveConfig({ tourState: s }); return s; };
  let cancelStart = null;
  let demoInputShown = false;

  const missingWindow = (i) => Tour.STEPS[i].target.window === 'widget' && !windows.widgetShown();
  const sendWin = (bw, payload) => {
    const wc = bw && !bw.isDestroyed() ? bw.webContents : null;
    if (!wc || wc.isDestroyed()) return false;
    if (wc.isLoading()) wc.once('did-finish-load', () => { if (!wc.isDestroyed()) wc.send('tour:step', payload); });
    else wc.send('tour:step', payload);
    return true;
  };
  const PAGES = ['home', 'usage'];
  function clearAll(except = []) {
    if (!except.includes('widget')) sendWin(windows.widget(), null);
    if (!except.includes('lights')) sendWin(windows.lights(), null);
    for (const p of PAGES) if (!except.includes(p)) windows.sendToPage(p, 'tour:step', null);
  }

  function show() {
    const cur = read();
    const s = Tour.settle(cur, { missing: missingWindow, now: now() });
    if (s !== cur) write(s);
    if (s.status !== 'running') { clearAll(); demoInputShown = false; return s; }
    const step = Tour.STEPS[s.step];
    const base = Tour.view(s);
    const hostKey = step.host.window === 'main' ? step.host.page : step.host.window;
    const sameWindow = step.target.window === step.host.window && step.target.page === step.host.page;
    const hostPayload = { ...base, selector: sameWindow ? step.target.selector : null, pointsTo: sameWindow ? null : step.target.window };
    const widgetSel = step.target.window === 'widget' ? step.target.selector : step.also?.window === 'widget' ? step.also.selector : null;
    clearAll([hostKey, ...(widgetSel ? ['widget'] : [])]);
    if (step.host.window === 'lights') { windows.openLights(); sendWin(windows.lights(), hostPayload); }
    else { windows.openPage(step.host.page); windows.sendToPage(step.host.page, 'tour:step', hostPayload); }
    demoInputShown = step.id === 'waiting' && demo.active();
    if (widgetSel) sendWin(windows.widget(), { id: step.id, highlight: widgetSel, demoInput: demoInputShown ? DEMO_INPUT : null, title: step.title });
    return s;
  }

  function begin() {
    cancelStart = null;
    if (!Tour.shouldAutoStart(config().tourState) && read().status !== 'running') return read();
    return run();
  }
  function run() {
    if (!hasConnectedTool() && !demo.active()) demo.start();
    write(Tour.start(now()));
    log('[tour] started');
    return show();
  }

  function act(kind, id) {
    const s = read();
    if (s.status !== 'running' || Tour.STEPS[s.step].id !== id) return { ok: false };
    let next;
    if (kind === 'skip') next = Tour.skip(s, now());
    else if (kind === 'next' && s.step === Tour.STEPS.length - 1) next = Tour.finish(s, now());
    else next = Tour.advance(s, { missing: missingWindow, now: now() });
    write(next);
    show();
    if (Tour.done(next)) log(`[tour] ${next.status}`);
    return { ok: true, status: next.status, step: next.step };
  }

  const sender = (e) => allowed.widget(e) || allowed.lights(e) || PAGES.some((p) => allowed.page(e, p));
  ipcMain.handle('tour:action', (e, kind, id) => (sender(e) && ACTIONS.has(kind) && typeof id === 'string' && id.length <= 20 ? act(kind, id) : null));
  ipcMain.handle('tour:restart', (e) => (allowed.page(e, 'help') ? (cancel(), run(), { ok: true }) : null));

  function cancel() { if (cancelStart) cancelStart(); cancelStart = null; }
  return {
    // First-run setup has closed: start within the 30-second window if this person has never seen the tour.
    onboardingClosed() {
      if (!Tour.shouldAutoStart(config().tourState) || cancelStart) return false;
      cancelStart = Tour.scheduleStart({ setTimeout: st, clearTimeout: ct, begin });
      return true;
    },
    restart: () => { cancel(); return run(); },
    state: read,
    act,
    demoInputShown: () => demoInputShown,
  };
}

// The widget answers the demo itself; main refuses its id outright, so it can never name a request file.
const isDemoId = (id) => id === DEMO_INPUT.id;

module.exports = { install, DEMO_INPUT, isDemoId };
