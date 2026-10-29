'use strict';
// First-run setup. Main does every write (src/ai-tools.js: preview, backup,
// read-back, Undo); this page only shows its state and sends tool ids.
const api = window.onboardingApi;
const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => { const el = document.createElement(tag); if (text) el.textContent = text; if (className) el.className = className; return el; };
const button = (text, className) => { const b = node('button', text, className); b.type = 'button'; return b; };
const Simple = window.PlexiformSimple;
const Legend = window.PlexiformLegend;
// Platform words (A2): the HTML carries the Mac wording.
const Brand = window.Brand;
const MACHINE = Brand.machine(), KEYS = Brand.keys(), TERMINAL = MACHINE === 'Mac' ? 'Terminal' : 'a terminal';
const NOT_SHOWING_MS = 20000;

let view = null;
let step = 'persona';
let signalSince = 0;
let diagnosisGoesTo = null;
const unticked = new Set();   // tool ids the person unticked (or undid): never ticked again on a redraw
const results = new Map();    // tool id -> error text from the last connect
let notShowingTimer = null;

const ticked = () => (view ? view.pending.filter((id) => !unticked.has(id)) : []);
const labelOf = (id) => view?.rows.find((r) => r.id === id)?.label || id;
const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0] || 'your AI tool');

function show(next) {
  step = next;
  for (const s of ['persona', 'connect', 'signal', 'extras']) $(`step-${s}`).hidden = s !== next;
  clearTimeout(notShowingTimer);
  if (next === 'signal') {
    const names = view ? view.rows.filter((r) => r.connected).map((r) => r.label) : [];
    $('signal-title').textContent = `Start a session in ${list(names.length ? names : ['Claude Code', 'Codex'])}`;
    signalSince = Date.now();
    notShowingTimer = setTimeout(draw, NOT_SHOWING_MS);
  }
  if (next === 'extras') $('team-box').hidden = !!view?.onTeam || !!view?.simple;
  if (next === 'extras') $('terminal-access-box').hidden = view?.mac !== true;
  draw();
  document.querySelector(`#step-${next} h1`)?.focus();
}

function toolRow(r) {
  const li = node('li', '', 'tool');
  li.id = `tool-${r.id}`;
  const text = node('span');
  text.append(node('span', r.label));
  const extra = results.get(r.id) || r.detail;
  if (extra) text.append(node('span', extra, results.has(r.id) ? 'detail error' : 'detail'));
  if (r.selectable) {
    const label = node('label');
    const box = node('input');
    box.type = 'checkbox';
    box.checked = !unticked.has(r.id);
    box.addEventListener('change', () => { if (box.checked) unticked.delete(r.id); else unticked.add(r.id); draw(); });
    label.append(box, text);
    li.append(label);
  } else {
    const name = node('span', '', 'name');
    name.append(text);
    li.append(name);
  }
  li.append(node('span', r.status, `pill${r.connected ? ' on' : r.status === 'Needs a fix' ? ' fix' : ''}`));
  if (r.canUndo) {
    const undo = button('Undo');
    undo.setAttribute('aria-label', `Undo connecting ${r.label}`);
    undo.addEventListener('click', () => act(async () => {
      const res = await api.undo(r.id);
      if (res?.ok) unticked.add(r.id);
      $('connect-status').textContent = res?.ok ? `${r.label}: ${res.message}` : `${r.label}: ${res?.error || 'Undo did not run.'}`;
      await refresh();
    }));
    li.append(undo);
  }
  return li;
}

function draw() {
  if (!view) return;
  $('loading').hidden = true;
  const found = view.rows.length > 0;
  $('connect-body').hidden = !found;
  const names = view.rows.map((r) => r.label);
  $('connect-body').textContent = `We found ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]} on this ${MACHINE}. We add a small note-taker to ${names.length > 1 ? 'each' : 'it'} so we know when it's busy or waiting for you. It never reads what you and your AI say. Undo with one click.`;
  $('tools').replaceChildren(...view.rows.map(toolRow));
  $('none').hidden = found;
  $('see-changes').parentElement.hidden = !found;
  $('missing-box').hidden = !view.missing.length;
  $('missing-title').textContent = `Not installed (${view.missing.length})`;
  $('missing').replaceChildren(...view.missing.map((m) => node('li', m.label)));
  const n = ticked().length;
  $('connect').textContent = n ? `Connect ${n} tool${n === 1 ? '' : 's'}` : 'Next';
  $('login-line').hidden = typeof view.loginItem !== 'boolean';
  $('login-text').textContent = view.loginItem ? 'Plexiform opens when you log in.' : "Plexiform won't open when you log in.";
  $('login-toggle').textContent = view.loginItem ? 'Turn off' : 'Turn on';
  if (step === 'signal') {
    $('waiting').hidden = !!view.session;
    $('seen').hidden = !view.session;
    $('seen-text').textContent = view.session ? view.session.text : '';
    $('signal-next').hidden = !view.session;
    $('skip-signal').hidden = !!view.session;
    const d = Simple.diagnose({ rows: view.rows, missing: view.missing, session: view.session, waitedMs: Date.now() - signalSince });
    $('not-showing').hidden = !d;
    if (d) {
      $('diagnosis-title').textContent = d.title;
      $('diagnosis-body').textContent = d.body;
      $('diagnosis-action').textContent = d.action.label;
      diagnosisGoesTo = d.action.destination;
    }
  }
}

async function refresh() {
  let next = null;
  try { next = await api.state(); } catch (err) { console.error('[onboarding]', err); }
  if (!next) { $('loading').textContent = 'Could not read your AI tools. Close this window and open Help → Run setup again.'; return; }
  view = next;
  draw();
}

let busy = false;
async function act(fn) {
  if (busy) return;
  busy = true;
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  try { await fn(); } catch (err) { console.error('[onboarding]', err); } finally {
    busy = false;
    for (const b of document.querySelectorAll('button')) b.disabled = false;
  }
}

async function go(destination, statusEl) {
  let ok = false;
  try { ok = await api.navigate(destination); } catch { /* reported below */ }
  if (!ok && statusEl) statusEl.textContent = 'Could not open that page. Try again from the main window.';
  return ok;
}

function diffBlock(file) {
  const pre = node('pre', '', 'diff');
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', `Changes to ${file.file}`);
  pre.append(node('div', file.file + (file.existed ? '' : ' (new file)'), 'gap'));
  for (const l of file.lines) pre.append(node('div', `${l.kind === 'add' ? '+ ' : '- '}${l.text}`, l.kind));
  if (file.unchanged) pre.append(node('div', `… ${file.unchanged} unchanged line${file.unchanged === 1 ? '' : 's'}`, 'gap'));
  return pre;
}

$('see-changes').addEventListener('click', () => act(async () => {
  const box = $('changes');
  if (!box.hidden) { box.hidden = true; $('see-changes').setAttribute('aria-expanded', 'false'); return; }
  const ids = ticked();
  const parts = [];
  if (!ids.length) parts.push(node('p', 'Nothing is ticked, so nothing will change.', 'muted'));
  for (const id of ids) {
    const p = await api.preview(id);
    parts.push(node('h2', labelOf(id)));
    if (!p || !p.ok) { parts.push(node('p', p?.error || 'Could not prepare a preview.', 'error')); continue; }
    for (const f of p.files) parts.push(diffBlock(f));
    for (const s of p.steps || []) parts.push(node('p', s));
  }
  box.replaceChildren(...parts);
  box.hidden = false;
  $('see-changes').setAttribute('aria-expanded', 'true');
}));

$('connect').addEventListener('click', () => act(async () => {
  const ids = ticked();
  if (!ids.length) { $('signal-note').textContent = ''; show('signal'); return; }
  $('connect-status').textContent = 'Connecting…';
  const r = await api.connect(ids);
  results.clear();
  if (!r) { $('connect-status').textContent = 'Nothing was connected. Try again, or use AI tools in the main window.'; return; }
  for (const x of r.results) if (!x.ok) results.set(x.id, x.error);
  const done = r.results.filter((x) => x.ok).map((x) => labelOf(x.id));
  $('changes').hidden = true;
  await refresh();
  if (r.ok) { $('signal-note').textContent = `Connected ${done.join(' and ')}. Changed your mind? Back has Undo next to each one.`; show('signal'); }
  else $('connect-status').textContent = done.length ? `Connected ${done.join(' and ')}. The others need a look; see each row.` : 'Nothing was connected; see each row.';
}));

$('login-toggle').addEventListener('click', () => act(async () => {
  const on = await api.setLoginItem(!view.loginItem);
  if (typeof on === 'boolean') view.loginItem = on;
  draw();
}));

async function choosePersona(id) {
  const saved = await api.setPersona(id);
  if (!saved) { $('persona-status').textContent = 'Could not save that. Try again.'; return; }
  if (view) view.simple = saved.simple;
  show('connect');
}
$('persona-simple').addEventListener('click', () => act(() => choosePersona('simple')));
$('persona-developer').addEventListener('click', () => act(() => choosePersona('developer')));
$('connect-back').addEventListener('click', () => show('persona'));
$('test-prompt').value = Simple.TEST_PROMPT;
const code = node('code', 'claude');
$('howto-open').replaceChildren(`Open ${TERMINAL}, type `, code, ` and press ${KEYS.enter}.`);
$('howto-paste').textContent = `Paste the prompt and press ${KEYS.enter}. It shows up here as soon as Claude starts.`;
$('team-note').textContent = `Optional: your board stays on this ${MACHINE} until you do.`;
$('legend-line').textContent = `That's your widget. ${Legend.SENTENCE}.`;
$('copy-prompt').addEventListener('click', async () => {
  let ok = false;
  try { await navigator.clipboard.writeText(Simple.TEST_PROMPT); ok = true; } catch { /* selected below instead */ }
  if (!ok) $('test-prompt').select?.();
  $('copy-status').textContent = ok ? `Copied. Now open ${TERMINAL}.` : `Press ${MACHINE === 'Mac' ? 'Command-C' : KEYS.combo('C')} to copy it.`;
});
$('diagnosis-action').addEventListener('click', () => {
  const d = diagnosisGoesTo;
  if (d === 'back') show('connect');
  else if (d) go(d, $('signal-note'));
});
$('skip-connect').addEventListener('click', () => show('signal'));
$('how-install').addEventListener('click', () => go('aitools', $('connect-status')));
$('check-again').addEventListener('click', () => act(refresh));
$('check-connection').addEventListener('click', () => {
  const first = view?.rows.find((r) => r.connected);
  go(first ? `aitools:${first.id}` : 'aitools', $('signal-note'));
});
$('skip-signal').addEventListener('click', () => show('extras'));
$('signal-back').addEventListener('click', () => show('connect'));
$('signal-next').addEventListener('click', () => show('extras'));
$('back').addEventListener('click', () => show('signal'));

$('budget-form').addEventListener('submit', (e) => {
  e.preventDefault();
  act(async () => {
    const dollars = Number($('budget').value);
    if (!Number.isFinite(dollars) || dollars < 1) { $('budget-status').textContent = 'Enter a whole number of dollars, like 20.'; return; }
    const saved = await api.setDailyBudget(Math.round(dollars));
    $('budget-status').textContent = typeof saved === 'number' ? `Saved. You'll get a heads-up near $${saved} a day; change it any time in Usage & cost.` : 'Could not save it. Set it later in Usage & cost.';
  });
});
$('join').addEventListener('click', () => go('join', $('extras-status')));
$('create-team').addEventListener('click', () => go('create-team', $('extras-status')));
// Navigation only (QoL4b): Preferences › Terminal access (Settings › Terminal in the chat preview) reads what macOS allowed and never asks on its own.
$('terminal-access').addEventListener('click', () => go('terminal-access', $('extras-status')));
$('finish').addEventListener('click', () => go('home', $('extras-status')));

api.onStatusChanged(() => { refresh(); });
refresh().then(() => { if (view && view.dailyBudget > 0) $('budget').value = String(view.dailyBudget); });
