'use strict';
// Execute the shipped Buddy WebContentsView authority methods and event
// registration, then the shipped main.js Tasks registrar/native-modal wiring.
// Electron windows/dialogs are controlled surfaces; no installed app is opened.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '../..');
const buddySource = fs.readFileSync(path.join(root, 'buddy-window/index.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
function createTasksWindowAuthority({ service, confirm }) {
  const state = { focused: true, visible: true, minimized: false, destroyed: false, loading: false, workspace: 'synthetic-workspace' };
  const dir = '/synthetic/app/buddy-window', expected = pathToFileURL(path.join(dir, '..', 'tasks.html')); expected.searchParams.set('embedded', '1'); state.url = expected.href;
  const wc = new EventEmitter(); Object.assign(wc, { id: 7, mainFrame: { url: expected.href }, getURL: () => state.url, isDestroyed: () => state.destroyed, isLoading: () => state.loading });
  const win = new EventEmitter(); Object.assign(win, { isDestroyed: () => state.destroyed, isVisible: () => state.visible, isMinimized: () => state.minimized, isFocused: () => state.focused });
  const view = { webContents: wc }; win.contentView = { children: [view] };
  const context = { URL, path, pathToFileURL, DIR: dir, win, selected: 'tasks', content: view, localViews: new Map([['tasks', view]]), store: { active: () => ({ id: state.workspace }) }, page: { id: 'tasks' }, v: view };
  const methods = buddySource.slice(buddySource.indexOf('    tasksContext()'), buddySource.indexOf('    setupSources,', buddySource.indexOf('    tasksContext()')));
  const events = buddySource.slice(buddySource.indexOf("      if(page.id==='tasks'){"), buddySource.indexOf("      v.webContents.on('did-finish-load'", buddySource.indexOf("      if(page.id==='tasks'){")));
  const blur = buddySource.slice(buddySource.indexOf("    win.on('blur',()=>{if(!tasksModalTicket)"), buddySource.indexOf("    win.on('closed'", buddySource.indexOf("    win.on('blur',()=>{if(!tasksModalTicket)")));
  if (!methods || !events || !blur) throw Error('shipped Tasks authority wiring missing');
  vm.runInNewContext('let tasksDocument=0,tasksGeneration=0,tasksModalTicket=null,setupModalTicket=null,setupSourcesGeneration=0,homeModalTicket=null,homeGeneration=0;globalThis.api={' + methods + '};' + events + blur
    + 'globalThis.retireAccount=()=>{setupSourcesGeneration++;};globalThis.navigate=()=>{tasksGeneration++;selected="other";};', context);
  const handlers = new Map(), dialogs = [];
  const registration = mainSource.match(/^require\('\.\/src\/tasks-main'\)\.register\([^\n]+\);$/m)?.[0];
  if (!registration || /ipcMain\.handle\('tasks:act'/.test(mainSource)) throw Error('production Tasks act is not exclusively document-bound');
  vm.runInNewContext(registration, { require: name => { if (name !== './src/tasks-main') throw Error(name); return require('../../src/tasks-main'); }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, buddyWin: context.api, getTasks: service });
  const start = mainSource.indexOf('    confirmDialog: async (info, wcId) => {', mainSource.indexOf('function getTasks()'));
  const finish = mainSource.indexOf('    seen: {', start);
  const nativeContext = { tasksPages: () => [wc], BrowserWindow: { fromWebContents: () => null }, buddyWin: context.api,
    dialog: { showMessageBox: async (owner, options) => { if (owner !== win) throw Error('Tasks modal lost its actual BaseWindow parent'); dialogs.push(options); return { response: await confirm(options) ? 1 : 0 }; } } };
  vm.runInNewContext('globalThis.confirm=({' + mainSource.slice(start, finish) + '}).confirmDialog;', nativeContext);
  return { state, wc, win, buddy: context.api, handlers, dialogs, confirmDialog: nativeContext.confirm,
    event: () => ({ sender: wc, senderFrame: wc.mainFrame }),
    reload: () => wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }),
    navigate: () => context.navigate(), account: () => context.retireAccount(), workspace: () => { state.workspace = 'replacement-workspace'; },
    blur: () => { state.focused = false; win.emit('blur'); }, refocus: () => state.focused = true,
  };
}
module.exports = { createTasksWindowAuthority };
