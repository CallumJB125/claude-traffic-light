// Hub configuration from the environment. Every variable is documented in
// hub/README.md; keep the two in sync.

import { isIP } from 'node:net'; // privacy-flow: local-board-sockets
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStorageMax, validateStorageMax } from './storage-watch.js';
import { r2Config } from './sync-store.js';

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
    dbSizeMaxMb: parseStorageMax(env.DB_SIZE_MAX_MB),
    auth,
    accessTeam: env.BOARD_ACCESS_TEAM || null,
    accessAud: env.BOARD_ACCESS_AUD || null,
    publicUrl: env.BOARD_PUBLIC_URL || null,
    trustCfIp: flag(env.BOARD_TRUST_CF_IP),
    resendApiKey: env.BOARD_RESEND_API_KEY || null,
    mailFrom: env.BOARD_MAIL_FROM || null,
    mailProvider: env.BOARD_MAIL_PROVIDER || null,
    sesRegion: env.BOARD_SES_REGION || null,
    // Raw, so a stray value without BOARD_MAIL_PROVIDER=ses is caught; 'display' is applied where it is used.
    sesFromFormat: env.BOARD_SES_FROM_FORMAT || null,
    downloadUrl: env.BOARD_DOWNLOAD_URL || null,
    consoleMailer: flag(env.BOARD_CONSOLE_MAILER),
    // Email one-time-code sign-in is off unless asked for: a mailer configured for invites never turns it on.
    emailSignin: flag(env.BOARD_EMAIL_SIGNIN),
    signinMethods: (env.BOARD_SIGNIN_METHODS || '').split(',').map((s) => s.trim()).filter(Boolean),
    signup: env.BOARD_SIGNUP || null,
    googleClientId: env.BOARD_GOOGLE_CLIENT_ID || null,
    googleClientSecret: env.BOARD_GOOGLE_CLIENT_SECRET || null,
    githubClientId: env.BOARD_GITHUB_CLIENT_ID || null,
    githubClientSecret: env.BOARD_GITHUB_CLIENT_SECRET || null,
    googleWebClientId: env.BOARD_GOOGLE_WEB_CLIENT_ID || null,
    githubWebClientId: env.BOARD_GITHUB_WEB_CLIENT_ID || null,
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
    // Paid plans (board/hub/billing/): off unless a provider is named; price ids are public, the keys below are hidden.
    billingProvider: env.BOARD_BILLING_PROVIDER || null,
    billingPrices: {
      'plus:month': env.BOARD_BILLING_PRICE_PLUS_MONTH || null, 'plus:year': env.BOARD_BILLING_PRICE_PLUS_YEAR || null,
      'team:month': env.BOARD_BILLING_PRICE_TEAM_MONTH || null, 'team:year': env.BOARD_BILLING_PRICE_TEAM_YEAR || null,
    },
    entitlementKeyFile: env.BOARD_ENTITLEMENT_KEY_FILE ? resolve(env.BOARD_ENTITLEMENT_KEY_FILE) : null,
    // Encrypted sync (sync.js): off unless an R2 bucket is named; the object keys below are hidden.
    syncR2Endpoint: env.BOARD_SYNC_R2_ENDPOINT || null,
    syncR2Bucket: env.BOARD_SYNC_R2_BUCKET || null,
  };
  // Non-enumerable, so JSON.stringify, util.inspect and spreads of the config never carry them.
  const hidden = (value) => ({ value, enumerable: false, writable: false, configurable: false });
  Object.defineProperties(cfg, {
    googleWebClientSecret: hidden(env.BOARD_GOOGLE_WEB_CLIENT_SECRET || null),
    githubWebClientSecret: hidden(env.BOARD_GITHUB_WEB_CLIENT_SECRET || null),
    sesAccessKeyId: hidden(env.BOARD_SES_ACCESS_KEY_ID || null),
    sesSecretAccessKey: hidden(env.BOARD_SES_SECRET_ACCESS_KEY || null),
    sesSessionToken: hidden(env.BOARD_SES_SESSION_TOKEN || null),
    secret: hidden(env.BOARD_SECRET || null),
    // Who may sign up is the operator's business: never in a log line or a dump of the config.
    signupAllow: hidden(env.BOARD_SIGNUP_ALLOW || null),
    billingApiKey: hidden(env.BOARD_BILLING_API_KEY || null),
    billingWebhookSecret: hidden(env.BOARD_BILLING_WEBHOOK_SECRET || null),
    syncR2AccessKeyId: hidden(env.BOARD_SYNC_R2_ACCESS_KEY_ID || null),
    syncR2SecretAccessKey: hidden(env.BOARD_SYNC_R2_SECRET_ACCESS_KEY || null),
  });
  // Only from the real environment (nothing started later inherits them); a test's env object stays as given.
  if (env === process.env) {
    delete env.BOARD_SECRET;
    delete env.BOARD_SIGNUP_ALLOW;
  }
  delete env.BOARD_SES_SECRET_ACCESS_KEY;
  delete env.BOARD_SES_SESSION_TOKEN;
  delete env.BOARD_LOCAL_SECRET;
  delete env.BOARD_RESEND_API_KEY;
  delete env.BOARD_GOOGLE_CLIENT_SECRET;
  delete env.BOARD_GITHUB_CLIENT_SECRET;
  delete env.BOARD_GOOGLE_WEB_CLIENT_SECRET;
  delete env.BOARD_GITHUB_WEB_CLIENT_SECRET;
  delete env.BOARD_BILLING_API_KEY;
  delete env.BOARD_BILLING_WEBHOOK_SECRET;
  delete env.BOARD_SYNC_R2_ACCESS_KEY_ID;
  delete env.BOARD_SYNC_R2_SECRET_ACCESS_KEY;
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
export const PRINTABLE_256 = /^[\x21-\x7e]{1,256}$/;
export const PRINTABLE_4096 = /^[\x21-\x7e]{1,4096}$/;
// ASCII only, dot-atom local part, hostname labels: what SES takes, with no
// room for a parsing differential between the hub and SES (no quoted local
// part, comment or address literal).
const MAIL_ADDRESS = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
// A From display name: plain atext and spaces (RFC 2047 encoded words fit), or one quoted string without quotes or backslashes inside.
const DISPLAY_NAME = /^(?:[A-Za-z0-9!#$%&'*+\/=?^_`{|}~ -]*| *"[\x20\x21\x23-\x5b\x5d-\x7e]*" *)$/;
const NAME_ADDR = /^([^<>]*)<([^<>]+)>$/;

/** The mailer the config asks for: 'resend', 'ses' or null. Unset BOARD_MAIL_PROVIDER keeps D66: Resend when its key is set. */
export function mailProvider(cfg) {
  if (cfg.mailProvider) return cfg.mailProvider;
  return cfg.resendApiKey ? 'resend' : null;
}

export function isMailAddress(s) {
  if (typeof s !== 'string' || s.length > 254 || !MAIL_ADDRESS.test(s)) return false;
  const local = s.slice(0, s.indexOf('@'));
  return !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
}

/** False when a `Name <addr>` From has a name SES and mail clients might read differently (not plain ASCII, not one clean quoted string). */
export function isDisplayName(from) {
  const m = NAME_ADDR.exec(from);
  return !m || DISPLAY_NAME.test(m[1]);
}

/**
 * SES FromEmailAddress for BOARD_MAIL_FROM, or null when unusable. 'display'
 * sends it as given (after checking the address and the name); 'bare' only the
 * address inside "Name <addr>", for an IAM ses:FromAddress condition that may
 * compare against the bare address.
 */
export function sesFromAddress(from, format) {
  if (typeof from !== 'string' || !from || from.length > 320 || /[\p{C}\u2028\u2029]/u.test(from)) return null;
  if (format !== 'display' && format !== 'bare') return null;
  if (!from.includes('<') && !from.includes('>')) return isMailAddress(from) ? from : null;
  const m = NAME_ADDR.exec(from);
  if (!m || !isMailAddress(m[2])) return null;
  if (format === 'bare') return m[2];
  return isDisplayName(from) ? from : null;
}

// Fixed texts only: a value here may be a credential.
function validateMail(cfg) {
  const sesSet = cfg.sesRegion || cfg.sesAccessKeyId || cfg.sesSecretAccessKey || cfg.sesSessionToken || cfg.sesFromFormat;
  if (cfg.mailProvider && !MAIL_PROVIDERS.includes(cfg.mailProvider)) throw new Error(`BOARD_MAIL_PROVIDER takes ${MAIL_PROVIDERS.join(' or ')}`);
  if (sesSet && cfg.mailProvider !== 'ses') throw new Error('BOARD_SES_* is set but BOARD_MAIL_PROVIDER is not ses');
  if (cfg.mailProvider === 'resend' && !cfg.resendApiKey) throw new Error('BOARD_MAIL_PROVIDER=resend needs BOARD_RESEND_API_KEY');
  if (cfg.mailProvider === 'ses' && cfg.resendApiKey) throw new Error('BOARD_RESEND_API_KEY is set but BOARD_MAIL_PROVIDER is ses');
  if (cfg.mailProvider !== 'ses') return;
  if (!cfg.sesRegion || !cfg.sesAccessKeyId || !cfg.sesSecretAccessKey) throw new Error('BOARD_MAIL_PROVIDER=ses needs BOARD_SES_REGION, BOARD_SES_ACCESS_KEY_ID and BOARD_SES_SECRET_ACCESS_KEY');
  if (!cfg.mailFrom) throw new Error('BOARD_MAIL_PROVIDER=ses needs BOARD_MAIL_FROM');
  if (typeof cfg.sesRegion !== 'string' || !SES_REGION.test(cfg.sesRegion)) throw new Error('BOARD_SES_REGION must look like af-south-1');
  if (typeof cfg.sesAccessKeyId !== 'string' || !SES_ACCESS_KEY_ID.test(cfg.sesAccessKeyId)) throw new Error('BOARD_SES_ACCESS_KEY_ID is not an AWS access key id');
  if (typeof cfg.sesSecretAccessKey !== 'string' || !PRINTABLE_256.test(cfg.sesSecretAccessKey)) throw new Error('BOARD_SES_SECRET_ACCESS_KEY must be 1 to 256 printable characters');
  if (cfg.sesSessionToken != null && (typeof cfg.sesSessionToken !== 'string' || !PRINTABLE_4096.test(cfg.sesSessionToken))) throw new Error('BOARD_SES_SESSION_TOKEN must be 1 to 4096 printable characters');
  const format = cfg.sesFromFormat ?? 'display';
  if (format !== 'display' && format !== 'bare') throw new Error('BOARD_SES_FROM_FORMAT takes display or bare');
  if (format === 'display' && typeof cfg.mailFrom === 'string' && !isDisplayName(cfg.mailFrom)) throw new Error('BOARD_MAIL_FROM display name must be plain ASCII or RFC 2047 words');
  if (!sesFromAddress(cfg.mailFrom, format)) throw new Error('BOARD_MAIL_FROM is not a usable From address');
}

export const SIGNIN_METHODS = Object.freeze(['google', 'github']);

// What hub.env.example ships with: an accounts hub refuses to start on any of it.
export const PLACEHOLDER = /change-me|replace-with|example|placeholder/i;
const EXAMPLE_DOMAIN = /(^|\.)example\.(com|org|net)\.?$/i;
// Every other credential an accounts hub reads, checked only when set.
const SECRET_VARS = Object.freeze([
  ['BOARD_SES_ACCESS_KEY_ID', 'sesAccessKeyId'], ['BOARD_SES_SECRET_ACCESS_KEY', 'sesSecretAccessKey'], ['BOARD_SES_SESSION_TOKEN', 'sesSessionToken'],
  ['BOARD_RESEND_API_KEY', 'resendApiKey'], ['BOARD_GOOGLE_CLIENT_SECRET', 'googleClientSecret'], ['BOARD_GITHUB_CLIENT_SECRET', 'githubClientSecret'],
  ['BOARD_GITHUB_TOKEN', 'githubToken'],
  ['BOARD_GOOGLE_WEB_CLIENT_SECRET', 'googleWebClientSecret'], ['BOARD_GITHUB_WEB_CLIENT_SECRET', 'githubWebClientSecret'],
  ['BOARD_BILLING_API_KEY', 'billingApiKey'], ['BOARD_BILLING_WEBHOOK_SECRET', 'billingWebhookSecret'],
  ['BOARD_SYNC_R2_ACCESS_KEY_ID', 'syncR2AccessKeyId'], ['BOARD_SYNC_R2_SECRET_ACCESS_KEY', 'syncR2SecretAccessKey'],
]);

export const SIGNUP_MODES = Object.freeze(['open', 'allowlist']);
const SIGNUP_ALLOW_MAX_CHARS = 8192;
const SIGNUP_ALLOW_MAX_ENTRIES = 256;
const DOMAIN_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * BOARD_SIGNUP / BOARD_SIGNUP_ALLOW (D104) → {mode, domains, emails}. Entries
 * take the stored-address normalisation (NFKC, trimmed, lower-cased); a
 * domain matches only itself, never a sub-domain or a longer name. Fixed
 * texts only: the list is never repeated.
 */
export function signupPolicy(cfg) {
  const mode = cfg.signup ?? 'allowlist';
  if (!SIGNUP_MODES.includes(mode)) throw new Error('BOARD_SIGNUP takes open or allowlist');
  const raw = cfg.signupAllow ?? '';
  if (typeof raw !== 'string') throw new Error('BOARD_SIGNUP_ALLOW must be a comma list');
  const entries = raw.split(',').map((e) => e.normalize('NFKC').trim().toLowerCase()).filter(Boolean);
  if (raw.length > SIGNUP_ALLOW_MAX_CHARS || entries.length > SIGNUP_ALLOW_MAX_ENTRIES) throw new Error(`BOARD_SIGNUP_ALLOW is too long (at most ${SIGNUP_ALLOW_MAX_CHARS} characters and ${SIGNUP_ALLOW_MAX_ENTRIES} entries)`);
  const domains = new Set();
  const emails = new Set();
  for (const e of entries) {
    const m = /^(domain|email):(.*)$/.exec(e);
    if (!m) throw new Error('BOARD_SIGNUP_ALLOW entries are domain:<domain> or email:<address>, comma-separated');
    const v = m[2].trim();
    if (m[1] === 'domain') {
      if (!DOMAIN_NAME.test(v)) throw new Error('BOARD_SIGNUP_ALLOW has a domain: entry that is not a domain name');
      domains.add(v);
    } else {
      if (!isMailAddress(v)) throw new Error('BOARD_SIGNUP_ALLOW has an email: entry that is not an address');
      emails.add(v);
    }
  }
  return { mode, domains, emails };
}

/** The OAuth providers this hub can sign in with: both the client id and its secret are set (D76). */
export function oauthProviders(cfg) {
  return SIGNIN_METHODS.filter((p) => cfg[`${p}ClientId`] && cfg[`${p}ClientSecret`]);
}

/** Browser sign-in has separate credentials and a fixed configured callback origin. */
export function webOauthProviders(cfg) {
  return cfg.publicUrl ? SIGNIN_METHODS.filter((p) => cfg[`${p}WebClientId`] && cfg[`${p}WebClientSecret`]) : [];
}

// BOARD_AUTH=accounts (D51, D66): the hub runs its own sign-in. Exposed, it
// must be https behind cloudflared (per-IP limits key on CF-Connecting-IP,
// trusted only from a loopback peer) with at least one sign-in method; the
// email code is optional (only with a real mailer and BOARD_EMAIL_SIGNIN=1) and the console mailer is
// never allowed there. Without a public URL it is a loopback try-out, and only
// with BOARD_ACCOUNTS_DEV=1.
function validateAccounts(cfg) {
  const loop = isLoopback(cfg.bind);
  if (!cfg.secret) throw new Error('BOARD_AUTH=accounts needs BOARD_SECRET (at least 32 bytes)');
  if (PLACEHOLDER.test(cfg.secret)) throw new Error('BOARD_SECRET still has its example placeholder: set a real secret (openssl rand -base64 48)');
  for (const [name, key] of SECRET_VARS) {
    if (typeof cfg[key] === 'string' && PLACEHOLDER.test(cfg[key])) throw new Error(`${name} still has an example placeholder: set the real value`);
  }
  let url = null;
  if (cfg.publicUrl) {
    try { url = new URL(cfg.publicUrl); } catch { throw new Error(`BOARD_PUBLIC_URL is not a URL: ${cfg.publicUrl}`); }
    if (EXAMPLE_DOMAIN.test(url.hostname)) throw new Error('BOARD_PUBLIC_URL still names an example host: set the address people reach this hub at');
  }
  for (const provider of SIGNIN_METHODS) {
    const id = cfg[`${provider}WebClientId`]; const secret = cfg[`${provider}WebClientSecret`];
    if (!!id !== !!secret) throw new Error(`BOARD_${provider.toUpperCase()}_WEB_CLIENT_ID and _SECRET must both be set`);
    if (id && (!url || url.username || url.password || url.pathname !== '/' || url.search || url.hash)) throw new Error('browser OAuth needs an origin-only BOARD_PUBLIC_URL without credentials, path, query or fragment');
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
  const signup = signupPolicy(cfg);
  if ([...signup.domains, ...[...signup.emails].map((e) => e.slice(e.lastIndexOf('@') + 1))].some((d) => EXAMPLE_DOMAIN.test(d))) {
    throw new Error('BOARD_SIGNUP_ALLOW still has an example.com/.org/.net entry: list your own domains and addresses');
  }
  if (cfg.consoleMailer && (exposed || !loop)) throw new Error('BOARD_CONSOLE_MAILER is for a loopback hub that is not exposed');
  if (exposed) {
    if (url?.protocol !== 'https:') throw new Error('an exposed BOARD_AUTH=accounts hub (BOARD_PUBLIC_URL off loopback, or BOARD_TUNNEL_PROBE_URL) needs an https BOARD_PUBLIC_URL');
    if (!cfg.trustCfIp) throw new Error('an exposed BOARD_AUTH=accounts hub needs BOARD_TRUST_CF_IP=1 (cloudflared on loopback), so per-IP limits see the client');
    if (!(mailProvider(cfg) && cfg.emailSignin) && !methods.length && !oauthProviders(cfg).length && !webOauthProviders(cfg).length) throw new Error('an exposed BOARD_AUTH=accounts hub needs a sign-in method: BOARD_GOOGLE_CLIENT_ID/_SECRET, BOARD_GITHUB_CLIENT_ID/_SECRET, BOARD_GOOGLE_WEB_CLIENT_ID/_SECRET, BOARD_GITHUB_WEB_CLIENT_ID/_SECRET, BOARD_SIGNIN_METHODS (google, github) or BOARD_EMAIL_SIGNIN=1 with a mailer (BOARD_RESEND_API_KEY + BOARD_MAIL_FROM, or BOARD_MAIL_PROVIDER=ses with BOARD_SES_*)');
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
  validateStorageMax(cfg.dbSizeMaxMb);
  if (!['access', 'dev', 'local', 'accounts'].includes(cfg.auth)) throw new Error(`BOARD_AUTH must be access, dev or local (or accounts), got ${cfg.auth}`);
  if (cfg.auth === 'accounts') validateAccounts(cfg);
  if (cfg.billingProvider != null) {
    if (cfg.billingProvider !== 'stripe') throw new Error(`BOARD_BILLING_PROVIDER must be stripe, got ${cfg.billingProvider}`);
    if (cfg.auth !== 'accounts') throw new Error('BOARD_BILLING_PROVIDER needs BOARD_AUTH=accounts');
    if (!cfg.billingApiKey || !cfg.billingWebhookSecret) throw new Error('BOARD_BILLING_PROVIDER needs BOARD_BILLING_API_KEY and BOARD_BILLING_WEBHOOK_SECRET');
  }
  if (cfg.syncR2Bucket != null) {
    if (cfg.auth !== 'accounts') throw new Error('BOARD_SYNC_R2_BUCKET needs BOARD_AUTH=accounts');
    if (!cfg.syncR2Endpoint || !cfg.syncR2AccessKeyId || !cfg.syncR2SecretAccessKey) throw new Error('BOARD_SYNC_R2_BUCKET needs BOARD_SYNC_R2_ENDPOINT, BOARD_SYNC_R2_ACCESS_KEY_ID and BOARD_SYNC_R2_SECRET_ACCESS_KEY');
    r2Config({ endpoint: cfg.syncR2Endpoint, bucket: cfg.syncR2Bucket, accessKeyId: cfg.syncR2AccessKeyId, secretAccessKey: cfg.syncR2SecretAccessKey });
  }
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
