// About & Updates renderer. Everything from the feed (release notes, error
// detail) goes in with textContent / createElement; never innerHTML.
(function () {
  const UV = window.UpdateView;
  const $ = (id) => document.getElementById(id);
  const api = window.updates;
  let state = null;
  let confirming = false; // "Restart anyway?" is showing (a session is busy, or an install was deferred)
  let armed = false; // "when you're not working" was asked for this ready update
  let ask = null; // another question: switch to Beta, revert
  let failure = null;
  let lastKey = null;

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }

  async function run(id) {
    const c = UV.COMMANDS[id];
    if (!c || !api) return;
    failure = null;
    const r = await api[c.name](c.arg).catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
    // A deferred install-now means a session is busy: ask before forcing. The
    // state that names the session may arrive after this answer, so the question
    // does not wait for it.
    if (id === 'install-now' && r && r.deferred) confirming = true;
    else if (id === 'install-idle' && r && r.ok !== false) armed = true;
    else failure = UV.commandFailure(r);
    render();
  }

  const viewOf = () => UV.view(state, { armed, deferred: confirming });

  function button(b) {
    const n = el('button', { type: 'button', class: b.primary ? 'primary' : '', 'data-action': b.id, disabled: b.disabled }, b.label);
    n.addEventListener('click', () => {
      if (b.id === 'install-now' && viewOf().busyReason) { confirming = true; render(); return; }
      run(b.id);
    });
    return n;
  }

  function renderNotes(blocks) {
    const out = [];
    for (const b of blocks) {
      const build = (segs) => segs.map((s) => (s.bold ? el('b', {}, s.text) : document.createTextNode(s.text)));
      if (b.type === 'ul') out.push(el('ul', {}, ...b.items.map((it) => el('li', {}, ...build(it)))));
      else out.push(el('p', {}, ...build(b.items[0])));
    }
    return out;
  }

  // Only repaint when what is drawn changed, so focus and the live regions are
  // not reset by every state push or the minute timer.
  function render() {
    const vm = viewOf();
    const question = ask || (confirming && vm.restartConfirm
      ? { text: vm.restartConfirm.text, yes: vm.restartConfirm.confirmLabel, no: vm.restartConfirm.cancelLabel, yesId: vm.restartConfirm.confirmId, onYes: () => { confirming = false; run(vm.restartConfirm.confirmId); } }
      : null);
    const key = JSON.stringify([vm, question && [question.text, question.yes, question.no], failure]);
    if (key === lastKey) return;
    lastKey = key;

    $('name').textContent = vm.name;
    $('current').textContent = vm.present ? vm.currentLine.slice(vm.name.length + 1) : '';
    $('headline').textContent = vm.headline;
    $('last-checked').textContent = vm.lastChecked || '';
    $('last-checked').hidden = !vm.lastChecked;

    $('buttons').replaceChildren(...vm.buttons.map(button));

    const bar = $('bar');
    bar.hidden = !vm.progress;
    if (vm.progress) {
      bar.classList.toggle('indeterminate', vm.progress.percent === null);
      bar.firstElementChild.style.width = vm.progress.percent === null ? '' : `${vm.progress.percent}%`;
      if (vm.progress.percent !== null) bar.setAttribute('aria-valuenow', String(vm.progress.percent)); else bar.removeAttribute('aria-valuenow');
      bar.setAttribute('aria-label', vm.progress.label);
    }
    $('size').hidden = !vm.size;
    $('size').textContent = vm.size ? `Download size: ${vm.size}` : '';

    const m = $('message');
    m.hidden = !vm.message;
    if (vm.message) {
      m.className = `msg ${vm.message.tone === 'info' ? '' : vm.message.tone}`;
      $('message-text').textContent = vm.message.text;
      $('message-detail').hidden = !vm.message.detail;
      $('message-detail').textContent = vm.message.detail || '';
    }
    $('failure').hidden = !failure;
    $('failure').textContent = failure || '';

    $('confirm').hidden = !question;
    if (question) {
      $('confirm-text').textContent = question.text;
      const yes = el('button', { type: 'button', class: 'primary', 'data-action': question.yesId || 'confirm-yes' }, question.yes);
      yes.addEventListener('click', () => { const fn = question.onYes; confirming = false; ask = null; if (fn) fn(); render(); });
      const no = el('button', { type: 'button', 'data-action': 'cancel-confirm' }, question.no);
      no.addEventListener('click', () => { confirming = false; ask = null; render(); });
      $('confirm-buttons').replaceChildren(yes, no);
    }

    $('notes-card').hidden = !(vm.notes && vm.notes.length);
    $('notes').replaceChildren(...(vm.notes ? renderNotes(vm.notes) : []));

    $('settings-card').hidden = !vm.present;
    $('channels').replaceChildren(...vm.channels.map((c) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(c.on), 'data-channel': c.id }, c.label);
      b.addEventListener('click', () => {
        if (c.on || !api) return;
        if (c.id === 'beta') { const q = vm.betaConfirm; ask = { text: q.text, yes: q.confirmLabel, no: q.cancelLabel, yesId: 'confirm-beta', onYes: () => api.setChannel('beta') }; render(); } else api.setChannel(c.id);
      });
      return b;
    }));
    $('auto-download').checked = vm.autoDownload;
    $('revert-row').hidden = !vm.revert;
    if (vm.revert) {
      $('revert').textContent = vm.revert.label;
      $('revert').disabled = vm.revert.disabled;
      $('revert-explain').textContent = vm.revert.explain;
    }
  }

  $('auto-download').addEventListener('change', (e) => { if (api) api.setAutoDownload(e.target.checked); });
  $('revert').addEventListener('click', () => {
    const q = viewOf().revert;
    if (q) { ask = { text: q.confirm.text, yes: q.confirm.confirmLabel, no: q.confirm.cancelLabel, yesId: 'confirm-revert', onYes: () => run('revert') }; render(); }
  });

  function take(s) {
    // a refused request answers { ok: false, error: 'forbidden' }, not a state
    state = s && s.status ? s : null;
    if (!state || state.status !== 'ready') { confirming = false; armed = false; }
    failure = null;
    render();
  }
  if (api) {
    api.onState(take);
    api.getState().then(take).catch(() => take(null));
  } else render();
  // "Last checked 2 hours ago" ages on its own.
  setInterval(() => { if (state) render(); }, 60000);
})();
