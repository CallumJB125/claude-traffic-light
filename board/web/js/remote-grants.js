import { call, el, signIn, staffTeams, selection, boards, access, lock } from './remote-browser.js';
const status = document.getElementById('remote-status'), error = document.getElementById('remote-error'), content = document.getElementById('remote-content');
const tokenPanel = document.getElementById('remote-token'), tokenInput = document.getElementById('token-value');
let generation = 0, account = null, team = null, busy = false;
const hideToken = () => { tokenInput.value = ''; tokenPanel.hidden = true; };
const fail = message => { error.textContent = message; error.hidden = false; };
document.getElementById('mcp-url').textContent = location.origin + '/api/mcp';
document.getElementById('token-forget').addEventListener('click', hideToken);
document.getElementById('token-copy').addEventListener('click', async () => {
  if (!tokenPanel.hidden && tokenInput.value) try { await navigator.clipboard.writeText(tokenInput.value); status.textContent = 'Token copied.'; } catch { tokenInput.focus(); tokenInput.select(); status.textContent = 'Select and copy the token.'; }
});
async function current() {
  const value = await call('GET', '/api/account');
  if (value.user.id !== account?.user.id || !staffTeams(value).some(item => item.id === team?.id)) { hideToken(); throw new Error('Your account or team access changed. Reload this page.'); }
  return value;
}
async function showTeam(chosen) {
  const turn = ++generation; hideToken(); team = chosen; document.getElementById('remote-team')?.remove(); error.hidden = true;
  if (!team) return;
  const root = el('section', null, { id: 'remote-team' }); content.append(root);
  try {
    const path = '/api/teams/' + encodeURIComponent(team.id) + '/remote-grants', list = await call('GET', path); if (turn !== generation) return;
    root.append(el('h2', 'Connections for ' + team.name));
    const rows = el('ul');
    for (const grant of list.grants) {
      const row = el('li'), names = grant.board_ids.map(id => team.boards.find(board => board.id === id)?.name ?? 'Unavailable board');
      row.append(el('strong', grant.name + ' · unverified application'), el('p', `${grant.kind === 'mcp' ? 'Remote MCP' : 'Integration API'} · ${grant.mode} · ${names.join(', ')} · expires ${new Date(grant.expires_at).toLocaleDateString()}`));
      if (grant.revoked_at) row.append(el('p', 'Revoked'));
      else {
        const revoke = el('button', 'Revoke access', { type: 'button', className: 'btn' }); row.append(revoke);
        revoke.addEventListener('click', async () => {
          if (busy || turn !== generation) return; busy = true; revoke.disabled = true; hideToken();
          try { const live = await current(); if (turn !== generation) return; const gesture = await call('POST', path + '/gesture', { purpose: 'revoke' }, live.csrf_token);
            if (turn !== generation) return; await call('DELETE', path + '/' + encodeURIComponent(grant.id), { gesture_id: gesture.gesture_id }, live.csrf_token); if (turn === generation) await showTeam(team);
          } catch (e) { if (turn === generation) { fail(e.message); revoke.disabled = false; } } finally { busy = false; }
        });
      }
      rows.append(row);
    }
    root.append(rows, el('h2', 'Create an integration token'));
    const form = el('form'), nameLabel = el('label', 'Application name'), name = el('input', null, { className: 'input', required: true, maxLength: 100, autocomplete: 'off' }); nameLabel.append(name); form.append(nameLabel);
    const selected = boards(form, team), mode = access(form, team.role !== 'viewer'), expiryLabel = el('label', 'Expires after (days)'), expiry = el('input', null, { className: 'input', type: 'number', min: '1', max: '30', value: '7', required: true }); expiryLabel.append(expiry); form.append(expiryLabel, el('button', 'Create token for selected boards', { className: 'btn btn-primary', type: 'submit' })); root.append(form);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || turn !== generation) return;
      if (!selected().length) { fail('Select at least one board.'); return; }
      busy = true; lock(form, true); hideToken(); error.hidden = true;
      try {
        const live = await current(); if (turn !== generation) return;
        const gesture = await call('POST', path + '/gesture', { purpose: 'create' }, live.csrf_token); if (turn !== generation) return;
        const result = await call('POST', path, { gesture_id: gesture.gesture_id, name: name.value, board_ids: selected(), mode: mode.value, expires_days: Number(expiry.value) }, live.csrf_token);
        if (turn !== generation) return;
        const refresh = showTeam(team), shownTurn = generation; await refresh;
        if (shownTurn !== generation) return; await current(); if (shownTurn !== generation) return; tokenInput.value = result.token; tokenPanel.hidden = false; tokenInput.focus(); status.textContent = 'Token created. Copy it before leaving this page.';
      } catch (e) { if (turn === generation) fail(e.message); } finally { busy = false; if (form.isConnected) lock(form, false); }
    });
  } catch (e) { if (turn === generation) fail(e.message); }
}
async function load() {
  const turn = ++generation; hideToken(); team = null; account = null; content.replaceChildren(); error.hidden = true;
  try { const value = await call('GET', '/api/account'); if (turn !== generation) return; account = value; status.textContent = 'Signed in as ' + (account.user.display_name ?? 'your account');
    const teams = staffTeams(account); if (!teams.length) { content.append(el('p', 'A staff membership is required to connect boards.')); return; }
    selection(content, teams, showTeam);
  } catch { if (turn !== generation) return; status.textContent = 'Sign in to manage your connections.'; signIn(content, load); }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) hideToken(); });
window.addEventListener('pagehide', () => { generation++; hideToken(); content.replaceChildren(); });
load();
