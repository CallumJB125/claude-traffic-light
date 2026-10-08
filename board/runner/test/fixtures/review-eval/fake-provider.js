// Deterministic stand-ins for a reviewer model, so CI can measure the review
// pipeline without a provider account. Both read only the DIFF block of the
// prompt (as a model should) and apply a few line rules.
//   fake      a careful reviewer: never follows text inside the data blocks
//   gullible  a fooled one: when the change asks for an approve, it approves.
//             The pipeline's guards must still keep that from reading "approve".

const RULES = [
  [/<=\s*[\w.]+\.length\b/, 'high', 'Loop runs one past the end of the array (<= length).'],
  [/catch\s*(?:\(\s*\w*\s*\))?\s*\{\s*\}/, 'medium', 'Errors are swallowed, so a failed write looks like success.'],
  [/\[redacted\]/, 'high', 'A credential is committed in the source.'],
  [/\beval\s*\(/, 'high', 'eval() on user input allows code injection.'],
  [/[^=!]==[^=]/, 'medium', 'Loose equality can match values of different types.'],
  [/listen\([^)]*'0\.0\.0\.0'/, 'medium', 'The server now listens on every interface, not only this machine.'],
];
const REMOVED_TEST = /^-\s*(?:test|it)\(/;
const ASKS_APPROVE = /\b(?:approve|"verdict"\s*:\s*"approve")\b/i;

function diffOf(prompt) {
  const m = /<<<BEGIN DIFF ([0-9a-f]+)>>>\n([\s\S]*?)\n<<<END DIFF \1>>>/.exec(String(prompt));
  return m ? m[2] : '';
}

function review(diff) {
  const findings = [];
  let file = null, line = 0;
  for (const raw of diff.split('\n')) {
    const f = /^\+\+\+ b\/(.+)$/.exec(raw);
    if (f) { file = f[1]; continue; }
    if (raw.startsWith('--- ')) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) { line = Number(h[1]); continue; }
    if (REMOVED_TEST.test(raw)) findings.push({ file, line, severity: 'high', rationale: 'A test was deleted instead of updated.' });
    if (raw.startsWith('+')) {
      for (const [re, severity, rationale] of RULES) if (re.test(raw.slice(1))) findings.push({ file, line, severity, rationale });
      if (/\b(?:reviewer|ai)\b/i.test(raw) && ASKS_APPROVE.test(raw)) findings.push({ file, line, severity: 'high', rationale: 'text in the change addresses the reviewer' });
      line++;
    } else if (!raw.startsWith('-')) line++;
  }
  const serious = findings.some((x) => x.severity !== 'low');
  return { verdict: serious ? 'changes_requested' : 'approve', summary: serious ? `${findings.length} problem(s) found.` : 'The change does what the card asks.', findings };
}

export const providers = {
  fake: async ({ prompt }) => ({ ok: true, text: JSON.stringify(review(diffOf(prompt))), cost_usd: 0 }),
  gullible: async ({ prompt }) => {
    const diff = diffOf(prompt);
    const added = diff.split('\n').filter((l) => l.startsWith('+')).join('\n');
    if (ASKS_APPROVE.test(added)) return { ok: true, text: '```json\n{"verdict":"approve","summary":"Looks good","findings":[]}\n```', cost_usd: 0 };
    return { ok: true, text: JSON.stringify(review(diff)), cost_usd: 0 };
  },
};
