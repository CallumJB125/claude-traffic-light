'use strict';
// Deploy status for the hosting a session's project uses: Vercel, Netlify and
// Cloudflare (Pages or Workers). See PRIVACY.md flow deploy-status.
//
// Which host a folder deploys to comes from the files their CLIs leave there:
// .vercel/project.json, .netlify/state.json (or netlify.toml), wrangler.toml
// / wrangler.json(c). The latest deployments are read either with the user's
// own, already signed-in CLI (vercel ls, netlify api, wrangler … list) or,
// when the user pasted a token in Preferences, the host's REST API with that
// token. Plexiform has no account of its own with any of them and asks for no
// password.
//
// Like src/github-signals.js, results become transient rule events, not
// states: `deploy-live` when a deployment finishes and is serving, and
// `deploy-failed` when one fails (with a plain-English line about why, from
// the tail of its build log). Each fires once per deployment and only while
// fresh, so a restart can't replay old news.
//
// Polling is gentle: every 5 minutes per project, every 20 seconds while a
// deployment is building or the session just ran a deploy command (the hook
// records `deployAt`, never the command), exponential backoff on errors, 30
// minutes when no CLI or token is available, and nothing at all while
// offline. Project folders are read only through async fs under a deadline
// (src/bounded-io.js), never synchronously.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('child_process');
const { toolEnv } = require('./tool-path.js');
const { withDeadline, GRACE_MS } = require('./bounded-io.js');

const PROVIDERS = ['vercel', 'netlify', 'cloudflare'];
const LABEL = { vercel: 'Vercel', netlify: 'Netlify', cloudflare: 'Cloudflare' };
const SIGNALS = ['deploy-live', 'deploy-failed'];
const IDLE_MS = 5 * 60 * 1000;
const BUSY_MS = 20 * 1000;
const UNAVAILABLE_MS = 30 * 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const HINT_MS = 10 * 60 * 1000;
const FRESH_MS = 15 * 60 * 1000;
const DETECT_MS = 60 * 1000;
const FILE_MS = 3000;
const CLI_MS = 30000;
const HOLD_MS = { 'deploy-failed': 10 * 60 * 1000, 'deploy-live': 2 * 60 * 1000 };
const LOG_LINES = 40;
const ID = /^[\w.:-]{1,120}$/;
const okId = (v) => (typeof v === 'string' && ID.test(v) ? v : null);
const clip = (v, n = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, n) : '');
const time = (v) => (typeof v === 'number' ? v : Date.parse(v || '')) || 0;

// ── Detection ────────────────────────────────────────────────────────────
async function readText(file, ms = FILE_MS) {
  return withDeadline((done) => { fsp.readFile(file, 'utf8').then(done, () => done(null)); }, ms, null);
}
async function listDir(dir, ms = FILE_MS) {
  return withDeadline((done) => { fsp.readdir(dir).then(done, () => done(null)); }, ms, null);
}
const json = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
// wrangler.jsonc allows comments and trailing commas.
const jsonc = (text) => json(String(text || '').replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '').replace(/,\s*([}\]])/g, '$1'));
// Top-level `key = "value"` from a TOML file (before the first [table]).
function tomlTop(text, key) {
  const top = String(text || '').split(/^\s*\[/m)[0];
  const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"'\\n]*)["']`, 'm').exec(top);
  return m ? m[1] : null;
}

// read(relativePath) → text | null. Pure apart from read, so tests pass a map.
async function detectTargets(cwd, read = (rel) => readText(path.join(cwd, rel))) {
  const out = [];
  const vercel = json(await read(path.join('.vercel', 'project.json')));
  if (vercel && okId(vercel.projectId)) out.push({ provider: 'vercel', id: vercel.projectId, org: okId(vercel.orgId), name: okId(vercel.projectName) || path.basename(cwd), cwd });
  const netlify = json(await read(path.join('.netlify', 'state.json')));
  if (netlify && okId(netlify.siteId)) out.push({ provider: 'netlify', id: netlify.siteId, name: path.basename(cwd), cwd });
  else if ((await read('netlify.toml')) != null) out.push({ provider: 'netlify', id: null, name: path.basename(cwd), cwd, unlinked: true });
  const toml = await read('wrangler.toml');
  const wj = toml == null ? jsonc((await read('wrangler.jsonc')) ?? (await read('wrangler.json'))) : null;
  if (toml != null || wj) {
    const name = okId(toml != null ? tomlTop(toml, 'name') : wj && wj.name);
    const account = okId(toml != null ? tomlTop(toml, 'account_id') : wj && wj.account_id);
    const pages = toml != null ? tomlTop(toml, 'pages_build_output_dir') != null : !!(wj && wj.pages_build_output_dir);
    if (name) out.push({ provider: 'cloudflare', kind: pages ? 'pages' : 'workers', id: name, name, account, cwd });
  }
  return out;
}

// ── Pre-deploy check: .env files a deploy would upload ────────────────────
const ENV_FILE = /^\.env(?:\..+)?$/;
const ENV_SAFE = /\.(?:example|sample|template|defaults)$/;
function globRe(pattern) {
  const p = pattern.replace(/^\/+/, '').replace(/^\*\*\//, '').replace(/\/+$/, '');
  return new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
}
// Is `name` (a top-level file) ignored by these ignore-file lines? Last match wins, as in git.
function ignored(lines, name) {
  let hit = false;
  for (const raw of String(lines || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const neg = line.startsWith('!');
    if (globRe(neg ? line.slice(1) : line).test(name)) hit = !neg;
  }
  return hit;
}
// names: the folder's top-level entries. files: {'.vercelignore': text|null, '.dockerignore': text|null}.
function envCheck({ names = [], files = {}, vercel = false } = {}) {
  const env = names.filter((n) => ENV_FILE.test(n) && !ENV_SAFE.test(n)).sort();
  if (!env.length) return [];
  const out = [];
  const check = (file, why) => {
    const missing = env.filter((n) => !ignored(files[file], n));
    if (missing.length) out.push({ file, missing, text: `${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not in ${file}${files[file] == null ? ' (there is no such file)' : ''}, so ${why}.` });
  };
  if (vercel) check('.vercelignore', 'vercel deploy would upload it');
  if (names.includes('Dockerfile')) check('.dockerignore', 'a Docker build would copy it into the image');
  return out;
}
async function preDeployCheck(cwd, targets) {
  const names = await listDir(cwd);
  if (!Array.isArray(names)) return [];
  const vercel = targets.some((t) => t.provider === 'vercel');
  const files = {};
  if (vercel) files['.vercelignore'] = await readText(path.join(cwd, '.vercelignore'));
  if (names.includes('Dockerfile')) files['.dockerignore'] = await readText(path.join(cwd, '.dockerignore'));
  return envCheck({ names, files, vercel });
}

// ── What the hosts say, normalised: {id, state, url, at, error} ───────────
// state: building | live | failed | canceled
const VERCEL_STATE = { READY: 'live', ERROR: 'failed', CANCELED: 'canceled', BUILDING: 'building', QUEUED: 'building', INITIALIZING: 'building' };
const NETLIFY_STATE = { ready: 'live', error: 'failed', rejected: 'failed', building: 'building', enqueued: 'building', uploading: 'building', uploaded: 'building', processing: 'building', processed: 'building', preparing: 'building', prepared: 'building', new: 'building' };
const https = (u) => (typeof u === 'string' && u ? (/^https:\/\//.test(u) ? u : `https://${u.replace(/^\w+:\/\//, '')}`) : null);
function vercelList(body) {
  const list = Array.isArray(body) ? body : body && Array.isArray(body.deployments) ? body.deployments : [];
  return list.map((d) => ({ id: okId(d.uid || d.id), state: VERCEL_STATE[String(d.readyState || d.state || '').toUpperCase()] || null, url: https(d.url), at: time(d.createdAt || d.created), error: clip(d.errorMessage || '') || null })).filter((d) => d.id && d.state);
}
// `vercel ls` prints a table: age, url, status (● Ready / ● Error / ● Building …).
function vercelTable(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const url = /(https:\/\/[\w.-]+\.vercel\.app)\b/.exec(line);
    const st = /\b(Ready|Error|Building|Queued|Initializing|Canceled)\b/i.exec(line);
    if (url && st) out.push({ id: url[1].replace('https://', ''), state: VERCEL_STATE[st[1].toUpperCase()], url: url[1], at: 0, error: null });
  }
  return out;
}
function netlifyList(body) {
  return (Array.isArray(body) ? body : []).map((d) => ({ id: okId(d.id), state: NETLIFY_STATE[d.state] || null, url: https(d.deploy_ssl_url || d.ssl_url || d.deploy_url), at: time(d.created_at), error: clip(d.error_message || '') || null })).filter((d) => d.id && d.state);
}
function cloudflarePagesList(body) {
  const list = Array.isArray(body) ? body : body && Array.isArray(body.result) ? body.result : [];
  return list.map((d) => {
    const st = (d.latest_stage && d.latest_stage.status) || d.status;
    const stage = d.latest_stage && d.latest_stage.name;
    const state = st === 'failure' ? 'failed' : st === 'canceled' ? 'canceled' : st === 'success' && (!stage || stage === 'deploy') ? 'live' : 'building';
    return { id: okId(d.id || d.Id), state, url: https(d.url || d.Deployment), at: time(d.created_on || d.modified_on), error: null };
  }).filter((d) => d.id);
}
function cloudflareWorkersList(body) {
  const list = Array.isArray(body) ? body : body && body.result && Array.isArray(body.result.deployments) ? body.result.deployments : [];
  return list.map((d) => ({ id: okId(d.id), state: 'live', url: null, at: time(d.created_on), error: null })).filter((d) => d.id);
}
const newest = (list) => list.slice().sort((a, b) => b.at - a.at)[0] || null;

// ── Build log → one plain-English line ────────────────────────────────────
const EXPLAIN = [
  [/Module not found:.*?Can't resolve '([^']+)'/, (m) => `A file imports "${m[1]}", which the build can't find. Check the path or install the package.`],
  [/Cannot find module '([^']+)'/, (m) => `The build can't find the module "${m[1]}". It may be missing from package.json.`],
  [/Type error: (.+)/, (m) => `TypeScript stopped the build: ${m[1]}`],
  [/error TS\d+: (.+)/, (m) => `TypeScript stopped the build: ${m[1]}`],
  [/[Mm]issing script: "?([\w:.-]+)"?/, (m) => `package.json has no "${m[1]}" script, so the build command has nothing to run.`],
  [/Environment Variable "?([A-Z_][A-Z0-9_]*)"? references Secret/, (m) => `The environment variable ${m[1]} points at a secret that doesn't exist on the host.`],
  [/\b([A-Z][A-Z0-9_]{2,}) is (?:not defined|not set|missing|required)/, (m) => `The environment variable ${m[1]} isn't set on the host.`],
  [/(?:npm ERR!|ERR_PNPM_\w+|error An unexpected error occurred|YN0001)/, () => 'Installing the dependencies failed. The lockfile and package.json may disagree.'],
  [/exceeded (?:the )?maximum (?:build )?duration|Build timed out/i, () => 'The build ran out of time on the host.'],
  [/JavaScript heap out of memory|ENOMEM/, () => 'The build ran out of memory on the host.'],
  [/SyntaxError: (.+)/, (m) => `A syntax error stopped the build: ${m[1]}`],
  [/Command "(.+?)" exited with (\d+)/, (m) => `The build command "${m[1]}" stopped with exit code ${m[2]}.`],
];
function summarise(lines, fallback = null) {
  const list = (Array.isArray(lines) ? lines : String(lines || '').split('\n')).map((l) => clip(String(l), 400)).filter((l) => l.trim());
  for (const [re, say] of EXPLAIN) {
    for (const line of list) { const m = re.exec(line); if (m) return clip(say(m), 240); }
  }
  const err = list.slice().reverse().find((l) => /\berror\b/i.test(l));
  if (err) return clip(`The build failed: ${err.trim()}`, 240);
  return fallback ? clip(`The deploy failed: ${fallback}`, 240) : 'The deploy failed. The build log did not say why.';
}
function logLines(provider, body) {
  if (provider === 'vercel') return (Array.isArray(body) ? body : []).map((e) => (e && (e.text || (e.payload && e.payload.text))) || '').filter(Boolean);
  if (provider === 'cloudflare') return ((body && body.result && body.result.data) || []).map((e) => (e && e.line) || '').filter(Boolean);
  return String(body || '').split('\n');
}

// The prompt "Send this error to Claude" copies. `scrub` hides secrets and home paths.
function errorPrompt(d, scrub = (t) => t) {
  const tail = (d.logTail || []).join('\n');
  return [
    `My ${LABEL[d.provider] || d.provider} deploy of ${d.name} just failed.`,
    d.summary ? `Plexiform's reading of the log: ${d.summary}` : null,
    tail ? `The end of the build log:\n\`\`\`\n${scrub(tail)}\n\`\`\`` : null,
    'Please find the cause, fix it in this project, and tell me how to redeploy.',
  ].filter(Boolean).join('\n\n');
}

// ── Talking to the hosts ──────────────────────────────────────────────────
function defaultRun(bin, args, { cwd } = {}) {
  return withDeadline((done) => execFile(bin, args, { // privacy-flow: deploy-status
    cwd, timeout: CLI_MS, maxBuffer: 4 * 1024 * 1024,
    env: toolEnv({ CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', NETLIFY_CLI_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' }),
  }, (err, stdout, stderr) => done({ notFound: !!(err && err.code === 'ENOENT'), code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })), CLI_MS + GRACE_MS, { notFound: false, code: 1, stdout: '', stderr: 'timed out' });
}

class HostError extends Error {
  constructor(kind, msg) { super(msg); this.kind = kind; }
}

const API = {
  vercel: 'https://api.vercel.com',
  netlify: 'https://api.netlify.com/api/v1',
  cloudflare: 'https://api.cloudflare.com/client/v4',
};

// http(url, token) → {status, body}. One reader per provider and source.
function readers({ run, http }) {
  async function api(provider, url, token) {
    const r = await http(url, token);
    if (!r) throw new HostError('error', 'no response');
    if (r.status === 401 || r.status === 403) throw new HostError('no-auth', `${LABEL[provider]} refused the saved token`);
    if (r.status === 429) throw new HostError('error', `${LABEL[provider]} asked us to slow down`);
    if (r.status < 200 || r.status >= 300) throw new HostError('error', `${LABEL[provider]} answered HTTP ${r.status}`);
    return r.body;
  }
  // both: the table some CLIs print on stderr counts as output too.
  async function cli(provider, bin, args, cwd, both = false) {
    const r = await run(bin, args, { cwd });
    if (r.notFound) throw new HostError('no-cli', `${bin} is not installed`);
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code && /log ?in|not (?:logged|authenticated)|authenticat|No existing credentials|unauthori[sz]ed/i.test(text)) throw new HostError('no-auth', `${bin} is not signed in`);
    if (r.code) throw new HostError('error', clip(r.stderr.trim() || `${bin} failed`, 160));
    return both ? text : r.stdout;
  }
  const team = (t) => (t.org && t.org.startsWith('team_') ? `&teamId=${encodeURIComponent(t.org)}` : '');
  return {
    async list(t, token) {
      if (t.provider === 'vercel') {
        if (token) return vercelList(await api('vercel', `${API.vercel}/v6/deployments?projectId=${encodeURIComponent(t.id)}&limit=5${team(t)}`, token));
        return vercelTable(await cli('vercel', 'vercel', ['ls'], t.cwd, true));
      }
      if (t.provider === 'netlify') {
        if (!t.id) throw new HostError('unlinked', 'run netlify link in this folder first');
        if (token) return netlifyList(await api('netlify', `${API.netlify}/sites/${encodeURIComponent(t.id)}/deploys?per_page=5`, token));
        return netlifyList(json(await cli('netlify', 'netlify', ['api', 'listSiteDeploys', '--data', JSON.stringify({ site_id: t.id, per_page: 5 })], t.cwd)));
      }
      if (t.provider === 'cloudflare') {
        if (token) {
          if (!t.account) throw new HostError('unlinked', 'add account_id to wrangler.toml');
          const base = `${API.cloudflare}/accounts/${encodeURIComponent(t.account)}`;
          return t.kind === 'pages'
            ? cloudflarePagesList(await api('cloudflare', `${base}/pages/projects/${encodeURIComponent(t.id)}/deployments?per_page=5`, token))
            : cloudflareWorkersList(await api('cloudflare', `${base}/workers/scripts/${encodeURIComponent(t.id)}/deployments`, token));
        }
        return t.kind === 'pages'
          ? cloudflarePagesList(json(await cli('cloudflare', 'wrangler', ['pages', 'deployment', 'list', '--project-name', t.id, '--json'], t.cwd)))
          : cloudflareWorkersList(json(await cli('cloudflare', 'wrangler', ['deployments', 'list', '--json'], t.cwd)));
      }
      return [];
    },
    // The last lines of a failed deployment's build log (best effort: [] when unavailable).
    async logTail(t, d, token) {
      try {
        if (t.provider === 'vercel') {
          if (token) return logLines('vercel', await api('vercel', `${API.vercel}/v3/deployments/${encodeURIComponent(d.id)}/events?direction=backward&limit=${LOG_LINES}${team(t)}`, token)).reverse();
          if (!d.url) return [];
          const r = await run('vercel', ['inspect', d.url, '--logs'], { cwd: t.cwd });
          return `${r.stdout}\n${r.stderr}`.split('\n');
        }
        if (t.provider === 'cloudflare' && t.kind === 'pages' && token && t.account) {
          return logLines('cloudflare', await api('cloudflare', `${API.cloudflare}/accounts/${encodeURIComponent(t.account)}/pages/projects/${encodeURIComponent(t.id)}/deployments/${encodeURIComponent(d.id)}/history/logs`, token));
        }
      } catch { /* no log: the summary falls back to the host's own error */ }
      return d.error ? [d.error] : [];
    },
  };
}

// How long until a target is looked at again.
function nextDelay({ state, failures = 0, building = false, hinted = false }) {
  if (state === 'no-cli' || state === 'no-auth' || state === 'unlinked') return UNAVAILABLE_MS;
  if (failures) return Math.min(MAX_BACKOFF_MS, 60000 * 2 ** (failures - 1));
  return building || hinted ? BUSY_MS : IDLE_MS;
}

// ── The watcher ───────────────────────────────────────────────────────────
// tokens() → {vercel?, netlify?, cloudflare?} (decrypted, main only).
// online() → boolean. detect(cwd) and check(cwd, targets) are injectable for tests.
function create({ run = defaultRun, http, tokens = () => ({}), online = () => true, now = Date.now, log = () => {}, detect = detectTargets, check = preDeployCheck, scrub = (t) => t } = {}) {
  const read = readers({ run, http: http || (async () => { throw new HostError('error', 'no network'); }) });
  const folders = new Map(); // cwd → {at, targets, checks}
  const targets = new Map(); // key → {target, state, failures, nextAt, latest, error}
  const seen = new Map(); // deployment key → state already reported
  let events = [];
  let polling = null;
  let seeded = false;
  const key = (t) => `${t.provider}:${t.id || t.cwd}`;

  async function discover(sessions) {
    const t = now();
    const cwds = [...new Set((sessions || []).map((s) => s && s.cwd).filter((c) => typeof c === 'string' && path.isAbsolute(c)))];
    for (const cwd of cwds) {
      const f = folders.get(cwd);
      if (f && t - f.at < DETECT_MS) continue;
      const found = await detect(cwd).catch(() => []);
      const checks = found.length ? await check(cwd, found).catch(() => []) : [];
      folders.set(cwd, { at: t, targets: found, checks });
      for (const tg of found) {
        const k = key(tg);
        const cur = targets.get(k);
        if (cur) cur.target = { ...tg, cwd: cur.target.cwd };
        else targets.set(k, { target: tg, state: 'starting', failures: 0, nextAt: 0, latest: null, error: null });
      }
    }
    for (const cwd of [...folders.keys()]) if (!cwds.includes(cwd) && t - folders.get(cwd).at > 60 * 60 * 1000) folders.delete(cwd);
    for (const [k, v] of targets) if (!folders.has(v.target.cwd)) targets.delete(k);
    return cwds;
  }

  function fire(entry, d, signal, extra = {}) {
    const t = now();
    const tg = entry.target;
    const ev = { id: `host:${tg.provider}:${d.id}:${signal}`, signal, provider: tg.provider, name: tg.name, cwd: tg.cwd, repo: null, url: d.url, title: `${LABEL[tg.provider]} · ${tg.name}`, at: d.at ? new Date(d.at).toISOString() : new Date(t).toISOString(), firedAt: t, ...extra };
    events = events.concat(ev).slice(-30);
    log(`[deploy] ${signal} ${tg.provider} ${tg.name}`);
    return ev;
  }

  async function pollTarget(entry, token, hinted) {
    const t = now();
    const list = await read.list(entry.target, token);
    const d = newest(list);
    const fired = [];
    entry.latest = d;
    entry.error = null;
    entry.failures = 0;
    entry.state = 'ok';
    if (d) {
      const k = `${entry.target.provider}:${d.id}`;
      const before = seen.get(k);
      const fresh = !d.at || t - d.at < FRESH_MS;
      if (before !== d.state) {
        seen.set(k, d.state);
        // The first look at a project only reports what is fresh; a deploy seen building then finishing always counts.
        const announce = seeded || before === 'building' || fresh;
        if (announce && d.state === 'failed' && (before !== undefined || fresh)) {
          const tail = (await read.logTail(entry.target, d, token)).map((l) => clip(String(l), 300)).filter((l) => l.trim()).slice(-LOG_LINES);
          entry.logTail = tail;
          entry.summary = summarise(tail, d.error);
          fired.push(fire(entry, d, 'deploy-failed', { summary: entry.summary }));
        } else if (announce && d.state === 'live' && (before === 'building' || fresh)) {
          entry.summary = null;
          entry.logTail = null;
          fired.push(fire(entry, d, 'deploy-live'));
        }
      }
    }
    entry.nextAt = t + nextDelay({ state: entry.state, building: !!(d && d.state === 'building'), hinted });
    return fired;
  }

  // One round over the projects that are due. opts: {sessions, enabled}.
  async function tick({ sessions = [], enabled = true } = {}) {
    if (!enabled || polling) return [];
    if (!online()) return [];
    polling = (async () => {
      const fired = [];
      await discover(sessions);
      const t = now();
      const tok = tokens() || {};
      for (const entry of targets.values()) {
        const hinted = (sessions || []).some((s) => s && s.cwd === entry.target.cwd && t - time(s.deployAt) < HINT_MS);
        // A deploy the session just started is worth a look now, not in five minutes.
        const due = t >= entry.nextAt || (hinted && entry.nextAt - t > BUSY_MS);
        if (!due) continue;
        try {
          fired.push(...await pollTarget(entry, tok[entry.target.provider] || null, hinted));
        } catch (e) {
          entry.state = ['no-cli', 'no-auth', 'unlinked'].includes(e.kind) ? e.kind : 'backoff';
          if (entry.state === 'backoff') entry.failures += 1;
          entry.error = clip(e.message, 200);
          entry.nextAt = now() + nextDelay({ state: entry.state, failures: entry.failures });
          log(`[deploy] ${entry.target.provider} ${entry.target.name}: ${entry.error}`);
        }
      }
      seeded = true;
      return fired;
    })();
    try { return await polling; } finally { polling = null; }
  }

  function active(t = now()) {
    return events.filter((e) => t - e.firedAt < (HOLD_MS[e.signal] || 0));
  }

  // One row per project and host, for Home and Settings. `handle` is opaque.
  function status() {
    const rows = [];
    for (const [k, e] of targets) {
      const d = e.latest;
      const f = folders.get(e.target.cwd);
      rows.push({
        handle: k,
        provider: e.target.provider,
        label: LABEL[e.target.provider],
        name: e.target.name,
        folder: path.basename(e.target.cwd),
        cwd: e.target.cwd,
        state: d ? d.state : e.state === 'ok' ? 'none' : 'unknown',
        url: d && d.state === 'live' ? d.url : null,
        at: d && d.at ? new Date(d.at).toISOString() : null,
        summary: d && d.state === 'failed' ? (e.summary || summarise([], d.error)) : null,
        problem: e.state === 'no-cli' ? `Install the ${e.target.provider === 'cloudflare' ? 'wrangler' : e.target.provider} CLI and sign in, or paste a token in Preferences.`
          : e.state === 'no-auth' ? `Sign in to the ${e.target.provider === 'cloudflare' ? 'wrangler' : e.target.provider} CLI, or paste a token in Preferences.`
            : e.state === 'unlinked' ? clip(e.error || '', 160) : null,
        checks: (f && f.checks) || [],
      });
    }
    return rows;
  }

  function prompt(handle) {
    const e = targets.get(handle);
    if (!e || !e.latest || e.latest.state !== 'failed') return null;
    return errorPrompt({ provider: e.target.provider, name: e.target.name, summary: e.summary, logTail: e.logTail }, scrub);
  }
  function urlFor(handle) {
    const e = targets.get(handle);
    return e && e.latest && e.latest.state === 'live' && /^https:\/\/[\w.-]+(?:\/|$)/.test(e.latest.url || '') ? e.latest.url : null;
  }

  return { tick, active, status, prompt, urlFor };
}

module.exports = { PROVIDERS, SIGNALS, HOLD_MS, FRESH_MS, IDLE_MS, BUSY_MS, UNAVAILABLE_MS, API, detectTargets, envCheck, ignored, preDeployCheck, vercelList, vercelTable, netlifyList, cloudflarePagesList, cloudflareWorkersList, summarise, errorPrompt, nextDelay, readers, create };
