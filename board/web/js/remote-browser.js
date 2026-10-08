// Fixed same-origin paths only. Token and consent responses stay in memory;
// no storage, logs, URL token parameters or third-party page resources.
export async function call(method, path, body, csrf) {
  const res = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: { // privacy-flow: remote-board-browser
    accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(csrf ? { 'x-csrf-token': csrf } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error(res.status === 401 || res.status === 403
    ? 'This connection request expired or your sign-in changed. Reload and try again.' : 'This request could not be completed. Reload and try again.');
  return data;
}
export function el(tag, text, props = {}) { const node = document.createElement(tag); if (text != null) node.textContent = text; Object.assign(node, props); return node; }
export function signIn(parent, reload) {
  parent.append(el('p', 'Sign in to this hub in a separate tab, then return here.'), el('a', 'Sign in', { href: '/signin', target: '_blank', rel: 'noopener noreferrer' }));
  const button = el('button', 'I have signed in', { type: 'button', className: 'btn' }); button.addEventListener('click', reload); parent.append(button);
}
export const staffTeams = account => (account?.teams ?? []).filter(team => ['owner', 'admin', 'member', 'viewer'].includes(team.role));
export function selection(parent, teams, changed) {
  const label = el('label', 'Team'), select = el('select', null, { className: 'input', required: true });
  select.append(el('option', 'Choose a team', { value: '' }));
  for (const team of teams) select.append(el('option', team.name, { value: team.id }));
  label.append(select); parent.append(label); select.addEventListener('change', () => changed(teams.find(team => team.id === select.value) ?? null)); return select;
}
export function boards(parent, team) {
  const group = el('fieldset'), legend = el('legend', 'Boards the application may access'); group.append(legend); const inputs = [];
  for (const board of team.boards.filter(board => !board.archived_at)) {
    const label = el('label'), input = el('input', null, { type: 'checkbox', value: board.id }); inputs.push(input); label.append(input, document.createTextNode(board.name)); group.append(label);
  }
  parent.append(group); return () => inputs.filter(input => input.checked).map(input => input.value);
}
export function access(parent, mayWrite) {
  const label = el('label', 'Access'), select = el('select', null, { className: 'input' });
  select.append(el('option', 'Read selected boards', { value: 'read' }));
  if (mayWrite) select.append(el('option', 'Read and collaborate on selected boards', { value: 'collaborate' }));
  label.append(select); parent.append(label); return select;
}
export function lock(form, busy) { for (const input of form.querySelectorAll('input,select,button')) input.disabled = busy; }
