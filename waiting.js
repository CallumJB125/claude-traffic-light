// The "Waiting on you" page: every stuck input across sessions, with the
// same answer controls as the widget bubble (input-bubble.js).
(function () {
  const api = window.waitingApi;
  const V = window.InputView;
  document.title = `Waiting on you — ${window.Brand.name}`;
  // Its own window has the macOS buttons over the header; the Plexiform
  // window's content view does not.
  if (new URLSearchParams(location.search).get('embedded') !== '1') document.body.classList.add('standalone');
  const sub = document.getElementById('sub');
  const list = window.InputBubble.create(document.getElementById('list'), {
    mode: 'page',
    api: {
      answerInput: (id, optionId, more) => api.answerInput(id, optionId, more),
      openInput: (id) => api.openInput(id),
      copyCommand: (id) => api.copyInputCommand(id),
      openAutoRule: (id) => api.openAutoRule({ inputId: id }),
      nudgeRule: (key) => api.openAutoRule({ nudgeKey: key }),
      nudgeMute: (key) => api.nudgeMute(key),
      setSessionScope: (id, mode) => api.setSessionScope(id, mode),
      setRepoScope: (url, mode) => api.setRepoScope(url, mode),
    },
  });
  let seq = 0;
  async function refresh() {
    const my = ++seq;
    let r;
    try { r = await api.getInputs(); } catch { return; }
    if (my !== seq || !r) return;
    const inputs = Array.isArray(r.inputs) ? r.inputs : [];
    document.body.classList.toggle('answering-off', !r.askFromWidget);
    list.update(inputs, { scopes: r.scopes || {} });
    const late = inputs.filter((i) => V.escalated(i)).length;
    sub.textContent = inputs.length
      ? `${inputs.length} waiting${late ? ` · ${late} for 5 min or more` : ''}`
      : 'Nothing is waiting on you.';
  }
  document.addEventListener('keydown', (e) => { list.keydown(e); });
  api.onStatusChanged(refresh);
  // In the Plexiform window nothing pushes status here: poll while shown.
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 3000);
  setInterval(() => list.tick(), 15000);
  refresh();
})();
