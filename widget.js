// ambient: the idle loops tick on a slow clock, not every display frame
const rig = mountRig(document.getElementById('housing'), { ambient: true });
// A user sprite pack (Settings or Lights pick it; main validates the files)
// replaces the drawn character; any failure leaves the built-in one.
function loadSpritePack() {
  if (!window.spritePacks) return;
  window.spritePacks.list().then((r) => rig.setSpritePack(r && r.current ? r.current : null)).catch(() => rig.setSpritePack(null));
}
loadSpritePack();
if (window.spritePacks) window.spritePacks.onChange(loadSpritePack);
rig.svg.classList.add('breathes');
// Main does the window travel (roam, knock hops, garden, drag glide), so
// it has to hear about reduced motion from here, now and on every change.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
window.trafficLight.setReducedMotion(reducedMotion.matches);
rig.blinks(!reducedMotion.matches);
reducedMotion.addEventListener('change', (e) => {
  window.trafficLight.setReducedMotion(e.matches);
  rig.blinks(!e.matches);
  if (e.matches) rig.lookAt(0, 0);
});
const kick = () => window.BuddyMotion.MOTION.pendulum.kick;
window.trafficLight.onLand((strength) => { rig.squash(strength); rig.swing(kick() * strength); retestUnderCursor().catch(() => {}); });
// A glide hit a work-area edge: squash against that wall; the sign carries
// on toward it and swings back.
window.trafficLight.onImpact((side, strength) => {
  rig.squash(strength, side);
  rig.swing(kick() * 1.5 * strength * (side === 'left' || side === 'top' ? -1 : 1));
});
window.trafficLight.onSway((v) => rig.swing(v));
window.trafficLight.onLean((vx) => rig.lean(vx));
window.trafficLight.onEyes((x, y) => rig.lookAt(x, y));
window.addEventListener('online', () => window.trafficLight.netChanged());
window.addEventListener('offline', () => window.trafficLight.netChanged());
const setLowPower = (on) => { document.body.classList.toggle('low-power', !!on); rig.setLowPower(!!on); };
window.trafficLight.onLowPower(setLowPower);
window.trafficLight.getLowPower().then(setLowPower).catch(() => {});
let motionPaused = false;
window.trafficLight.onMotionPaused((paused) => {
  motionPaused = !!paused;
  document.body.classList.toggle('motion-paused', motionPaused);
  rig.setHidden(motionPaused);
});
const tooltip = document.getElementById('tooltip');
const app = document.getElementById('app');

let lastRuleId = null;
// The agents roster is a hover reveal, so it never covers Claude at rest.
let hovering = false;
app.addEventListener('mouseenter', () => { hovering = true; loadCards(); if (rig.look) rig.setLook({ ...rig.look, showRoster: rig.look.agentRoster !== false }); });
app.addEventListener('mouseleave', () => { hovering = false; if (rig.look) rig.setLook({ ...rig.look, showRoster: false }); });
let sleepSince = null;
// when the current cigarette run started; the rig counts its 5-minute cigarettes from it
let smokeSince = null;
let confettiTimer = null;
const GRUMPY_AFTER_MS = 3 * 60 * 1000;
const TOOLTIP_MAX = 90;

// Status pushes can overlap; only the newest fetch may paint, and one bad
// frame must not leave the widget frozen on a stale pose.
let refreshSeq = 0;
async function refresh() {
  const seq = ++refreshSeq;
  try {
    let timer;
    const data = await Promise.race([window.trafficLight.getAggregateStatus(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('status unavailable')), 4500);
    })]).finally(() => clearTimeout(timer));
    if (seq !== refreshSeq) return;
    if (!data || !data.look) throw new Error('status unavailable');
    applyStatus(data);
  } catch (err) {
    console.error('[refresh]', err);
    if (seq !== refreshSeq) return;
    try { rig.setLook({ ...(rig.look || {}), lamp: 'off', pose: 'none', minions: 0, agents: [], showRoster: false, celebrate: false }); } catch (e2) { console.error('[refresh] safe look failed', e2); }
    clearInterval(confettiTimer); confettiTimer = null;
    sleepSince = null; smokeSince = null; lastRuleId = null;
    tooltip.textContent = 'AI activity unavailable — last status could not be refreshed';
    bubble.update([]);
  }
}
// Every waiting input, answerable or not (docs/waiting-inputs.md).
const bubbleEl = document.getElementById('bubble');
let bubblePx = -1;
// The height main last confirmed it made room for.
let stripAck = -1;
const bubble = window.InputBubble.create(bubbleEl, {
  mode: 'widget',
  maxRows: 2,
  api: {
    answerInput: (id, optionId, more) => (tourInput && id === tourInput.id ? tourAnswered() : window.trafficLight.answerInput(id, optionId, more)),
    openInput: (id) => window.trafficLight.openInput(id),
    explainInput: (id) => window.trafficLight.explainInput(id),
    explainStatus: () => window.trafficLight.explainStatus(),
    copyCommand: (id) => window.trafficLight.copyInputCommand(id),
    openAutoRule: (id) => window.trafficLight.openAutoRule({ inputId: id }),
    openWaiting: () => window.trafficLight.openWaiting(),
    nudgeRule: (key) => window.trafficLight.openAutoRule({ nudgeKey: key }),
    nudgeMute: (key) => window.trafficLight.nudgeMute(key),
    setSessionScope: (id, mode) => window.trafficLight.setSessionScope(id, mode),
    setRepoScope: (url, mode) => window.trafficLight.setRepoScope(url, mode),
  },
  onLayout: () => reportBubble(),
  onScreen: () => stripAck === bubblePx,
});
// First-run tour, demo only: a made-up question in the bubble; answering it
// moves the tour on and never reaches a hook (src/first-run-tour-main.js).
let tourInput = null;
const withTourInput = (inputs) => (tourInput ? [...inputs, tourInput] : inputs);
function tourAnswered() {
  const id = tourInput.id;
  tourInput = null;
  bubble.update(lastInputs);
  window.tourApi?.action('answered', 'waiting');
  return Promise.resolve({ ok: true, id });
}
document.addEventListener('plexiform-tour', (e) => {
  const next = e.detail && e.detail.demoInput && typeof e.detail.demoInput.id === 'string' ? e.detail.demoInput : null;
  if ((next && next.id) === (tourInput && tourInput.id)) return;
  tourInput = next;
  bubble.update(withTourInput(lastInputs));
});
window.trafficLight.onStripApplied((px) => { stripAck = px; if (px === bubblePx) bubble.revealed(); });
// Also on resize: widening the window rewraps the text, so the height changes.
function reportBubble() {
  const on = bubbleEl.classList.contains('has-items');
  document.body.classList.toggle('asking', on);
  const px = on ? Math.ceil(bubbleEl.getBoundingClientRect().height) + 8 : 0;
  if (px === bubblePx) return;
  bubblePx = px;
  document.body.style.setProperty('--bubble-h', `${px}px`);
  stripAck = -1; // an ack for an earlier height must not vouch for this one
  window.trafficLight.setBubbleHeight(px);
}
window.addEventListener('resize', reportBubble);
document.addEventListener('keydown', (e) => { bubble.keydown(e); });
setInterval(() => { if (!motionPaused) bubble.tick(); }, 15000);

function reportedLook(data) {
  const look = { ...data.look, ...(data.look.pose === 'ak47' || data.look.pose === 'sniper' ? aim : {}), showRoster: hovering && data.look.agentRoster !== false };
  const reports = data.providerStatus;
  const stale = Array.isArray(reports?.providers) && reports.providers.length > 0 && reports.providers.every(p => p.recent === 0);
  if (!['manual', 'preview', 'travel'].includes(data.reason) && (reports?.available === false || reports?.online === false || stale))
    Object.assign(look, { lamp: 'off', pose: 'none', minions: 0, agents: [], showRoster: false, celebrate: false });
  return look;
}

function applyStatus(data) {
  const look = reportedLook(data);
  sleepSince = look.pose === 'sleep' ? (sleepSince ?? Date.now()) : null;
  look.grumpy = sleepSince !== null && Date.now() - sleepSince > GRUMPY_AFTER_MS;
  smokeSince = look.pose === 'smoke' ? (smokeSince ?? Date.now()) : null;
  if (smokeSince) look.smokeSince = smokeSince;
  rig.setLook(look);
  lastSessions = data.sessions || [];
  paintPolish();
  // A preview carries no inputs: keep what is showing rather than flicker.
  lastInputs = Array.isArray(data.inputs) ? data.inputs : lastInputs;
  if (hovering) loadCards();
  if (data.reason === 'travel') bubble.update([]);
  else if (Array.isArray(data.inputs)) bubble.update(withTourInput(data.inputs), { scopes: window.WorkScopeView.scopesBySession(data.sessions) });
  // A look preview carries no budget field: keep what is showing.
  if (data.budget !== undefined || data.reason === 'travel') renderBudget(data.reason === 'travel' ? null : data.budget);
  renderAway(data.reason === 'travel' ? null : data.away, data.reason === 'travel' ? null : data.team);
  idleNow = data.reason === 'idle' && !(data.inputs && data.inputs.length);
  if (idleNow && !hintAsked) { hintAsked = true; window.trafficLight.teamHint().then((h) => { hintOffer = h; paintRow(); }).catch(() => {}); }
  else paintRow();
  // Confetti fires on entering a celebrating state, then again every 10s
  // for as long as that state holds.
  if (look.celebrate && look.ruleId !== lastRuleId) {
    rig.celebrate();
    clearInterval(confettiTimer);
    confettiTimer = setInterval(() => { if (!motionPaused) rig.celebrate(); }, 10000);
  } else if (!look.celebrate) {
    clearInterval(confettiTimer);
    confettiTimer = null;
  }
  lastRuleId = look.ruleId;
  // Stuck is amber like "your turn", so it carries its own glyph (src/colour-legend.js).
  document.body.classList.toggle('stuck', !!look.stuck);

  const count = data.sessions?.length || 0;
  const agents = data.agentCount || 0;
  const suffix = data.reason === 'manual'
    ? ' (manual override)'
    : data.reason === 'preview'
      ? ' (preview)'
      : count
        ? ` — ${count} session${count === 1 ? '' : 's'}${agents ? ` · ${agents} agent${agents === 1 ? '' : 's'}` : ''}`
        : ' (no active sessions)';
  // Lamp owner first (the real state), then the tool, then the accents
  // layered on top — dropped with '…' once the line gets too long.
  const names = data.firedNames?.length ? data.firedNames : [look.name || 'Claude Traffic Light'];
  // F1 spend: the spend rule's name carries its burn rate or budget line.
  const note = (n) => (data.spendNote && n === data.spendNote.rule ? `${n} (${data.spendNote.text})` : n);
  let text = note(names[0]) + (data.tool ? ` · ${data.tool}` : '');
  if (data.stuck && look.stuck) text = `${data.stuck.text} · ${text}`;
  for (const n0 of names.slice(1)) {
    const n = note(n0);
    if (`${text} · ${n} · …`.length + suffix.length > TOOLTIP_MAX) { text += ' · …'; break; }
    text += ` · ${n}`;
  }
  // Usage history: today against your own usual, when it is clearly above.
  const reported = !['manual', 'preview', 'travel'].includes(data.reason) ? data.providerStatus?.headline : null;
  const reportAge = data.providerStatus?.latest_age_ms;
  const seen = reported ? Number.isFinite(reportAge) && reportAge >= 0 ? ` · Last seen ${Math.floor(reportAge / 1000)}s ago` : ' · Last seen unknown' : '';
  const team = data.team ? ` · ${data.team.looks.length ? `${data.team.looks.length} teammate${data.team.looks.length === 1 ? '' : 's'} asking you to look` : ''}${data.team.looks.length && data.team.waiting.length ? ', ' : ''}${data.team.waiting.length ? `waiting on ${data.team.waiting.length}` : ''}` : '';
  tooltip.textContent = (reported ? `${reported} · Rule “${text}”` : text) + suffix + team + (data.paceLine ? ` — ${data.paceLine}` : '') + seen;
}

// In-app update row. Text only (textContent): a hub name is not ours.
// `armed`: "when you're not working" was asked for; `dismissedFor`: the state
// the person said "Later" to, so the next change brings the row back.
let updateRow = null;
let updateState = null;
let armed = false;
let dismissedFor = null;
const updateKey = (s) => JSON.stringify([s.status, s.available && s.available.version, s.requiredByHub, s.installKind, s.error && s.error.code]);
function renderUpdate(state) {
  if (state && updateState && updateKey(state) !== updateKey(updateState)) { armed = false; dismissedFor = null; }
  updateState = state;
  updateRow = state && dismissedFor !== updateKey(state) ? window.UpdateView.widgetRow(state, { name: window.Brand.name, armed }) : null;
  paintRow();
}
// The one-time Team hint rides in the update row's box and strip, below the
// ask, the recap and the update itself. main decides whether there is one
// (never after dismissal); it ends on a click or after HINT_MS, then never again.
const HINT_MS = 20000;
let hintOffer = null;
let hintAsked = false;
let hintOn = false;
let hintTimer = null;
let idleNow = false;
function hintDone(open) {
  clearTimeout(hintTimer);
  hintOffer = null;
  window.trafficLight.teamHintDone(open).catch(() => {});
  paintRow();
}
function paintRow() {
  const wantHint = !updateRow && !!hintOffer && idleNow && !document.body.classList.contains('asking') && !document.body.classList.contains('away') && !document.body.classList.contains('budget');
  if (wantHint && !hintOn) hintTimer = setTimeout(() => hintDone(false), HINT_MS);
  if (!wantHint && hintOn) clearTimeout(hintTimer);
  hintOn = wantHint;
  const row = updateRow || (hintOn ? { kind: 'hint', text: hintOffer.text, sub: '', button: { label: hintOffer.label } } : null);
  const box = document.getElementById('update');
  box.className = row ? row.kind : '';
  if (row) {
    document.getElementById('update-text').textContent = row.text;
    document.getElementById('update-sub').textContent = row.sub || '';
    const b = document.getElementById('update-btn');
    b.hidden = !row.button;
    b.textContent = row.button ? row.button.label : '';
    const later = document.getElementById('update-later');
    later.textContent = hintOn ? '×' : 'Later';
    later.title = hintOn ? 'Dismiss' : 'Hide this until something changes; the tray keeps the update';
  }
  document.body.classList.toggle('updating', !!row);
  window.trafficLight.updateRowShown(!!row);
}
const stop = (e) => e.stopPropagation();
for (const id of ['update-btn', 'update-later']) document.getElementById(id).addEventListener('mousedown', stop);
document.getElementById('update-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (hintOn) { hintDone(true); return; }
  const id = updateRow && updateRow.button && updateRow.button.id;
  if (id === 'open-updates') { window.trafficLight.openUpdates(); return; }
  const when = id === 'install-now' ? 'now' : id === 'install-idle' ? 'idle' : null;
  if (!when) return;
  const r = await window.trafficLight.updaterInstall(when).catch(() => null);
  // A session is working: the team board still needs this, so wait for a quiet moment instead of interrupting.
  if (r && r.deferred && when === 'now') { await window.trafficLight.updaterInstall('idle').catch(() => null); armed = true; }
  if (when === 'idle' && r && r.ok !== false) armed = true;
  renderUpdate(updateState);
});
document.getElementById('update-later').addEventListener('click', (e) => {
  e.stopPropagation();
  if (hintOn) { hintDone(false); return; }
  if (updateState) { dismissedFor = updateKey(updateState); renderUpdate(updateState); }
});
window.trafficLight.onUpdaterState(renderUpdate);
window.trafficLight.getUpdaterState().then((s) => { if (s && s.status) renderUpdate(s); }).catch(() => {});

// A run stopped at its budget: both buttons open the card on the board (main
// builds the fragment from the run id; this page never sees it). With no way
// to open it, say where to go and offer the board itself.
const BUDGET_FALLBACK = 'Open the card on your board to raise the budget or stop the run.';
let budgetShown = null;
let budgetFailed = false;
function budgetButton(label, quiet, onClick) {
  const b = document.createElement('button');
  if (quiet) b.className = 'quiet';
  b.textContent = label;
  b.title = 'Opens the card on your board';
  b.addEventListener('mousedown', stop);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}
// Rebuilt only when what it shows changes: every status broadcast calls this,
// and replacing the buttons between a mousedown and its mouseup loses the click.
let budgetKey = null;
function renderBudget(list) {
  const first = list && list[0];
  document.body.classList.toggle('budget', !!first);
  if (!first) { budgetShown = null; budgetFailed = false; budgetKey = null; return; }
  if (first.runId !== budgetShown) { budgetShown = first.runId; budgetFailed = false; }
  const key = JSON.stringify([first.runId, first.text, budgetFailed, list.length]);
  if (key === budgetKey) return;
  budgetKey = key;
  const more = list.length > 1 ? ` (+${list.length - 1} more)` : '';
  document.getElementById('budget-text').textContent = budgetFailed ? BUDGET_FALLBACK : `${first.text}${more}`;
  document.getElementById('budget-text').title = first.text;
  const open = async () => {
    const r = await window.trafficLight.budgetNotice('open', first.runId).catch(() => null);
    if (!r || r.ok === false) { budgetFailed = true; renderBudget(list); }
  };
  document.getElementById('budget-acts').replaceChildren(...(budgetFailed
    ? [budgetButton('Open board', false, () => window.trafficLight.budgetNotice('board', first.runId))]
    : [budgetButton('Increase & continue', false, open), budgetButton('Stop', true, open)]));
}
document.getElementById('budget-x').addEventListener('mousedown', stop);
document.getElementById('budget-x').addEventListener('click', (e) => { e.stopPropagation(); if (budgetShown) window.trafficLight.budgetNotice('dismiss', budgetShown); });

// The recap: needs-you first, then failures, then finished. Three lines
// fit under the heading; past three items the last becomes "+N more".
const AWAY_LINES = 3;
// Widget polish (src/widget-polish-main.js): size, edge snapping, accents and the quiet moon.
let polish = { snap: 'corners', size: 'normal', colours: {}, quiet: false };
const projectKey = (cwd) => String(cwd || '').replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
const accentFor = (cwd) => (cwd && Object.prototype.hasOwnProperty.call(polish.colours, projectKey(cwd)) ? polish.colours[projectKey(cwd)] : null);
let lastSessions = [];
function paintPolish() {
  for (const k of ['normal', 'compact', 'dot']) document.body.classList.toggle(`size-${k}`, polish.size === k);
  document.body.classList.toggle('quiet', !!polish.quiet);
  const lit = (lastSessions || []).map((x) => accentFor(x && x.cwd)).find(Boolean) || null;
  document.body.classList.toggle('has-accent', !!lit);
  if (lit) document.body.style.setProperty('--project-accent', lit); else document.body.style.removeProperty('--project-accent');
  document.body.style.setProperty('--dot', rig.svg.style.getPropertyValue('--lamp-on') || 'var(--lamp-off)');
}
async function refreshPolish() {
  try { const p = await window.trafficLight.polish.state(); if (p) polish = { ...polish, ...p, colours: p.colours || {} }; } catch { /* keep the last one */ }
  paintPolish();
}

const AWAY_WORDS = { 'needs-you': (x) => x.detail || 'needs you', failed: (x) => `failed${x.detail && x.detail !== 'error' ? ` (${x.detail})` : ''}`, done: () => 'done' };
let awayKey = null;
let teamDismissed = null; // the team panel the person closed; it returns when the requests change
const teamKey = (team) => team ? [...team.looks.map((l) => `l:${l.id}:${l.handling ? 1 : 0}`), ...team.waiting.map((w) => `w:${w.id}:${w.state}`)].join('|') : null;
// Teammates' requests take the recap's panel when there is no recap: who is asking me to look, and what I am waiting on.
function renderTeam(team, rows) {
  document.getElementById('away-head').textContent = 'Teammates';
  document.getElementById('away-head').title = `${team.looks.length} asking you to look · ${team.waiting.length} you are waiting on — click a row to open agent mail`;
  const els = [];
  for (const l of team.looks.slice(0, AWAY_LINES)) {
    const b = document.createElement('button');
    b.className = `row look${l.handling ? ' handling' : ''}`;
    b.title = `${l.from} asks: ${l.question}${l.handling ? ' — you said you would handle it' : ''}`;
    const dot = document.createElement('i'); dot.className = 'dot';
    const text = document.createElement('span'); text.textContent = `${l.from} · ${l.handling ? 'handling' : 'asks'} · ${l.question}`;
    b.append(dot, text);
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', async (e) => { e.stopPropagation(); if (!(await window.trafficLight.openMail())) showFeedback('Agent mail could not be opened'); });
    els.push(b);
  }
  for (const w of team.waiting.slice(0, Math.max(0, AWAY_LINES - els.length))) {
    const b = document.createElement('button');
    b.className = 'row waiting';
    b.title = `Waiting on ${w.to}: ${w.question} — ${w.state}`;
    const dot = document.createElement('i'); dot.className = 'dot';
    const text = document.createElement('span'); text.textContent = `Waiting on ${w.to} · ${w.state}`;
    b.append(dot, text);
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', async (e) => { e.stopPropagation(); if (!(await window.trafficLight.openMail())) showFeedback('Agent mail could not be opened'); });
    els.push(b);
  }
  const extra = team.looks.length + team.waiting.length - els.length;
  if (extra > 0) { const m = document.createElement('div'); m.className = 'more'; m.textContent = `+${extra} more`; els.push(m); }
  rows.replaceChildren(...els);
}
function renderAway(recap, team = null) {
  const showTeam = !recap && !!team && teamKey(team) !== teamDismissed;
  document.body.classList.toggle('away', !!recap || showTeam);
  document.body.classList.toggle('team', showTeam);
  const key = recap ? `${recap.to}` : showTeam ? `team:${teamKey(team)}` : null;
  if (key === awayKey) return;
  awayKey = key;
  const rows = document.getElementById('away-rows');
  if (showTeam) { renderTeam(team, rows); return; }
  if (!recap) { rows.replaceChildren(); return; }
  document.getElementById('away-head').textContent = 'While you were away';
  document.getElementById('away-head').title = `${recap.headline}${recap.reasons && recap.reasons.length ? ` — while busy (${recap.reasons.join(', ')})` : ''}`;
  // Held pings take the last line when there were any.
  const room = AWAY_LINES - (recap.held ? 1 : 0);
  const shown = recap.items.length > room ? room - 1 : recap.items.length;
  const els = recap.items.slice(0, shown).map((x, i) => {
    const b = document.createElement('button');
    b.className = `row ${x.kind}`;
    b.title = `${x.folder || 'session'}: ${AWAY_WORDS[x.kind](x)} — click to go there`;
    const accent = x.folder && Object.prototype.hasOwnProperty.call(polish.colours, x.folder) ? polish.colours[x.folder] : null;
    if (accent) b.style.setProperty('--row-accent', accent);
    const dot = document.createElement('i');
    dot.className = 'dot';
    const text = document.createElement('span');
    text.textContent = `${x.folder || 'session'} · ${AWAY_WORDS[x.kind](x)}`;
    b.append(dot, text);
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', async (e) => { e.stopPropagation(); const r = await window.trafficLight.awayOpen(i); if (!r) return; if (r.note) showFeedback(r.note); else if (r.opened === 'none-found') showFeedback('path copied'); else if (r.folder) showFeedback(`→ ${r.folder} · path copied`); });
    return b;
  });
  const extra = recap.items.length - shown;
  if (extra > 0) { const m = document.createElement('div'); m.className = 'more'; m.textContent = `+${extra} more`; els.push(m); }
  if (recap.held) {
    const h = document.createElement('div');
    h.className = 'row held';
    const list = (recap.heldPings || []).map((p) => `${p.rule}${p.count > 1 ? ` ×${p.count}` : ''}`);
    h.title = `Held while you were busy: ${list.join(', ')}`;
    const dot = document.createElement('i');
    dot.className = 'dot';
    const text = document.createElement('span');
    text.textContent = `${recap.held} held${list.length ? ` · ${list.join(', ')}` : ''}`;
    h.append(dot, text);
    els.push(h);
  }
  rows.replaceChildren(...els);
}
document.getElementById('away-x').addEventListener('mousedown', (e) => e.stopPropagation());
document.getElementById('away-x').addEventListener('click', (e) => { e.stopPropagation(); if (document.body.classList.contains('team')) { teamDismissed = awayKey ? awayKey.slice('team:'.length) : null; awayKey = null; renderAway(null, null); } else window.trafficLight.awayDismiss(); });

refresh();
window.trafficLight.onStatusChanged(refresh);
// Poll accepted metadata too: a dropped status push must not freeze the lamp.
setInterval(refresh, 5000);
refreshPolish();
window.trafficLight.onStatusChanged(refreshPolish);
setInterval(refreshPolish, 15000);
window.trafficLight.onBurst((ms) => rig.burst(ms));
// Aim updates arrive ~8x/s while a gun pose is live; re-apply the current
// look with the new facing/angle without waiting for the next poll.
let aim = { facing: 'right', aimAngle: 0 };
window.trafficLight.onAim((a) => { aim = a; if (rig.look) rig.setLook({ ...rig.look, ...aim }); });

// Dragging: the window's top-left is always the cursor minus where it
// grabbed (clientX/Y), so nothing waits on IPC and the first move lands.
// Moves coalesce to one IPC per frame; the release velocity hands off to
// a momentum glide in main.
let drag = null;
let didDrag = false;
let dragFrame = 0;
let dragTo = null;
const flushDrag = () => {
  dragFrame = 0;
  if (dragTo) { window.trafficLight.setWindowPosition(dragTo.x, dragTo.y); dragTo = null; }
};

// Press and hold (without moving) = ask a question out loud; letting go
// sends it. The release is not also a click.
const LONG_PRESS_MS = 650;
// Known up front, so a hold where voice can't work stays a plain click.
let longPressOn = false;
const syncVoice = () => window.trafficLight.voiceEnabled().then((on) => { longPressOn = !!on; }).catch(() => { longPressOn = false; });
syncVoice();
window.trafficLight.onStatusChanged(syncVoice);
let pressTimer = 0;
let pressTalking = false;
let swallowClick = false;
const endPress = () => {
  clearTimeout(pressTimer);
  pressTimer = 0;
  if (!pressTalking) return;
  pressTalking = false;
  swallowClick = true;
  window.trafficLight.voiceStop();
};
app.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  clearTimeout(pressTimer);
  if (longPressOn) pressTimer = setTimeout(() => {
    pressTimer = 0;
    if (!drag || didDrag) return;
    pressTalking = true;
    window.trafficLight.voiceStart().then((r) => { if (r && r.ok) drag = null; else pressTalking = false; }).catch(() => { pressTalking = false; });
  }, LONG_PRESS_MS);
  drag = { grabX: e.clientX, grabY: e.clientY, startX: e.screenX, startY: e.screenY, samples: [{ x: e.screenX, y: e.screenY, t: e.timeStamp }] };
  didDrag = false;
  window.trafficLight.dragStart();
  rig.squash(0.6);
});
// While dragging, the sign trails the pointer's velocity; when the pointer
// pauses (no more moves arrive) it swings back upright.
let leanTimer = 0;
const dragLean = (vx) => {
  rig.lean(vx);
  clearTimeout(leanTimer);
  leanTimer = vx ? setTimeout(() => rig.lean(0), 70) : 0;
};

// Only what is actually drawn should catch the mouse: over the empty
// corners of the transparent window, clicks fall through to whatever is
// behind. The hit test runs on every move; the IPC only fires on change.
let clickThrough = null;
const solidAt = (x, y) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return false;
  if (el.closest('#gear, #help, #bubble, #budget, #away, #update, #event-lane .lane-row, .minion, #strip, #session-card, #dot')) return true;
  return rig.solidAt(x, y);
};
const hitTest = (x, y) => {
  const ignore = !solidAt(x, y);
  if (ignore !== clickThrough) { clickThrough = ignore; window.trafficLight.setClickThrough(ignore); }
};
window.addEventListener('mousemove', (e) => {
  if (drag) return;
  hitTest(e.clientX, e.clientY);
});
window.trafficLight.onHitTest((x, y) => { if (!drag) hitTest(x, y); });
// A glide can land under a cursor that never moves, so no mousemove comes.
const retestUnderCursor = async () => {
  if (drag) return;
  const pt = await window.trafficLight.cursorInWindow();
  if (pt) hitTest(pt.x, pt.y);
};

window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  if (e.buttons !== 1) { endDrag(e, false); return; }
  if (Math.abs(e.screenX - drag.startX) > 3 || Math.abs(e.screenY - drag.startY) > 3) didDrag = true;
  if (!didDrag) return;
  drag.samples.push({ x: e.screenX, y: e.screenY, t: e.timeStamp });
  if (drag.samples.length > 12) drag.samples.shift();
  dragTo = { x: e.screenX - drag.grabX, y: e.screenY - drag.grabY };
  if (!dragFrame) dragFrame = requestAnimationFrame(flushDrag);
  dragLean(window.BuddyMotion.releaseVelocity(drag.samples, e.timeStamp).vx);
});

// A click (no drag) never glides; a drag throws with whatever velocity
// the pointer still had when it let go.
function endDrag(e, released) {
  const d = drag;
  drag = null;
  if (!d || !didDrag) return;
  dragLean(0);
  if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = 0; }
  if (released) d.samples.push({ x: e.screenX, y: e.screenY, t: e.timeStamp });
  const x = e.screenX - d.grabX;
  const y = e.screenY - d.grabY;
  window.trafficLight.setWindowPosition(x, y);
  dragTo = null;
  // Snapping to edges places the widget where it was let go, then onto the nearest edge: no throw.
  if (polish.snap === 'edges') { window.trafficLight.dragEnd(0, 0); window.trafficLight.polish.snap().catch(() => {}); return; }
  const v = window.BuddyMotion.releaseVelocity(d.samples, e.timeStamp);
  window.trafficLight.dragEnd(released ? v.vx : 0, released ? v.vy : 0);
}
window.addEventListener('mouseup', (e) => { endPress(); endDrag(e, true); });

let wheelAccum = 0;
app.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (polish.size !== 'normal') return; // compact and dot are fixed sizes
  wheelAccum += e.deltaY;
  if (Math.abs(wheelAccum) < 12) return;
  const factor = wheelAccum < 0 ? 1.06 : 0.94;
  wheelAccum = 0;
  window.trafficLight.resizeWindowBy(factor);
}, { passive: false });

let feedbackTimer = null;
function showFeedback(text) {
  clearTimeout(feedbackTimer);
  tooltip.textContent = text;
  tooltip.style.opacity = '1';
  feedbackTimer = setTimeout(() => {
    tooltip.style.opacity = '';
    refresh();
  }, 3000);
}

window.trafficLight.onEvent((name) => rig.playEvent(name));

// Notification lane and rings (src/widget-lane-view.js, src/widget-rings-view.js):
// main sends one event per new thing and the rings when they change. Event
// text comes from session folders, repos and teammates: textContent only.
const laneEl = document.getElementById('event-lane');
let laneEvents = [];
let laneTimer = 0;
const LANE_GO = new Set(['needs-you', 'finished']);
function laneRow(r) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.id = r.id;
  b.className = `lane-row ${r.kind}${LANE_GO.has(r.kind) ? ' go' : ''} enter`;
  const dot = document.createElement('i'); dot.className = 'dot';
  const text = document.createElement('span'); text.textContent = r.text;
  b.title = r.text;
  b.append(dot, text);
  b.addEventListener('mousedown', stop);
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!LANE_GO.has(r.kind)) return;
    if (r.inputId) { window.trafficLight.openInput(r.inputId); return; }
    const res = await window.trafficLight.goToNeedingSession().catch(() => null);
    if (res && res.feedback) showFeedback(res.feedback);
  });
  requestAnimationFrame(() => b.classList.remove('enter'));
  return b;
}
function paintLane() {
  clearTimeout(laneTimer);
  laneTimer = 0;
  const now = Date.now();
  laneEvents = window.WidgetLaneView.expire(laneEvents, now);
  const rows = window.WidgetLaneView.laneModel(laneEvents, { now });
  const have = new Map([...laneEl.children].map((el) => [el.dataset.id, el]));
  const els = rows.map((r) => {
    const el = have.get(r.id) || laneRow(r);
    el.classList.toggle('fading', r.fading);
    return el;
  });
  laneEl.replaceChildren(...els);
  const next = window.WidgetLaneView.nextChangeMs(laneEvents, { now });
  if (next !== null) laneTimer = setTimeout(paintLane, next);
}
window.trafficLight.onLaneEvent((ev) => {
  laneEvents = window.WidgetLaneView.pushEvent(laneEvents, ev, Date.now());
  paintLane();
});
const RING_C = { spend: 2 * Math.PI * 47, turn: 2 * Math.PI * 43.5 };
const ringsEl = document.getElementById('rings');
function paintRing(name, ring) {
  const g = document.getElementById(`ring-${name}`);
  const arc = document.getElementById(`ring-${name}-arc`);
  g.hidden = !ring || !ring.show;
  if (g.hidden) return;
  arc.setAttribute('class', `arc ${ring.band || 'green'}`);
  arc.setAttribute('stroke-dasharray', `${RING_C[name]}`);
  arc.setAttribute('stroke-dashoffset', `${RING_C[name] * (1 - ring.fraction)}`);
  const t = g.querySelector('title') || g.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'title'));
  t.textContent = ring.label;
}
function paintRings(r) {
  const show = !!(r && r.show);
  ringsEl.hidden = !show;
  if (!show) return;
  paintRing('spend', r.spend);
  paintRing('turn', r.turn);
}
window.trafficLight.onRings(paintRings);
window.trafficLight.laneState().then((s) => {
  if (!s) return;
  if (Array.isArray(s.lane)) for (const r of s.lane.slice().reverse()) laneEvents = window.WidgetLaneView.pushEvent(laneEvents, { ...r, at: Date.now() - r.age }, Date.now());
  paintLane();
  paintRings(s.rings);
}).catch(() => {});

// Voice states from main: the mic badge while listening, what was heard
// and the answer on the tooltip, and the mouth working while he talks.
let voiceTimer = null;
function showVoiceText(text, ms) {
  clearTimeout(feedbackTimer);
  clearTimeout(voiceTimer);
  tooltip.textContent = text;
  tooltip.style.opacity = '1';
  if (ms) voiceTimer = setTimeout(() => { tooltip.style.opacity = ''; refresh(); }, ms);
}
// Agent mode: "Start a task: …?" waits for a click; nothing starts without one.
let voiceOfferId = null;
let voiceOfferTimer = null;
function showVoiceOffer(o) {
  clearTimeout(voiceOfferTimer);
  voiceOfferId = o && typeof o.id === 'string' ? o.id : null;
  document.body.classList.toggle('voice-offer', !!voiceOfferId);
  if (!voiceOfferId) return;
  document.getElementById('voice-offer-text').textContent = `Start a task: ${String(o.text || '')}?`;
  voiceOfferTimer = setTimeout(() => showVoiceOffer(null), 120000);
}
for (const [id, action] of [['voice-offer-start', 'start'], ['voice-offer-cancel', 'cancel']]) {
  const b = document.getElementById(id);
  b.addEventListener('mousedown', (e) => e.stopPropagation());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const offer = voiceOfferId;
    showVoiceOffer(null);
    if (offer) window.trafficLight.voiceOffer(offer, action).catch(() => {});
  });
}
window.trafficLight.onVoice((st) => {
  const listening = st.state === 'listening';
  document.body.classList.toggle('listening', listening);
  rig.talking(st.state === 'talking');
  if (listening) showVoiceText(st.partial ? `“${st.partial}”` : 'Listening…');
  else if (st.state === 'authorizing') showVoiceText(`Allow ${window.Brand.name} in the macOS prompt`);
  else if (st.state === 'thinking') showVoiceText(st.text || (st.heard ? `“${st.heard}”` : '…'));
  else if (st.state === 'offer') { showVoiceOffer(st.offer); return; }
  else if (st.state === 'talking') showVoiceText(st.text || '');
  else if (st.state === 'error') showVoiceText(st.error || 'Could not listen', 6000);
  else showVoiceText(tooltip.textContent, 4000);
});
window.trafficLight.onSoundFlash(() => rig.flash(600));

// Gestures are programmable per state (Lights → On click). The main
// process resolves the action; we just show feedback and any reaction.
async function gesture(g) {
  const r = await window.trafficLight.gesture(g);
  if (!r) return;
  if (r.react) rig.react(r.react, r.ms || 1400);
  if (r.feedback) showFeedback(r.feedback);
}
let clickTimer = null;
app.addEventListener('dblclick', () => { clearTimeout(clickTimer); clickTimer = null; gesture('double'); });
app.addEventListener('click', (e) => {
  if (swallowClick) { swallowClick = false; return; }
  if (didDrag) return;
  // Clicking an agent chip names it and says what it is doing.
  const chip = e.target.closest && e.target.closest('.minion');
  if (chip) { showFeedback(`${chip.dataset.name} — ${chip.dataset.status}`); return; }
  if (e.target.closest && e.target.closest('.pet')) { if (rig.pokePet()) { showFeedback('!'); return; } }
  if (e.altKey) { gesture('alt'); return; }
  if (clickTimer) return;
  clickTimer = setTimeout(() => { clickTimer = null; gesture('click'); }, 230);
});

document.getElementById('gear').addEventListener('mousedown', (e) => e.stopPropagation());
document.getElementById('gear').addEventListener('click', (e) => { e.stopPropagation(); window.trafficLight.openLights(); });

document.getElementById('help').addEventListener('mousedown', (e) => e.stopPropagation());
document.getElementById('help').addEventListener('click', (e) => { e.stopPropagation(); window.trafficLight.openHelp(); });

// Right-click the widget → the Plexiform window (one app, on the last page).
// Shift- or Option-right-click → the tray's menu, which on Linux without a
// tray is the only way to reach Quit.
app.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.trafficLight.widgetMenu(e.shiftKey || e.altKey);
});

// Session strip and hover cards (wave 1, lane A). While the pointer is over
// the widget, a strip of session chips shows at the top: the pinned one first,
// idle sessions folded into "+N idle", teammates on a second row. Resting on a
// chip (or focusing it) for 350 ms shows that session's card in place of the
// one-line tooltip. Every string comes from session files or a teammate: text
// only (textContent), never markup.
const CARD_DELAY_MS = 350;
const stripEl = document.getElementById('strip');
const cardEl = document.getElementById('session-card');
let lastInputs = [];
let cardsSeq = 0;
let cardsModel = null;
let cardTimer = 0;
let cardFor = null;
let cardsAt = 0;
function loadCards(force = false) {
  if (!window.trafficLight.getSessionCards) return;
  if (!force && Date.now() - cardsAt < 1000) return;
  cardsAt = Date.now();
  const seq = ++cardsSeq;
  window.trafficLight.getSessionCards().then((m) => { if (seq === cardsSeq && m) { cardsModel = m; paintStrip(); } }).catch(() => {});
}
function chipFor(row) {
  const b = document.createElement('button');
  b.type = 'button';
  if (row.kind === 'idle') {
    b.className = 'chip idle-count';
    b.textContent = `+${row.count} idle`;
    b.setAttribute('aria-label', `${row.count} idle sessions`);
    return b;
  }
  const c = row.card;
  b.className = `chip${c.waiting ? ' waiting' : c.idle ? ' idle' : ' active'}${row.pinned ? ' pinned' : ''}${row.team ? ' team' : ''}`;
  b.dataset.id = row.id || '';
  const dot = document.createElement('i'); dot.className = 'dot';
  const label = document.createElement('span');
  label.textContent = row.team && c.teammate ? c.teammate.initials : c.title;
  b.append(dot, label);
  b.setAttribute('aria-label', `${c.title}: ${c.state}`);
  const show = () => { clearTimeout(cardTimer); cardTimer = setTimeout(() => showCard(row, b), CARD_DELAY_MS); };
  b.addEventListener('mouseenter', show);
  b.addEventListener('focus', () => { clearTimeout(cardTimer); showCard(row, b); });
  b.addEventListener('mouseleave', () => { clearTimeout(cardTimer); cardTimer = setTimeout(hideCard, 200); });
  b.addEventListener('blur', (e) => { if (!cardEl.contains(e.relatedTarget)) hideCard(); });
  return b;
}
function paintStrip() {
  const m = cardsModel;
  const mine = m ? m.rows.map(chipFor) : [];
  const team = m ? m.team.map(chipFor) : [];
  const r1 = document.createElement('div'); r1.className = 'strip-row'; r1.replaceChildren(...mine);
  const r2 = document.createElement('div'); r2.className = 'strip-row team'; r2.replaceChildren(...team);
  stripEl.replaceChildren(...(mine.length ? [r1] : []), ...(team.length ? [r2] : []));
  document.body.classList.toggle('has-strip', mine.length + team.length > 0);
  for (const el of stripEl.querySelectorAll('button')) el.addEventListener('mousedown', stop);
  if (cardFor && !(m && [...m.rows, ...m.team].some((r) => r.id === cardFor))) hideCard();
}
function cardButton(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('mousedown', stop);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}
const CARD_ACTIONS = {
  open: () => cardButton('Open', async () => { const r = await window.trafficLight.goToNeedingSession().catch(() => null); if (r && r.feedback) showFeedback(r.feedback); hideCard(); }),
  answer: (c) => cardButton('Answer', async () => {
    const input = lastInputs.find((i) => i && i.session === c.id);
    const r = input ? await window.trafficLight.openInput(input.id).catch(() => null) : await window.trafficLight.goToNeedingSession().catch(() => null);
    if (r && (r.note || r.feedback)) showFeedback(r.note || r.feedback);
    hideCard();
  }),
  pin: (c) => cardButton('Pin', async () => { await window.trafficLight.pinSession(c.id).catch(() => null); loadCards(true); }),
  unpin: () => cardButton('Unpin', async () => { await window.trafficLight.pinSession(null).catch(() => null); loadCards(true); }),
  'resume-nudges': (c) => cardButton('Resume nudges', async () => { await window.trafficLight.resumeNudges?.(c.id).catch(() => null); loadCards(true); }),
};
function showCard(row, anchor) {
  const c = row.card;
  cardFor = row.id;
  const head = document.createElement('div'); head.className = 'card-head';
  if (c.teammate) { const av = document.createElement('span'); av.className = 'avatar'; av.textContent = c.teammate.initials; av.title = c.teammate.name; head.append(av); }
  const t = document.createElement('span'); t.className = 'card-title'; t.textContent = c.title; head.append(t);
  const lines = [head];
  const st = document.createElement('div'); st.className = 'card-state'; st.textContent = c.state; lines.push(st);
  if (c.spend) { const sp = document.createElement('div'); sp.className = 'card-spend'; sp.textContent = c.spend; lines.push(sp); }
  if (c.teammate) { const who = document.createElement('div'); who.className = 'card-spend'; who.textContent = c.teammate.name; lines.push(who); }
  if (c.deploy) { const d = document.createElement('div'); d.className = 'card-spend card-deploy'; d.textContent = c.deploy; lines.push(d); }
  if (c.nudgesPaused) { const p = document.createElement('div'); p.className = 'card-spend card-paused'; p.textContent = 'Nudges paused: it crossed your spend line'; lines.push(p); }
  if (c.recap) {
    const rc = document.createElement('div'); rc.className = 'card-recap';
    const h = document.createElement('div'); h.className = 'card-recap-head'; h.textContent = c.recap.headline; rc.append(h);
    if (c.recap.line) { const l = document.createElement('div'); l.textContent = c.recap.line; rc.append(l); }
    lines.push(rc);
  }
  if (c.help && c.help.length) {
    if (c.helpWhy) { const w = document.createElement('div'); w.className = 'card-spend'; w.textContent = c.helpWhy; lines.push(w); }
    const box = document.createElement('div'); box.className = 'card-acts card-help';
    box.append(...c.help.map((h) => cardButton(h.label, async () => { const r = await window.trafficLight.cardHelp?.(h.handle).catch(() => null); showFeedback(r && r.ok ? 'Copied. Paste it into your AI.' : 'Could not copy that.'); })));
    lines.push(box);
  }
  const acts = c.actions.map((a) => CARD_ACTIONS[a] && CARD_ACTIONS[a](c)).filter(Boolean);
  if (acts.length) { const box = document.createElement('div'); box.className = 'card-acts'; box.append(...acts); lines.push(box); }
  cardEl.replaceChildren(...lines);
  const r = anchor.getBoundingClientRect();
  cardEl.style.top = `${Math.round(r.bottom + 4)}px`;
  cardEl.classList.add('shown');
  cardEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('carding');
}
function hideCard() {
  clearTimeout(cardTimer);
  cardFor = null;
  cardEl.classList.remove('shown');
  cardEl.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('carding');
}
cardEl.addEventListener('mouseenter', () => clearTimeout(cardTimer));
cardEl.addEventListener('mouseleave', () => { cardTimer = setTimeout(hideCard, 200); });
cardEl.addEventListener('mousedown', stop);
cardEl.addEventListener('focusout', (e) => { if (!cardEl.contains(e.relatedTarget) && !stripEl.contains(e.relatedTarget)) hideCard(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cardFor) hideCard(); });
