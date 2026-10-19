'use strict';
// Exact, human-written assignments use the existing shared-session controls.
// No model chooses targets, grants itself permission or retries provider work.
(() => {
  const api = window.overviewApi?.coordinator, $ = id => document.getElementById(id);
  const panel = $('coordinator-panel');
  if (!panel || !api || !['inventory', 'propose', 'confirm', 'results', 'cancel'].every(k => typeof api[k] === 'function')) return;
  panel.hidden = false;
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const text = (v, max) => typeof v === 'string' && v.length <= max;
  const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
  const hex = (v, n) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v);
  const el = (tag, value, cls) => { const node = document.createElement(tag); if (value != null) node.textContent = value; if (cls) node.className = cls; return node; };
  const button = (label, fn) => { const b = el('button', label); b.type = 'button'; b.addEventListener('click', fn); return b; };
  const targetText = t => t ? `${t.owner} · ${t.provider} · ${t.task} · ${t.device}` : 'No longer shared with you';
  const validTarget = t => object(t) && hex(t.id, 40) && ['owner', 'provider', 'task', 'device'].every(k => text(t[k], 400));
  const validPlan = r => object(r) && r.ok === true && uuid(r.proposal) && text(r.title, 120) && text(r.status, 80) && Number.isFinite(r.expiresAt)
    && Array.isArray(r.assignments) && r.assignments.length > 0 && r.assignments.length <= 6 && r.assignments.every(a => object(a) && uuid(a.assignment) && text(a.name, 80) && text(a.text, 4000) && text(a.status, 80) && text(a.reason, 600) && text(a.response, 16000)
      && (a.target === null || validTarget(a.target)) && (a.receipt === null || object(a.receipt) && text(a.receipt.id, 100) && text(a.receipt.state, 80)));
  let inventory = null, plan = null, revision = 0, busy = false, expiryTimer = null;
  const ownerRequests = ['requestOwner','remoteList','remoteSend','remoteCancel'].every(k => typeof api[k] === 'function');
  const rows = [];
  const status = message => { $('coordinator-status').textContent = message; };
  const failure = r => text(r?.error, 600) && r.error ? r.error : 'This action is unavailable. Check current sessions and review again.';
  function controls() {
    $('coordinator-refresh').disabled = busy;
    $('coordinator-add').disabled = busy || !inventory || rows.length >= 6;
    $('coordinator-review').disabled = busy || !inventory || rows.length === 0;
    $('coordinator-confirm').disabled = busy || !plan || plan.status !== 'review' || Date.now() > plan.expiresAt || !$('coordinator-results').querySelector('input[type="checkbox"]:checked');
    $('coordinator-replies').disabled = busy || !plan || plan.status === 'review';
    $('coordinator-request-owner').disabled = busy || !plan || plan.status !== 'review' || Date.now() > plan.expiresAt || !plan.assignments.some(a => a.status === 'review');
    $('coordinator-back').disabled = busy;
    for (const row of rows) for (const control of [row.name, row.target, row.message, row.remove, ...row.remote.querySelectorAll('button')]) control.disabled = busy;
  }
  function retire(message = '') {
    const old = plan; plan = null; revision++; clearTimeout(expiryTimer);
    $('coordinator-preview').hidden = true; $('coordinator-results').replaceChildren();
    for (const row of rows) row.decisions.replaceChildren();
    if (old?.status === 'review') void Promise.resolve(api.cancel({ proposal: old.proposal })).catch(() => {});
    if (message) status(message);
    controls();
  }
  function fillTargets(row) {
    const previous = row.target.value;
    row.target.replaceChildren(el('option', 'Choose a shared session'));
    row.target.firstChild.value = '';
    for (const entry of inventory?.entries ?? []) {
      const option = el('option', `${targetText(entry)}${entry.available ? '' : ` · ${entry.reason}`}`);
      option.value = entry.id; option.disabled = !entry.available; row.target.append(option);
    }
    if ([...row.target.options].some(o => o.value === previous && !o.disabled)) row.target.value = previous;
  }
  function addRow() {
    if (busy || !inventory || rows.length >= 6) return;
    retire();
    const box = el('fieldset', '', 'coordinator-assignment'), legend = el('legend', `Assignment ${rows.length + 1}`);
    const nameLabel = el('label', 'Assignment name'), name = el('input'); name.type = 'text'; name.maxLength = 80; name.setAttribute('aria-label', 'Assignment name'); nameLabel.append(name);
    const targetLabel = el('label', 'Shared session'), target = el('select'); target.setAttribute('aria-label', 'Assignment session'); targetLabel.append(target);
    const messageLabel = el('label', 'Exact message'), message = el('textarea'); message.maxLength = 4000; message.setAttribute('aria-label', 'Assignment message'); messageLabel.append(message);
    const remote = el('div'), decisions = el('div');
    const row = { box, name, target, message, remove: null, remote, decisions };
    if (ownerRequests) remote.append(button('Check owner decisions for this session', () => void ownerDecisions(row)), decisions);
    row.remove = button('Remove assignment', () => { if (busy) return; retire(); box.remove(); rows.splice(rows.indexOf(row), 1); controls(); });
    for (const n of [name, target, message]) n.addEventListener('input', () => retire('Draft changed. Review the exact assignments again.'));
    target.addEventListener('change', () => retire('Target changed. Review the exact assignments again.'));
    box.append(legend, nameLabel, targetLabel, messageLabel, row.remove, remote); rows.push(row); fillTargets(row); $('coordinator-assignments').append(box); controls();
  }
  async function refresh() {
    if (busy) return;
    retire(); const at = revision; busy = true; controls(); status('Checking the current shared sessions…');
    const selected = $('team-pick')?.value;
    let r; try { r = await api.inventory({ team: hex(selected, 32) ? selected : null }); } catch { r = null; }
    busy = false;
    if (at !== revision) { controls(); return; }
    if (!r?.ok || !object(r.team) || !hex(r.team.key, 32) || !text(r.team.name, 200) || !Array.isArray(r.entries) || r.entries.length > 300 || !r.entries.every(e => validTarget(e) && typeof e.available === 'boolean' && text(e.reason, 600))) {
      inventory = null; status(failure(r)); controls(); return;
    }
    inventory = r;
    for (const row of rows) fillTargets(row);
    if (!rows.length) addRow();
    status(`${r.team.name}: ${r.entries.filter(e => e.available).length} shared send channels. Review checks each session is idle before approval.`); controls();
  }
  function showPlan(r) {
    plan = r; const reviewing = r.status === 'review';
    $('coordinator-preview').hidden = false; $('coordinator-preview-title').textContent = r.title;
    const cards = r.assignments.map(a => {
      const card = el('article', '', 'coordinator-result'), h = el('h4', a.name);
      card.append(h, el('p', targetText(a.target), 'team-target'), el('p', a.text, 'delivery-text'));
      if (reviewing && a.status === 'review') {
        const label = el('label', '', 'coordinator-grant'), choice = el('input'); choice.type = 'checkbox'; choice.value = a.assignment;
        choice.addEventListener('change', controls); label.append(choice, el('span', `Allow “${a.name}” to send this one message`)); card.append(label);
      } else card.append(el('p', a.status === 'blocked' ? `Blocked: ${a.reason}` : a.status, 'reason'));
      if (a.reason && a.status !== 'blocked') card.append(el('p', a.reason, 'reason'));
      if (a.receipt) card.append(el('p', `Provider receipt: ${a.receipt.state}`, 'reason'));
      if (a.response) card.append(el('p', a.response, 'delivery-response'));
      else if (a.receipt) card.append(el('p', 'Waiting for output tied to this exact receipt. No automatic resend.', 'reason'));
      return card;
    });
    $('coordinator-results').replaceChildren(...cards);
    $('coordinator-confirm').hidden = !reviewing; $('coordinator-replies').hidden = reviewing;
    $('coordinator-request-owner').hidden = !reviewing || !ownerRequests;
    $('coordinator-back').textContent = reviewing ? 'Back to draft' : 'Close results';
    $('coordinator-expiry').textContent = reviewing ? `Approve by ${new Date(r.expiresAt).toLocaleTimeString()}. Each checked assignment grants one send only.` : 'Compare provider-reported output below. A receipt or response does not verify the work succeeded.';
    clearTimeout(expiryTimer);
    if (reviewing) expiryTimer = setTimeout(() => { if (plan === r) { $('coordinator-expiry').textContent = 'This review expired. Return to the draft and review current sessions again.'; controls(); } }, Math.max(0, r.expiresAt - Date.now() + 1));
    controls();
  }
  async function review() {
    if (busy || !inventory) return;
    retire(); const at = revision; busy = true; controls(); status('Checking the exact targets and their current turns…');
    const request = { team: inventory.team.key, title: $('coordinator-title').value.trim(), assignments: rows.map(r => ({ id: r.target.value, name: r.name.value.trim(), text: r.message.value.trim() })) };
    let r; try { r = await api.propose(request); } catch { r = null; }
    busy = false;
    if (at !== revision) { controls(); return; }
    if (!validPlan(r)) { status(failure(r)); controls(); return; }
    showPlan(r); status('Review each named target and exact message. Nothing has been sent.');
  }
  async function confirm() {
    if (busy || !plan || plan.status !== 'review' || Date.now() > plan.expiresAt) return;
    const grants = [...$('coordinator-results').querySelectorAll('input[type="checkbox"]:checked')].map(n => ({ assignment: n.value, operation: 'send' }));
    if (!grants.length) return;
    const selected = plan, at = revision; busy = true; controls(); status('Sending only the approved assignments…');
    let r; try { r = await api.confirm({ proposal: selected.proposal, grants }); } catch { r = null; }
    busy = false;
    if (at !== revision) { controls(); return; }
    if (!validPlan(r)) { retire(failure(r)); return; }
    showPlan(r); status(`${r.assignments.filter(a => a.status === 'sent').length} assignment(s) returned a correlated receipt. Check individual refusals or uncertain outcomes before acting again.`);
  }
  async function replies() {
    if (busy || !plan || plan.status === 'review') return;
    const selected = plan, at = revision; busy = true; controls(); status('Checking only the receipts from this proposal…');
    let r; try { r = await api.results({ proposal: selected.proposal }); } catch { r = null; }
    busy = false;
    if (at !== revision) { controls(); return; }
    if (!validPlan(r)) { retire(failure(r)); return; }
    showPlan(r); status('Results refreshed from the current authorized sessions.');
  }
  async function requestOwners() {
    if (!ownerRequests || busy || !plan || plan.status !== 'review' || Date.now() > plan.expiresAt) return;
    const selected = plan, at = revision; busy = true; controls(); status('Saving the listed requests for their session owners to review…');
    let r; try { r = await api.requestOwner({ proposal: selected.proposal }); } catch { r = null; }
    busy = false;
    if (at !== revision) { controls(); return; }
    if (!validPlan(r)) { retire(failure(r)); return; }
    showPlan(r); status('Requests saved where accepted. Owners review them in each session’s Share panel. Use Check owner decisions to see approval and send once. No provider work is started by requesting review.');
  }
  async function ownerDecisions(row, operation = null, proposal = null, replacement = null) {
    if (!ownerRequests || busy || !hex(row.target.value, 40)) return;
    const id = row.target.value, at = revision;
    busy = true; controls(); status(operation === 'send' ? 'Sending this owner-approved message once…' : 'Checking the selected session’s owner decisions…');
    let result, r;
    try {
      if (operation) result = await api[operation === 'send' ? 'remoteSend' : operation === 'replace' ? 'remoteReplace' : 'remoteCancel']({ selection: proposal.selection, ...(operation==='replace'?{text:replacement}:{}) });
      if (at === revision && row.target.value === id) r = await api.remoteList({ id });
    } catch { r = null; }
    busy = false;
    if (at !== revision || row.target.value !== id || !rows.includes(row)) { controls(); return; }
    row.decisions.replaceChildren();
    const valid = p => object(p) && uuid(p.selection) && uuid(p.id) && text(p.title,120) && text(p.text,4000) && Number.isSafeInteger(p.version) && text(p.status,80)
      && (p.receipt == null || object(p.receipt) && text(p.receipt.id,100) && text(p.receipt.state,80));
    if (!r?.ok || !Array.isArray(r.proposals) || r.proposals.length > 64 || !r.proposals.every(valid)) { status(failure(r)); controls(); return; }
    for (const p of r.proposals) {
      const card = el('article', '', 'coordinator-result');
      card.append(el('h4', p.title), el('p', `${row.target.selectedOptions[0]?.textContent || 'Selected session'} · version ${p.version} · ${p.status}`, 'reason'), el('p', p.text, 'delivery-text'));
      if (p.acknowledgedAt) card.append(el('p', `Owner acknowledged this exact version. Grant expires ${new Date(p.expiresAt).toLocaleString()}.`, 'reason'));
      if (p.status === 'approved') card.append(button('Send this approved message once', () => void ownerDecisions(row, 'send', p)));
      if (['pending','approved'].includes(p.status)) card.append(button('Cancel this request', () => void ownerDecisions(row, 'cancel', p)));
      if (typeof api.remoteReplace === 'function' && ['pending','approved','expired','refused','revoked','sent'].includes(p.status)) {
        const edit = el('details'), summary = el('summary','Revise this request'), label = el('label','New exact message'), input = el('textarea');
        input.value = p.text; input.maxLength = 4000; input.setAttribute('aria-label','Revised owner request'); label.append(input);
        edit.append(summary,label,el('p',`Creates decision version ${p.version+1} and retires an unused earlier grant. The owner must approve the new text.`, 'reason'),button('Send revised text for owner review',()=>void ownerDecisions(row,'replace',p,input.value)));
        card.append(edit);
      }

      if (p.receipt) card.append(el('p', `Provider receipt: ${p.receipt.id} (${p.receipt.state}). Open the session for its response.`, 'reason'));
      row.decisions.append(card);
    }
    if (!r.proposals.length) row.decisions.append(el('p', 'No retained owner requests for your account on this session.', 'reason'));
    status(operation && !result?.ok ? failure(result) : 'Owner decisions refreshed. Review the exact text and target before sending; grants permit one new turn and are never retried automatically.'); controls();
  }
  $('coordinator-refresh').addEventListener('click', () => void refresh());
  $('coordinator-add').addEventListener('click', addRow);
  $('coordinator-review').addEventListener('click', () => void review());
  $('coordinator-confirm').addEventListener('click', () => void confirm());
  $('coordinator-replies').addEventListener('click', () => void replies());
  $('coordinator-request-owner').addEventListener('click', () => void requestOwners());
  $('coordinator-back').addEventListener('click', () => retire('Draft retained. Review current sessions before sending again.'));
  $('coordinator-title').addEventListener('input', () => retire('Draft changed. Review the exact assignments again.'));
  $('team-pick')?.addEventListener('change', () => { retire('Team changed. Check its current shared sessions.'); inventory = null; for (const row of rows) { row.target.replaceChildren(); row.message.value = ''; } controls(); });
  $('tab-mine')?.addEventListener('click', () => retire());
  window.addEventListener('blur', () => retire('Review retired while Plexiform was in the background. Your draft is retained.'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) retire(); });
  controls();
})();
