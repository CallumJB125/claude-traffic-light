#!/usr/bin/env node
// Read-only preflight for the Access -> accounts hub cutover (docs/CUTOVER.md).
//   node scripts/cutover-preflight.mjs <hub.env> [--db /path/to/board.db]
// Parses the env file (nothing is exported, nothing is sent anywhere), runs the
// hub's own accounts-mode validation against it, and lists risks. Exit 0 = no
// blocking errors (risks may remain), 1 = the hub would refuse to start, 2 = usage.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, signupPolicy } from '../board/hub/config.js';

const PUBLIC_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'yahoo.com', 'proton.me', 'protonmail.com', 'aol.com']);

export function parseEnv(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    env[m[1]] = v;
  }
  return env;
}

/** -> { errors: string[], risks: string[] }. `env` is a plain object (never process.env); secret values are never echoed. */
export function preflight(env) {
  const errors = [];
  const risks = [];
  const has = (k) => env[k] != null && env[k] !== '';
  if (env.BOARD_AUTH !== 'accounts') errors.push(`BOARD_AUTH is ${env.BOARD_AUTH ? `"${env.BOARD_AUTH}"` : 'unset (defaults to access)'}: set BOARD_AUTH=accounts`);
  if (!has('BOARD_ENC_KEY') && !has('BOARD_ENC_KEY_FILE')) risks.push('no BOARD_ENC_KEY or BOARD_ENC_KEY_FILE: stored integration secrets have no key');
  if (has('BOARD_ENC_KEY_FILE') && !existsSync(env.BOARD_ENC_KEY_FILE)) risks.push(`BOARD_ENC_KEY_FILE ${env.BOARD_ENC_KEY_FILE} does not exist on this machine (fine if you are checking a copy off the host)`);
  if (env.BOARD_AUTH === 'accounts') {
    const copy = { ...env };
    try { loadConfig(copy); } catch (e) { errors.push(`hub would refuse to start: ${e.message}`); }
  }
  if (has('BOARD_ACCESS_TEAM') || has('BOARD_ACCESS_AUD')) risks.push('BOARD_ACCESS_* still set: unused in accounts mode, remove them so nobody assumes Access is in front');
  if (!has('BOARD_TUNNEL_PROBE_URL')) risks.push('BOARD_TUNNEL_PROBE_URL unset: the hub will not self-probe through the tunnel (set it to <BOARD_PUBLIC_URL>/api/health once Access is removed)');
  if (has('BOARD_BOOTSTRAP')) risks.push('BOARD_BOOTSTRAP is set: remove it after the first start (it only seeds an empty database)');
  if (env.BOARD_RESTORE === '1' || env.BOARD_RESTORE === 'true') risks.push('BOARD_RESTORE is set: it bumps every card fence on start; remove it unless this start is a restore');
  if (has('BOARD_DEV_LOGIN_SECRET') || has('BOARD_DEV_SEED') || has('BOARD_ACCOUNTS_DEV') || has('BOARD_CONSOLE_MAILER')) risks.push('a BOARD_DEV_* / BOARD_ACCOUNTS_DEV / BOARD_CONSOLE_MAILER variable is set: development settings do not belong on the production host');
  if (env.BOARD_EMAIL_SIGNIN === '1' && env.BOARD_MAIL_PROVIDER === 'ses') risks.push('email-code sign-in over SES: in the SES sandbox only verified addresses receive codes');
  const signup = env.BOARD_SIGNUP || 'allowlist';
  if (signup === 'open') risks.push('BOARD_SIGNUP=open: anyone with a Google/GitHub account can create an account and a team. Google consent in Testing mode additionally limits sign-in to listed test users (see docs/CUTOVER.md)');
  else if (signup === 'allowlist') {
    let policy = null;
    try { policy = signupPolicy({ signup, signupAllow: env.BOARD_SIGNUP_ALLOW ?? '' }); } catch { /* reported by loadConfig above */ }
    if (policy) {
      if (!policy.domains.size && !policy.emails.size) risks.push('BOARD_SIGNUP=allowlist with an empty BOARD_SIGNUP_ALLOW: only invites and Access-era member rows can sign up');
      for (const d of policy.domains) if (PUBLIC_MAIL.has(d)) risks.push(`BOARD_SIGNUP_ALLOW has domain:${d}, a public mail provider: that admits everyone with such an address`);
    }
  }
  if ((has('BOARD_GOOGLE_CLIENT_ID') || has('BOARD_GOOGLE_WEB_CLIENT_ID')) && signup !== 'open') risks.push('Google sign-in is on: if the OAuth consent screen is in Testing mode only its listed test users (max 100) can sign in, whatever BOARD_SIGNUP_ALLOW says');
  if (has('BOARD_PUBLIC_URL') && /^http:/i.test(env.BOARD_PUBLIC_URL)) risks.push('BOARD_PUBLIC_URL is http: OAuth redirects and invite links need https');
  return { errors, risks };
}

/** Access-era member rows no account has claimed. Opens the file read-only. */
export function unclaimedMembers(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const cols = db.prepare('PRAGMA table_info(members)').all().map((c) => c.name);
    if (!cols.includes('user_id')) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM members WHERE removed_at IS NULL').get().n;
      return { migrated: false, rows: [], total: n };
    }
    const rows = db.prepare('SELECT email, role, github_login FROM members WHERE user_id IS NULL AND removed_at IS NULL ORDER BY email').all();
    return { migrated: true, rows: rows.map((r) => ({ email: r.email, role: r.role, github_login: r.github_login })), total: rows.length };
  } finally { db.close(); }
}

function main(argv) {
  const args = argv.slice();
  let dbPath = null;
  const i = args.indexOf('--db');
  if (i >= 0) { dbPath = args[i + 1]; args.splice(i, 2); }
  if (args.length !== 1 || (i >= 0 && !dbPath)) { process.stderr.write('usage: cutover-preflight.mjs <hub.env> [--db /path/to/board.db]\n'); return 2; }
  let text;
  try { text = readFileSync(args[0], 'utf8'); } catch (e) { process.stderr.write(`cannot read ${args[0]}: ${e.code ?? e.message}\n`); return 2; }
  const { errors, risks } = preflight(parseEnv(text));
  const out = (s) => process.stdout.write(`${s}\n`);
  for (const e of errors) out(`ERROR  ${e}`);
  for (const r of risks) out(`RISK   ${r}`);
  if (dbPath) {
    if (!existsSync(dbPath)) { out(`ERROR  no database at ${dbPath}`); errors.push('no database'); }
    else {
      try {
        const m = unclaimedMembers(dbPath);
        if (!m.migrated) out(`INFO   database predates accounts (migration 009 runs at first start): ${m.total} active member row(s) will all be unclaimed; each counts as an invite until its owner signs in`);
        else {
          out(`INFO   ${m.total} unclaimed Access-era member row(s); each can sign up (counts as an invite): review or revoke before exposing the hostname`);
          for (const r of m.rows) out(`       ${r.email ?? '(no email)'}  role=${r.role}  github=${r.github_login}`);
        }
      } catch (e) { out(`ERROR  cannot read ${dbPath}: ${e.message}`); errors.push('db unreadable'); }
    }
  }
  out(errors.length ? `FAIL   ${errors.length} blocking error(s), ${risks.length} risk(s)` : `OK     no blocking errors, ${risks.length} risk(s) to review`);
  return errors.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
