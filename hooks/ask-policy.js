// How long a blocking permission hook waits for the widget, what Plexiform tells the person about it, and how the hook
// cleans up after itself. Measured on Claude Code 2.1.310 (docs/waiting-inputs.md, work/dogfood-lab/cv-report.md): the
// terminal dialog is NOT held while a PermissionRequest hook runs (it is drawn within 0.3 s and answerable at once), and a
// late allow after a terminal answer is ignored, so the hook waits its full 55 s and nothing else needs to gate it.
'use strict';

const ASK_CEILING_MS = 55000;

// → the one line shown once on the first real request (C-N).
const NOTICE_TEXT = 'You can answer Claude’s permission prompts here or in the terminal.';
const noticeText = () => NOTICE_TEXT;

// G2: said at setup's Connect, where the blocking permission hook is consented to (onboarding.html carries the same words).
const CONSENT_TEXT = 'We also add a hook that lets Plexiform show Claude’s permission prompts and wait briefly for your answer. If you don’t answer, the terminal asks as usual. Settings › Widget turns it off.';

// A repo's .claude/settings.json can set environment variables for every hook, so the environment can only shorten a
// wait (0 = don't wait at all: the in-process caller and tests use it), never lengthen it.
function clampAskMs(raw, ceilingMs = ASK_CEILING_MS) {
  const n = Number(raw);
  return raw === undefined || raw === '' || !Number.isFinite(n) ? ceilingMs : Math.min(ceilingMs, Math.max(0, n));
}
function clampHookTimeoutMs(raw, installedMs) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(installedMs, n) : installedMs;
}

module.exports = { ASK_CEILING_MS, clampAskMs, clampHookTimeoutMs, noticeText, NOTICE_TEXT, CONSENT_TEXT };
