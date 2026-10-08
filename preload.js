const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trafficLight', {
  openClaude: () => ipcRenderer.invoke('open-claude'),
  goToNeedingSession: () => ipcRenderer.invoke('go-to-needing-session'),
  getAggregateStatus: () => ipcRenderer.invoke('get-aggregate-status'),
  cursorInWindow: () => ipcRenderer.invoke('cursor-in-window'),
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  setWindowPosition: (x, y) => ipcRenderer.send('set-window-position', x, y),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: (vx, vy) => ipcRenderer.send('drag-end', vx, vy),
  onLand: (cb) => ipcRenderer.on('land', (e, strength) => cb(strength)),
  onImpact: (cb) => ipcRenderer.on('impact', (e, side, strength) => cb(side, strength)),
  onSway: (cb) => ipcRenderer.on('sway', (e, degPerSec) => cb(degPerSec)),
  onLean: (cb) => ipcRenderer.on('lean', (e, vx) => cb(vx)),
  onEyes: (cb) => ipcRenderer.on('eyes', (e, x, y) => cb(x, y)),
  getLowPower: () => ipcRenderer.invoke('get-low-power'),
  onLowPower: (cb) => ipcRenderer.on('low-power', (e, on) => cb(on)),
  onMotionPaused: (cb) => ipcRenderer.on('motion-paused', (e, paused) => cb(paused)),
  // Chromium's own online/offline events; main only re-checks on a slow timer otherwise.
  netChanged: () => ipcRenderer.send('net-changed'),
  setReducedMotion: (on) => ipcRenderer.send('reduced-motion', on),
  setClickThrough: (ignore) => ipcRenderer.send('set-click-through', ignore),
  // Linux only: main reports the cursor while clicks pass through (src/click-through.js).
  onHitTest: (cb) => ipcRenderer.on('hit-test', (e, x, y) => cb(x, y)),
  resizeWindowBy: (factor) => ipcRenderer.send('resize-window-by', factor),
  onStatusChanged: (callback) => ipcRenderer.on('status-changed', callback),
  openLights: () => ipcRenderer.invoke('open-lights'),
  widgetMenu: (menu) => ipcRenderer.invoke('widget-menu', { menu: menu === true }),
  openHelp: () => ipcRenderer.invoke('open-help'),
  onBurst: (cb) => ipcRenderer.on('burst', (e, ms) => cb(ms)),
  onAim: (cb) => ipcRenderer.on('aim', (e, a) => cb(a)),
  onEvent: (cb) => ipcRenderer.on('event', (e, name) => cb(name)),
  onSoundFlash: (cb) => ipcRenderer.on('sound-flash', () => cb()),
  // PendingInput (docs/waiting-inputs.md): answer by option id; open = jump to its terminal.
  answerInput: (id, optionId, more) => ipcRenderer.invoke('answer-input', id, optionId, more),
  openInput: (id) => ipcRenderer.invoke('open-input', id),
  copyInputCommand: (id) => ipcRenderer.invoke('copy-input-command', id),
  // The bubble's height: main grows the window by it so Claude keeps his size.
  setBubbleHeight: (px) => ipcRenderer.send('set-bubble-height', px),
  // main has given the bubble that much room (until then it may be clipped).
  onStripApplied: (cb) => ipcRenderer.on('strip-applied', (e, px) => cb(px)),
  openWaiting: () => ipcRenderer.invoke('open-waiting'),
  // Lights → Auto-answer, prefilled from an input ({inputId}) or a nudge ({nudgeKey}).
  openAutoRule: (from) => ipcRenderer.invoke('open-auto-rule', from),
  nudgeMute: (key) => ipcRenderer.invoke('nudge-mute', key),
  // Work scope (§C2): mode 'personal' | 'auto'. Absent core → these reject.
  setSessionScope: (sessionId, mode) => ipcRenderer.invoke('set-session-scope', sessionId, mode),
  setRepoScope: (canonicalUrl, mode) => ipcRenderer.invoke('set-repo-scope', canonicalUrl, mode),
  gesture: (g) => ipcRenderer.invoke('gesture', g),
  // In-app update row (src/update-view.js). The widget may read the state and ask
  // for an install (never forced); nothing else of the updater reaches it.
  getUpdaterState: () => ipcRenderer.invoke('updater:get-state'),
  onUpdaterState: (cb) => ipcRenderer.on('updater:state', (_e, state) => cb(state)),
  updaterInstall: (when) => ipcRenderer.invoke('updater:install', { when: when === 'now' ? 'now' : 'idle' }),
  openUpdates: () => ipcRenderer.invoke('open-updates'),
  updateRowShown: (on) => ipcRenderer.send('update-row', !!on),
  awayOpen: (i) => ipcRenderer.invoke('away-open', i),
  awayDismiss: () => ipcRenderer.invoke('away-dismiss'),
  // Budget notice: the widget names a run and an action; main builds the fragment.
  budgetNotice: (action, runId) => ipcRenderer.invoke('budget-notice', { action, runId }),
  // Push-to-talk (F7): long-press starts and ends a question; main pushes
  // listening / thinking / talking / idle / error back for the mic badge and the mouth.
  teamHint: () => ipcRenderer.invoke('team-hint'),
  teamHintDone: (open) => ipcRenderer.invoke('team-hint-done', open === true),
  burstChip: () => ipcRenderer.invoke('burst:chip'),
  voiceEnabled: () => ipcRenderer.invoke('voice-enabled'),
  voiceStart: () => ipcRenderer.invoke('voice-start'),
  voiceStop: () => ipcRenderer.invoke('voice-stop'),
  onVoice: (cb) => ipcRenderer.on('voice-state', (e, st) => cb(st)),
});

// User characters: the list main has validated, and a nudge when it changes.
contextBridge.exposeInMainWorld('userCharacters', {
  list: () => ipcRenderer.invoke('characters:list'),
  onChange: (cb) => ipcRenderer.on('characters:changed', () => cb()),
});
