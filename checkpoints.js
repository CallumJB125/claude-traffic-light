'use strict';
const api = window.checkpointsApi;
const $ = id => document.getElementById(id);
const status = $('status'), turnsBox = $('turns'), select = $('session');
const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
const button = (text, onClick) => { const b = node('button', text); b.type = 'button'; b.addEventListener('click', onClick); return b; };
const when = ms => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const folder = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p || 'Unknown folder';
const SKIP = { 'not-git': 'This folder is not a git repository, so it has no checkpoints.', filters: 'This repository defines its own git filters or includes, so Plexiform does not checkpoint it.', 'no-git': 'git was not found on this computer.', unknown: 'No checkpoints for this session yet.', error: 'Checkpoints for this session could not be read.' };
const REASON = { busy: 'An AI turn is still running in this folder. Try again when it finishes.', missing: 'That checkpoint is gone (it may have been cleaned up).', cancelled: null, moved: 'The project folder has moved.', unknown: 'No checkpoints for this session.', failed: 'Restoring failed. Your files were not changed past the safety checkpoint.' };
const UNDO_REASON = { ...REASON, failed: 'Undo did not finish. Refresh and inspect the saved safety checkpoint before trying again.', stale: 'The review changed or expired. Review this turn again before undoing it.', unavailable: 'This turn is no longer available for Undo.', unattributed: 'Undo needs an exact start and end captured by this version of Plexiform.', overlap: 'Another observed session worked in this folder during this turn. Review and integrate isolated work instead.', attributes: 'Undo cannot safely reproduce this repository’s Git content transformations.', interrupted: 'Work changed while Undo ran. Some files may have been restored; inspect the safety checkpoint before continuing.' };
const SKIPPED = { 'later-change': 'Keep: changed after this turn', 'unsupported-path': 'Keep: linked, large or unsupported path', attributes: 'Keep: Git content transformations', metadata: 'Keep: deleted files and permission changes need their original filesystem metadata' };
let current = null, generation = 0, state = null;

function renderPatch(text, truncated) {
  const pre = node('pre', null, 'patch');
  for (const line of text.split('\n')) {
    const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('@@') ? 'h' : line.startsWith('+') ? 'a' : line.startsWith('-') ? 'd' : null;
    pre.append(node('span', `${line}\n`, cls));
  }
  if (truncated) pre.append(node('span', '[Too long to show in full]\n', 'h'));
  return pre;
}

async function showDiff(holder, turn, file) {
  const open = holder.querySelector('.patch');
  if (open && open.dataset.file === (file ?? '')) { open.remove(); return; }
  open?.remove();
  const d = await api.diff(current, turn, file ?? null);
  if (!d) { status.textContent = 'That change could not be shown.'; return; }
  const pre = renderPatch(d.text || '(no text changes)', d.truncated);
  pre.dataset.file = file ?? '';
  holder.append(pre);
}

async function restore(target) {
  const r = await api.restore(current, target);
  if (!r) return;
  if (r.ok) status.textContent = `Files restored (${r.written} written, ${r.removed} removed). A safety checkpoint of the previous state is listed below.`;
  else if (REASON[r.reason]) status.textContent = REASON[r.reason];
  await loadTurns();
}

async function reviewUndo(holder, turn) {
  const id = current, request = generation;
  holder.querySelector('.undo-review')?.remove();
  const r = await api.previewUndo(id, turn).catch(() => null);
  if (current !== id || generation !== request || !holder.isConnected) return;
  if (!r?.ok) { status.textContent = UNDO_REASON[r?.reason] || 'This turn could not be reviewed.'; return; }
  const panel = node('section', null, 'undo-review');
  panel.setAttribute('aria-label', `Review Undo for turn ${turn}`);
  panel.append(node('h4', `Undo turn ${turn}`), node('p', `${r.eligible} file(s) to undo · ${r.skipped} kept. Later edits are preserved. This review expires in 45 seconds.`, 'muted'), node('p', 'Check every path: a turn captures project changes during that time, including edits made outside the agent. Stop other writers before continuing.', 'note'));
  const files = node('ul', null, 'files');
  for (const f of r.files) files.append(node('li', `${f.path} — ${f.reason ? SKIPPED[f.reason] || 'Keep' : f.action === 'remove' ? 'Remove the unchanged file added by this turn' : 'Restore its content from before this turn'}`));
  const apply = button('Undo reviewed files', async () => {
    if (current !== id || generation !== request || !panel.isConnected) return;
    apply.disabled = true;
    const result = await api.undo(id, r.token).catch(() => null);
    if (current !== id) return;
    await loadTurns();
    if (current !== id) return;
    status.textContent = result?.ok ? `Turn undone: ${result.written} restored, ${result.removed} removed, ${result.skipped} kept.${result.safety ? ' A safety checkpoint is available below.' : ''}` : UNDO_REASON[result?.reason] || 'Undo could not be completed. Refresh before trying again.';
  });
  apply.disabled = !r.eligible;
  panel.append(files, apply, button('Cancel', () => { panel.remove(); void api.cancelUndo?.(id, r.token).catch(() => {}); }));
  holder.append(panel);
}

function renderTurn(t) {
  const el = node('div', null, 'turn');
  const head = node('div', null, 'turn-head');
  const title = node('div');
  const files = t.files ?? [];
  const add = files.reduce((n, f) => n + (f.add ?? 0), 0), del = files.reduce((n, f) => n + (f.del ?? 0), 0);
  title.append(node('h3', `Turn ${t.turn}${t.running ? ' · running' : ''}`));
  const summary = node('p', `${when(t.at)} · `, 'muted');
  if (t.files) { summary.append(`${files.length} file${files.length === 1 ? '' : 's'} `, node('span', `+${add}`, 'add'), ' ', node('span', `−${del}`, 'del')); }
  else summary.append(t.running ? 'In progress' : 'Changes unknown: Plexiform did not see this turn start');
  title.append(summary);
  const actions = node('div', null, 'actions');
  if (t.files?.length) actions.append(button('Show all changes', () => showDiff(el, t.turn, null)));
  if (t.files?.length && t.undoAvailable) actions.append(button('Review Undo this turn', () => reviewUndo(el, t.turn)));
  if (t.hasBefore) actions.append(button(`Restore whole project before turn ${t.turn}`, () => restore({ turn: t.turn, which: 'before' })));
  if (t.hasAfter) actions.append(button(`Restore whole project after turn ${t.turn}`, () => restore({ turn: t.turn, which: 'after' })));
  head.append(title, actions);
  el.append(head);
  if (t.approx) el.append(node('p', 'Plexiform did not see this turn start, so "before" is the end of the turn before it and may include your own edits.', 'note'));
  if (t.files?.length && !t.running && !t.undoAvailable) el.append(node('p', UNDO_REASON[t.undoReason] || UNDO_REASON.unattributed, 'note'));
  if (files.length) {
    const list = node('ul', null, 'files');
    for (const f of files) {
      const li = node('li');
      li.append(node('span', f.status, 'st'), button(f.path, () => showDiff(el, t.turn, f.path)), node('span', f.add == null ? 'binary' : `+${f.add} −${f.del}`, 'muted'));
      list.append(li);
    }
    el.append(list);
  } else if (t.files) el.append(node('p', 'No file changes in this turn.', 'note'));
  if (t.review?.ok) el.append(node('div', t.review.text, 'review'));
  else if (t.review && !t.review.ok) el.append(node('p', 'The second-opinion review did not complete.', 'note'));
  return el;
}

async function loadTurns() {
  const request = ++generation;
  if (!current) { turnsBox.replaceChildren(); return; }
  const data = await api.turns(current).catch(() => null);
  if (request !== generation) return;
  turnsBox.replaceChildren();
  if (!data) { status.textContent = SKIP.error; return; }
  if (data.skip) { status.textContent = SKIP[data.skip] ?? SKIP.unknown; return; }
  status.textContent = data.turns.length ? `${data.turns.length} checkpoint${data.turns.length === 1 ? '' : 's'} for this session.` : SKIP.unknown;
  for (const t of data.turns) turnsBox.append(renderTurn(t));
  if (data.safety.length) {
    const box = node('div', null, 'turn');
    box.append(node('h3', 'Before your restores'), node('p', 'Plexiform saved these just before each restore, so a restore can be undone.', 'muted'));
    for (const s of data.safety) {
      const row = node('div', null, 'row');
      row.append(node('span', when(Number(s.id))), button('Put these files back', () => restore({ safety: s.id })));
      box.append(row);
    }
    turnsBox.append(box);
  }
}

function renderState(s) {
  state = s;
  $('enabled').checked = s.enabled;
  $('limits').textContent = `Keeps ${s.limits.turns === Infinity || s.limits.turns == null ? 'every turn' : `the last ${s.limits.turns} turns`} per session, for up to ${s.limits.days} days.`;
  const keep = current;
  select.replaceChildren();
  for (const x of s.sessions) {
    const o = node('option', `${folder(x.top || x.cwd)} · ${x.source || 'AI'} · ${when(x.updatedAt)}${x.skip ? ' · not checkpointed' : ''}`);
    o.value = x.id; select.append(o);
  }
  current = s.sessions.some(x => x.id === keep) ? keep : s.sessions[0]?.id ?? null;
  if (current) select.value = current;
  if (!s.sessions.length) {
    const o = node('option', 'No sessions yet'); o.value = ''; o.disabled = true; o.selected = true; select.append(o);
    status.textContent = s.enabled ? 'No sessions yet. Checkpoints appear after the next AI turn in a git repository.' : 'No sessions yet. Switch on checkpoints above, and each AI turn in a git repository will show up here.';
  }
  select.disabled = !s.sessions.length;
  const model = $('review-model');
  model.replaceChildren(...s.models.map(m => { const o = node('option', m); o.value = m; return o; }));
  model.value = s.review.model;
  $('review-enabled').checked = s.review.enabled;
  $('review-enabled').disabled = !s.reviewAllowed;
  model.disabled = !s.reviewAllowed;
  $('review-cap').textContent = `Budget cap per review: $${s.review.maxBudgetUsd.toFixed(2)}`;
  $('review-badge').hidden = s.reviewAllowed;
  $('review-note').textContent = s.reviewAllowed ? '' : "Second opinion isn't part of your current plan.";
}

async function refresh() {
  const s = await api.state().catch(() => null);
  if (!s) { status.textContent = 'Checkpoints are unavailable.'; return; }
  renderState(s);
  await loadTurns();
}

$('enabled').addEventListener('change', async e => { renderState(await api.set({ enabled: e.target.checked })); });
$('review-enabled').addEventListener('change', async e => { renderState(await api.set({ review: { ...state.review, enabled: e.target.checked } })); });
$('review-model').addEventListener('change', async e => { renderState(await api.set({ review: { ...state.review, model: e.target.value } })); });
select.addEventListener('change', () => { current = select.value; void loadTurns(); });
$('refresh').addEventListener('click', () => void refresh());
api.changed(() => void refresh());
void refresh();
