'use strict';
// Project guardrails for people who build with AI but don't read diffs: what
// a turn's changes put at risk, in plain English. Everything here is pure: it
// reads text it is handed and returns findings. src/guardrails-main.js feeds it
// checkpoint diffs (src/checkpoints.js), file lists and permission requests.
//
// A finding never holds a secret: only its kind, where it is, a redacted
// preview and an id. Ids are keyed (HMAC with a per-install salt) over the
// repo, file, rule and the matched value, so the same problem keeps its id when
// it moves lines, and a rescan can tell "still there" from "gone".

const crypto = require('node:crypto');
const { findSecrets } = require('./secret-patterns.js');
const { shellFinding, SHELL_TOOLS, stringsIn } = require('./deny/denylist.js');
const { parseShell } = require('./deny/shell.js');

const KIND_NAMES = {
  aws_access_key: 'AWS', github_token: 'GitHub', github_pat: 'GitHub', openai_key: 'OpenAI', anthropic_key: 'Anthropic',
  stripe_key: 'Stripe', supabase_key: 'Supabase', supabase_service_role: 'Supabase service_role', google_api_key: 'Google',
  slack_token: 'Slack', jwt: 'login token (JWT)', env_secret: 'secret', private_key: 'private', groq_key: 'Groq', xai_key: 'xAI',
};
// Where to make a new key and switch the old one off. Only for kinds whose page is well known.
const ROTATE = {
  aws: 'https://console.aws.amazon.com/iam/home#/security_credentials',
  github: 'https://github.com/settings/tokens',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  stripe: 'https://dashboard.stripe.com/apikeys',
  supabase: 'https://supabase.com/dashboard/project/_/settings/api-keys',
  google: 'https://console.cloud.google.com/apis/credentials',
  slack: 'https://api.slack.com/apps',
  groq: 'https://console.groq.com/keys',
  xai: 'https://console.x.ai',
};
function kindName(kind) {
  if (KIND_NAMES[kind]) return KIND_NAMES[kind];
  const base = String(kind).replace(/_(key|token|secret|pat|api_key)$/, '').replace(/_/g, ' ');
  return base.charAt(0).toUpperCase() + base.slice(1);
}
function rotateUrl(kind) {
  const k = String(kind).toLowerCase();
  const hit = Object.keys(ROTATE).find((p) => k.startsWith(p));
  return hit ? ROTATE[hit] : null;
}

// A few characters of the start (enough to recognise the kind), never the rest.
function redact(value) {
  const v = String(value);
  const keep = v.length >= 16 ? 4 : 0;
  return `${v.slice(0, keep)}${'•'.repeat(8)} (${v.length} characters)`;
}
function lineWithRedaction(line, start, length) {
  const shown = `${line.slice(0, start)}${redact(line.slice(start, start + length))}${line.slice(start + length)}`.trim();
  return shown.length > 160 ? `${shown.slice(0, 157)}…` : shown;
}

function findingId(salt, parts) {
  return crypto.createHmac('sha256', String(salt)).update(parts.map(String).join('\0')).digest('hex').slice(0, 20);
}

/** The lines a unified diff adds → [{file, line, text}] (line numbers in the new file). */
function addedLines(diff) {
  const out = [];
  let file = null, n = 0;
  for (const raw of String(diff || '').split('\n')) {
    if (raw.startsWith('+++ ')) { const p = raw.slice(4).trim(); file = p === '/dev/null' ? null : p.replace(/^b\//, ''); continue; }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git')) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) { n = Number(h[1]); continue; }
    if (!file) continue;
    if (raw.startsWith('+')) { out.push({ file, line: n, text: raw.slice(1) }); n += 1; } else if (raw.startsWith(' ')) n += 1;
  }
  return out;
}

const b64json = (s) => { try { return JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return null; } };
/** A Supabase-style JWT's role claim, or null. */
function jwtRole(token) {
  const p = String(token).split('.');
  return p.length >= 2 ? b64json(p[1])?.role ?? null : null;
}
// Keys that are meant to be public: anon JWTs, publishable keys, Stripe pk_.
function publicKey(value) {
  if (/^(?:sb_publishable_|pk_(?:live|test)_)/.test(value)) return true;
  return /^eyJ/.test(value) && jwtRole(value) === 'anon';
}
function secretsIn(text) {
  return findSecrets(text, { classes: ['credential'] }).filter((h) => !publicKey(text.slice(h.index, h.index + h.length)));
}
const serviceRole = (v) => /^sb_secret_/.test(v) || (/^eyJ/.test(v) && jwtRole(v) === 'service_role');

/** Secrets a turn added. → findings of type 'secret'. */
function secretFindings(lines, { salt, repo, turn = null, sessionId = null }) {
  const out = [];
  for (const l of lines) {
    for (const h of secretsIn(l.text)) {
      const value = l.text.slice(h.index, h.index + h.length);
      const kind = serviceRole(value) ? 'supabase_service_role' : h.kind;
      out.push({
        id: findingId(salt, [repo, 'secret', l.file, kind, value]), type: 'secret', kind, file: l.file, line: l.line, turn, sessionId,
        preview: lineWithRedaction(l.text, h.index, h.length), rotate: rotateUrl(kind),
        title: `${turn ? `Turn ${turn}` : 'A change'} added what looks like a${/^[AEIOU]/i.test(kindName(kind)) ? 'n' : ''} ${kindName(kind)} key at ${l.file}:${l.line}`,
        fix: 'Anyone who can see this file can use the key. Make a new key, switch this one off, and keep the new one in a .env file that git ignores.',
      });
    }
  }
  return out;
}

// Names a framework copies into the browser bundle.
const PUBLIC_NAME = /(?<![A-Za-z0-9_])((?:NEXT_PUBLIC|VITE|EXPO_PUBLIC|PUBLIC|REACT_APP|NUXT_PUBLIC|GATSBY)_[A-Z0-9_]+)["']?\s*[:=]\s*["'`]?([^\s"'`,;]+)/g;
const SECRET_NAME = /SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|PASSWD|ADMIN_KEY|_TOKEN$/;
const MEANT_PUBLIC = /ANON|PUBLISHABLE|PUBLIC_KEY|_PK$|SITE_KEY|CLIENT_ID|MEASUREMENT_ID|_URL$/;
const PLACEHOLDER = /^(?:\$\{?[A-Z_]+\}?|<[^>]*>|x{3,}|\.{3}|changeme|your[-_].*|process\.env\..*|import\.meta\.env\..*|true|false|\d+)$/i;
const SERVER_PATH = /(?:^|\/)(?:supabase\/functions|server|api|pages\/api|app\/api|functions|backend|scripts|migrations)\/|\.server\.[cm]?[jt]sx?$|(?:^|\/)route\.[jt]s$|(?:^|\/)\.env[^/]*$/;
const CLIENT_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html)$/;

/** Secrets a browser would receive. → findings of type 'browser'. */
function browserFindings(lines, { salt, repo, turn = null, sessionId = null }) {
  const out = [];
  const seen = new Set();
  const push = (l, rule, kind, value, title, fix) => {
    const id = findingId(salt, [repo, 'browser', l.file, rule, value]);
    if (seen.has(id)) return; seen.add(id);
    const at = l.text.indexOf(value);
    out.push({ id, type: 'browser', kind, file: l.file, line: l.line, turn, sessionId, preview: at >= 0 ? lineWithRedaction(l.text, at, value.length) : '', rotate: rotateUrl(kind), title, fix });
  };
  for (const l of lines) {
    for (const m of l.text.matchAll(PUBLIC_NAME)) {
      const [, name, value] = m;
      if (PLACEHOLDER.test(value) || value.length < 8) continue;
      const hit = secretsIn(value)[0];
      const named = SECRET_NAME.test(name) && !MEANT_PUBLIC.test(name);
      if (!hit && !named && !serviceRole(value)) continue;
      if (publicKey(value)) continue;
      push(l, `public:${name}`, serviceRole(value) ? 'supabase_service_role' : hit?.kind ?? 'secret', value,
        `${name} is sent to every visitor's browser (${l.file}:${l.line})`,
        `Anything named ${/^(?:NEXT_PUBLIC|EXPO_PUBLIC|NUXT_PUBLIC|REACT_APP|[A-Z]+)_/.exec(name)[0]}… is copied into the website itself. Rename it without that prefix and only use it from server code, then make a new key because this one may already be public.`);
    }
    if (CLIENT_FILE.test(l.file) && !SERVER_PATH.test(l.file)) {
      for (const h of findSecrets(l.text, { classes: ['credential'] })) {
        const value = l.text.slice(h.index, h.index + h.length);
        if (!serviceRole(value)) continue;
        push(l, 'service-role-client', 'supabase_service_role', value,
          `The Supabase service_role key is in code that runs in the browser (${l.file}:${l.line})`,
          'This key skips every database rule. Use the anon or publishable key in the app, keep service_role on the server only, and make a new one in Supabase.');
      }
      if (/SUPABASE_SERVICE_ROLE/.test(l.text) && /(?:NEXT_PUBLIC|VITE|EXPO_PUBLIC|import\.meta\.env)/.test(l.text)) {
        push(l, 'service-role-env-client', 'supabase_service_role', 'SUPABASE_SERVICE_ROLE',
          `Browser code reads the Supabase service_role key (${l.file}:${l.line})`,
          'This key skips every database rule. Only read it in server code (API routes, edge functions).');
      }
    }
  }
  return out;
}

const DB_FILE = /(?:^|\/)supabase\/migrations\/[^/]+\.sql$|(?:^|\/)(?:firestore|storage)\.rules$/;
/** Database rules that look locked but aren't, in the lines a turn added. Per-repo opt-in is the caller's. */
function dbFindings(lines, { salt, repo, turn = null, sessionId = null }) {
  const out = [];
  const byFile = new Map();
  for (const l of lines) if (DB_FILE.test(l.file)) { if (!byFile.has(l.file)) byFile.set(l.file, []); byFile.get(l.file).push(l); }
  const add = (l, rule, title, fix) => out.push({ id: findingId(salt, [repo, 'db', l.file, rule]), type: 'db', kind: rule, file: l.file, line: l.line, turn, sessionId, preview: l.text.trim().slice(0, 160), title, fix });
  for (const [file, ls] of byFile) {
    if (file.endsWith('.sql')) {
      const all = ls.map((l) => l.text).join('\n');
      for (const l of ls) {
        if (/\b(?:using|with\s+check)\s*\(\s*true\s*\)/i.test(l.text)) add(l, `using-true:${l.text.trim().toLowerCase()}`, `A database rule lets anyone in (${file}:${l.line})`, 'USING (true) means every visitor passes, signed in or not. Check the row belongs to them instead, for example USING (auth.uid() = user_id).');
        if (/user_metadata/i.test(l.text)) add(l, `user-metadata:${l.text.trim().toLowerCase()}`, `A database rule trusts something users can change about themselves (${file}:${l.line})`, 'People can edit their own user_metadata, so they can give themselves access. Use app_metadata (only your server can set it) or a table of roles.');
        const t = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?((?:"?\w+"?\.)?"?(\w+)"?)/i.exec(l.text);
        if (t) {
          const name = t[2];
          const rls = new RegExp(`alter\\s+table\\s+(?:only\\s+)?(?:"?\\w+"?\\.)?"?${name}"?\\s+enable\\s+row\\s+level\\s+security`, 'i');
          if (!rls.test(all)) add(l, `no-rls:${name.toLowerCase()}`, `The new table ${name} has no access rules (${file}:${l.line})`, `Without row level security anyone with your public key can read and change every row. Add: ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY; and then a policy for who may see what.`);
        }
      }
    } else {
      for (const l of ls) {
        if (/\ballow\s+[a-z, ]+:\s*if\s+true\s*;?/i.test(l.text) || /\ballow\s+[a-z, ]+;\s*$/i.test(l.text.trim())) {
          add(l, `allow-true:${l.text.trim().toLowerCase()}`, `A ${file.includes('storage') ? 'storage' : 'database'} rule lets anyone in (${file}:${l.line})`, 'if true lets every visitor read or write. Check who they are instead, for example: allow read, write: if request.auth != null && request.auth.uid == userId;');
        }
        if (/token\.(?:name|email|picture)\b/.test(l.text) && /==/.test(l.text) && /admin|role/i.test(l.text)) {
          add(l, `profile-claim:${l.text.trim().toLowerCase()}`, `A rule trusts something users can change about themselves (${file}:${l.line})`, 'Profile fields can be edited by the user. Use a custom claim set by your server for roles.');
        }
      }
    }
  }
  return out;
}

const ENV_SAFE = /(?:^|\/)\.env\.(?:example|sample|template|defaults|dist)$/i;
const isEnvFile = (p) => /(?:^|\/)\.env(?:\.[\w.-]+)?$/.test(p) && !ENV_SAFE.test(p);
/** .env files git would share. tracked: in the index; exposed: untracked and not ignored. Names only. */
function envFindings({ tracked = [], exposed = [] }, { salt, repo }) {
  const out = [];
  for (const file of new Set(tracked.filter(isEnvFile))) out.push({ id: findingId(salt, [repo, 'env', file, 'tracked']), type: 'env', kind: 'tracked', file, line: null, preview: '', title: `${file} is saved in git`, fix: `Its secrets go wherever the code goes. Run: git rm --cached ${file}, add ${file.split('/').pop()} to .gitignore, and make new keys for anything in it if the repo was ever pushed.` });
  for (const file of new Set(exposed.filter(isEnvFile))) out.push({ id: findingId(salt, [repo, 'env', file, 'exposed']), type: 'env', kind: 'exposed', file, line: null, preview: '', title: `${file} is not in .gitignore`, fix: `The next "git add ." will save it in git. Add ${file.split('/').pop()} to .gitignore.` });
  return out;
}

// ── commands you can't take back ────────────────────────────────────────────
const SQL_DESTRUCTIVE = /\b(drop\s+(?:table|database|schema)(?:\s+if\s+exists)?\s+([\w."]+)|truncate\s+(?:table\s+)?([\w."]+))/i;
const DEPLOY = [
  [(c) => c.cmd === 'vercel' && c.args.some((a) => a === '--prod' || a === '--production'), 'production deploy (Vercel)'],
  [(c) => c.cmd === 'netlify' && c.args[0] === 'deploy' && c.args.includes('--prod'), 'production deploy (Netlify)'],
  [(c) => c.cmd === 'firebase' && c.args[0] === 'deploy', 'deploy (Firebase)'],
  [(c) => (c.cmd === 'fly' || c.cmd === 'flyctl') && c.args[0] === 'deploy', 'deploy (Fly.io)'],
  [(c) => c.cmd === 'railway' && c.args[0] === 'up', 'deploy (Railway)'],
  [(c) => c.cmd === 'supabase' && c.args[0] === 'db' && c.args[1] === 'push', 'push database changes to Supabase'],
  [(c) => c.cmd === 'eas' && (c.args[0] === 'submit' || (c.args[0] === 'update' && c.args.some((a) => /prod/.test(a)))), 'publish to app users (Expo)'],
];
const RESETS = [
  [(c) => c.cmd === 'supabase' && c.args[0] === 'db' && c.args[1] === 'reset', 'wipe the database (supabase db reset)', (c) => (c.args.includes('--linked') ? 'the linked (remote) database' : 'the local database')],
  [(c) => c.cmd === 'prisma' && c.args[0] === 'migrate' && c.args[1] === 'reset', 'wipe the database (prisma migrate reset)', () => 'the database in DATABASE_URL'],
  [(c) => c.cmd === 'prisma' && c.args[0] === 'db' && c.args[1] === 'push' && c.args.includes('--force-reset'), 'wipe the database (prisma db push --force-reset)', () => 'the database in DATABASE_URL'],
  [(c) => (c.cmd === 'drizzle-kit' || c.cmd === 'rails' || c.cmd === 'rake') && c.args.some((a) => /^(drop|db:drop|db:reset)$/.test(a)), 'drop the database', () => 'the database'],
];
// npx prisma …, pnpm dlx supabase …, bunx … → the tool itself.
function unwrap(c) {
  if (/^(npx|bunx|pnpx)$/.test(c.cmd) || ((c.cmd === 'pnpm' || c.cmd === 'yarn') && c.args[0] === 'dlx') || (c.cmd === 'npm' && c.args[0] === 'exec')) {
    const rest = c.args.slice(c.cmd === 'npx' || c.cmd === 'bunx' || c.cmd === 'pnpx' ? 0 : 1).filter((a) => !a.startsWith('-'));
    if (rest.length) return { ...c, cmd: rest[0].replace(/@.*$/, ''), args: c.args.slice(c.args.indexOf(rest[0]) + 1) };
  }
  return c;
}
const short = (s) => (s.length > 120 ? `${s.slice(0, 117)}…` : s);

/** One permission request's tool call → {shape, target} when it can't be taken back, else null. */
function destructive(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const texts = SHELL_TOOLS.test(String(toolName ?? '')) ? stringsIn(Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'description'))) : [];
  for (const text of texts) {
    let cmds = [];
    try { cmds = parseShell(text).cmds.map(unwrap); } catch { cmds = []; }
    for (const c of cmds) {
      if (c.cmd === 'rm' && shellFinding(`rm ${c.args.join(' ')}`, 'rm-recursive') && c.args.some((a) => /^-[a-zA-Z]*f/.test(a) || a === '--force')) {
        return { shape: 'delete folders for good (rm -rf)', target: short(c.args.filter((a) => !a.startsWith('-')).join(' ') || 'unknown') };
      }
      if (c.cmd === 'git') {
        const line = `git ${c.args.join(' ')}`;
        const push = shellFinding(line, 'git-force-push');
        if (push && /force/.test(push.reason)) return { shape: 'overwrite history on GitHub (git push --force)', target: short(c.args.filter((a) => !a.startsWith('-') && a !== 'push').join(' ') || 'the current branch') };
        const d = shellFinding(line, 'git-destructive');
        if (d && /reset --hard|clean -f/.test(d.reason)) return { shape: d.reason === 'git reset --hard' ? 'throw away unsaved changes (git reset --hard)' : 'delete untracked files (git clean -f)', target: short(c.args.filter((a) => !a.startsWith('-') && !/^(reset|clean)$/.test(a)).join(' ') || 'all uncommitted work') };
      }
      for (const [match, shape, target] of RESETS) if (match(c)) return { shape, target: target(c) };
      for (const [match, shape] of DEPLOY) if (match(c)) return { shape, target: 'production (people using your app)' };
    }
  }
  // SQL from any tool (psql -c, an execute_sql MCP tool, a migration being written).
  for (const t of stringsIn(input)) {
    const m = SQL_DESTRUCTIVE.exec(t);
    if (m) return { shape: /^truncate/i.test(m[1]) ? 'delete every row (TRUNCATE)' : `delete a ${/database/i.test(m[1]) ? 'database' : /schema/i.test(m[1]) ? 'schema' : 'table'} and its data (DROP)`, target: short((m[2] || m[3] || '').replace(/"/g, '')) };
  }
  return null;
}

/**
 * Merges a scan into the stored findings for one scope (repo + types scanned).
 * New ids come in as 'new'; ids already known keep their state; ids in scope
 * that the scan no longer finds become 'resolved' (scope: `files` when given,
 * else the whole repo). Dismissed stays dismissed.
 */
function reconcile(stored, scanned, { repo, types, files = null, now = Date.now() }) {
  const next = { ...stored };
  const found = new Set();
  for (const f of scanned) {
    found.add(f.id);
    const prev = stored[f.id];
    if (!prev || prev.status === 'resolved') next[f.id] = { ...f, repo, status: 'new', firstSeen: prev?.firstSeen ?? now, lastSeen: now };
    else next[f.id] = { ...prev, ...f, repo, status: prev.status, turn: prev.turn ?? f.turn, lastSeen: now };
  }
  for (const [id, f] of Object.entries(stored)) {
    if (f.repo !== repo || !types.includes(f.type) || found.has(id) || (files && !files.has(f.file))) continue;
    if (f.status === 'new' || f.status === 'open') next[id] = { ...f, status: 'resolved', resolvedAt: now };
  }
  return next;
}

module.exports = { addedLines, secretFindings, browserFindings, dbFindings, envFindings, destructive, reconcile, findingId, redact, jwtRole, publicKey, isEnvFile, kindName, rotateUrl, DB_FILE };
