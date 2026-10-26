// How long a blocking permission hook waits for the widget, and what Plexiform tells the person about it. The two
// constants below are the recorded C-V measurement on the pinned Claude Code (docs/waiting-inputs.md); both default to
// today's behaviour until the lab result sets them. Loaded by the hook script (hooks/), main and the tests.
'use strict';

// (a) Is Claude Code's own terminal dialog held while a PermissionRequest hook runs? When it is, every second the hook
//     waits is a second the person at the keyboard cannot answer there, so the wait comes down and stops early when the
//     session's terminal is frontmost. The first-use notice (C-N) is worded by the same constant.
const PERMISSION_DIALOG_HELD = false;

// (b) Does a late allow (after the terminal prompt took over) do harm? When it does, main checks the session is still
//     waiting on a permission before it writes an answer.
const LATE_ALLOW_HARMFUL = false;

const TODAY_CEILING_MS = 55000;
const HELD_CEILING_MS = 9000;
const EARLY_STOP_AFTER_MS = 1500;

// A policy for the measured facts; defaults to the recorded constants. Tests pass the facts in.
function policy({ held = PERMISSION_DIALOG_HELD, lateAllowHarmful = LATE_ALLOW_HARMFUL } = {}) {
  return {
    held: held === true,
    lateAllowHarmful: lateAllowHarmful === true,
    ceilingMs: held === true ? HELD_CEILING_MS : TODAY_CEILING_MS,
    earlyStopWhenTerminalFrontmost: held === true,
  };
}

// → the one line shown once on the first real request (C-N). Which copy depends on (a).
function noticeText(opts = {}) {
  const p = policy(opts);
  return p.held
    ? `Plexiform shows Claude’s permission prompts here; your terminal still gets them if you don’t answer within ${Math.round(p.ceilingMs / 1000)} s.`
    : 'You can answer Claude’s permission prompts here or in the terminal.';
}

// (b): a request whose session is no longer asking is answered too late; the person sees the terminal prompt instead.
// → null to go ahead, else the sentence to give back.
function lateAnswerRefusal(session, opts = {}) {
  if (!policy(opts).lateAllowHarmful) return null;
  if (session && session.signal === 'permission-ask') return null;
  return 'The terminal already took this over: answer it there.';
}

// (a): is the session's own terminal in front? `frontApp` is the frontmost application's name, `hostApp` the session's.
function terminalFrontmost(frontApp, hostApp) {
  const a = String(frontApp || '').trim().toLowerCase();
  const b = String(hostApp || '').trim().toLowerCase();
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}

// G2: said at setup's Connect, where the blocking permission hook is consented to (onboarding.html carries the same words).
const CONSENT_TEXT = 'We also add a hook that lets Plexiform show Claude’s permission prompts and wait briefly for your answer. If you don’t answer, the terminal asks as usual. Settings › Widget turns it off.';

module.exports = { CONSENT_TEXT, PERMISSION_DIALOG_HELD, LATE_ALLOW_HARMFUL, TODAY_CEILING_MS, HELD_CEILING_MS, EARLY_STOP_AFTER_MS, policy, noticeText, lateAnswerRefusal, terminalFrontmost };
