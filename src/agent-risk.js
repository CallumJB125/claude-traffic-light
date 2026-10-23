'use strict';
// Risky-directive scan for third-party agent prompts. An agent file is a
// standing instruction that runs with the user's AI tool permissions, so the
// catalogue build scans every one and the app shows the flags before adding.
// Pure: text in, flags out. The same rules run at build time
// (scripts/agent-risk-scan.js) and in tests against the shipped catalogue.
const { DESTRUCTIVE_CMDS } = require('./auto-rules.js');
const { findSecrets } = require('./secret-patterns.js');

const RULES_VERSION = 1;
const MAX_FLAGS = 20;
const EXCERPT = 160;

// Hosts a link to which is ordinary reference material, not a destination.
const URL_ALLOW = /^(?:[a-z0-9-]+\.)*(?:github\.com|githubusercontent\.com|gitlab\.com|mozilla\.org|w3\.org|whatwg\.org|python\.org|nodejs\.org|npmjs\.com|rust-lang\.org|go\.dev|golang\.org|microsoft\.com|apple\.com|android\.com|google\.com|googleapis\.com|anthropic\.com|claude\.com|openai\.com|aws\.amazon\.com|amazon\.com|cloud\.google\.com|azure\.com|kubernetes\.io|docker\.com|owasp\.org|nist\.gov|wikipedia\.org|ietf\.org|schema\.org|example\.com|example\.org|localhost)$/i;

const HIGH = [
  { rule: 'pipe-to-shell', re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i, why: 'Downloads a script and runs it in a shell.' },
  { rule: 'pipe-to-shell', re: /\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b/i, why: 'Downloads a script and runs it in a shell.' },
  { rule: 'permission-bypass', re: /--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|\bbypassPermissions\b|--yolo\b|approval_policy\s*=\s*["']?never/i, why: 'Turns off the AI tool\'s permission prompts.' },
  { rule: 'sensitive-config', re: /\b(?:write|edit|modify|append|add|update|overwrite|change|replace|insert)\b[^\n]{0,80}(?:~\/\.ssh\b|authorized_keys|\.bashrc\b|\.zshrc\b|\.bash_profile\b|\.zprofile\b|(?:~|\$HOME)\/\.profile\b|\.claude\/settings(?:\.local)?\.json|\.mcp\.json|mcpServers|\.codex\/config\.toml)/i, why: 'Tells the AI to change shell start-up files, SSH keys, hooks or MCP config.' },
  { rule: 'sensitive-config', re: />>?\s*(?:~|\$HOME)\/\.(?:ssh\/|bashrc|zshrc|bash_profile|zprofile|profile)\b/i, why: 'Writes into SSH or shell start-up files.' },
  { rule: 'base64-blob', re: /[A-Za-z0-9+/]{200,}={0,2}/, why: 'A long encoded blob that cannot be read before adding.' },
  { rule: 'exfiltration', re: /\b(?:send|post|upload|exfiltrate|transmit|forward|report|beacon)\b[^\n]{0,80}\b(?:to|at)\s+<?https?:\/\/(?!(?:www\.)?example\.(?:com|org)\b|localhost\b|127\.0\.0\.1\b)/i, why: 'Tells the AI to send data to a web address.' },
  { rule: 'hidden-characters', re: /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/, why: 'Invisible or text-direction characters can hide instructions.' },
];

function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const end = text.indexOf('\n', index);
  return { line: text.slice(0, index).split('\n').length, text: text.slice(start, end < 0 ? text.length : end) };
}
const excerpt = (s) => { const t = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '␣').trim(); return t.length > EXCERPT ? `${t.slice(0, EXCERPT - 1)}…` : t; };

function fenced(text) {
  const out = [];
  const re = /^(```|~~~)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;
  let m;
  while ((m = re.exec(text))) out.push({ index: m.index + m[0].indexOf('\n') + 1, text: m[2] });
  return out;
}

/**
 * Scans one agent. `body` is the prompt text (frontmatter excluded);
 * `tools` is the declared tool list, or null when the author declared none.
 * Returns { level: 'none'|'review'|'high', flags: [{ level, rule, line, excerpt, why }] }.
 */
function scanAgent({ body, tools = null, frontmatter = '' }) {
  const text = String(body ?? '');
  const flags = [];
  const seen = new Set();
  const add = (level, rule, index, why, src = text, lineOffset = 0) => {
    const at = lineAt(src, index);
    const key = `${rule}:${at.line + lineOffset}`;
    if (seen.has(key) || flags.length >= MAX_FLAGS) return;
    seen.add(key);
    flags.push({ level, rule, line: at.line + lineOffset, excerpt: excerpt(at.text), why });
  };
  for (const r of HIGH) {
    const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : `${r.re.flags}g`);
    let m;
    while ((m = re.exec(text))) { add('high', r.rule, m.index, r.why); if (m[0].length === 0) re.lastIndex++; }
  }
  // The frontmatter gets the same high rules; its flags are reported on line 0.
  const fm = String(frontmatter ?? '');
  for (const r of HIGH) {
    const m = new RegExp(r.re.source, r.re.flags.replace('g', '')).exec(fm);
    if (m && !seen.has(`${r.rule}:0`) && flags.length < MAX_FLAGS) { seen.add(`${r.rule}:0`); flags.push({ level: 'high', rule: r.rule, line: 0, excerpt: `(frontmatter) ${excerpt(lineAt(fm, m.index).text)}`.slice(0, EXCERPT), why: r.why }); }
  }
  for (const h of findSecrets(text, { classes: ['credential'] })) add('high', 'secret', h.index, 'Looks like a real credential.');

  for (const f of fenced(text)) {
    for (const lm of f.text.matchAll(/^[ \t>$#]*(?:sudo\s+)?([a-z][\w.-]*)/gm)) {
      if (DESTRUCTIVE_CMDS.has(lm[1])) add('review', 'destructive-command', f.index + lm.index, `Example uses \`${lm[1]}\`, which can delete work, reach the network or change permissions.`);
    }
  }
  if (tools === null) flags.push({ level: 'review', rule: 'all-tools', line: 0, excerpt: '(no tools listed)', why: 'The author did not limit its tools, so it gets every tool your AI tool has.' });
  else if (tools.some((t) => /^bash\b/i.test(t))) flags.push({ level: 'review', rule: 'runs-commands', line: 0, excerpt: `tools: ${tools.join(', ')}`.slice(0, EXCERPT), why: 'It can run terminal commands.' });
  const hosts = new Set();
  for (const m of text.matchAll(/\bhttps?:\/\/([a-z0-9.-]+)/gi)) {
    const host = m[1].toLowerCase().replace(/\.$/, '');
    if (URL_ALLOW.test(host) || hosts.has(host)) continue;
    hosts.add(host);
    add('review', 'external-url', m.index, `Links to ${host}.`);
  }
  flags.sort((a, b) => (a.level === b.level ? 0 : a.level === 'high' ? -1 : 1) || a.line - b.line || a.rule.localeCompare(b.rule));
  const level = flags.some((f) => f.level === 'high') ? 'high' : flags.length ? 'review' : 'none';
  return { level, flags };
}

module.exports = { scanAgent, RULES_VERSION, URL_ALLOW };
