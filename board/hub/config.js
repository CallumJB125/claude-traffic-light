// Hub configuration from the environment. Every variable is documented in
// hub/README.md; keep the two in sync.

import { isIP } from 'node:net'; // privacy-flow: local-board-sockets
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const int = (v, d) => {
  if (v == null || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got ${v}`);
  return n;
};
const flag = (v) => v === '1' || v === 'true' || v === 'yes';

const LOCAL_BINDS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopback(host) {
  if (host === 'localhost') return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  if (isIP(host) === 6) return host === '::1' || host === '0:0:0:0:0:0:0:1';
  return false;
}

export function loadConfig(env = process.env) {
  const auth = env.BOARD_AUTH || 'access';
  const dataDir = env.BOARD_DATA_DIR ? resolve(env.BOARD_DATA_DIR) : resolve(HERE, 'data');
  const cfg = {
    bind: env.BOARD_BIND || '127.0.0.1',
    port: int(env.BOARD_PORT, 8787),
    dataDir,
    dbPath: env.BOARD_DB ? resolve(env.BOARD_DB) : join(dataDir, 'board.db'),
    auth,
    accessTeam: env.BOARD_ACCESS_TEAM || null,
    accessAud: env.BOARD_ACCESS_AUD || null,
    secret: env.BOARD_SECRET || null,
    publicUrl: env.BOARD_PUBLIC_URL || null,
    trustCfIp: flag(env.BOARD_TRUST_CF_IP),
    resendApiKey: env.BOARD_RESEND_API_KEY || null,
    mailFrom: env.BOARD_MAIL_FROM || null,
    mailProvider: env.BOARD_MAIL_PROVIDER || null,
    sesRegion: env.BOARD_SES_REGION || null,
    sesFromFormat: env.BOARD_SES_FROM_FORMAT || 'display',
    downloadUrl: env.BOARD_DOWNLOAD_URL || null,
    consoleMailer: flag(env.BOARD_CONSOLE_MAILER),
    signinMethods: (env.BOARD_SIGNIN_METHODS || '').split(',').map((s) => s.trim()).filter(Boolean),
    googleClientId: env.BOARD_GOOGLE_CLIENT_ID || null,
    googleClientSecret: env.BOARD_GOOGLE_CLIENT_SECRET || null,
    githubClientId: env.BOARD_GITHUB_CLIENT_ID || null,
    githubClientSecret: env.BOARD_GITHUB_CLIENT_SECRET || null,
    accountsDev: flag(env.BOARD_ACCOUNTS_DEV),
    authFailBudget: int(env.BOARD_AUTH_FAIL_BUDGET, 20),
    mailDailyCap: int(env.BOARD_MAIL_DAILY_CAP, 2000),
    devSeed: flag(env.BOARD_DEV_SEED),
    devRepo: env.BOARD_DEV_REPO || null,
    devLoginSecret: env.BOARD_DEV_LOGIN_SECRET || null,
    localSecret: env.BOARD_LOCAL_SECRET || null,
    bootstrap: env.BOARD_BOOTSTRAP || null,
    bootstrapBoard: env.BOARD_BOOTSTRAP_BOARD || (auth === 'local' ? 'Me:ME' : 'Team:BRD'),
    restore: flag(env.BOARD_RESTORE),
    tunnelProbeUrl: env.BOARD_TUNNEL_PROBE_URL || null,
    tunnelProbeMs: int(env.BOARD_TUNNEL_PROBE_MS, 15_000),
    githubToken: env.BOARD_GITHUB_TOKEN || null,
    githubApi: env.BOARD_GITHUB_API || 'https://api.github.com',
    githubPollMs: int(env.BOARD_GITHUB_POLL_MS, 60_000),
    webDir: env.BOARD_WEB_DIR ? resolve(env.BOARD_WEB_DIR) : resolve(HERE, '..', 'web'),
    sharedDir: resolve(HERE, '..', 'shared'),
    logLevel: env.BOARD_LOG_LEVEL || 'info',
    shutdownGraceMs: int(env.BOARD_SHUTDOWN_GRACE_MS, 5_000),
    ...(env.BOARD_WEBHOOK_READ_MS ? { webhookReads: { deadlineMs: int(env.BOARD_WEBHOOK_READ_MS, 3_000) } } : {}),
  };
  // Non-enumerable, so JSON.stringify, util.inspect and spreads of the config never carry them.
  const hidden = (value) => ({ value, enumerable: false, writable: false, configurable: false });
  Object.defineProperties(cfg, {
    sesAccessKeyId: hidden(env.BOARD_SES_ACCESS_KEY_ID || null),
    sesSecretAccessKey: hidden(env.BOARD_SES_SECRET_ACCESS_KEY || null),
    sesSessionToken: hidden(env.BOARD_SES_SESSION_TOKEN || null),
  });
  delete env.BOARD_SES_SECRET_ACCESS_KEY;
  delete env.BOARD_SES_SESSION_TOKEN;
  delete env.BOARD_LOCAL_SECRET;
  delete env.BOARD_RESEND_API_KEY;
  delete env.BOARD_GOOGLE_CLIENT_SECRET;
  delete env.BOARD_GITHUB_CLIENT_SECRET;
  validateConfig(cfg);
  return cfg;
}

// Reachable from outside: a BOARD_PUBLIC_URL naming a non-loopback host, or a tunnel probe.
export function isExposed(cfg) {
  if (cfg.tunnelProbeUrl) return true;
  if (!cfg.publicUrl) return false;
  try { return !isLoopback(new URL(cfg.publicUrl).hostname.replace(/^\[|\]$/g, '')); } catch { return true; }
}

export const MAIL_PROVIDERS = Object.freeze(['resend', 'ses']);
export const SES_REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]$/;
export const SES_ACCESS_KEY_ID = /^[A-Z0-9]{16,128}$/;
export const SES_SECRET = /^[\x21-\x7e]{1,256}$/;
export const SES_SESSION_TOKEN = /^[\x21-\x7e]{1,4096}$/;
const MAIL_ADDRESS = /^[^\s@<>,;"'\p{C}]+@[^\s@<>,;"'\p{C}]+$/u;

/** The mailer the config asks for: 'resend', 'ses' or null. Unset BOARD_MAIL_PROVIDER keeps D66: Resend when its key is set. */
export function mailProvider(cfg) {
  if (cfg.mailProvider) return cfg.mailProvider;
  return cfg.resendApiKey ? 'resend' : null;
}

export function isMailAddress(s) {
  return typeof s === 'string' && s.length <= 254 && MAIL_ADDRESS.test(s);
}

/**
 * SES FromEmailAddress for BOARD_MAIL_FROM, or null when unusable. 'display'
 * sends it as given; 'bare' only the address inside "Name <addr>", for an IAM
 * ses:FromAddress condition that may compare against the bare address.
 */
export function sesFromAddress(from, format) {
  if (typeof from !== 'string' || !from || from.length > 320 || /[\p{C}\u2028\u2029]/u.test(from)) return null;
  if (format === 'display') return from;
  if (format !== 'bare') return null;
  if (!from.includes('<') && !from.includes('>')) return isMailAddress(from) ? from : null;
  const m = /^[^<>]*<([^<>]+)>$/.exec(from);
  return m && isMailAddress(m[1]) ? m[1] : null;
}

// Fixed texts only: a value here may be a credential.
function validateMail(cfg) {
  const sesSet = cfg.sesRegion || cfg.sesAccessKeyId || cfg.sesSecretAccessKey || cfg.sesSessionToken;
  if (cfg.mailProvider && !MAIL_PROVIDERS.includes(cfg.mailProvider)) throw new Error(`BOARD_MAIL_PROVIDER takes ${MAIL_PROVIDERS.join(' or ')}`);
  if (sesSet && cfg.mailProvider !== 'ses') throw new Error('BOARD_SES_* is set but BOARD_MAIL_PROVIDER is not ses');
  if (cfg.mailProvider === 'resend' && !cfg.resendApiKey) throw new Error('BOARD_MAIL_PROVIDER=resend needs BOARD_RESEND_API_KEY');
  if (cfg.mailProvider !== 'ses') return;
  if (!cfg.sesRegion || !cfg.sesAccessKeyId || !cfg.sesSecretAccessKey) throw new Error('BOARD_MAIL_PROVIDER=ses needs BOARD_SES_REGION, BOARD_SES_ACCESS_KEY_ID and BOARD_SES_SECRET_ACCESS_KEY');
  if (!cfg.mailFrom) throw new Error('BOARD_MAIL_PROVIDER=ses needs BOARD_MAIL_FROM');
  if (typeof cfg.sesRegion !== 'string' || !SES_REGION.test(cfg.sesRegion)) throw new Error('BOARD_SES_REGION must look like af-south-1');
  if (typeof cfg.sesAccessKeyId !== 'string' || !SES_ACCESS_KEY_ID.test(cfg.sesAccessKeyId)) throw new Error('BOARD_SES_ACCESS_KEY_ID is not an AWS access key id');
  if (typeof cfg.sesSecretAccessKey !== 'string' || !SES_SECRET.test(cfg.sesSecretAccessKey)) throw new Error('BOARD_SES_SECRET_ACCESS_KEY must be 1 to 256 printable characters');
  if (cfg.sesSessionToken != null && (typeof cfg.sesSessionToken !== 'string' || !SES_SESSION_TOKEN.test(cfg.sesSessionToken))) throw new Error('BOARD_SES_SESSION_TOKEN must be 1 to 4096 printable characters');
  const format = cfg.sesFromFormat ?? 'display';
  if (format !== 'display' && format !== 'bare') throw new Error('BOARD_SES_FROM_FORMAT takes display or bare');
  if (!sesFromAddress(cfg.mailFrom, format)) throw new Error('BOARD_MAIL_FROM is not a usable From address');
}

export const SIGNIN_METHODS = Object.freeze(['google', 'github']);

/** The OAuth providers this hub can sign in with: both the client id and its secret are set (D76). */
export function oauthProviders(cfg) {
  return SIGNIN_METHODS.filter((p) => cfg[`${p}ClientId`] && cfg[`${p}ClientSecret`]);
}

// BOARD_AUTH=accounts (D51, D66): the hub runs its own sign-in. Exposed, it
// must be https behind cloudflared (per-IP limits key on CF-Connecting-IP,
// trusted only from a loopback peer) with at least one sign-in method; the
// email code is optional (only with a real mailer) and the console mailer is
// never allowed there. Without a public URL it is a loopback try-out, and only
// with BOARD_ACCOUNTS_DEV=1.
function validateAccounts(cfg) {
  const loop = isLoopback(cfg.bind);
  if (!cfg.secret) throw new Error('BOARD_AUTH=accounts needs BOARD_SECRET (at least 32 bytes)');
  let url = null;
  if (cfg.publicUrl) {
    try { url = new URL(cfg.publicUrl); } catch { throw new Error(`BOARD_PUBLIC_URL is not a URL: ${cfg.publicUrl}`); }
  }
  const exposed = isExposed(cfg);
  if (!url && !(loop && cfg.accountsDev)) throw new Error('BOARD_AUTH=accounts needs BOARD_PUBLIC_URL (only a loopback bind with BOARD_ACCOUNTS_DEV=1 may do without)');
  if (!loop && url?.protocol !== 'https:') throw new Error('BOARD_AUTH=accounts needs an https BOARD_PUBLIC_URL (only a loopback bind may do without)');
  if (url && url.protocol !== 'https:' && !isLoopback(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('BOARD_PUBLIC_URL must be https unless it names a loopback host');
  if (cfg.trustCfIp && !loop) throw new Error('BOARD_TRUST_CF_IP needs a loopback bind (cloudflared on the same host is the only ingress)');
  if (cfg.resendApiKey && !cfg.mailFrom) throw new Error('BOARD_RESEND_API_KEY needs BOARD_MAIL_FROM');
  validateMail(cfg);
  const methods = cfg.signinMethods ?? [];
  const bad = methods.filter((m) => !SIGNIN_METHODS.includes(m));
  if (bad.length) throw new Error(`BOARD_SIGNIN_METHODS takes ${SIGNIN_METHODS.join(', ')} (got ${bad.join(', ')})`);
  if (cfg.consoleMailer && (exposed || !loop)) throw new Error('BOARD_CONSOLE_MAILER is for a loopback hub that is not exposed');
  if (exposed) {
    if (url?.protocol !== 'https:') throw new Error('an exposed BOARD_AUTH=accounts hub (BOARD_PUBLIC_URL off loopback, or BOARD_TUNNEL_PROBE_URL) needs an https BOARD_PUBLIC_URL');
    if (!cfg.trustCfIp) throw new Error('an exposed BOARD_AUTH=accounts hub needs BOARD_TRUST_CF_IP=1 (cloudflared on loopback), so per-IP limits see the client');
    if (!mailProvider(cfg) && !methods.length && !oauthProviders(cfg).length) throw new Error('an exposed BOARD_AUTH=accounts hub needs a sign-in method: BOARD_GOOGLE_CLIENT_ID/_SECRET, BOARD_GITHUB_CLIENT_ID/_SECRET, BOARD_SIGNIN_METHODS (google, github) or a mailer (BOARD_RESEND_API_KEY + BOARD_MAIL_FROM, or BOARD_MAIL_PROVIDER=ses with BOARD_SES_*)');
  }
  if (cfg.devSeed || cfg.bootstrap?.includes(',')) throw new Error('BOARD_AUTH=accounts takes BOARD_BOOTSTRAP=<email> only, and no BOARD_DEV_SEED');
  if (cfg.authFailBudget != null && (!Number.isInteger(cfg.authFailBudget) || cfg.authFailBudget < 1 || cfg.authFailBudget > 100)) throw new Error('BOARD_AUTH_FAIL_BUDGET must be an integer from 1 to 100');
  if (cfg.mailDailyCap != null && (!Number.isInteger(cfg.mailDailyCap) || cfg.mailDailyCap < 1)) throw new Error('BOARD_MAIL_DAILY_CAP must be a positive integer');
  if (cfg.downloadUrl) {
    let d;
    try { d = new URL(cfg.downloadUrl); } catch { throw new Error(`BOARD_DOWNLOAD_URL is not a URL: ${cfg.downloadUrl}`); }
    if (d.protocol !== 'https:') throw new Error('BOARD_DOWNLOAD_URL must be https');
  }
}

export function validateConfig(cfg) {
  if (!['access', 'dev', 'local', 'accounts'].includes(cfg.auth)) throw new Error(`BOARD_AUTH must be access, dev or local (or accounts), got ${cfg.auth}`);
  if (cfg.auth === 'accounts') validateAccounts(cfg);
  // Local = the hub embedded in the desktop app: only its own window may reach it.
  if (cfg.auth === 'local') {
    if (!LOCAL_BINDS.has(cfg.bind)) throw new Error(`BOARD_AUTH=local needs BOARD_BIND=127.0.0.1, ::1 or localhost (got ${cfg.bind})`);
    if (cfg.publicUrl || cfg.tunnelProbeUrl) throw new Error('BOARD_AUTH=local must never sit behind a proxy or tunnel: unset BOARD_PUBLIC_URL and BOARD_TUNNEL_PROBE_URL');
    if (cfg.devSeed) throw new Error('BOARD_AUTH=local does not take BOARD_DEV_SEED');
  }
  if (cfg.localSecret != null && process.parentPort) throw new Error('BOARD_LOCAL_SECRET is for tests only: the desktop app generates its own per-launch secret');
  if (cfg.localSecret != null && cfg.auth !== 'local') throw new Error('BOARD_LOCAL_SECRET needs BOARD_AUTH=local');
  if (cfg.localSecret != null && Buffer.byteLength(cfg.localSecret) < 32) throw new Error('BOARD_LOCAL_SECRET must be at least 32 bytes');
  if (cfg.devSeed && cfg.auth !== 'dev') throw new Error('BOARD_DEV_SEED needs BOARD_AUTH=dev');
  if (cfg.auth === 'dev' && !isLoopback(cfg.bind)) throw new Error(`BOARD_AUTH=dev is allowed only on a loopback bind (BOARD_BIND=${cfg.bind})`);
  // Behind a proxy or tunnel every request arrives from loopback, so the
  // loopback check on /api/dev/login proves nothing there: refuse outright.
  if (cfg.auth === 'dev' && cfg.trustCfIp) throw new Error('BOARD_AUTH=dev must never sit behind a proxy or tunnel: unset BOARD_TRUST_CF_IP');
  if (cfg.auth === 'dev' && (cfg.publicUrl || cfg.tunnelProbeUrl)) throw new Error('BOARD_AUTH=dev must never sit behind a proxy or tunnel: unset BOARD_PUBLIC_URL and BOARD_TUNNEL_PROBE_URL, or use BOARD_AUTH=access');
  if (cfg.devLoginSecret != null && Buffer.byteLength(cfg.devLoginSecret) < 16) throw new Error('BOARD_DEV_LOGIN_SECRET must be at least 16 bytes');
  if (cfg.auth === 'access' && (!cfg.accessTeam || !cfg.accessAud)) throw new Error('BOARD_AUTH=access needs BOARD_ACCESS_TEAM and BOARD_ACCESS_AUD');
  if (cfg.secret != null && Buffer.byteLength(cfg.secret) < 32) throw new Error('BOARD_SECRET must be at least 32 bytes');
  return cfg;
}
