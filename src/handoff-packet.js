'use strict';
// The packet behind "Hand off to <another AI tool>": goal, files touched, last
// summary and branch, every free-text field run through src/scrub.js. Pure and
// local: building one sends nothing and launches nothing. A packet is only
// releasable with a confirmation bound to its exact contents (digest), so any
// edit after the person looked invalidates it. Releasing is the caller's job
// (src/handoff.js copy or launch) and it must call release() first.

const crypto = require('node:crypto');
const Scrub = require('./scrub.js');

const KIND = 'plexiform-handoff-packet';
const VERSION = 1;
const TOOL = /^[a-z]{2,12}$/;
const LIMITS = Object.freeze({ goal: 500, summary: 2000, branch: 200, file: 300, files: 50 });

function clean(v, max, opts) {
  if (typeof v !== 'string') return '';
  const t = v.trim().slice(0, max * 2);
  return Scrub.redactSecretsPass(opts.home ? t.split(opts.home).join('~') : t).trim().slice(0, max);
}

// input: { from, to, goal, files[], summary, branch }; opts.home is shown as ~. Secrets and PII go through scrub.redactSecretsPass; file names are kept, the next tool needs them.
function build(input, opts = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const files = [...new Set((Array.isArray(i.files) ? i.files : []).map((f) => clean(f, LIMITS.file, opts)).filter(Boolean))].slice(0, LIMITS.files);
  return {
    kind: KIND,
    v: VERSION,
    from: typeof i.from === 'string' && TOOL.test(i.from) ? i.from : null,
    to: typeof i.to === 'string' && TOOL.test(i.to) ? i.to : null,
    goal: clean(i.goal, LIMITS.goal, opts),
    files,
    summary: clean(i.summary, LIMITS.summary, opts),
    branch: clean(i.branch, LIMITS.branch, opts),
  };
}

function validate(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return { ok: false, errors: ['Not a handoff packet.'] };
  if (p.kind !== KIND || p.v !== VERSION) errors.push('Unknown packet version.');
  if (typeof p.to !== 'string' || !TOOL.test(p.to)) errors.push('Choose the tool to hand off to.');
  if (p.from != null && (typeof p.from !== 'string' || !TOOL.test(p.from))) errors.push('Invalid source tool.');
  if (p.from && p.from === p.to) errors.push('Hand off to a different tool.');
  if (typeof p.goal !== 'string' || !p.goal) errors.push('A goal is required.');
  else if (p.goal.length > LIMITS.goal) errors.push('Goal is too long.');
  if (typeof p.summary !== 'string' || p.summary.length > LIMITS.summary) errors.push('Summary is missing or too long.');
  if (typeof p.branch !== 'string' || p.branch.length > LIMITS.branch) errors.push('Branch is invalid.');
  if (!Array.isArray(p.files) || p.files.length > LIMITS.files || p.files.some((f) => typeof f !== 'string' || !f || f.length > LIMITS.file)) errors.push('Files are invalid.');
  return { ok: errors.length === 0, errors };
}

// Stable over the known fields only, so unknown extras never ride along.
const digest = (p) => crypto.createHash('sha256').update(JSON.stringify([p.kind, p.v, p.from, p.to, p.goal, p.files, p.summary, p.branch])).digest('hex');

// What the person is shown, and what a copy or launch would deliver.
function toPrompt(p) {
  const v = validate(p);
  if (!v.ok) throw new Error(v.errors[0]);
  return [
    `# Handoff${p.from ? ` from ${p.from}` : ''} to ${p.to}`,
    '',
    '## Goal', p.goal,
    ...(p.branch ? ['', '## Branch', p.branch] : []),
    ...(p.files.length ? ['', '## Files touched', ...p.files.map((f) => `- ${f}`)] : []),
    ...(p.summary ? ['', '## Where it was left', p.summary] : []),
    '',
  ].join('\n');
}

// The confirmation the UI creates when the person presses the confirm button
// for the packet they were shown.
const confirmation = (p) => ({ confirmed: true, digest: digest(p) });

// Throws unless the packet is valid and the confirmation is for exactly this content.
function release(p, c) {
  const v = validate(p);
  if (!v.ok) throw new Error(v.errors[0]);
  if (!c || c.confirmed !== true || c.digest !== digest(p)) throw new Error('Confirm the handoff first.');
  return toPrompt(p);
}

module.exports = { build, validate, toPrompt, confirmation, release, digest, LIMITS, KIND, VERSION };
