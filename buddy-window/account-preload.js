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
  invite: (email, role) => call('invite', str(email), str(role)),
  resendInvite: (id) => call('resendInvite', str(id)),
  revokeInvite: (id) => call('revokeInvite', str(id)),
  setRole: (memberId, role) => call('setRole', str(memberId), str(role)),
  removeMember: (memberId) => call('removeMember', str(memberId)),
  joinCode: (code) => call('joinCode', str(code)),
  accept: () => call('accept'),
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
