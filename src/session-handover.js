'use strict';

// A local handover document for every session Plexiform lists, on every
// adapter. hooks/handover-tap.js keeps the facts from each hook event; this
// turns them into <data root>/handovers/<adapter>-<sessionId>.md a few seconds
// after the last event. Sessions with no (or older) hook events are filled in
// from their own transcript (src/handover-transcripts.js), or, for an adapter
// with none readable, from Plexiform's own session list. Facts only: nothing
// here is the AI's own summary, and the document says where its facts came
// from. Secrets are removed with the shared scrubber's secret pass (paths stay
// readable: it is a local file for the person's own next session).

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const Tap = require('../hooks/handover-tap.js');
const Transcripts = require('./handover-transcripts.js');
const { redactSecretsPass, scrub } = require('./scrub.js');
const BurstHandover = require('./burst-handover.js');
const { withDeadline, GRACE_MS } = require('./bounded-io.js');

const MARKER = '<!-- plexiform-session-handover v1 -->';
const MAX_DOC_BYTES = 24 * 1024;
const RING_LIMIT = 200;
const DEBOUNCE_MS = 5000;
const BACKFILL_MS = 3 * 60 * 1000;
const STARTUP_DELAY_MS = 15 * 1000;
const PASS_LIMIT = 25;
const PASS_BUDGET_MS = 2000;
const WRITE_NOW_MS = 2000;
const GIT_LINES = 40;
const BURST_CHARS = 4000;
const LABEL = 'Plexiform-written from hook events, not by the AI.';
const LABELS = {
  hooks: LABEL,
  transcript: 'Plexiform-written from the session\'s own transcript on this computer, not by the AI.',
  'hooks+transcript': 'Plexiform-written from hook events and the session\'s own transcript, not by the AI.',
  state: 'Plexiform-written from its own session list only (no hook events or readable transcript), not by the AI.',
};
const KEY = /^[\w.-]{1,200}$/;
const RESUME = { 'claude-code': (id) => `claude --resume ${id}`, codex: (id) => `codex resume ${id}` };

const adapterOf = (source) => (source == null || source === 'claude' || source === 'claude-code' ? 'claude-code' : String(source));
const safe = (s) => String(s || 'default').replace(/[^\w.-]/g, '_').slice(0, 120) || 'default';
const keyOf = (adapter, sessionId) => `${safe(adapter)}-${safe(sessionId)}`;
const dirs = (rootDir) => ({ docs: Tap.dirOf(rootDir), facts: path.join(Tap.dirOf(rootDir), '.facts') });

const GIT_MS = 3000;

function runGit(cwd, args) {
  return withDeadline((done) => execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { // privacy-flow: session-handover-git
    timeout: GIT_MS, maxBuffer: 128 * 1024, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  }, (err, out) => done(err ? null : String(out))), GIT_MS + GRACE_MS);
}

// Bounded and read-only. repo:false when the folder is not a git work tree
// (git itself says so: the folder is never touched from this thread).
async function gitFacts(cwd, run = runGit) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { repo: false };
  const branch = await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return { repo: false };
  const [stat, status] = await Promise.all([run(cwd, ['diff', '--stat', 'HEAD']), run(cwd, ['status', '--short'])]);
  const cut = (t) => String(t || '').split('\n').filter(Boolean).slice(0, GIT_LINES);
  return { repo: true, branch: branch.trim(), stat: cut(stat), status: cut(status) };
}

const when = (iso) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z$/, 'Z') : 'unknown');
const fence = (lines) => (lines.length ? ['```', ...lines, '```'] : ['(none)']);
const shellWord = (s) => (/^[\w./@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// cd + the provider's own resume command, when Plexiform knows it.
function resumeLines(f, home) {
  const out = [];
  if (typeof f.cwd === 'string' && path.isAbsolute(f.cwd)) {
    const h = home ? String(home).replace(/\/+$/, '') : null;
    const target = h && f.cwd.startsWith(`${h}/`) ? `~/${shellWord(f.cwd.slice(h.length + 1))}` : shellWord(f.cwd);
    out.push(`- Folder: \`cd ${target}\``);
  } else out.push('- Folder: unknown');
  const cmd = RESUME[f.adapter];
  out.push(cmd ? `- Resume this session: \`${cmd(safe(f.sessionId))}\`` : '- Resume: no resume command is known for this adapter; start a new session in the folder and paste this handover.');
  return out;
}

// facts + git facts (+ Plexiform's own state for the session, + an optional Burst section) → the markdown. Pure.
// state: { status, waiting: 'permission' | 'question' | null, tool } from the session list, or null.
function renderDoc(f, git = { repo: false }, { burst = null, home = null, renderedAt = new Date().toISOString(), state = null } = {}) {
  const source = Object.hasOwn(LABELS, f.source) ? f.source : 'hooks';
  const files = Object.entries(f.files || {});
  const edited = files.filter(([, k]) => k === 'edit').map(([p]) => p);
  const read = files.filter(([, k]) => k !== 'edit').map(([p]) => p);
  const toolEntries = Object.entries(f.tools || {}).sort((a, b) => b[1] - a[1]);
  const tools = toolEntries.map(([n, c]) => `${n} x${c}`);
  const calls = toolEntries.reduce((n, [, c]) => n + c, 0);
  const commands = f.commands || [];
  const open = [];
  if (state && state.waiting === 'permission') open.push(`Blocked: a permission request${state.tool ? ` (${state.tool})` : ''} is waiting for the person.`);
  if (state && state.waiting === 'question') open.push('Blocked: the AI asked a question and is waiting for an answer.');
  if (f.awaitingReply) open.push(`The latest prompt has no recorded end of turn${f.lastPromptAt ? ` (sent ${when(f.lastPromptAt)})` : ''}: the AI may still be working, or the turn was interrupted.`);
  if (f.lastToolFailed) open.push(`The last tool call failed${f.lastToolFailed.tool ? ` (${f.lastToolFailed.tool})` : ''} at ${when(f.lastToolFailed.at)}.`);
  if (f.lastTurnFailed) open.push(`The last turn ended with an error at ${when(f.lastTurnFailed)}.`);
  if (git.repo && git.status.length) open.push(`${git.status.length >= GIT_LINES ? `${GIT_LINES}+` : git.status.length} uncommitted change${git.status.length === 1 ? '' : 's'} in the working folder.`);
  if (!f.endedAt && !f.awaitingReply && f.lastStopAt) open.push('The last turn finished; the next step is whatever the person asks next.');
  if (f.endedAt) open.push(`The session ended at ${when(f.endedAt)}.`);
  if (!open.length) open.push('Nothing open is recorded.');
  const t = f.transcript;
  const lines = [
    MARKER,
    `<!-- plexiform-meta git=${git.repo ? 'repo' : 'none'} source=${source} -->`,
    `# Session handover: ${f.adapter} ${f.sessionId}`,
    `> ${LABELS[source]} Facts only; check the repository before relying on any of it.`,
    '',
    '## Session',
    `- Adapter: ${f.adapter}`, `- Session id: ${f.sessionId}`, `- Working folder: ${f.cwd || 'unknown'}`,
    `- Branch: ${git.repo ? git.branch : 'unknown (not a git repository)'}`,
    ...(state && state.status ? [`- Plexiform status: ${state.status}`] : []),
    `- Started: ${when(f.startedAt)}`, `- Last active: ${when(f.lastActive)}`, `- Written: ${when(renderedAt)}`,
    ...(t && t.partial ? ['- Transcript: large, so only its start and its latest part were read.'] : []),
    '', '## Current goal',
    `Latest request, in the person's own words (scrubbed and truncated; not an AI summary): ${f.lastPrompt || f.firstPrompt || '(not seen)'}`,
    '', '## What was asked',
    `- First prompt: ${f.firstPrompt || '(not seen)'}`,
    ...(f.lastPrompt && f.lastPrompt !== f.firstPrompt ? [`- Latest prompt: ${f.lastPrompt}`] : []),
    '', '## What was done',
    `${edited.length} file${edited.length === 1 ? '' : 's'} edited, ${read.length} read or opened, ${commands.length} recent command${commands.length === 1 ? '' : 's'}, ${calls} tool call${calls === 1 ? '' : 's'} recorded.`,
    '', '## Files touched', `Edited (${edited.length}):`, ...fence(edited), `Read or opened (${read.length}):`, ...fence(read),
    '', '## Commands run (newest last)', ...fence(commands),
    '', '## Tools used', tools.length ? tools.join(', ') : '(none recorded)',
    '', '## Git state', ...(git.repo ? ['`git status --short`:', ...fence(git.status), '`git diff --stat HEAD`:', ...fence(git.stat)] : ['Working folder is not a git repository: no git facts.']),
    '', '## Last assistant status line', f.lastAssistant || '(none recorded)',
    '', '## Open questions / next step', ...open.map((o) => `- ${o}`),
    '', '## How to resume', ...resumeLines(f, home),
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
  return ['Continue the work described below. It was recorded by Plexiform from the previous AI session\'s hook events and transcript, not written by that AI, so check the repository state before relying on it.', '', '---', String(doc || '').replace(MARKER, '').trim(), '---', '', 'Start by confirming the current state of the working folder, then carry on from "Open questions / next step".'].join('\n');
}

const ago = (ms) => (ms < 60000 ? 'just now' : ms < 3600000 ? `${Math.floor(ms / 60000)}m ago` : ms < 86400000 ? `${Math.floor(ms / 3600000)}h ago` : `${Math.floor(ms / 86400000)}d ago`);
const isoAt = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const msOf = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : 0; };

// Hook facts and transcript facts for one session → one set. The fresher
// source supplies everything it has; the transcript knows the true first
// prompt and start, the hooks the folder the agent reported.
function mergeFacts(hook, tx) {
  if (!tx) return hook;
  if (!hook) return tx;
  const newer = msOf(tx.lastActive) > msOf(hook.lastActive) ? tx : hook;
  const older = newer === tx ? hook : tx;
  const out = { ...older, ...Object.fromEntries(Object.entries(newer).filter(([, v]) => v !== null && v !== undefined)) };
  out.firstPrompt = tx.firstPrompt || hook.firstPrompt || null;
  out.startedAt = [tx.startedAt, hook.startedAt].filter(Boolean).sort()[0] || null;
  out.cwd = hook.cwd || tx.cwd || '';
  out.source = 'hooks+transcript';
  return out;
}

// rows(): the sessions Plexiform lists, as { adapter, sessionId, cwd, lastActiveMs, state }
// (src/session-handover-main.js builds them). transcripts: src/handover-transcripts.js createLocator, or null.
function create({ rootDir, isExcluded = () => false, burstFor = () => null, git = gitFacts, home = null, now = () => Date.now(), debounceMs = DEBOUNCE_MS, ringLimit = RING_LIMIT, rows = () => [], transcripts = null, backfillMs = BACKFILL_MS, startupDelayMs = STARTUP_DELAY_MS, passLimit = PASS_LIMIT, passBudgetMs = PASS_BUDGET_MS, log = () => {} }) {
  const { docs, facts } = dirs(rootDir);
  const rendered = new Map(); // key -> { factsMtime, at }
  const txCache = new Map(); // key -> { file, mtimeMs, size, facts }
  const failed = new Map(); // key -> signature of a backfill attempt that wrote nothing
  const wroteNow = new Map(); // key -> when "Write now" last ran
  let timer = null, backfillTimer = null, startupTimer = null, running = false, backfilling = false, seq = 0;
  const docFile = (key) => path.join(docs, `${key}.md`);
  const factsPath = (key) => path.join(facts, `${key}.json`);
  const readFacts = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const isOurs = (file) => { try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(MARKER.length); fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); return b.toString() === MARKER; } catch { return false; } };
  const mtime = (file) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
  // Only ever removes a file this module wrote (the marker is its signature).
  const dropDoc = (key) => { const f = docFile(key); if (isOurs(f)) fs.rmSync(f, { force: true }); };
  const listRows = () => { try { const r = rows(); return Array.isArray(r) ? r.filter((x) => x && typeof x.sessionId === 'string' && x.sessionId && typeof x.adapter === 'string') : []; } catch { return []; } };
  const rowFor = (key) => listRows().find((r) => keyOf(r.adapter, r.sessionId) === key) || null;

  function writeAtomic(file, text) {
    fs.mkdirSync(docs, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${seq++}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // Parsed once per transcript change; null when there is none to read.
  function transcriptFor(key, adapter, sessionId) {
    if (!transcripts) return null;
    let file = null; try { file = transcripts.find(adapter, sessionId); } catch { file = null; }
    if (!file) return null;
    let st; try { st = fs.statSync(file); } catch { return null; }
    const c = txCache.get(key);
    if (c && c.file === file && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.facts;
    const f = Transcripts.factsFrom(file, { adapter, sessionId: safe(sessionId) });
    if (txCache.size > 500) txCache.clear();
    txCache.set(key, { file, mtimeMs: st.mtimeMs, size: st.size, facts: f });
    return f;
  }

  // Everything known about one session → its document. Returns false when there is nothing to write from.
  async function render(key, { adapter, sessionId, cwd = '', lastActiveMs = 0, state = null }, hookFacts) {
    const tx = transcriptFor(key, adapter, sessionId);
    let f = mergeFacts(hookFacts ? { ...hookFacts, source: hookFacts.source || 'hooks' } : null, tx);
    if (!f) f = { v: 1, adapter, sessionId: safe(sessionId), cwd: typeof cwd === 'string' ? cwd.slice(0, 500) : '', startedAt: null, lastActive: isoAt(lastActiveMs), tools: {}, files: {}, commands: [], source: 'state' };
    if (!f.cwd && cwd) f.cwd = String(cwd).slice(0, 500);
    if (isExcluded(f.cwd)) { dropDoc(key); return false; }
    const g = await git(f.cwd);
    let burst = null;
    try { burst = burstFor({ adapter: f.adapter, sessionId: f.sessionId, cwd: f.cwd }); } catch { burst = null; }
    writeAtomic(docFile(key), renderDoc(f, g, { burst, home, renderedAt: new Date(now()).toISOString(), state }));
    return true;
  }

  async function renderOne(key, f) {
    const row = rowFor(key) || { adapter: f.adapter, sessionId: f.sessionId, cwd: f.cwd };
    await render(key, { ...row, adapter: row.adapter || f.adapter }, f);
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
        let m; try { m = fs.statSync(file).mtimeMs; } catch { continue; }
        const f = readFacts(file);
        if (!f || typeof f !== 'object') continue;
        if (isExcluded(f.cwd)) { dropDoc(key); fs.rmSync(file, { force: true }); rendered.delete(key); continue; }
        const last = rendered.get(key);
        const docM = mtime(docFile(key));
        if ((last && last.factsMtime >= m) || (!last && docM >= m)) continue;
        if (!f.endedAt && last && now() - last.at < debounceMs) continue;
        try { await renderOne(key, f); rendered.set(key, { factsMtime: m, at: now() }); } catch (e) { log('[session-handover] write failed', e && e.code); }
      }
      enforceRing();
    } finally { running = false; }
  }

  // Missing, or older than the session's last activity or its transcript.
  function staleness(key, row) {
    const docM = mtime(docFile(key));
    if (!docM || !isOurs(docFile(key))) return { stale: true, docM: 0 };
    const tx = transcripts ? (() => { try { const f = transcripts.find(row.adapter, row.sessionId); return f ? mtime(f) : 0; } catch { return 0; } })() : 0;
    return { stale: (Number(row.lastActiveMs) || 0) > docM + debounceMs || tx > docM + debounceMs, docM, tx };
  }

  // One write for one listed session, whatever the source. → true when written.
  async function writeRow(row) {
    const key = keyOf(row.adapter, row.sessionId);
    return render(key, row, readFacts(factsPath(key)));
  }

  // The sessions whose document is missing or stale, a bounded number per pass.
  async function backfill() {
    if (backfilling) return 0;
    backfilling = true;
    const began = Date.now();
    let wrote = 0;
    try {
      for (const row of listRows()) {
        if (wrote >= passLimit || Date.now() - began > passBudgetMs) break;
        const key = keyOf(row.adapter, row.sessionId);
        const s = staleness(key, row);
        if (!s.stale) continue;
        const sig = `${row.lastActiveMs}|${s.tx}|${s.docM}`;
        if (failed.get(key) === sig) continue;
        try { if (await writeRow(row)) { wrote += 1; failed.delete(key); } else failed.set(key, sig); } catch (e) { failed.set(key, sig); log('[session-handover] backfill failed', e && e.code); }
        await new Promise((r) => setImmediate(r));
      }
      if (wrote) enforceRing();
    } finally { backfilling = false; }
    return wrote;
  }

  // "Write now" from the Sessions page: one listed session, at most every WRITE_NOW_MS.
  async function refresh(key) {
    if (typeof key !== 'string' || !KEY.test(key)) return { ok: false, error: 'Unknown session.' };
    const row = rowFor(key);
    if (!row) return { ok: false, error: 'That session is no longer listed.' };
    if (isExcluded(row.cwd)) return { ok: false, error: 'This project is muted, so it has no handover.' };
    if (now() - (wroteNow.get(key) || -Infinity) < WRITE_NOW_MS) return { ok: true };
    wroteNow.set(key, now());
    try { return (await writeRow(row)) ? { ok: true } : { ok: false, error: 'This project is muted, so it has no handover.' }; } catch { return { ok: false, error: 'Could not write the handover.' }; }
  }

  // What the Sessions page needs for one row: a path and age, or why not.
  function info(row) {
    const adapter = adapterOf(row && row.source), key = keyOf(adapter, row && row.sessionId);
    const cwd = row && row.cwd;
    const file = docFile(key);
    let st = null; try { st = fs.statSync(file); } catch { /* none */ }
    if (isExcluded(cwd)) return { state: 'absent', key, reason: 'session excluded' };
    if (st && isOurs(file)) {
      let head = ''; try { head = fs.readFileSync(file, 'utf8').slice(0, 200); } catch { /* ignore */ }
      const active = msOf(row && (row.codexLifecycle === 1 && row.codexHookAt ? row.codexHookAt : row.updatedAt));
      return { state: 'ready', key, updatedMs: st.mtimeMs, ageMs: Math.max(0, now() - st.mtimeMs), limited: /git=none/.test(head) ? 'cwd not a git repo — facts limited' : null, stale: active > st.mtimeMs + debounceMs };
    }
    if (fs.existsSync(factsPath(key))) return { state: 'absent', key, reason: 'handover is being written' };
    return { state: 'absent', key, reason: 'written at the next refresh' };
  }

  // The plain-data view the page renders.
  function view(row) {
    try {
      const i = info(row);
      return i.state === 'ready'
        ? { key: i.key, updated: `Handover: updated ${ago(i.ageMs)}`, note: i.stale ? 'older than the session’s last activity; refreshing' : i.limited, ready: true, canWrite: true }
        : { key: i.key, updated: 'Handover: not written yet', note: i.reason, ready: false, canWrite: i.reason !== 'session excluded' };
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
    tick, backfill, refresh, info, view, text, forCwd, pathOf: resolveKey, promptOf: (key) => { const t = text(key); return t ? asPrompt(t) : null; },
    // The same merged facts a handover is written from, for src/work-record.js. Unscrubbed: main only.
    facts(adapter, sessionId) {
      if (typeof adapter !== 'string' || typeof sessionId !== 'string' || !KEY.test(sessionId)) return null;
      const key = keyOf(adapter, sessionId);
      return mergeFacts(readFacts(factsPath(key)), transcriptFor(key, adapter, sessionId));
    },
    // The event-driven tick every debounceMs; one backfill pass shortly after
    // start, then one every backfillMs (each only for missing or stale docs).
    start(ms = debounceMs) {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => {}); }, ms); timer.unref?.();
      startupTimer = setTimeout(() => { backfill().catch(() => {}); }, startupDelayMs); startupTimer.unref?.();
      backfillTimer = setInterval(() => { backfill().catch(() => {}); }, backfillMs); backfillTimer.unref?.();
    },
    stop() { for (const t of [timer, backfillTimer]) if (t) clearInterval(t); if (startupTimer) clearTimeout(startupTimer); timer = backfillTimer = startupTimer = null; },
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

module.exports = { salvagePayload, forCard, create, renderDoc, mergeFacts, asPrompt, gitFacts, adapterOf, keyOf, MARKER, RING_LIMIT, MAX_DOC_BYTES, LABEL, LABELS };
