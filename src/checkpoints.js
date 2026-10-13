// Per-turn checkpoints for AI sessions ("What changed" page). When a session's
// turn starts and ends (read from the session files the hooks already write),
// the project's files are saved as a commit under refs/plexiform/cp/<session>/
// in that repo, made from a temporary index so the user's index, HEAD and
// working tree are never changed (src/checkpoint-git.js). The page lists each
// turn's changes and can restore the files to before or after a turn, always
// saving a safety checkpoint of the current state first.
//
// Off until switched on from the page. Free keeps the last
// limits()['checkpoints.turns'] turns per session; every plan drops checkpoints
// older than limits()['checkpoints.days']. Folders that are not git repos are skipped.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const CheckpointGit = require('./checkpoint-git');
const DiffReview = require('./diff-review');

const { REF_ROOT } = CheckpointGit;
const CONFIG_FILE = 'checkpoints.json';
const DATA_DIR = 'checkpoints';
const MAX_SESSIONS = 200;
const SAFETY_KEEP = 5;
const MAX_PATCH = 512 * 1024;
const DAY = 86400e3;
// The turn is over: finished, failed or stopped by a usage limit. A permission ask is mid-turn.
const END = new Set(['stop', 'turn-failed', 'limit-hit']);

const refSid = (sid) => String(sid ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'default';
const sessionPrefix = (sid) => `${REF_ROOT}${refSid(sid)}/`;
const turnRef = (sid, n) => `${sessionPrefix(sid)}t${String(n).padStart(6, '0')}`;
const safetyRef = (sid, ms) => `${sessionPrefix(sid)}safety-${ms}`;
const subject = (phase) => `plexiform checkpoint ${phase}`;
const phaseOf = (s) => (/^plexiform checkpoint ([a-z-]+)$/.exec(s ?? '') || [])[1] ?? null;

function parseRef(r, prefix) {
  const name = r.ref.slice(prefix.length);
  const t = /^t(\d{6})$/.exec(name);
  if (t) return { ...r, kind: 'turn', turn: Number(t[1]), phase: phaseOf(r.subject) };
  const s = /^safety-(\d{1,15})$/.exec(name);
  if (s) return { ...r, kind: 'safety', id: s[1], phase: 'safety' };
  return null;
}

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * The turn tracker for one session file: prev (or undefined on first sight) +
 * the file's data → {track, events}, events being 'end' and/or 'start' in order.
 */
function turnStep(prev, data) {
  const signal = data?.signal ?? null, since = data?.signalSince ?? null;
  const working = !!data?.workingSince || signal === 'permission-ask';
  const track = { inTurn: prev?.inTurn ?? false, signal, since, cwd: data?.cwd || prev?.cwd || '', source: data?.source || prev?.source || null };
  if (!prev) return { track: { ...track, inTurn: working && !END.has(signal) }, events: [] };
  const fresh = since !== prev.since || signal !== prev.signal;
  if (prev.inTurn) {
    if (END.has(signal)) return { track: { ...track, inTurn: false }, events: ['end'] };
    if (signal === 'prompt-submit' && fresh) return { track: { ...track, inTurn: true }, events: ['end', 'start'] };
    return { track, events: [] };
  }
  if (END.has(signal)) return { track, events: fresh ? ['end'] : [] }; // a whole turn between two looks
  if (working && fresh) return { track: { ...track, inTurn: true }, events: ['start'] };
  return { track, events: [] };
}

/** Watches the hooks' session files and calls onEvent(event, {sessionId, cwd, source}) per turn boundary. */
function createTurnWatcher({ dir, onEvent, pollMs = 5000, debounceMs = 250, log = () => {} }) {
  const tracks = new Map(); // file -> track
  const mtimes = new Map();
  let timer = null, watcher = null, poll = null, closed = false;
  function scan() {
    timer = null;
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { /* no sessions yet */ }
    const seen = new Set(names);
    for (const [file, t] of tracks) {
      if (seen.has(file)) continue;
      tracks.delete(file); mtimes.delete(file);
      if (t.inTurn) emit('end', t);
    }
    for (const file of names) {
      const p = path.join(dir, file);
      let m;
      try { m = fs.statSync(p).mtimeMs; } catch { continue; }
      if (mtimes.get(file) === m) continue;
      mtimes.set(file, m);
      const data = readJson(p, null);
      if (!data || typeof data.sessionId !== 'string') continue;
      const { track, events } = turnStep(tracks.get(file), data);
      track.sessionId = data.sessionId;
      tracks.set(file, track);
      for (const ev of events) emit(ev, track);
    }
  }
  function emit(ev, t) {
    try { onEvent(ev, { sessionId: t.sessionId, cwd: t.cwd, source: t.source }); } catch (e) { log(`[checkpoints] ${ev} failed: ${e?.message ?? e}`); }
  }
  const kick = () => { if (!closed && !timer) timer = setTimeout(scan, debounceMs); };
  try { fs.mkdirSync(dir, { recursive: true }); watcher = fs.watch(dir, kick); watcher.on('error', () => {}); } catch { /* the poll still runs */ }
  poll = setInterval(kick, pollMs); poll.unref?.();
  scan();
  return {
    scan,
    working: () => [...tracks.values()].filter((t) => t.inTurn).map((t) => ({ sessionId: t.sessionId, cwd: t.cwd })),
    close() { closed = true; clearTimeout(timer); clearInterval(poll); try { watcher?.close(); } catch { /* closed */ } },
  };
}

function createCheckpoints({ rootDir, entitlements, git = CheckpointGit.createGit(), review = DiffReview.review, now = Date.now, notify = () => {}, isBusy = async () => false, log = () => {} }) {
  const configFile = path.join(rootDir, CONFIG_FILE);
  const dataDir = path.join(rootDir, DATA_DIR);
  const indexFile = path.join(dataDir, 'index.json');
  const chains = new Map();
  // One thing at a time per key (a session, then a repo), in the order asked.
  function serial(key, fn) {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    chains.set(key, tail);
    tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return next;
  }

  function config() {
    const c = readJson(configFile, {});
    return { enabled: c?.enabled === true, review: DiffReview.normalize(c?.review) };
  }
  function setConfig(patch) {
    const c = config();
    if (typeof patch?.enabled === 'boolean') c.enabled = patch.enabled;
    if (patch?.review && typeof patch.review === 'object') {
      const r = DiffReview.normalize({ ...c.review, ...patch.review });
      if (r.enabled && !entitlements.has('checkpoints.review')) r.enabled = false;
      c.review = r;
    }
    writeJson(configFile, c);
    notify();
    return c;
  }
  function limits() {
    const l = entitlements.limits() ?? {};
    const turns = l['checkpoints.turns'];
    const days = l['checkpoints.days'];
    return { turns: turns === Infinity || (Number.isInteger(turns) && turns > 0) ? turns : 3, days: Number.isFinite(days) && days > 0 ? days : 7 };
  }

  const index = () => readJson(indexFile, { sessions: {} }).sessions ?? {};
  function remember(sid, entry) {
    const all = index();
    all[sid] = { ...all[sid], ...entry, updatedAt: now() };
    const keep = Object.entries(all).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_SESSIONS);
    writeJson(indexFile, { sessions: Object.fromEntries(keep) });
  }

  async function refsOf(top, sid) {
    const prefix = sessionPrefix(sid);
    return (await git.listRefs(top, prefix)).map((r) => parseRef(r, prefix)).filter(Boolean);
  }
  const lastTurn = (refs) => refs.filter((r) => r.kind === 'turn').sort((a, b) => b.turn - a.turn)[0] ?? null;

  async function repoFor(sid, cwd, source) {
    const repo = await git.repoOf(cwd);
    remember(sid, repo.skip ? { cwd, source, skip: repo.skip, top: null } : { cwd, source, skip: null, top: repo.top });
    return repo;
  }

  const active = () => config().enabled && entitlements.has('checkpoints');

  function turnStart({ sessionId, cwd, source = null }) {
    if (!active()) return Promise.resolve({ skipped: 'off' });
    return serial(`s:${sessionId}`, async () => {
      const repo = await repoFor(sessionId, cwd, source);
      if (repo.skip) return { skipped: repo.skip };
      const out = await serial(`r:${repo.top}`, async () => {
        const last = lastTurn(await refsOf(repo.top, sessionId));
        // A turn whose end was never seen: how things are now is its end.
        if (last?.phase === 'start') await git.updateRef(repo.top, turnRef(sessionId, last.turn), await git.snapshot(repo, { parent: last.sha, message: subject('end-approx') }));
        const n = (last?.turn ?? 0) + 1;
        await git.updateRef(repo.top, turnRef(sessionId, n), await git.snapshot(repo, { message: subject('start') }));
        await gc(repo.top, sessionId);
        return { turn: n };
      });
      notify();
      return out;
    });
  }

  function turnEnd({ sessionId, cwd, source = null }) {
    if (!active()) return Promise.resolve({ skipped: 'off' });
    return serial(`s:${sessionId}`, async () => {
      const repo = await repoFor(sessionId, cwd, source);
      if (repo.skip) return { skipped: repo.skip };
      const done = await serial(`r:${repo.top}`, async () => {
        const last = lastTurn(await refsOf(repo.top, sessionId));
        const open = last?.phase === 'start';
        const n = open ? last.turn : (last?.turn ?? 0) + 1;
        const parent = last?.sha ?? null;
        // Without a start, the turn before's end stands in for "before" (approximate).
        const phase = open ? 'end' : parent ? 'end-approx' : 'end-only';
        const end = await git.snapshot(repo, { parent, message: subject(phase) });
        await git.updateRef(repo.top, turnRef(sessionId, n), end);
        await gc(repo.top, sessionId);
        return { turn: n, before: parent, after: end };
      });
      notify();
      if (done.before) void reviewTurn(repo, sessionId, done);
      return { turn: done.turn };
    });
  }

  const reviewFile = (sid, n) => path.join(dataDir, 'reviews', `${refSid(sid)}-t${n}.json`);
  async function reviewTurn(repo, sid, { turn, before, after }) {
    const settings = config().review;
    if (!settings.enabled || !entitlements.has('checkpoints.review')) return;
    try {
      const diff = await git.diffText(repo.top, before, after);
      const r = await review({ diff, settings, entitled: entitlements.has('checkpoints.review') });
      if (r.reason === 'empty' || r.reason === 'off' || r.reason === 'not-entitled') return;
      writeJson(reviewFile(sid, turn), { at: now(), model: settings.model, ...r });
      notify();
    } catch (e) { log(`[checkpoints] review failed: ${e?.message ?? e}`); }
  }

  /** Keeps the newest `turns` turns and SAFETY_KEEP safety points per session, none older than `days`. */
  async function gc(top, sid) {
    const { turns, days } = limits();
    const cutoff = now() - days * DAY;
    const refs = await refsOf(top, sid);
    const drop = [];
    refs.filter((r) => r.kind === 'turn').sort((a, b) => b.turn - a.turn).forEach((r, i) => { if (i >= turns || r.at < cutoff) drop.push(r.ref); });
    refs.filter((r) => r.kind === 'safety').sort((a, b) => b.at - a.at).forEach((r, i) => { if (i >= SAFETY_KEEP || r.at < cutoff) drop.push(r.ref); });
    for (const ref of drop) await git.deleteRef(top, ref);
    return drop.length;
  }

  async function gcAll() {
    const all = index();
    let changed = false;
    for (const [sid, e] of Object.entries(all)) {
      if (!e.top) { if (e.updatedAt < now() - limits().days * DAY) { delete all[sid]; changed = true; } continue; }
      try {
        await serial(`r:${e.top}`, () => gc(e.top, sid));
        if (!(await refsOf(e.top, sid)).length) { delete all[sid]; changed = true; }
      } catch { /* repo moved or gone: its entry ages out */ if (e.updatedAt < now() - limits().days * DAY) { delete all[sid]; changed = true; } }
    }
    if (changed) writeJson(indexFile, { sessions: all });
  }

  function sessions() {
    return Object.entries(index()).sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .map(([id, e]) => ({ id, cwd: e.cwd ?? '', top: e.top ?? null, source: e.source ?? null, skip: e.skip ?? null, updatedAt: e.updatedAt }));
  }

  function state() {
    return { ...config(), reviewAllowed: entitlements.has('checkpoints.review'), limits: limits(), sessions: sessions(), models: DiffReview.MODELS, maxBudget: DiffReview.MAX_BUDGET };
  }

  /** One session's turns (newest first) with changed files, plus its safety points. */
  async function turns(sid) {
    const e = index()[sid];
    if (!e?.top) return { turns: [], safety: [], skip: e?.skip ?? 'unknown' };
    const refs = await refsOf(e.top, sid);
    const out = [];
    for (const r of refs.filter((x) => x.kind === 'turn').sort((a, b) => b.turn - a.turn)) {
      const running = r.phase === 'start';
      const before = running ? r.sha : r.parent;
      const after = running ? null : r.sha;
      let files = null;
      if (before && after) { try { files = await git.diffFiles(e.top, before, after); } catch { files = null; } }
      out.push({ turn: r.turn, at: r.at, phase: r.phase, running, approx: r.phase === 'end-approx', hasBefore: !!before, hasAfter: !!after, files, review: readJson(reviewFile(sid, r.turn), null) });
    }
    const safety = refs.filter((x) => x.kind === 'safety').sort((a, b) => b.at - a.at).map((r) => ({ id: r.id, at: r.at }));
    return { turns: out, safety, skip: null };
  }

  async function turnCommits(top, sid, n) {
    const r = (await refsOf(top, sid)).find((x) => x.kind === 'turn' && x.turn === n);
    if (!r) return null;
    return r.phase === 'start' ? { before: r.sha, after: null } : { before: r.parent, after: r.sha };
  }

  /** A turn's patch (or one file's), bounded. → {text, truncated} | null. */
  async function diff(sid, n, file = null) {
    const e = index()[sid];
    if (!e?.top) return null;
    const c = await turnCommits(e.top, sid, n);
    if (!c?.before || !c.after) return null;
    const text = await git.diffText(e.top, c.before, c.after, file, MAX_PATCH * 4);
    return text.length > MAX_PATCH ? { text: text.slice(0, MAX_PATCH), truncated: true } : { text, truncated: false };
  }

  /**
   * Puts the session's project files back as they were: target {turn, which:'before'|'after'} or {safety: id}.
   * A safety checkpoint of the current state is saved first. → {ok, safety, written, removed} | {ok:false, reason}.
   */
  async function restore(sid, target) {
    const e = index()[sid];
    if (!e?.top) return { ok: false, reason: 'unknown' };
    if (await isBusy(e.top)) return { ok: false, reason: 'busy' };
    const repo = await git.repoOf(e.top);
    if (repo.skip || repo.top !== e.top) return { ok: false, reason: repo.skip ?? 'moved' };
    const out = await serial(`r:${repo.top}`, async () => {
      let sha = null;
      if (target?.safety != null) {
        sha = (await refsOf(repo.top, sid)).find((r) => r.kind === 'safety' && r.id === String(target.safety))?.sha ?? null;
      } else if (Number.isInteger(target?.turn)) {
        const c = await turnCommits(repo.top, sid, target.turn);
        sha = target.which === 'after' ? c?.after : c?.before;
      }
      if (!sha) return { ok: false, reason: 'missing' };
      const ms = now();
      const safety = await git.snapshot(repo, { message: subject('safety') });
      await git.updateRef(repo.top, safetyRef(sid, ms), safety);
      const r = await git.restoreTree(repo, safety, sha);
      await gc(repo.top, sid);
      return { ok: true, safety: String(ms), ...r };
    });
    notify();
    return out;
  }

  return { turnStart, turnEnd, turns, diff, restore, gc, gcAll, state, config, setConfig, sessions, limits };
}

const SID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const PATH_MAX = 4096;

/** Paid-wiring entry point (src/paid-wiring.js): the watcher, the page's IPC and a daily clean-up. */
function register(ctx) {
  const { ipcMain, rootDir, entitlements, fromPage, onQuit, log } = ctx;
  const { dialog, BrowserWindow } = require('electron');
  const page = () => ctx.buddy?.()?.pageWebContents?.('checkpoints') ?? null;
  const notify = () => { const wc = page(); if (wc && !wc.isDestroyed()) wc.send('checkpoints:changed'); };
  const git = CheckpointGit.createGit();
  let watcher = null;
  const isBusy = async (top) => {
    for (const w of watcher?.working() ?? []) { const r = await git.repoOf(w.cwd); if (r.top === top) return true; }
    return false;
  };
  const cps = createCheckpoints({ rootDir, entitlements, git, notify, isBusy, log });
  watcher = createTurnWatcher({ dir: path.join(rootDir, 'sessions'), log,
    onEvent: (ev, s) => { (ev === 'start' ? cps.turnStart(s) : cps.turnEnd(s)).catch((e) => log(`[checkpoints] ${ev}: ${e?.message ?? e}`)); } });
  const sweep = () => cps.gcAll().catch((e) => log(`[checkpoints] clean-up: ${e?.message ?? e}`));
  const daily = setInterval(sweep, DAY); daily.unref?.();
  setTimeout(sweep, 60_000).unref?.();
  onQuit?.(() => { watcher.close(); clearInterval(daily); });

  const ok = (e) => fromPage(e, 'checkpoints');
  const sid = (v) => typeof v === 'string' && SID_RE.test(v) ? v : null;
  ipcMain.handle('checkpoints:state', (e) => ok(e) ? cps.state() : null);
  ipcMain.handle('checkpoints:set', (e, patch) => {
    if (!ok(e) || !patch || typeof patch !== 'object') return null;
    const clean = {};
    if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
    if (patch.review && typeof patch.review === 'object') clean.review = { enabled: patch.review.enabled === true, model: String(patch.review.model ?? ''), maxBudgetUsd: Number(patch.review.maxBudgetUsd) };
    cps.setConfig(clean);
    return cps.state();
  });
  ipcMain.handle('checkpoints:turns', async (e, id) => ok(e) && sid(id) ? cps.turns(id).catch(() => ({ turns: [], safety: [], skip: 'error' })) : null);
  ipcMain.handle('checkpoints:diff', async (e, id, turn, file) => {
    if (!ok(e) || !sid(id) || !Number.isInteger(turn) || (file != null && (typeof file !== 'string' || file.length > PATH_MAX))) return null;
    return cps.diff(id, turn, file ?? null).catch(() => null);
  });
  ipcMain.handle('checkpoints:restore', async (e, id, target) => {
    if (!ok(e) || !sid(id) || !target || typeof target !== 'object') return null;
    const t = typeof target.safety === 'string' && /^\d{1,15}$/.test(target.safety) ? { safety: target.safety }
      : Number.isInteger(target.turn) && (target.which === 'before' || target.which === 'after') ? { turn: target.turn, which: target.which } : null;
    if (!t) return null;
    const s = cps.sessions().find((x) => x.id === id);
    if (!s?.top) return { ok: false, reason: 'unknown' };
    const what = t.safety ? 'how they were just before your last restore' : `how they were ${t.which} turn ${t.turn}`;
    const answer = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender) ?? undefined, {
      type: 'warning', buttons: ['Cancel', 'Restore files'], defaultId: 0, cancelId: 0, noLink: true,
      message: `Put the files in ${path.basename(s.top)} back to ${what}?`,
      detail: 'Tracked and untracked files change to match that checkpoint; ignored files are left alone. Commits, branches and staged changes are not touched. Plexiform saves a checkpoint of the files as they are now first, so you can undo this from the same page.',
    });
    if (answer.response !== 1) return { ok: false, reason: 'cancelled' };
    return cps.restore(id, t).catch((err) => { log(`[checkpoints] restore failed: ${err?.message ?? err}`); return { ok: false, reason: 'failed' }; });
  });
  return cps;
}

module.exports = { register, createCheckpoints, createTurnWatcher, turnStep, turnRef, safetyRef, refSid, END };
