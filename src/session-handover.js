'use strict';

// A local handover document for every observed session on every adapter.
// hooks/handover-tap.js keeps the facts from each hook event; this turns them
// into <data root>/handovers/<adapter>-<sessionId>.md a few seconds after the
// last event. Facts only: nothing here is the AI's own summary, and the
// document says so. Secrets are removed with the shared scrubber's secret pass
// (paths stay readable: it is a local file for the person's own next session).

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const Tap = require('../hooks/handover-tap.js');
const { redactSecretsPass, scrub } = require('./scrub.js');
const BurstHandover = require('./burst-handover.js');

const MARKER = '<!-- plexiform-session-handover v1 -->';
const MAX_DOC_BYTES = 24 * 1024;
const RING_LIMIT = 200;
const DEBOUNCE_MS = 5000;
const GIT_LINES = 40;
const BURST_CHARS = 4000;
const LABEL = 'Plexiform-written from hook events, not by the AI.';
const KEY = /^[\w.-]{1,200}$/;

const adapterOf = (source) => (source == null || source === 'claude' || source === 'claude-code' ? 'claude-code' : String(source));
const safe = (s) => String(s || 'default').replace(/[^\w.-]/g, '_').slice(0, 120) || 'default';
const keyOf = (adapter, sessionId) => `${safe(adapter)}-${safe(sessionId)}`;
const dirs = (rootDir) => ({ docs: Tap.dirOf(rootDir), facts: path.join(Tap.dirOf(rootDir), '.facts') });

function runGit(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { // privacy-flow: session-handover-git
      timeout: 3000, maxBuffer: 128 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, out) => resolve(err ? null : String(out)));
  });
}

// Bounded and read-only. repo:false when the folder is not a git work tree.
async function gitFacts(cwd, run = runGit) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { repo: false };
  try { if (!fs.statSync(cwd).isDirectory()) return { repo: false }; } catch { return { repo: false }; }
  const branch = await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return { repo: false };
  const [stat, status] = await Promise.all([run(cwd, ['diff', '--stat', 'HEAD']), run(cwd, ['status', '--short'])]);
  const cut = (t) => String(t || '').split('\n').filter(Boolean).slice(0, GIT_LINES);
  return { repo: true, branch: branch.trim(), stat: cut(stat), status: cut(status) };
}

const when = (iso) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z$/, 'Z') : 'unknown');
const fence = (lines) => (lines.length ? ['```', ...lines, '```'] : ['(none)']);

// facts + git facts (+ an optional Burst section) → the markdown. Pure.
function renderDoc(f, git = { repo: false }, { burst = null, home = null, renderedAt = new Date().toISOString() } = {}) {
  const files = Object.entries(f.files || {});
  const edited = files.filter(([, k]) => k === 'edit').map(([p]) => p);
  const read = files.filter(([, k]) => k !== 'edit').map(([p]) => p);
  const tools = Object.entries(f.tools || {}).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} x${c}`);
  const open = [];
  if (f.awaitingReply) open.push(`The latest prompt has no recorded end of turn${f.lastPromptAt ? ` (sent ${when(f.lastPromptAt)})` : ''}: the AI may still be working, or the turn was interrupted.`);
  if (f.lastToolFailed) open.push(`The last tool call failed${f.lastToolFailed.tool ? ` (${f.lastToolFailed.tool})` : ''} at ${when(f.lastToolFailed.at)}.`);
  if (f.lastTurnFailed) open.push(`The last turn ended with an error at ${when(f.lastTurnFailed)}.`);
  if (git.repo && git.status.length) open.push(`${git.status.length >= GIT_LINES ? `${GIT_LINES}+` : git.status.length} uncommitted change${git.status.length === 1 ? '' : 's'} in the working folder.`);
  if (!f.endedAt && !f.awaitingReply && f.lastStopAt) open.push('The last turn finished; the next step is whatever the person asks next.');
  if (f.endedAt) open.push(`The session ended at ${when(f.endedAt)}.`);
  if (!open.length) open.push('Nothing open is recorded.');
  const lines = [
    MARKER,
    `<!-- plexiform-meta git=${git.repo ? 'repo' : 'none'} -->`,
    `# Session handover: ${f.adapter} ${f.sessionId}`,
    `> ${LABEL} Facts only; check the repository before relying on any of it.`,
    '',
    '## Session',
    `- Adapter: ${f.adapter}`, `- Session id: ${f.sessionId}`, `- Working folder: ${f.cwd || 'unknown'}`,
    `- Branch: ${git.repo ? git.branch : 'unknown (not a git repository)'}`,
    `- Started: ${when(f.startedAt)}`, `- Last active: ${when(f.lastActive)}`, `- Written: ${when(renderedAt)}`,
    '', '## What was asked',
    `- First prompt: ${f.firstPrompt || '(not seen)'}`,
    ...(f.lastPrompt && f.lastPrompt !== f.firstPrompt ? [`- Latest prompt: ${f.lastPrompt}`] : []),
    '', '## Files touched', `Edited (${edited.length}):`, ...fence(edited), `Read or opened (${read.length}):`, ...fence(read),
    '', '## Commands run (newest last)', ...fence(f.commands || []),
    '', '## Tools used', tools.length ? tools.join(', ') : '(none recorded)',
    '', '## Git state', ...(git.repo ? ['`git status --short`:', ...fence(git.status), '`git diff --stat HEAD`:', ...fence(git.stat)] : ['Working folder is not a git repository: facts limited to the hook events above.']),
    '', '## Last assistant status line', f.lastAssistant || '(this adapter reported none)',
    '', '## Open questions / next step', ...open.map((o) => `- ${o}`),
  ];
  if (burst) lines.push('', '## Burst handover', String(burst).slice(0, BURST_CHARS));
  let text = lines.join('\n') + '\n';
  text = redactSecretsPass(text);
  if (home) text = text.split(String(home).replace(/\/+$/, '')).join('~');
  if (Buffer.byteLength(text) > MAX_DOC_BYTES) text = `${Buffer.from(text).subarray(0, MAX_DOC_BYTES - 64).toString('utf8')}\n\n(truncated: size cap)\n`;
  return text;
}

// A ready-to-paste "continue this work" prompt for any AI.
function asPrompt(doc) {
  return ['Continue the work described below. It was recorded by Plexiform from the previous AI session\'s hook events, not written by that AI, so check the repository state before relying on it.', '', '---', String(doc || '').replace(MARKER, '').trim(), '---', '', 'Start by confirming the current state of the working folder, then carry on from "Open questions / next step".'].join('\n');
}

const ago = (ms) => (ms < 60000 ? 'just now' : ms < 3600000 ? `${Math.floor(ms / 60000)}m ago` : ms < 86400000 ? `${Math.floor(ms / 3600000)}h ago` : `${Math.floor(ms / 86400000)}d ago`);

function create({ rootDir, isExcluded = () => false, burstFor = () => null, git = gitFacts, home = null, now = () => Date.now(), debounceMs = DEBOUNCE_MS, ringLimit = RING_LIMIT, log = () => {} }) {
  const { docs, facts } = dirs(rootDir);
  const rendered = new Map(); // key -> { factsMtime, at }
  let timer = null, running = false;
  const docFile = (key) => path.join(docs, `${key}.md`);
  const readFacts = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const isOurs = (file) => { try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(MARKER.length); fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); return b.toString() === MARKER; } catch { return false; } };
  // Only ever removes a file this module wrote (the marker is its signature).
  const dropDoc = (key) => { const f = docFile(key); if (isOurs(f)) fs.rmSync(f, { force: true }); };

  function writeAtomic(file, text) {
    fs.mkdirSync(docs, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  async function renderOne(key, f) {
    const g = await git(f.cwd);
    let burst = null;
    try { burst = burstFor({ adapter: f.adapter, sessionId: f.sessionId, cwd: f.cwd }); } catch { burst = null; }
    writeAtomic(docFile(key), renderDoc(f, g, { burst, home, renderedAt: new Date(now()).toISOString() }));
  }

  function enforceRing() {
    let entries;
    try { entries = fs.readdirSync(docs).filter((n) => n.endsWith('.md')).map((n) => ({ n, f: path.join(docs, n) })); } catch { return; }
    const ours = entries.filter((e) => isOurs(e.f)).map((e) => ({ ...e, m: fs.statSync(e.f).mtimeMs })).sort((a, b) => b.m - a.m);
    for (const e of ours.slice(ringLimit)) {
      fs.rmSync(e.f, { force: true });
      rendered.delete(e.n.slice(0, -3));
      fs.rmSync(path.join(facts, `${e.n.slice(0, -3)}.json`), { force: true });
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      let names = [];
      try { names = fs.readdirSync(facts).filter((n) => n.endsWith('.json')); } catch { return; }
      for (const n of names) {
        const key = n.slice(0, -5), file = path.join(facts, n);
        let mtime; try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
        const f = readFacts(file);
        if (!f || typeof f !== 'object') continue;
        if (isExcluded(f.cwd)) { dropDoc(key); fs.rmSync(file, { force: true }); rendered.delete(key); continue; }
        const last = rendered.get(key);
        let docM = 0; try { docM = fs.statSync(docFile(key)).mtimeMs; } catch { /* none yet */ }
        if ((last && last.factsMtime >= mtime) || (!last && docM >= mtime)) continue;
        if (!f.endedAt && last && now() - last.at < debounceMs) continue;
        try { await renderOne(key, f); rendered.set(key, { factsMtime: mtime, at: now() }); } catch (e) { log('[session-handover] write failed', e && e.code); }
      }
      enforceRing();
    } finally { running = false; }
  }

  // What the Sessions page needs for one row: a path and age, or why not.
  function info(row) {
    const adapter = adapterOf(row && row.source), key = keyOf(adapter, row && row.sessionId);
    const cwd = row && row.cwd;
    const file = docFile(key);
    let st = null; try { st = fs.statSync(file); } catch { /* none */ }
    if (st && isOurs(file)) {
      let head = ''; try { head = fs.readFileSync(file, 'utf8').slice(0, 200); } catch { /* ignore */ }
      return { state: 'ready', key, updatedMs: st.mtimeMs, ageMs: Math.max(0, now() - st.mtimeMs), limited: /git=none/.test(head) ? 'cwd not a git repo — facts limited' : null };
    }
    if (isExcluded(cwd)) return { state: 'absent', key, reason: 'session excluded' };
    if (fs.existsSync(path.join(facts, `${key}.json`))) return { state: 'absent', key, reason: 'handover is being written' };
    return { state: 'absent', key, reason: 'no events yet' };
  }

  // The plain-data view the page renders.
  function view(row) {
    try {
      const i = info(row);
      return i.state === 'ready'
        ? { key: i.key, updated: `Handover updated ${ago(i.ageMs)}`, note: i.limited, ready: true }
        : { key: i.key, updated: 'No handover yet', note: i.reason, ready: false };
    } catch { return null; }
  }

  const resolveKey = (key) => {
    if (typeof key !== 'string' || !KEY.test(key)) return null;
    const f = docFile(key);
    return isOurs(f) ? f : null;
  };
  const text = (key) => { const f = resolveKey(key); if (!f) return null; try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  // Newest local handover for a working folder (the board card's tab).
  function forCwd(cwd) {
    let best = null;
    let names = []; try { names = fs.readdirSync(facts).filter((n) => n.endsWith('.json')); } catch { return null; }
    for (const n of names) {
      const f = readFacts(path.join(facts, n));
      if (!f || f.cwd !== cwd) continue;
      const key = n.slice(0, -5), file = docFile(key);
      let m; try { m = fs.statSync(file).mtimeMs; } catch { continue; }
      if (isOurs(file) && (!best || m > best.m)) best = { key, m };
    }
    return best ? { key: best.key, text: text(best.key), updatedMs: best.m } : null;
  }

  return {
    tick, info, view, text, forCwd, pathOf: resolveKey, promptOf: (key) => { const t = text(key); return t ? asPrompt(t) : null; },
    start(ms = debounceMs) { if (!timer) { timer = setInterval(() => { tick().catch(() => {}); }, ms); timer.unref?.(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

// The one thing that may leave the machine, and only for a repository the
// person turned "Share handover with team" on for (the Burst opt-in, default
// off): the handover scrubbed in full (paths and names hashed), as the text of
// a system-written salvage section. null when not shared.
function salvagePayload(doc, { root, shared = {}, home = null, user = null, date = '' } = {}) {
  if (!root || shared[BurstHandover.repoKey(root)] !== true || !doc) return null;
  const text = scrub(String(doc).replace(MARKER, '').replace(/<!-- plexiform-meta[^>]*-->\n?/, ''), { home, user }).slice(0, 8000);
  return { text, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '' };
}

// The local handover for the observed session a board card was created from.
// capture: the work-capture overview rows ({ provider, session_id, card_id }).
function forCard(writer, cardId, capture) {
  const row = (Array.isArray(capture) ? capture : []).find((c) => c && c.card_id === cardId && typeof c.session_id === 'string');
  if (!row) return null;
  const key = keyOf(adapterOf(row.provider), row.session_id);
  const t = writer.text(key);
  return t ? { markdown: t.replace(MARKER, '').replace(/<!-- plexiform-meta[^>]*-->\n?/, '').trim() } : null;
}

module.exports = { salvagePayload, forCard, create, renderDoc, asPrompt, gitFacts, adapterOf, keyOf, MARKER, RING_LIMIT, MAX_DOC_BYTES, LABEL };
