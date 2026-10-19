import { call, el, signIn, staffTeams, selection, boards, access, lock } from './remote-browser.js';
const status = document.getElementById('remote-status'), error = document.getElementById('remote-error'), content = document.getElementById('remote-content');
const params = new URLSearchParams(location.hash.slice(1)), intent = params.get('intent');
let generation = 0;
const fail = message => { error.textContent = message; error.hidden = false; };
async function load() {
  const turn = ++generation; content.replaceChildren(); error.hidden = true;
  if ([...params.keys()].length !== 1 || !/^[0-9a-f-]{36}$/i.test(intent ?? '')) { status.textContent = 'This connection request is invalid. Start again in your application.'; return; }
  try {
    const preview = await call('GET', '/oauth/consent?intent=' + encodeURIComponent(intent)); if (turn !== generation) return;
    status.textContent = `${preview.name} · unverified application`;
    content.append(el('p', 'Only approve an application you meant to connect. It can receive the content of the boards you select, including task text, comments and handoffs.'));
    if (!preview.signed_in) { signIn(content, load); return; }
    const account = preview.account, teams = staffTeams(account);
    content.append(el('p', `Connecting as ${account.user.display_name ?? 'your signed-in account'}. This grant expires within 30 days and survives signing out of this browser. You can revoke it in Your connections.`));
    if (!teams.length) { content.append(el('p', 'You need a staff membership in a team to connect boards.')); return; }
    const form = el('form'), choices = el('div'); let team = null, boardIds = () => [], mode = null;
    const select = selection(form, teams, chosen => {
      team = chosen; choices.replaceChildren(); if (!team) return;
      boardIds = boards(choices, team); mode = access(choices, team.role !== 'viewer' && preview.scope.includes('boards:collaborate'));
    }); form.append(choices);
    const approve = el('button', 'Allow selected access', { type: 'submit', className: 'btn btn-primary' });
    const cancel = el('button', 'Decline', { type: 'button', className: 'btn' }); form.append(approve, cancel); content.append(form);
    async function finish(approved) {
      if (!team || approved && !boardIds().length) { fail('Choose a team and at least one board.'); select.focus(); return; }
      lock(form, true); error.hidden = true;
      try {
        const current = await call('GET', '/api/account'); if (current.user.id !== account.user.id || turn !== generation) throw new Error('Your sign-in changed. Start this connection again.');
        const result = await call('POST', '/oauth/consent', { intent_id: intent, team_id: team.id, approve: approved, board_ids: approved ? boardIds() : [], mode: approved ? mode.value : 'read' }, current.csrf_token);
        if (turn !== generation) return;
        // The server returns only the durable registration-bound callback.
        const target = new URL(result.redirect_uri);
        if (!(target.protocol === 'https:' || target.protocol === 'http:' && target.hostname === '127.0.0.1') || target.username || target.password || target.hash) throw new Error('Reconnect from your application.');
        generation++; content.replaceChildren(el('p', approved ? 'Access approved. Returning to your application…' : 'Access declined. Returning to your application…')); location.assign(target.href);
      } catch (e) { if (turn === generation) { fail(e.message); lock(form, false); } }
    }
    form.addEventListener('submit', event => { event.preventDefault(); finish(true); }); cancel.addEventListener('click', () => finish(false));
  } catch (e) { if (turn === generation) fail(e.message); }
}
window.addEventListener('pagehide', () => { generation++; content.replaceChildren(); });
load();
