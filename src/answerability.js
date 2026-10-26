// Can Plexiform deliver an answer to this waiting input? One pure function the widget, Home, the Inbox and the
// Waiting page all ask, so none of them shows a button that main would refuse. It only chooses what to show:
// main still checks the sender and the setting itself (answer-input, home:answer-input).
//   answerability(request, { askFromWidget, now }) → { answerable, reason, action }
//   action: 'answer' (buttons), 'open' (jump to the hook's own terminal), 'go-to-terminal' (answer it there)
// Loaded as a plain script (window.PlexiformAnswerability) and by Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlexiformAnswerability = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const REASON_TEXT = Object.freeze({
    'setting-off': 'Answering here is off',
    expired: 'The hook stopped waiting: answer in the terminal.',
    'session-reported': 'The session reported this itself, so Plexiform can’t send an answer. Answer it in the terminal.',
    'pre-hook': 'Answer in the terminal (restart this session to answer here).',
    terminal: 'This is a dialog in the terminal. Answer it there.',
    blocked: 'Plexiform can’t decide this for you.',
    gone: 'It is no longer waiting.',
  });

  // What answer-input / home:answer-input return, in words. Anything main already wrote as a sentence passes through.
  const ERROR_TEXT = Object.freeze({
    off: 'Answering from here is off. Turn it on in Settings › Widget, or answer in the terminal.',
    'not allowed': 'This window can’t answer that. Answer it in the terminal.',
    flagged: 'This one needs a careful look first: open it and click Allow anyway, or answer in the terminal.',
    invalid: 'That answer wasn’t sent because it didn’t look right. Answer it in the terminal.',
  });
  const LAST_RESORT = 'Could not send: answer it in the terminal.';

  const CHOICE_KINDS = new Set(['permission', 'plan', 'question', 'elicitation']);

  function expired(request, now) {
    const at = Date.parse(request && request.expires_at);
    return Number.isFinite(at) && now >= at;
  }

  function answerability(request, context = {}) {
    const now = Number.isFinite(context.now) ? context.now : Date.now();
    if (!request || typeof request !== 'object') return { answerable: false, reason: 'gone', action: 'open' };
    const on = typeof context.askFromWidget === 'boolean' ? context.askFromWidget : request.answering !== false;
    const actions = Array.isArray(request.actions) ? request.actions : [];
    if (request.kind === 'blocked') return { answerable: false, reason: 'blocked', action: 'open' };
    const hook = request.answerable === true && actions.includes('answer');
    if (hook && expired(request, now)) return { answerable: false, reason: 'expired', action: 'open' };
    if (hook) return on ? { answerable: true, reason: null, action: 'answer' } : { answerable: false, reason: 'setting-off', action: 'open' };
    if (request.source === 'tmux' || request.kind === 'dialog') return { answerable: false, reason: 'terminal', action: 'go-to-terminal' };
    if (request.preHook === true) return { answerable: false, reason: 'pre-hook', action: 'go-to-terminal' };
    // Reported by the session, not by a blocking hook. Turning answering on can only help a Claude session.
    const claude = !request.provider || request.provider === 'claude';
    const choice = CHOICE_KINDS.has(request.kind) || (request.kind === 'notification' && request.notification_type === 'permission_prompt');
    if (!on && claude && choice) return { answerable: false, reason: 'setting-off', action: 'go-to-terminal' };
    return { answerable: false, reason: 'session-reported', action: 'go-to-terminal' };
  }

  const reasonText = (reason) => REASON_TEXT[reason] || '';

  function errorText(error) {
    const s = typeof error === 'string' ? error.trim() : '';
    if (Object.hasOwn(ERROR_TEXT, s)) return ERROR_TEXT[s];
    // A sentence from main (it has spaces and is not one of the bare codes) is already in words.
    return /\s/.test(s) && s.length <= 300 ? s : LAST_RESORT;
  }

  // The jump to a terminal failed: its own `cant` (or note) says why.
  function openErrorText(result) {
    if (result && result.error === 'gone') return REASON_TEXT.gone;
    const why = result && (result.cant || result.note);
    return typeof why === 'string' && why.trim() ? why.trim().slice(0, 300) : 'Could not find its terminal.';
  }

  // The choices of a question that can't be answered here, as one plain sentence: "In the terminal: A, B or C."
  function optionsSentence(labels) {
    const l = (Array.isArray(labels) ? labels : []).map((x) => String(x || '').trim()).filter(Boolean);
    if (!l.length) return '';
    return `In the terminal: ${l.length === 1 ? l[0] : `${l.slice(0, -1).join(', ')} or ${l[l.length - 1]}`}.`;
  }

  return { answerability, reasonText, errorText, openErrorText, optionsSentence, REASON_TEXT, ERROR_TEXT, LAST_RESORT };
});
