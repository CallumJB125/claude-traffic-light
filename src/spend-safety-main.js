'use strict';
// Spend safety, main side (src/spend-safety.js does the sums). Local only:
// reads the Claude Code transcripts, ~/.claude.json's plan tier fields and the
// provider the Claude carry resolves (gateway, key or cloud) on this Mac, keeps its settings in spend-safety.json, and raises desktop
// notifications. Nothing here touches the network or stops a session.
//   - per-project daily caps: one notification per project per day when over
//   - retry loops: the same failing tool call 3+ times in a row, one
//     notification per loop
//   - the widget lane's spend alerts (alerts(), read by widget-lane-main.js)
//   - IPC for the Usage page and Preferences: spend-safety:get / :set
const fs = require('fs');
const path = require('path');
const S = require('./spend-safety.js');
const Quiet = require('./quiet.js');

const FILE = 'spend-safety.json';
const TICK_MS = 60 * 1000;
const RECENT_MS = 15 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;
const MAX_FILES = 40;

let current = { alerts: [] };
const alerts = () => current.alerts.slice();
// "Pause nudges" (a rule action on the runaway signal): sessionId → {firedAt, rule}
// while held. Nudges for a held session are dropped, not replayed; acknowledging
// the burn (resumeNudges) lets them through again until the next burn.
const paused = new Map();
const acked = new Set();
const nudgesPaused = (sessionId) => typeof sessionId === 'string' && paused.has(sessionId);
function resumeNudges(sessionId) {
  const p = typeof sessionId === 'string' ? paused.get(sessionId) : null;
  if (!p) return { ok: false };
  acked.add(`${sessionId}|${p.firedAt}`);
  if (acked.size > 500) acked.delete(acked.values().next().value);
  paused.delete(sessionId);
  current = { alerts: current.alerts.map((a) => (a.sessionId === sessionId && a.paused ? { ...a, paused: false, text: a.text.replace(PAUSED_TAIL, '') } : a)) };
  return { ok: true };
}
const PAUSED_TAIL = '. Other nudges for it are paused until you resume them';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function tailLines(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } finally { fs.closeSync(fd); }
}

function recentTranscripts(root, now) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 1) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { const st = fs.statSync(p); if (now - st.mtimeMs < RECENT_MS) out.push({ file: p, mtime: st.mtimeMs }); } catch {}
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES);
}

function cwdOf(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(lines[i]);
    if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { return null; } }
  }
  return null;
}

/**
 * deps: { handle(channel, allowed, fn), allowed(e), Notification?, rootDir, projectsDir?, home,
 *         env?, provider?() → Promise<the resolved Claude provider (user-provider.cjs) | null>, config() → app config, turns() → Promise<usage turns>, spend() → spend snapshot,
 *         silent?: bool (dev runs: no notifications), now?, log? }
 */
function install(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const file = path.join(deps.rootDir, FILE);
  const projectsRoot = deps.projectsDir || path.join(deps.home, '.claude', 'projects');
  const settings = () => S.normalize(readJson(file, {}));
  // The provider is read through the carry's own resolver (no second detector), at most once a minute;
  // callers that arrive while a read (which may ask the login shell) is running share it.
  let providerMemo = null;
  let providerRead = null;
  function provider() {
    if (!deps.provider) return Promise.resolve(null);
    if (providerMemo && now() - providerMemo.at < TICK_MS) return Promise.resolve(providerMemo.value);
    if (!providerRead) {
      providerRead = (async () => {
        let value = null;
        try { value = (await deps.provider()) || null; } catch (err) { log(`[spend-safety] provider read failed: ${err.message}`); }
        providerMemo = { at: now(), value };
        providerRead = null;
        return value;
      })();
    }
    return providerRead;
  }
  const detected = async () => S.detectPlan({ claudeJson: readJson(path.join(deps.home, '.claude.json'), null), env: deps.env || {}, provider: await provider() });
  const notified = new Set();
  let loops = [];

  function notify(key, title, body, cwd) {
    if (notified.has(key)) return;
    notified.add(key);
    if (notified.size > 500) notified.delete(notified.values().next().value);
    const c = deps.config() || {};
    if (Quiet.reason(c, { now: now(), cwd: cwd || null })) return;
    log(`[spend-safety] ${title}`);
    if (deps.silent || !deps.Notification || !deps.Notification.isSupported()) return;
    new deps.Notification({ title, body, silent: true }).show();
  }

  function scanLoops() {
    const t = now();
    const found = [];
    for (const { file } of recentTranscripts(projectsRoot, t)) {
      let lines;
      try { lines = tailLines(file); } catch { continue; }
      const l = S.retryLoop(lines);
      if (!l) continue;
      const cwd = cwdOf(lines);
      found.push({ sessionId: path.basename(file, '.jsonl'), cwd, ...l, text: S.loopText(l, cwd) });
    }
    return found;
  }

  async function view() {
    const c = deps.config() || {};
    const s = settings();
    const det = await detected();
    const plan = S.effectivePlan(s, det, c.spend && c.spend.mode);
    let turns = [];
    try { turns = (await deps.turns()) || []; } catch (err) { log(`[spend-safety] turns failed: ${err.message}`); }
    const t = now();
    const subscriber = S.SUBSCRIPTIONS.includes(plan);
    return {
      settings: s, plan, planLabel: plan ? S.PLAN_LABEL[plan] : null, detected: det, subscriber,
      // Dollars are API-price equivalents unless the person pays per token on the API (an unknown plan included).
      apiEquivalent: plan !== 'api',
      showDollars: !subscriber || s.showApiPrices,
      limits: subscriber ? S.limitEstimate(turns, plan, t) : null,
      unknownPlan: !plan && turns.length > 0,
      projected: S.projectedToday(turns, t),
      projects: S.projectCaps(turns, s, t, (c.spend && c.spend.warnAt) || 0.8),
      loops: loops.map((l) => ({ sessionId: l.sessionId, tool: l.tool, count: l.count, text: l.text })),
    };
  }

  async function tick() {
    try {
      loops = settings().notifyLoops ? scanLoops() : [];
      for (const l of loops) notify(`loop|${l.sessionId}|${l.since}`, 'Retry loop?', `${l.text}. Check it isn't stuck.`, l.cwd);
      const v = await view();
      const day = new Date(now()).toDateString();
      for (const p of v.projects) if (p.level === 'over') notify(`cap|${p.project}|${day}`, 'Project over its daily cap', `${p.text}${v.apiEquivalent ? ' (API-price equivalent)' : ''}.`, null);
      const snap = deps.spend ? deps.spend() : null;
      const burns = (snap && snap.runaway) || [];
      for (const p of S.nudgePauses((deps.config() || {}).rules, burns, acked)) {
        if (!paused.has(p.sessionId)) log(`[spend-safety] nudges paused for a burning session (rule: ${p.rule})`);
        paused.set(p.sessionId, p);
      }
      current = {
        alerts: [
          ...burns.map((r) => ({ key: `burn|${r.sessionId}|${r.firedAt || 0}`, kind: 'needs-you', sessionId: r.sessionId, paused: paused.has(r.sessionId), text: `${S.burnText(r, v.apiEquivalent)}${paused.has(r.sessionId) ? PAUSED_TAIL : ''}` })),
          ...v.projects.filter((p) => p.level === 'over').map((p) => ({ key: `cap|${p.project}|${day}`, kind: 'needs-you', sessionId: `cap:${p.project}`, text: `${p.project} is over its daily cap` })),
          ...loops.map((l) => ({ key: `loop|${l.sessionId}|${l.since}`, kind: 'stuck', sessionId: l.sessionId, text: l.text })),
        ],
      };
    } catch (err) { log(`[spend-safety] tick failed: ${err.message}`); }
  }

  deps.handle('spend-safety:get', deps.allowed, () => view());
  deps.handle('spend-safety:set', deps.allowed, (_e, v) => {
    const next = S.normalize({ ...settings(), ...(v && typeof v === 'object' ? v : {}) });
    try {
      fs.mkdirSync(deps.rootDir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
      return { ok: true, settings: next };
    } catch (err) { return { error: `Could not save: ${err.message}` }; }
  });
  if (deps.tick !== false) { const h = setInterval(tick, TICK_MS); if (h.unref) h.unref(); }
  return { tick, view, alerts, nudgesPaused, resumeNudges };
}

module.exports = { install, alerts, nudgesPaused, resumeNudges, recentTranscripts, tailLines, cwdOf, FILE };
