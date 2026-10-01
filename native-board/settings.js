'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const api = window.settingsApi;
  const el = (id) => document.getElementById(`native-board-${id}`);
  const app = el('app'), workspace = el('workspace'), mode = el('mode'), choices = el('choices'), hint = el('hint');
  let snapshot = { connections: [], apps: [] }, epoch = 0, busy = false;
  const option = (value, name) => { const n = document.createElement('option'); n.value = value; n.textContent = name; return n; };
  const connected = () => snapshot.connections?.find((c) => c.target === app.value);
  const message = (s) => { hint.textContent = s; };
  const buttons = () => { app.disabled = workspace.disabled = mode.disabled = busy; el('connect').disabled = busy || !workspace.value || !choices.querySelector('input:checked'); el('disconnect').disabled = busy || (!connected() && !snapshot.apps?.find((a) => a.target === app.value)?.installed); };
  async function boards() {
    const mine = ++epoch;
    choices.replaceChildren(); buttons();
    if (!workspace.value) return;
    const r = await api.nativeBoardBoards(workspace.value);
    if (mine !== epoch) return;
    if (!r.ok) { message(r.error); return; }
    const c = connected();
    for (const b of r.boards) {
      const row = document.createElement('label'); row.className = 'row';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = b.id;
      input.checked = c?.workspaceId === workspace.value && c.boardIds.includes(b.id);
      input.addEventListener('change', buttons);
      row.append(input, document.createTextNode(` ${b.name}`)); choices.append(row);
    }
    buttons();
  }
  async function refresh() {
    const r = await api.nativeBoardStatus();
    if (!r.ok) { message(r.error); return; }
    snapshot = r;
    const previous = workspace.value;
    workspace.replaceChildren(option('', r.workspaces.length ? 'Choose a signed-in team' : 'Sign in to a team in Plexiform first'));
    for (const w of r.workspaces) workspace.append(option(w.id, w.name));
    const c = connected();
    workspace.value = c?.workspaceId ?? previous;
    mode.value = c?.mode ?? 'read';
    buttons(); await boards();
  }
  app.addEventListener('change', async () => {
    const c = connected(); workspace.value = c?.workspaceId ?? ''; mode.value = c?.mode ?? 'read';
    const s = snapshot.apps.find((a) => a.target === app.value);
    message(s?.error ?? (c ? 'Connected to the selected boards. Remove the connection to revoke access immediately.' : 'Choose the workspace, boards and access for this app.'));
    buttons(); await boards();
  });
  workspace.addEventListener('change', boards);
  const action = (fn) => async () => {
    busy = true; buttons();
    try { const r = await fn(); message(r.error ?? r.warning ?? (r.restartNeeded ? 'Connected. Open a new session in your AI app, or use its Restart option to load the board tools.' : 'Connection removed. This app no longer has board access.')); await refresh(); }
    catch { message('The connection could not be updated. Try again.'); }
    finally { busy = false; buttons(); }
  };
  el('connect').addEventListener('click', action(() => api.nativeBoardConnect({ target: app.value, workspaceId: workspace.value, boardIds: [...choices.querySelectorAll('input:checked')].map((n) => n.value), mode: mode.value })));
  el('disconnect').addEventListener('click', action(() => api.nativeBoardDisconnect(app.value)));
  api.onAccountChanged?.(() => refresh().catch(() => message('Refresh Settings to see your teams.')));
  refresh().catch(() => message('Board connections are unavailable. Reopen Settings to try again.'));
});
