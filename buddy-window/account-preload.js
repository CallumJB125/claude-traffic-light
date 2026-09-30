// Account page bridge: one narrow function per action. Main checks the sender
// and every argument's type before anything runs; tokens never cross here.
const { contextBridge, ipcRenderer } = require('electron');

const call = (op, ...args) => ipcRenderer.invoke(`buddy:acct:${op}`, ...args);
const str = (v) => String(v ?? '');

contextBridge.exposeInMainWorld('buddyAccount', {
  state: () => call('state'),
  go: (screen) => call('go', str(screen)),
  hub: (address) => call('hub', str(address)),
  confirm: (yes) => call('confirm', !!yes),
  email: (email) => call('email', str(email)),
  code: (code) => call('code', str(code)),
  resend: () => call('resend'),
  createTeam: (name) => call('createTeam', str(name)),
  // Team actions name the team the page rendered; main refuses them if it changed.
  invite: (team, email, role) => call('invite', str(team), str(email), str(role)),
  resendInvite: (team, id) => call('resendInvite', str(team), str(id)),
  revokeInvite: (team, id) => call('revokeInvite', str(team), str(id)),
  setRole: (team, memberId, role) => call('setRole', str(team), str(memberId), str(role)),
  removeMember: (team, memberId) => call('removeMember', str(team), str(memberId)),
  joinCode: (code) => call('joinCode', str(code)),
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
  runner: (id, on) => call('runner', str(id), !!on),
  presence: (host, on) => call('presence', str(host), !!on),
  onChanged: (fn) => ipcRenderer.on('buddy:acct:changed', () => fn()),
});
