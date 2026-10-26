'use strict';

// Carries the user's own Claude provider and auth into Plexiform-started Claude
// runs (lab finding T3). Reads through user-provider.cjs, runs the user's
// helpers itself (key-helper.cjs), and answers two shapes:
//   mode 'bash'   a run with a Bash tool (board runs, Tasks, takeover): D26,
//                 no secret is reachable from a tool shell. Routing goes into the
//                 run's settings `env`; a key goes only to <run>/api.key behind
//                 `apiKeyHelper: /bin/cat <file>`; anything else is refused.
//   mode 'notool' a one-shot or chat child with no shell: keys go in its env.
// Never used for hosted runs (the hub config is their only source). prepare()
// never throws and never puts a value in a reason.
const fs = require('node:fs');
const net = require('node:net'); // privacy-flow: gateway-probe
const os = require('node:os');
const path = require('node:path');
const {
  claudeProvider, boundedReadFile, readDirOrNull, CLAUDE_READ_NAMES, CLAUDE_JSON_MAX_BYTES, CONFIG_TOML_MAX_BYTES,
} = require('./user-provider.cjs');
const { runUserCommand } = require('./key-helper.cjs');

const PROBE_MS = 2000;
// Burst's default listens: 7777 is its Claude gateway; 7779 its Codex gateway (real capture of `claude-burst codex
// enable`, board/shared/test/fixtures/codex-config/burst-codex-enable.redacted.toml).
const BURST_GATEWAY_PORT = 7777;
const BURST_CODEX_GATEWAY_PORT = 7779;
const DEFAULT_TTL_MS = 5 * 60_000;
const NOT_LOGGED_IN = 'Claude is not logged in. Run claude in a terminal and sign in with /login, then resume.';
const OAUTH_TOKEN_NOTE = " (a CLAUDE_CODE_OAUTH_TOKEN in your shell doesn't reach runs yet)";
// Lab 2026-10-26 (dogfood-lab/fixtures/proc-environ-read.md): Read refuses /proc itself, but Grep follows an in-tree
// symlink to /proc/self/environ and returns the CLI's launch env, one regex at a time. A Read deny rule covers Grep too,
// because the check resolves the symlink. So every generated Claude settings file denies /proc, and a key never rides the
// launch env of a child that has any file tool.
const PROC_RULES = ['Read', 'Grep', 'Glob'].flatMap((t) => [`${t}(//proc/**)`, `${t}(/proc/**)`]);
// Not passed to the CLI: Plexiform's own refresh timer reads it.
const NOT_FOR_CLI = new Set(['CLAUDE_CODE_API_KEY_HELPER_TTL_MS']);
const CLOUD = new Set(['bedrock', 'vertex', 'foundry']);

// "Move it to X" for a secret that can't travel to a run that has a shell.
const MOVE_IT = {
  secret_in_routing: 'Put the credential in apiKeyHelper (a command that prints the key) in your Claude settings.',
  secret_custom_headers: 'Put the credential in ANTHROPIC_AUTH_TOKEN or apiKeyHelper in your Claude settings.',
  secret_bedrock_token: 'Use an AWS profile (AWS_PROFILE with a credentials file) or apiKeyHelper instead.',
};
const BLOCKING_ALWAYS = new Set(['claude_settings_unreadable', 'path_var_relative']);

function tcpProbe({ host, port, timeoutMs = PROBE_MS, connect = net.connect }) { // privacy-flow: gateway-probe
  return new Promise((resolve) => {
    let done = false;
    let sock;
    const finish = (ok) => { if (!done) { done = true; try { sock?.destroy(); } catch { /* gone */ } resolve(ok); } };
    try { sock = connect({ host, port }); } catch { return finish(false); }
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.on('connect', () => finish(true));
    sock.on('error', () => finish(false));
  });
}

// Burst owns a loopback port when it is installed (its binary is in place) and the port is its gateway's.
async function burstOwnsPort(port, { home = os.homedir(), platform = process.platform, burstPort = BURST_GATEWAY_PORT } = {}) {
  if (platform !== 'darwin' || port !== burstPort) return false;
  try { fs.accessSync(path.join(home, '.local', 'bin', 'claude-burst'), fs.constants.X_OK); return true; } catch { return false; }
}

function writeSecretFile(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, value, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ }
    throw e;
  }
}

const EMPTY = Object.freeze({ carry: false, failure: null, settingsEnv: {}, cliEnv: {}, apiKeyFile: null, model: null, oneShotModel: 'haiku', childEnv: {}, denyRead: [], disallowed: [] });

// Permission rules (leading "//" = absolute) for every path a run's file tools must not touch.
function denyRules(paths) {
  return ['Read', 'Edit', 'Write'].flatMap((t) => paths.flatMap((p) => [`${t}(/${p})`, `${t}(/${p}/**)`]));
}

function createClaudeCarry({
  env = process.env, home = os.homedir(), platform = process.platform,
  loginShellEnv = null,     // seam for PR 1b (src/login-shell-env.js): async ({ names }) => ({ [name]: value })
  readFile = (file) => boundedReadFile(file, file.endsWith('.claude.json') ? CLAUDE_JSON_MAX_BYTES : CONFIG_TOML_MAX_BYTES),
  readDir = (dir) => readDirOrNull(dir),
  runCommand = runUserCommand, probe = tcpProbe,
  burstOwnsPort: burstOwns = (port) => burstOwnsPort(port, { home, platform }),
  credentialsExist = null,             // (configDir) => boolean; default only knows Linux
  log = () => {}, setInterval: setTimer = setInterval, clearInterval: clearTimer = clearInterval,
} = {}) {
  const fail = (kind, reason) => ({ ...EMPTY, carry: true, failure: { kind, reason } });

  async function resolveWith() {
    let loginEnv = {};
    if (typeof loginShellEnv === 'function') {
      try { loginEnv = (await loginShellEnv({ names: [...CLAUDE_READ_NAMES, 'CLAUDE_CODE_OAUTH_TOKEN'] })) || {}; } catch { loginEnv = {}; }
    }
    return { provider: claudeProvider({ env, loginEnv, home, platform, readFile, readDir }), loginEnv };
  }
  const resolve = async () => (await resolveWith()).provider;

  // A successful helper result is reused for the helper's TTL; any failure drops it.
  let helperCache = null;
  const ttlOf = (routing) => {
    const ttl = Number(routing.CLAUDE_CODE_API_KEY_HELPER_TTL_MS);
    return routing.CLAUDE_CODE_API_KEY_HELPER_TTL_MS !== undefined && Number.isFinite(ttl) ? ttl : DEFAULT_TTL_MS;
  };
  async function runHelper(cmdOpts, command, ttl) {
    if (helperCache && helperCache.command === command && ttl > 0 && Date.now() - helperCache.at < ttl) return { ok: true, output: helperCache.output };
    const r = await runCommand({ ...cmdOpts, command, label: 'key helper' });
    if (r.ok && r.output) helperCache = { command, output: r.output, at: Date.now() };
    else helperCache = null;
    return r;
  }

  const hasCredentials = (configDir) => {
    if (credentialsExist) return credentialsExist(configDir);
    if (platform !== 'linux') return true; // macOS keeps the login in the keychain: unknown, so don't guess
    try { return fs.existsSync(path.join(configDir, '.credentials.json')); } catch { return true; }
  };

  /**
   * opts.mode 'bash' | 'chat' | 'notool'. 'chat' is a writable owned chat: no shell but file tools, so it
   * gets the 'bash' treatment (key file, no secret in env) plus /proc rules.
   * opts.keyFile: where a 'bash' or 'chat' run's api.key goes (inside a private run dir).
   * → { carry, failure:{kind:'auth'|'provider', reason}|null, settingsEnv, cliEnv, apiKeyFile, model,
   *     oneShotModel, childEnv, denyRead, disallowed, release() }
   * carry:false = nothing to carry (the caller behaves as it did before).
   */
  async function prepare({ mode, keyFile = null } = {}) {
    let provider, loginEnv;
    try { ({ provider, loginEnv } = await resolveWith()); } catch { return { ...EMPTY, release() {} }; }
    if (!provider.carry) {
      if (provider.carryOffReason === 'managed_settings_unreadable') return withRelease(fail('provider', "your organisation's Claude settings could not be read"));
      return { ...EMPTY, release() {} };
    }
    const bash = mode === 'bash' || mode === 'chat';
    const a = provider.auth;

    for (const u of provider.unsupported) {
      if (BLOCKING_ALWAYS.has(u.code)) return withRelease(fail('provider', u.message));
      if (u.code === 'claude_global_config_unreadable' && a.secretName === 'ANTHROPIC_API_KEY') return withRelease(fail('provider', `${u.message}, so a key you declined can't be ruled out`));
      if (bash && MOVE_IT[u.code]) return withRelease(fail('provider', `${u.message}. ${MOVE_IT[u.code]}`));
    }
    if (bash && a.awsCredentialExport && a.awsCredentialExportOrigin !== 'managed') {
      return withRelease(fail('provider', 'awsCredentialExport can\'t be passed to a run that has a shell. Use an AWS profile (AWS_PROFILE with a credentials file) instead.'));
    }

    const routing = provider.routing;
    const cmdOpts = { home, env, platform, extraEnv: { ...routing, ...provider.pathVars } };

    // The user's awsAuthRefresh, once, from $HOME (its output is not used).
    if (a.awsAuthRefresh && CLOUD.has(a.kind)) {
      const r = await runCommand({ ...cmdOpts, command: a.awsAuthRefresh, label: 'aws auth refresh' });
      if (!r.ok) return withRelease(fail('auth', r.reason));
    }

    let key = null;
    let helperCommand = null;
    if (a.kind === 'helper' && !a.managedHelper) {
      helperCommand = a.helper;
      const r = await runHelper(cmdOpts, helperCommand, ttlOf(routing));
      if (!r.ok) return withRelease(fail('auth', r.reason));
      if (!r.output) return withRelease(fail('auth', 'key helper returned nothing'));
      key = r.output;
    } else if (a.secret) key = a.secret;

    // Reachability of every gateway: a bare TCP connect, so no key, header or URL path is ever sent.
    // (An unreachable base URL otherwise burns about three minutes inside the CLI before it fails.)
    const gateways = provider.gateways || (provider.localGateway ? [provider.localGateway] : []);
    for (const { host, port } of gateways) {
      if (await probe({ host, port, timeoutMs: PROBE_MS })) continue;
      const local = provider.localGateway && provider.localGateway.host === host && provider.localGateway.port === port;
      let burst = false;
      if (local) { try { burst = (await burstOwns(port)) === true; } catch { burst = false; } }
      return withRelease(fail('provider', burst ? "Burst gateway isn't running" : `the gateway at ${host}:${port} isn't answering`));
    }

    // Runs only: a run that starts without any login burns minutes before it fails; a one-shot just returns 'failed'.
    if (mode === 'bash' && a.kind === 'oauth-or-none' && !routing.ANTHROPIC_BASE_URL && !hasCredentials(provider.configDir)) {
      const tokenSet = !!(env.CLAUDE_CODE_OAUTH_TOKEN || (loginEnv && loginEnv.CLAUDE_CODE_OAUTH_TOKEN));
      return withRelease(fail('auth', tokenSet ? NOT_LOGGED_IN.replace(/, then resume\.$/, `${OAUTH_TOKEN_NOTE}, then resume.`) : NOT_LOGGED_IN));
    }

    const customDir = provider.configDir !== path.join(home, '.claude');
    const denyRead = [...provider.denyRead, ...(customDir ? [provider.configDir] : [])];
    const out = {
      ...EMPTY, carry: true, model: provider.model, denyRead, disallowed: [...denyRules(denyRead), ...(bash ? PROC_RULES : [])],
      oneShotModel: oneShotModel(provider),
    };
    const routingForCli = Object.fromEntries(Object.entries(routing).filter(([k]) => !NOT_FOR_CLI.has(k)));
    const timers = [];
    let fileWritten = null;
    let released = false;

    if (bash) {
      out.settingsEnv = routingForCli;
      if (customDir) out.cliEnv = { CLAUDE_CONFIG_DIR: provider.configDir };
      if (key && keyFile) {
        try { writeSecretFile(keyFile, key); } catch { return withRelease(fail('provider', "the run's key file could not be written")); }
        fileWritten = keyFile;
        out.apiKeyFile = keyFile;
        const every = ttlOf(routing);
        if (helperCommand && every > 0) {
          let busy = false;
          const t = setTimer(async () => {
            if (busy) return;
            busy = true;
            try {
              const r = await runCommand({ ...cmdOpts, command: helperCommand, label: 'key helper' });
              if (released) return;
              if (r.ok && r.output) {
                helperCache = { command: helperCommand, output: r.output, at: Date.now() };
                writeSecretFile(keyFile, r.output);
                if (released) fs.rmSync(keyFile, { force: true });
              } else { helperCache = null; log('key helper refresh failed'); }
            } catch { log('key helper refresh failed'); } finally { busy = false; }
          }, every);
          t.unref?.();
          timers.push(t);
        }
      }
    } else {
      const childEnv = { ...routingForCli };
      if (customDir) childEnv.CLAUDE_CONFIG_DIR = provider.configDir;
      Object.assign(childEnv, provider.noToolSecrets);
      if (a.kind === 'helper' && !a.managedHelper && key) {
        childEnv.ANTHROPIC_API_KEY = key;
        childEnv.ANTHROPIC_AUTH_TOKEN = key;
      } else if (a.secretName && a.secret) childEnv[a.secretName] = a.secret;
      if (a.awsCredentialExport && a.awsCredentialExportOrigin !== 'managed') {
        const r = await runCommand({ ...cmdOpts, command: a.awsCredentialExport, label: 'aws credential export' });
        if (!r.ok) return withRelease(fail('auth', r.reason));
        const c = parseCredentials(r.output);
        if (!c) return withRelease(fail('auth', 'aws credential export did not print AWS credentials'));
        Object.assign(childEnv, c);
      }
      out.childEnv = childEnv;
    }

    out.release = () => {
      released = true;
      for (const t of timers) clearTimer(t);
      timers.length = 0;
      if (fileWritten) { try { fs.rmSync(fileWritten, { force: true }); } catch { /* gone */ } fileWritten = null; }
    };
    return out;
  }

  const withRelease = (r) => ({ ...r, release() {} });
  return { prepare, resolve };
}

// The model a no-tool one-shot asks for when its default is `haiku`: on a gateway or cloud provider
// that has no haiku, follow ANTHROPIC_DEFAULT_HAIKU_MODEL → ANTHROPIC_SMALL_FAST_MODEL → the user's model.
function oneShotModel(provider) {
  const custom = !!provider.routing.ANTHROPIC_BASE_URL || CLOUD.has(provider.auth.kind);
  return custom ? (provider.smallModel || 'haiku') : 'haiku';
}

function parseCredentials(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const c = j && typeof j === 'object' ? (j.Credentials || j.credentials || j) : null;
  const id = c?.AccessKeyId, secret = c?.SecretAccessKey;
  if (typeof id !== 'string' || typeof secret !== 'string' || !id || !secret) return null;
  return { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret, ...(typeof c.SessionToken === 'string' && c.SessionToken ? { AWS_SESSION_TOKEN: c.SessionToken } : {}) };
}

// Deletes api.key and Codex's codex-provider.key / codex-takeover.key (and a half-written *.tmp of any) from every <runRoot>/<id>/
// except those `keep(id)` names.
// For a start after a crash: carry state is in memory, so a key left on disk would otherwise stay forever.
function sweepKeyFiles(runRoot, keep = () => false) {
  let ids;
  try { ids = fs.readdirSync(runRoot); } catch { return 0; }
  let n = 0;
  for (const id of ids) {
    if (keep(id)) continue;
    let names;
    try { names = fs.readdirSync(path.join(runRoot, id)); } catch { continue; }
    for (const f of names) {
      if (f !== 'api.key' && f !== 'codex-provider.key' && f !== 'codex-takeover.key' && !/^(?:api|codex-provider|codex-takeover)\.key\..*\.tmp$/.test(f)) continue;
      try { fs.rmSync(path.join(runRoot, id, f), { force: true }); n++; } catch { /* gone */ }
    }
  }
  return n;
}

// The carry the app's own processes use. Under the no-real-cli guard (tests) there is none, so a test
// that starts an entry point never reads the developer's Claude files or runs their key helper.
function productionCarry(opts = {}) {
  if (globalThis.__plexiformNoRealCli) return null;
  return createClaudeCarry({ env: process.env, ...opts });
}

module.exports = { PROC_RULES, createClaudeCarry, productionCarry, sweepKeyFiles, burstOwnsPort, BURST_GATEWAY_PORT, BURST_CODEX_GATEWAY_PORT, denyRules, tcpProbe, oneShotModel, NOT_LOGGED_IN, PROBE_MS };
