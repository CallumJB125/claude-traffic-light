// Everything waiting on the person, in one list the bubble can render
// (schema: docs/waiting-inputs.md "PendingInput"). Three sources:
//   hook     requests/<id>.json from a blocking hook: answerable
//   session  what a session file says it is waiting on (a notification ask,
//            a question with no widget channel, a classifier denial): shown,
//            answered in the terminal
//   tmux     a dialog read off the session's tmux pane (pane-dialogs.js):
//            shown, answered in the terminal
// Pure: main.js passes what it has already read.
const { describeRequest, reveal } = require('./request-view.js');
const Input = require('../hooks/pending-input.js');

const ASK_MS = 55000;
const BLOCKED_KEEP_MS = 30 * 60 * 1000;
const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);
const text = (v, n = 4000) => reveal(typeof v === 'string' ? v : '').slice(0, n);

// Options go to the renderer without their answer payloads: a click sends
// the option id back and main.js looks the answer up again from the request
// (answerInput), so the renderer can never make up an answer.
const publicOption = ({ answer, ...o }) => o;

function fromRequest(req) {
  const kind = Input.KINDS.includes(req.kind) ? req.kind : 'permission';
  const view = Input.viewOf({ ...req, kind });
  const created = Date.parse(req.createdAt);
  const expires = Date.parse(req.expiresAt) || created + ASK_MS;
  const base = {
    v: 1, id: req.id, session: req.sessionId || null, host: req.host || null, cwd: req.cwd || null,
    kind, source: 'hook', tool: req.tool || null,
    created_at: iso(created), expires_at: iso(expires),
    answerable: typeof req.toolInputHash === 'string', actions: ['answer', 'open'],
  };
  if (kind === 'permission') {
    const d = describeRequest(req);
    return { ...base, title: view.title, text: d.detail, headline: d.headline, options: view.options.map(publicOption) };
  }
  return {
    ...base, title: text(view.title, 200), text: text(view.text, 20000), options: view.options.map(publicOption),
    ...(view.questions ? { questions: view.questions } : {}),
    ...(view.schema ? { schema: view.schema } : {}),
    ...(view.freeText ? { freeText: true } : {}),
  };
}

// The answer an option id stands for, recomputed from the request itself.
// For a question, `answers` (free text or a multi-question form) is taken
// from the click; for an elicitation, `content`.
function answerFor(req, optionId, { answers, content, message } = {}) {
  const kind = Input.KINDS.includes(req.kind) ? req.kind : 'permission';
  const view = Input.viewOf({ ...req, kind });
  if (optionId === 'answers' && kind === 'question' && answers) return { decision: 'allow', extra: { answers } };
  const opt = view.options.find((o) => o.id === optionId);
  if (!opt) return null;
  const extra = { ...(opt.answer.extra || {}) };
  if (opt.answer.decision === 'deny' && typeof message === 'string' && message.trim()) extra.message = message.slice(0, 1000);
  if (kind === 'elicitation' && opt.answer.decision === 'accept' && content) extra.content = content;
  return { decision: opt.answer.decision, extra };
}

function fromSession(s, { pendingSessionIds = new Set(), now = Date.now() } = {}) {
  const out = [];
  const base = { v: 1, session: s.sessionId || null, host: s.host || null, cwd: s.cwd || null, source: 'session', answerable: false, actions: ['open'], expires_at: null };
  const ask = s.ask && typeof s.ask === 'object' ? s.ask : null;
  if (s.signal === 'permission-ask' && ask && !pendingSessionIds.has(s.sessionId)) {
    if (ask.kind === 'question') {
      const questions = Array.isArray(ask.questions) ? ask.questions : [];
      out.push({ ...base, id: `ask-${s.host}-${s.sessionId}`, kind: 'question', tool: ask.tool || 'AskUserQuestion', title: text(questions[0]?.header, 60) || 'Claude has a question',
        text: text(questions.map((q) => q.question).join('\n\n')), questions, options: [], created_at: ask.at || null });
    } else if (ask.kind === 'notification') {
      out.push({ ...base, id: `ask-${s.host}-${s.sessionId}`, kind: 'notification', notification_type: ask.type || null, tool: s.tool || null,
        title: text(ask.title, 200) || 'Needs your input', text: text(ask.message, 2000), options: [], created_at: ask.at || null });
    }
  }
  const b = s.blocked && typeof s.blocked === 'object' ? s.blocked : null;
  const bAt = b ? Date.parse(b.at) : NaN;
  if (b && Number.isFinite(bAt) && now - bAt < BLOCKED_KEEP_MS) {
    out.push({ ...base, id: `blocked-${s.host}-${s.sessionId}-${bAt}`, kind: 'blocked', tool: b.tool || null,
      title: `Blocked: ${text(b.tool, 80) || 'a tool call'} needs your decision`,
      text: [text(b.summary, 300), b.reason ? `Reason: ${text(b.reason, 500)}` : ''].filter(Boolean).join('\n'),
      reason: b.reason ? text(b.reason, 500) : null,
      // Not prompts: what the person can do about it. None is automatic.
      options: [
        { id: 'run-yourself', label: 'Run it yourself' },
        { id: 'switch-mode', label: 'Switch permission mode' },
        { id: 'add-rule', label: 'Add a rule' },
      ],
      created_at: b.at });
  }
  return out;
}

function fromDialog(d) {
  return {
    v: 1, id: `dialog-${d.key}`, session: d.sessionId, host: d.host || null, cwd: d.cwd, launch: d.launchId || null,
    kind: 'dialog', dialog: d.dialog, source: 'tmux', tool: null,
    title: d.title, text: d.text, options: d.options,
    created_at: d.seenAt, expires_at: null, answerable: false, actions: ['open'],
  };
}

function collect({ requests = [], sessions = [], dialogs = [], now = Date.now() } = {}) {
  const pendingSessionIds = new Set(requests.map((r) => r.sessionId));
  const items = [
    ...requests.map(fromRequest),
    ...sessions.flatMap((s) => fromSession(s, { pendingSessionIds, now })),
  ];
  // A pane read beats the session's vaguer notification text for the same session.
  const dialogSessions = new Set(dialogs.map((d) => d.sessionId).filter(Boolean));
  const kept = items.filter((i) => !(i.kind === 'notification' && dialogSessions.has(i.session)));
  return [...kept, ...dialogs.map(fromDialog)].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

module.exports = { fromRequest, fromSession, fromDialog, answerFor, collect, BLOCKED_KEEP_MS };
