'use strict';
// My setup: export to a file, import with a full preview, Apply with a backup
// first, Undo from that backup. Also renders the same preview for a team setup.
// Text only ever goes in with textContent; nothing here runs anything.
(function () {
  const api = window.setupsApi?.personal;
  const root = document.getElementById('personal');
  if (!api || !root) return;
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = String(text); if (cls) n.className = cls; return n; };
  const say = (node, text) => { node.textContent = text; };
  let gen = 0;
  const KIND = { rules: 'Rules', skill: 'Skill', command: 'Command', agent: 'Agent', setting: 'Setting', mcp: 'MCP server', unsupported: 'Not applied' };

  function button(text, fn, cls) {
    const b = el('button', text, cls);
    b.type = 'button';
    b.onclick = async () => { if (b.disabled) return; b.disabled = true; try { await fn(); } catch { /* the status line already says what happened */ } finally { if (b.isConnected) b.disabled = false; } };
    return b;
  }
  function checkbox(text, onchange) {
    const label = el('label'), box = el('input');
    box.type = 'checkbox';
    box.onchange = onchange;
    label.append(box, document.createTextNode(` ${text}`));
    return { label, box };
  }
  function diffView(diff) {
    const pre = el('pre', undefined, 'personal-diff');
    for (const d of diff) pre.append(el('span', `${d.op} ${d.text}\n`, d.op === '+' ? 'add' : d.op === '-' ? 'del' : 'same'));
    return pre;
  }

  const status = el('p', 'Your setup stays on this computer until you save an export file.');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const area = el('div');
  root.replaceChildren(
    el('h2', 'My setup'),
    el('p', 'Export your rules, skills, commands, agents, MCP entries and hook-free Claude Code settings to a file, then import it on another computer. Secrets and hooks are never exported. Importing shows every change first and runs nothing.'),
    button('Export my setup…', exportDraft),
    button('Import a setup file…', importFile),
    button('Backups and Undo', showBackups),
    status, area,
  );

  async function exportDraft() {
    const mine = ++gen;
    say(status, 'Reading your setup…');
    area.replaceChildren();
    const draft = await api.collect();
    if (mine !== gen) return;
    if (!draft?.ok) { say(status, draft?.error ?? 'Your setup could not be read.'); return; }
    say(status, `Review ${draft.files.length} file${draft.files.length === 1 ? '' : 's'}. Untick anything you do not want in the file.`);
    const rows = [];
    for (const f of draft.files) {
      const section = el('section');
      const inc = checkbox(`Include ${f.relative_path}`, () => { reviewed.box.checked = false; update(); });
      inc.box.checked = true;
      rows.push({ id: f.id, box: inc.box });
      section.append(el('h3', `${KIND[f.kind] ?? f.kind} · ${f.relative_path}`), inc.label);
      if (f.code) section.append(el('p', 'Not plain text: whoever imports this is asked to confirm it separately.'));
      section.append(el('pre', f.content));
      area.append(section);
    }
    if (draft.dropped_settings?.length) area.append(el('p', `Left out of settings: ${draft.dropped_settings.join(', ')}. Hooks and anything that runs commands are never exported.`));
    if (draft.withheld?.length) { const d = el('details'); d.append(el('summary', `${draft.withheld.length} file${draft.withheld.length === 1 ? '' : 's'} left out`), el('pre', draft.withheld.map((w) => `${w.path}: ${w.reason}`).join('\n'))); area.append(d); }
    const reviewed = checkbox('I reviewed every included file for private details.', () => update());
    const save = button('Save export file…', async () => {
      if (mine !== gen) return;
      const r = await api.exportFile(draft.handle, rows.filter((r) => !r.box.checked).map((r) => r.id));
      if (mine !== gen) return;
      say(status, r?.ok ? `Exported ${r.files} file${r.files === 1 ? '' : 's'}.` : r?.error ?? 'Export failed.');
    });
    const update = () => { save.disabled = !reviewed.box.checked || !rows.some((r) => r.box.checked); };
    area.append(reviewed.label, save);
    update();
  }

  async function importFile() {
    const mine = ++gen;
    area.replaceChildren();
    const plan = await api.importFile();
    if (mine !== gen) return;
    if (!plan?.ok) { say(status, plan?.error ?? 'That file could not be imported.'); return; }
    renderPlan(area, plan, status, () => mine === gen);
  }

  // A plan from a file or a team: every change with its full before/after, per
  // change opt-in, and a separate tick for each MCP server, permission or
  // runnable file. Apply stays off until every one of those is confirmed.
  function renderPlan(container, plan, line, current = () => true) {
    container.replaceChildren();
    const ready = plan.units.filter((u) => u.status === 'ready');
    say(line, ready.length ? `Review ${ready.length} change${ready.length === 1 ? '' : 's'} from ${plan.origin === 'team' ? 'this team setup' : 'this file'}. Nothing has changed yet.` : 'Nothing in this setup can be applied here.');
    container.append(el('h3', plan.origin === 'team' ? 'Apply this team setup on this computer' : 'Imported setup'), el('p', 'Imported setups are untrusted until you review them. A backup is saved before anything changes, and Undo restores it.'));
    if (plan.dropped?.length) container.append(el('p', `Never imported: ${plan.dropped.map((d) => `${d.key} (${d.reason})`).join('; ')}.`));
    const rows = [], values = new Map();
    for (const u of plan.units) {
      const section = el('section', undefined, 'personal-unit');
      section.append(el('h4', `${KIND[u.kind] ?? u.kind} · ${u.label}`), el('p', `${u.target} · ${u.status === 'ready' ? 'will change' : u.status === 'unchanged' ? 'already the same' : u.status === 'unsupported' ? 'shown for review only' : 'cannot be applied'}`));
      if (u.reason) section.append(el('p', u.reason));
      if (u.command) section.append(el('p', 'Command Claude Code will start when it loads this server:'), el('pre', u.command, 'personal-command'));
      if (u.diff?.length) section.append(diffView(u.diff));
      else if (u.after) section.append(el('pre', u.after));
      if (u.status === 'ready') {
        const pick = checkbox('Apply this change', () => sync());
        section.append(pick.label);
        let confirm = null;
        if (u.requires_confirm) { confirm = checkbox(`I confirm this ${u.kind === 'mcp' ? 'MCP server and its command' : u.kind === 'setting' ? 'permission change' : 'runnable file'} exactly as shown.`, () => sync()); section.append(confirm.label); }
        for (const name of u.placeholders ?? []) {
          if (values.has(name)) continue;
          const label = el('label', `Your own value for ${name}`), input = el('input');
          input.type = name.startsWith('SECRET:') ? 'password' : 'text';
          input.autocomplete = 'off';
          input.maxLength = 4096;
          input.oninput = () => sync();
          label.append(input);
          values.set(name, input);
          section.append(label);
        }
        rows.push({ u, pick: pick.box, confirm: confirm?.box ?? null });
      }
      container.append(section);
    }
    const result = el('p');
    result.setAttribute('role', 'status');
    const apply = button('Apply selected changes…', async () => {
      if (!current()) return;
      const chosen = rows.filter((r) => r.pick.checked);
      const vals = Object.fromEntries([...values].filter(([, i]) => i.value !== '').map(([k, i]) => [k, i.value]));
      const r = await api.apply(plan.handle, { selected: chosen.map((r) => r.u.id), confirmed: chosen.filter((r) => r.confirm?.checked).map((r) => r.u.id), values: vals });
      for (const input of values.values()) input.value = '';
      if (!current()) return;
      if (!r?.ok) { say(result, r?.error ?? 'Apply failed. Nothing was changed.'); if (r?.status !== 'cancelled') for (const row of rows) row.pick.disabled = true; sync(); return; }
      used = true;
      container.querySelectorAll('input').forEach((n) => { n.disabled = true; });
      say(result, `Applied ${r.applied} change${r.applied === 1 ? '' : 's'} to ${r.files} file${r.files === 1 ? '' : 's'}. A backup was saved first.`);
      container.append(button('Undo this Apply…', () => undo(r.backup_id, result)));
      sync();
    });
    let used = false;
    const sync = () => {
      const chosen = rows.filter((r) => r.pick.checked);
      const missing = chosen.some((r) => (r.u.placeholders ?? []).some((p) => !values.get(p)?.value));
      apply.disabled = used || !chosen.length || chosen.some((r) => r.confirm && !r.confirm.checked) || missing;
    };
    container.append(apply, result);
    sync();
  }

  async function undo(id, line) {
    const r = await api.undo(id);
    if (!r?.ok) { say(line, r?.error ?? 'Undo is not available for this backup.'); return; }
    say(line, r.conflicts.length ? `Restored ${r.restored.length}. Kept because they changed after Apply: ${r.conflicts.join(', ')}.` : `Restored ${r.restored.length} from the backup.`);
  }

  async function showBackups() {
    const mine = ++gen;
    area.replaceChildren();
    const r = await api.backups();
    if (mine !== gen) return;
    if (!r?.ok || !r.backups.length) { say(status, 'No setup backups yet. One is saved each time you apply a setup.'); return; }
    say(status, `${r.backups.length} backup${r.backups.length === 1 ? '' : 's'}, newest first.`);
    for (const b of r.backups) {
      const row = el('section'), line = el('p', `${b.status.replace('_', ' ')} · ${b.changes} change${b.changes === 1 ? '' : 's'} · ${b.files.join(', ')}`);
      row.append(el('h3', `${new Date(b.created_at).toLocaleString()} · from ${b.origin === 'team' ? 'a team setup' : 'a file'}`), line);
      if (b.status === 'applied' || b.status === 'applying') row.append(button('Undo…', () => undo(b.id, line)));
      area.append(row);
    }
  }

  window.SetupsPersonal = Object.freeze({ renderPlan });
})();
