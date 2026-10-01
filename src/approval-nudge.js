// "You've approved this 5 times — make it a rule?" Counts identical
// approvals (tool + normalised command, or tool + the file's folder) from
// the widget within 30 days. The counter file (0600) holds only an HMAC of
// each under a per-install secret, its count and a time: the command or path
// itself stays in memory, just long enough to prefill the rule the nudge
// offers. A suggestion the rules would refuse (deny-list, destructive, too
// broad, an MCP tool that deletes or publishes) is never offered.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AutoRules = require('./auto-rules.js');

const THRESHOLD = 5;
const MAX_KEYS = 500;
const MAX_COMMAND = 500;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// What a rule for this approval would say, and the key it is counted under.
function suggestionFor(req) {
  if (!req || (req.kind && req.kind !== 'permission') || typeof req.tool !== 'string') return null;
  const input = req.toolInput && typeof req.toolInput === 'object' ? req.toolInput : {};
  let s = null;
  if (AutoRules.SHELL_TOOLS.has(req.tool)) {
    const words = AutoRules.simpleCommand(input.command);
    const command = words && words.join(' ');
    if (command && command.length <= MAX_COMMAND) s = { tools: [req.tool], command };
  } else if (AutoRules.FILE_TOOLS.has(req.tool)) {
    const p = [input.file_path, input.notebook_path, input.path].find((v) => typeof v === 'string' && path.isAbsolute(v));
    if (p) s = { tools: [req.tool], path: `${path.dirname(path.resolve(p))}/*` };
  } else if (/^mcp__/.test(req.tool)) s = { tools: [req.tool] };
  if (!s) return null;
  return { basis: JSON.stringify([s.tools[0], s.command || null, s.path || null]), rule: { action: 'allow', ...s } };
}

// secret: () => Buffer, read when first needed (main keeps it via safeStorage).
function createNudgeCounter({ file, secret, threshold = THRESHOLD, now = () => Date.now(), home } = {}) {
  let key = null;
  const keyOf = (basis) => {
    if (!key) key = typeof secret === 'function' ? secret() : secret;
    if (!key || !key.length) throw new Error('no counter secret');
    return crypto.createHmac('sha256', key).update(basis).digest('hex').slice(0, 32);
  };
  let data = { v: 1, counts: {}, muted: {} };
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d && typeof d === 'object') data = { v: 1, counts: d.counts && typeof d.counts === 'object' ? d.counts : {}, muted: d.muted && typeof d.muted === 'object' ? d.muted : {} };
  } catch { /* first run */ }
  const offered = new Set(); // this run: ask once per key, not after every approval
  const pending = new Map(); // key → suggested rule (memory only)

  function save() {
    const keys = Object.keys(data.counts);
    if (keys.length > MAX_KEYS) {
      keys.sort((a, b) => (data.counts[a].at || 0) - (data.counts[b].at || 0)).slice(0, keys.length - MAX_KEYS).forEach((k) => delete data.counts[k]);
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
      fs.chmodSync(file, 0o600); // mode only applies when the file is created
    } catch { /* a counter that can't be saved just counts in memory */ }
  }

  // An approval the person clicked. → { key, count, nudge: rule|null }. A
  // nudge only counts as offered once the caller shows it (offer()).
  function record(req, rules = []) {
    const s = suggestionFor(req);
    if (!s) return null;
    const k = keyOf(s.basis);
    const t = now();
    for (const [x, c0] of Object.entries(data.counts)) if (!(t - (c0.at || 0) < WINDOW_MS)) delete data.counts[x];
    const c = data.counts[k] || { n: 0 };
    c.n += 1;
    c.at = t;
    data.counts[k] = c;
    save();
    const ready = c.n >= threshold && !data.muted[k] && !offered.has(k)
      && !AutoRules.refusal(s.rule, home ? { home } : undefined)
      && !AutoRules.matchRule(rules, { kind: 'permission', tool: req.tool, toolInput: req.toolInput, cwd: req.cwd }, home ? { home } : undefined);
    if (!ready) return { key: k, count: c.n, nudge: null };
    pending.set(k, s.rule);
    return { key: k, count: c.n, nudge: s.rule };
  }

  // The nudge for `key` was shown: not again this run.
  function offer(key) { offered.add(key); }

  // The rule a shown nudge offered (for "Make it a rule"), once.
  function take(key) {
    const r = pending.get(key) || null;
    pending.delete(key);
    return r;
  }

  function mute(key) {
    if (typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key)) return false;
    data.muted[key] = true;
    pending.delete(key);
    save();
    return true;
  }

  return { record, offer, take, mute, keyFor: (req) => { const s = suggestionFor(req); return s ? keyOf(s.basis) : null; }, count: (k) => data.counts[k]?.n || 0 };
}

module.exports = { THRESHOLD, WINDOW_MS, suggestionFor, createNudgeCounter };
