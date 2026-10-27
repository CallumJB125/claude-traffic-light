// Account page bridge: one narrow function per action. Main checks the sender
// and every argument's type before anything runs; tokens never cross here.
const { contextBridge, ipcRenderer } = require('electron');

const call = (op, ...args) => ipcRenderer.invoke(`buddy:acct:${op}`, ...args);
const str = (v) => String(v ?? '');
const strArgs = (args) => Object.fromEntries(Object.entries(args && typeof args === 'object' ? args : {}).filter(([k, v]) => /^[a-z]{1,20}$/.test(k) && typeof v === 'string' && v.length <= 60));

contextBridge.exposeInMainWorld('buddyAccount', {
  state: () => call('state'),
  burstStatus: () => ipcRenderer.invoke('burst:status'),
  // Card actions, Terminal kinds and the v0.20 kinds (mod-install, mod-update → burst-ipc ACTION_KINDS) alike:
  // args, when given, are a plain object of short string fields (the mod's id).
  burstAction: (kind, mode, args) => ipcRenderer.invoke('burst:action', { kind: str(kind), mode: str(mode), ...(args && typeof args === 'object' ? { args: strArgs(args) } : {}) }),
  // Allow-listed mutation ids with their own consent dialog, by id (e.g. 'mod-action', {action:'toasts', on:'false'}).
  burstRunAction: (kind, args) => ipcRenderer.invoke('burst-action', str(kind), strArgs(args)),
  burstSetCompaction: (req) => ipcRenderer.invoke('burst:set-compaction', { enabled: !!(req && req.enabled), confirmed: !!(req && req.confirmed), ...(req && req.mode ? { mode: str(req.mode) } : {}) }),
  keepAwakeGet: () => ipcRenderer.invoke('keepawake:get'),
  macView: () => ipcRenderer.invoke('keepawake:mac'),
  keepAwakeSet: (enabled, mode) => ipcRenderer.invoke('keepawake:set', { enabled: !!enabled, ...(mode ? { mode: str(mode) } : {}) }),
  openClients: () => call('openClients'),
  go: (screen) => call('go', str(screen)),
  // Only drawn when main loaded the page with back=1 (the visit began in the Settings sheet); fixed target, no argument.
  backToSettings: () => call('back-to-settings'),
  hub: (address) => call('hub', str(address)),
  confirm: (yes) => call('confirm', !!yes),
  email: (email) => call('email', str(email)),
  code: (code) => call('code', str(code)),
  oauth: (provider) => call('oauth', str(provider)),
  signInWith: (provider) => call('signInWith', str(provider)),
  signInOther: () => call('signInOther'),
  cancelOAuth: () => call('cancelOAuth'),
  resend: () => call('resend'),
  createTeam: (name) => call('createTeam', str(name)),
  // Team actions name the team the page rendered; main refuses them if it changed.
  invite: (team, email, role) => call('invite', str(team), str(email), str(role)),
  resendInvite: (team, id) => call('resendInvite', str(team), str(id)),
  emailInvite: (team, id) => call('emailInvite', str(team), str(id)),
  revokeInvite: (team, id) => call('revokeInvite', str(team), str(id)),
  setRole: (team, memberId, role) => call('setRole', str(team), str(memberId), str(role)),
  removeMember: (team, memberId) => call('removeMember', str(team), str(memberId)),
  renameTeam: (team, name) => call('renameTeam', str(team), str(name)),
  teamDeleteStart: (team, slug) => call('teamDeleteStart', str(team), str(slug)),
  teamDeleteCode: (team, code) => call('teamDeleteCode', str(team), str(code)),
  teamDeleteResend: (team) => call('teamDeleteResend', str(team)),
  teamDeleteOAuth: (team, provider) => call('teamDeleteOAuth', str(team), str(provider)),
  deleteTeam: (team) => call('deleteTeam', str(team)),
  addBoard: (team, name) => call('addBoard', str(team), str(name)),
  joinCode: (code) => call('joinCode', str(code)),
  acceptCode: (code) => call('acceptCode', str(code)),
  accept: (previewId) => call('accept', str(previewId)),
  notNow: () => call('notNow'),
  acceptPending: (id) => call('acceptPending', str(id)),
  switchAccount: () => call('switchAccount'),
  skipInvites: () => call('skipInvites'),
  openTeam: (id) => call('openTeam', str(id)),
  signOut: (host) => call('signOut', str(host)),
  deleteStart: (host) => call('deleteStart', str(host)),
  deleteConfirm: (code) => call('deleteConfirm', str(code)),
  cancelDelete: () => call('cancelDelete'),
  deleteOAuth: (provider) => call('deleteOAuth', str(provider)),
  cancelDeleteOAuth: () => call('cancelDeleteOAuth'),
  runner: (id, on) => call('runner', str(id), !!on),
  revokeRunner: (team, id) => call('revokeRunner', str(team), str(id)),
  presence: (host, on) => call('presence', str(host), !!on),
  summaries: (host, on) => call('summaries', str(host), !!on),
  captureEnabled: (on) => call('captureEnabled', !!on),
  captureDefault: (repo, key) => call('captureDefault', str(repo), str(key)),
  onChanged: (fn) => ipcRenderer.on('buddy:acct:changed', () => fn()),
});
