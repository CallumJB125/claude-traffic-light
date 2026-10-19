// Crash reports, local half. A crash in the main process (an uncaught
// exception or unhandled rejection) or a renderer that dies is turned into a
// small allow-listed report, scrubbed with src/scrub.js before it is written,
// and kept in a capped ring file in the data folder (mode 0600). Nothing here
// talks to the network: main injects the structural-only sender after consent. test/crash-reports.test.js checks that this
// file loads no network module.
//
// Only these fields are ever kept: an error's name, the first line of its
// message (cut short) and its "at …" stack frames; a renderer's exit reason
// and code; the app version, OS and architecture. No URLs, window titles,
// prompts, file contents or environment. Reading the ring back keeps only
// the same fields, so a hand-edited file can't add more.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { scrub } = require('./scrub.js');
const { CONSENT_VERSION } = require('../board/shared/crash-report.cjs');

const RING_FILE = 'reports.jsonl';
const CONSENT_FILE = 'consent.json';
const MAX_REPORTS = 20;
const MAX_RING_BYTES = 64 * 1024;
const MAX_MESSAGE = 300;
const MAX_FRAMES = 30;
const MAX_PER_RUN = 25;
const KINDS = new Set(['uncaughtException', 'unhandledRejection', 'renderer-gone']);
const REASONS = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction']);

const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const str = (v, n) => (typeof v === 'string' ? cut(v, n) : '');

function errorFields(err, scrubOpts) {
  const e = err instanceof Error ? err : null;
  const name = e ? str(e.name, 60).replace(/[^\w.]/g, '') || 'Error' : 'NonError';
  const firstLine = e ? String(e.message || '').split('\n')[0] : typeof err === 'string' ? err.split('\n')[0] : `thrown ${err === null ? 'null' : typeof err}`;
  const frames = e && typeof e.stack === 'string' ? e.stack.split('\n').filter((l) => /^\s*at /.test(l)).slice(0, MAX_FRAMES).map((l) => cut(l.trim(), 400)) : [];
  return {
    name,
    message: cut(scrub(cut(firstLine, MAX_MESSAGE * 2), scrubOpts), MAX_MESSAGE),
    stack: frames.length ? scrub(frames.join('\n'), scrubOpts).split('\n') : [],
  };
}

function rendererFields(details) {
  const d = details || {};
  return { reason: REASONS.has(d.reason) ? d.reason : 'unknown', exitCode: Number.isInteger(d.exitCode) ? d.exitCode : null };
}

function clean(r) {
  if (!r || typeof r !== 'object' || !KINDS.has(r.kind) || !/^[0-9a-f-]{36}$/.test(r.id)) return null;
  const out = {
    id: r.id,
    at: Number.isNaN(Date.parse(r.at)) ? new Date(0).toISOString() : new Date(r.at).toISOString(),
    kind: r.kind,
    app: { version: str(r.app?.version, 40), os: str(r.app?.os, 20), osVersion: str(r.app?.osVersion, 40), arch: str(r.app?.arch, 20) },
  };
  if (r.kind === 'renderer-gone') out.renderer = rendererFields(r.renderer);
  else out.error = { name: str(r.error?.name, 60), message: str(r.error?.message, MAX_MESSAGE + 1), stack: Array.isArray(r.error?.stack) ? r.error.stack.filter((l) => typeof l === 'string').slice(0, MAX_FRAMES).map((l) => cut(l, 400)) : [] };
  return out;
}

function writePrivate(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

// Safe fallback for collectors without an injected sender.
function sendCrashReport(_report) {
  return { sent: false, reason: 'Sending is unavailable; report saved locally.' };
}

//   dir:       where the ring and the consent file live (inside the data folder)
//   app:       { version, os, osVersion, arch }
//   scrubWith: () => options for scrub() (home, user, hostname, names)
function create({ dir, app = {}, scrubWith = () => ({}), now = () => Date.now(), send = sendCrashReport } = {}) {
  const ring = path.join(dir, RING_FILE);
  const consent = path.join(dir, CONSENT_FILE);
  let written = 0;

  const ensureDir = () => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); };

  function list() {
    let text = '';
    try { text = fs.readFileSync(ring, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const r = clean(JSON.parse(line)); if (r) out.push(r); } catch { /* a torn line is dropped */ }
    }
    return out.slice(-MAX_REPORTS);
  }

  function isOptedIn() {
    try { const c = JSON.parse(fs.readFileSync(consent, 'utf8')); return c.optedIn === true && c.version === CONSENT_VERSION; } catch { return false; }
  }

  function setOptIn(on) {
    ensureDir();
    writePrivate(consent, JSON.stringify({ version: CONSENT_VERSION, optedIn: on === true, at: new Date(now()).toISOString() }));
    return isOptedIn();
  }

  function build(kind, what) {
    const opts = { ...scrubWith(), salt: crypto.randomBytes(8).toString('hex') };
    return clean({
      id: crypto.randomUUID(),
      at: new Date(now()).toISOString(),
      kind,
      app,
      error: kind === 'renderer-gone' ? undefined : errorFields(what, opts),
      renderer: kind === 'renderer-gone' ? what : undefined,
    });
  }

  function record(kind, what) {
    if (!KINDS.has(kind) || written >= MAX_PER_RUN) return null;
    written++;
    try {
      const report = build(kind, what);
      const kept = list().concat(report).slice(-MAX_REPORTS).map((r) => JSON.stringify(r));
      while (kept.length > 1 && Buffer.byteLength(kept.join('\n') + '\n') > MAX_RING_BYTES) kept.shift();
      ensureDir();
      writePrivate(ring, `${kept.join('\n')}\n`); // privacy-flow: crash-capture-local
      if (isOptedIn()) Promise.resolve(send(report)).catch(() => {});
      return report;
    } catch { return null; }
  }

  const latest = () => list().pop() || null;
  const payload = (report = latest()) => (report ? JSON.stringify(report, null, 2) : '');
  const bundle = () => JSON.stringify({ exportedAt: new Date(now()).toISOString(), app: clean({ id: crypto.randomUUID(), kind: 'uncaughtException', app }).app, reports: list() }, null, 2);

  return { record, list, latest, payload, bundle, isOptedIn, setOptIn, ringFile: ring };
}

module.exports = { create, sendCrashReport, clean, MAX_REPORTS, MAX_RING_BYTES, MAX_PER_RUN };
