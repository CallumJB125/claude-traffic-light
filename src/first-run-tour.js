'use strict';
// The first-run tour: five coachmarks that show a new user the product doing
// something useful within 30 seconds of finishing setup. Pure: the state lives
// in config as `tourState`, main (src/first-run-tour-main.js) opens windows and
// sends steps, and tour-coachmark.js draws them. Once finished or skipped it
// never comes back on its own; Help → "Take the tour again" restarts it.

// target: where the highlighted thing is. host: where the callout is drawn
// (the widget is too small to hold one, so its steps are explained from Home).
const STEPS = Object.freeze([
  { id: 'widget', target: { window: 'widget', selector: '#housing' }, host: { window: 'main', page: 'home' },
    title: 'This is your widget', body: 'The lamp shows what your AI is doing: green working, amber waiting on you, red stuck. The character acts it out.', primary: 'Next' },
  { id: 'waiting', target: { window: 'widget', selector: '#bubble' }, host: { window: 'main', page: 'home' },
    title: 'Answer from the widget', body: 'When an AI asks you something, the question appears under the widget. Pick an answer there and it carries on.', primary: 'Next' },
  { id: 'rules', target: { window: 'lights', selector: '#rule-list' }, host: { window: 'lights' },
    title: 'Make it yours', body: 'Rules decide what the widget does for each state. Change a colour, a pose or a sound and try it live.', primary: 'Next' },
  { id: 'spend', target: { window: 'main', page: 'usage', selector: '#mix' }, host: { window: 'main', page: 'usage' }, also: { window: 'widget', selector: '#rings' },
    title: 'See what it costs', body: 'Usage shows what each day costs, worked out on this Mac. The ring round the widget fills as you near your daily budget.', primary: 'Next' },
  { id: 'team', target: { window: 'main', page: 'home', selector: '#cards, #teamwork, #teamtoday' }, host: { window: 'main', page: 'home' },
    title: 'Bring your team', body: 'Invite teammates to share boards and hand work over. Try Team when you are ready.', primary: 'Open Team' },
]);

const STATUSES = ['not-started', 'running', 'finished', 'skipped'];
const INITIAL = Object.freeze({ status: 'not-started', step: 0, at: null });

function parse(raw) {
  if (!raw || typeof raw !== 'object' || !STATUSES.includes(raw.status)) return { ...INITIAL };
  const step = Number.isSafeInteger(raw.step) && raw.step >= 0 && raw.step < STEPS.length ? raw.step : 0;
  return { status: raw.status, step, at: Number.isSafeInteger(raw.at) ? raw.at : null };
}

const done = (s) => s.status === 'finished' || s.status === 'skipped';
// Automatic start only for someone who has never seen it; restart is Help's.
const shouldAutoStart = (s) => parse(s).status === 'not-started';
const start = (now = Date.now()) => ({ status: 'running', step: 0, at: now });
const restart = start;

// missing(i) is true for a step whose target is absent; such steps are passed over.
function advance(s, { from = s.step, missing = () => false, now = Date.now() } = {}) {
  if (s.status !== 'running' || from !== s.step) return s;
  let i = s.step + 1;
  while (i < STEPS.length && missing(i)) i += 1;
  return i >= STEPS.length ? { status: 'finished', step: STEPS.length - 1, at: now } : { status: 'running', step: i, at: now };
}
// The first step that is present, from the current one.
function settle(s, { missing = () => false, now = Date.now() } = {}) {
  if (s.status !== 'running' || !missing(s.step)) return s;
  return advance(s, { missing, now });
}
const skip = (s, now = Date.now()) => (s.status === 'running' ? { status: 'skipped', step: s.step, at: now } : s);
const finish = (s, now = Date.now()) => (s.status === 'running' ? { status: 'finished', step: s.step, at: now } : s);

// What a window is sent for the current step (step numbers are 1-based for people).
function view(s) {
  if (s.status !== 'running') return null;
  const st = STEPS[s.step];
  return { id: st.id, index: s.step + 1, total: STEPS.length, title: st.title, body: st.body, primary: st.primary, skip: 'Skip tour', last: s.step === STEPS.length - 1 };
}

// The 30-second promise: start this long after setup closes (and never later
// than DEADLINE_MS after it), so the new user sees it while still looking.
const DELAY_MS = 4000;
const DEADLINE_MS = 30_000;
function scheduleStart({ setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout, delayMs = DELAY_MS, ready = () => true, begin, retryMs = 2000 } = {}) {
  let timer = null, waited = 0, cancelled = false;
  const tick = () => {
    if (cancelled) return;
    if (ready()) { timer = null; begin(); return; }
    if (waited + retryMs > DEADLINE_MS - delayMs) { timer = null; begin(); return; }
    waited += retryMs;
    timer = st(tick, retryMs);
  };
  timer = st(tick, Math.min(delayMs, DEADLINE_MS));
  return () => { cancelled = true; if (timer) ct(timer); timer = null; };
}

module.exports = { STEPS, STATUSES, INITIAL, parse, done, shouldAutoStart, start, restart, advance, settle, skip, finish, view, scheduleStart, DELAY_MS, DEADLINE_MS };
