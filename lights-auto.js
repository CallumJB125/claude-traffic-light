// Lights → Auto-answer: the rules list and the form for one rule. Main says
// why a rule can't be saved (check-auto-rule, src/auto-rules.js) and checks
// again on save, so this page can only ask, never force. Text from a prefill
// (a command an agent ran) only ever goes into input values and textContent.
(function () {
  const api = window.lightsApi;
  const $ = (id) => document.getElementById(id);
  const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep'];
  const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep']);
  let rules = [];
  let editing = null; // id of the rule in the form, or null for a new one
  let action = 'allow';
  let checkSeq = 0;
  let refusedReason = 'Pick at least one tool.';

  const toolBoxes = TOOLS.map((t) => {
    const lab = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = t;
    box.addEventListener('change', changed);
    lab.append(box, document.createTextNode(t));
    $('auto-tools').appendChild(lab);
    return box;
  });

  function formRule() {
    const tools = toolBoxes.filter((b) => b.checked).map((b) => b.value);
    const mcp = $('auto-mcp').value.trim();
    if (mcp) tools.push(mcp);
    const shell = tools.includes('Bash');
    const file = tools.some((t) => FILE_TOOLS.has(t));
    return {
      id: editing || undefined,
      action, tools,
      command: shell ? $('auto-command').value.trim() || null : null,
      path: file ? $('auto-path').value.trim() || null : null,
      cwd: $('auto-cwd').value.trim() || null,
      note: $('auto-note').value.trim(),
      enabled: true,
    };
  }

  function setAction(a) {
    action = a;
    for (const [id, v] of [['auto-allow', 'allow'], ['auto-deny', 'deny']]) {
      $(id).classList.toggle('on', a === v);
      $(id).setAttribute('aria-checked', String(a === v));
    }
    changed();
  }
  $('auto-allow').addEventListener('click', () => setAction('allow'));
  $('auto-deny').addEventListener('click', () => setAction('deny'));

  async function changed() {
    const r = formRule();
    $('auto-command-row').hidden = !r.tools.includes('Bash');
    $('auto-path-row').hidden = !r.tools.some((t) => FILE_TOOLS.has(t));
    const my = ++checkSeq;
    let reason;
    try { reason = (await api.checkAutoRule(r)).reason; } catch { reason = 'Could not check this rule.'; }
    if (my !== checkSeq) return;
    refusedReason = reason;
    const why = $('auto-why');
    why.className = reason ? 'refused' : 'ok';
    why.textContent = reason ? `Can’t save: ${reason}` : action === 'allow' ? 'OK: deny-listed or destructive calls still wait for you.' : 'OK';
    $('auto-save').disabled = !!reason;
  }
  for (const id of ['auto-mcp', 'auto-command', 'auto-path', 'auto-cwd']) $(id).addEventListener('input', changed);

  function fill(rule) {
    const r = rule || {};
    editing = r.id || null;
    $('auto-form-title').textContent = editing ? 'Edit rule' : 'New rule';
    const tools = Array.isArray(r.tools) ? r.tools : [];
    for (const b of toolBoxes) b.checked = tools.includes(b.value);
    $('auto-mcp').value = tools.find((t) => !TOOLS.includes(t)) || '';
    $('auto-command').value = r.command || '';
    $('auto-path').value = r.path || '';
    $('auto-cwd').value = r.cwd || '';
    $('auto-note').value = r.note || '';
    setAction(r.action === 'deny' ? 'deny' : 'allow');
  }

  const describe = (r) => (r.command || r.path || 'any use');
  function render() {
    const list = $('auto-list');
    if (!rules.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No rules yet. Every permission prompt waits for you.';
      list.replaceChildren(li);
      return;
    }
    list.replaceChildren(...rules.map((r) => {
      const li = document.createElement('li');
      if (!r.enabled) li.classList.add('off');
      const pill = document.createElement('span');
      pill.className = `pill ${r.action}`;
      pill.textContent = r.action === 'deny' ? 'Deny' : 'Allow';
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = `${r.tools.join(', ')}: ${describe(r)}`;
      what.title = r.note ? `${what.textContent} — ${r.note}` : what.textContent;
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = r.cwd ? `in ${r.cwd}` : 'any project';
      const on = document.createElement('input');
      on.type = 'checkbox';
      on.checked = r.enabled;
      on.setAttribute('aria-label', `Rule on: ${what.textContent}`);
      on.addEventListener('change', () => save(rules.map((x) => (x.id === r.id ? { ...x, enabled: on.checked } : x))));
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn ghost';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => { fill(r); $('auto-form').scrollIntoView({ block: 'nearest' }); });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn ghost danger';
      del.textContent = 'Delete';
      del.setAttribute('aria-label', `Delete rule: ${what.textContent}`);
      del.addEventListener('click', () => save(rules.filter((x) => x.id !== r.id)));
      li.append(pill, what, where, on, edit, del);
      return li;
    }));
  }

  async function save(next) {
    const cfg = await api.saveConfig({ autoAnswer: { v: 1, rules: next } });
    rules = (cfg && cfg.autoAnswer && cfg.autoAnswer.rules) || [];
    render();
    return rules;
  }

  $('auto-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (refusedReason) return;
    const r = { ...formRule(), id: editing || `ar_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: new Date().toISOString() };
    const next = editing ? rules.map((x) => (x.id === editing ? r : x)) : [...rules, r];
    const saved = await save(next);
    if (!saved.some((x) => x.id === r.id)) { $('auto-why').className = 'refused'; $('auto-why').textContent = 'The app refused this rule.'; return; }
    fill(null);
    $('auto-why').className = 'ok';
    $('auto-why').textContent = 'Saved.';
  });
  $('auto-cancel').addEventListener('click', () => fill(null));

  // From the widget: "make it a rule" or a blocked call's "Add a rule".
  api.onAutoRulePrefill((rule) => { fill({ ...rule, id: null }); $('auto-command').focus(); });

  (async () => {
    const cfg = await api.getConfig();
    rules = (cfg.autoAnswer && cfg.autoAnswer.rules) || [];
    render();
    fill(null);
  })();
})();
