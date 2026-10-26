'use strict';

// What the user's own Claude Code / Codex setup says about routing and auth,
// reduced to a closed allowlist. Pure: no spawn, no network, no logging, no
// process.env or os.homedir(). All file access goes through the injected
// readFile (and readDir for the managed drop-in folder). Reader contract:
// null = missing, a throw = unreadable. Callers pass a size-bounded reader
// (see boundedReadFile); this module caps config.toml only after reading it. Results carry values
// only in routing, pathVars, auth.secret, noToolSecrets and cliEnv.
const path = require('node:path');
const { parse } = require('smol-toml');
const { findSecrets } = require('./secret-patterns.mjs');

const CLAUDE_ROUTING_KEYS = Object.freeze([
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
  'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_BASE_URL',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE',
  'API_TIMEOUT_MS',
  // Read by PR 2's key helper; never passed to the CLI.
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
]);
const VERTEX_REGION_PREFIX = 'VERTEX_REGION_';
const CLAUDE_PATH_KEYS = Object.freeze(['AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'GOOGLE_APPLICATION_CREDENTIALS']);
const CLAUDE_SECRET_KEYS = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK']);
const CLAUDE_READ_NAMES = Object.freeze([...CLAUDE_ROUTING_KEYS, ...CLAUDE_PATH_KEYS, ...CLAUDE_SECRET_KEYS, 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']);

const CODEX_TOP_KEYS = Object.freeze(['profile', 'model_provider', 'model', 'profiles', 'model_providers']);
// Verify against the pinned codex before PR 3 relies on it.
const CODEX_PROVIDER_FIELDS = Object.freeze(['name', 'base_url', 'wire_api', 'env_key', 'env_key_instructions', 'env_http_headers', 'query_params', 'requires_openai_auth', 'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms']);
const CODEX_BUILTIN_PROVIDER_IDS = Object.freeze(['openai', 'oss', 'ollama', 'lmstudio']);
// Provider id Burst writes for `claude-burst codex enable` (fixture reconstructed from the Burst binary).
const BURST_CODEX_MARKERS = Object.freeze(['claude-burst']);
const CONFIG_TOML_MAX_BYTES = 262144;
const CLAUDE_JSON_MAX_BYTES = 16 * 1024 * 1024;

const MANAGED_DIRS = { darwin: '/Library/Application Support/ClaudeCode', linux: '/etc/claude-code', win32: 'C:\\Program Files\\ClaudeCode' };
const ROUTING = new Set(CLAUDE_ROUTING_KEYS);
const PATH_KEYS = new Set(CLAUDE_PATH_KEYS);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_HEADER_NAME = /auth|key|token|secret|cookie/i;
const SECRET_QUERY_NAME = /key|token|secret|sig|auth|passw|pwd|credential/i;
const TRUTHY = /^(1|true|yes|on)$/i;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);
const flavor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

function expandHome(value, home, p) {
  if (value === '~') return home;
  if (value.startsWith('~/') || (p === path.win32 && value.startsWith('~\\'))) return p.join(home, value.slice(2));
  return value;
}

// A value that must not travel as routing: a known secret shape, URL userinfo, or a credential-named query parameter.
function secretish(value) {
  if (typeof value !== 'string') return false;
  if (findSecrets(value).length) return true;
  let u;
  try { u = new URL(value); } catch { return false; }
  if (u.username || u.password) return true;
  for (const k of u.searchParams.keys()) if (SECRET_QUERY_NAME.test(k)) return true;
  return false;
}

function readJson(readFile, file, unsupported, code = 'claude_settings_unreadable') {
  let text;
  try { text = readFile(file); } catch {
    unsupported.push({ code, message: `${file} could not be read` });
    return null;
  }
  if (text == null) return null;
  try {
    const v = JSON.parse(text);
    if (isObj(v)) return v;
  } catch { /* fall through */ }
  unsupported.push({ code, message: `${file} is not valid JSON` });
  return null;
}

// Bounded reader for the injected readFile: null when missing, throws on other errors, and never
// returns more than maxBytes + 1 bytes (so the config.toml cap still trips). Loops over short reads.
// Use the default for config.toml and settings files; pass CLAUDE_JSON_MAX_BYTES for ~/.claude.json,
// which the CLI grows with every project (a truncated read there reports as unreadable).
function boundedReadFile(file, maxBytes = CONFIG_TOML_MAX_BYTES, fs = require('node:fs')) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
    throw e;
  }
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buf.length) {
      const n = fs.readSync(fd, buf, total, buf.length - total, total);
      if (n === 0) break;
      total += n;
    }
    return buf.toString('utf8', 0, total);
  } finally { fs.closeSync(fd); }
}

// readDir for managed-settings.d: null when the folder is missing, a throw otherwise (which fails closed).
function readDirOrNull(dir, fs = require('node:fs')) {
  try { return fs.readdirSync(dir); } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
    throw e;
  }
}

function localGatewayOf(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch { return null; }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host !== 'localhost' && host !== '::1' && !/^127\.\d+\.\d+\.\d+$/.test(host)) return null;
  return { host, port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80 };
}

// Every gateway host:port the run would talk to (probed with a bare connect, nothing sent).
function gatewaysOf(routing) {
  const out = [];
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL']) {
    if (!routing[k]) continue;
    let u;
    try { u = new URL(routing[k]); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    if (!out.some((g) => g.host === host && g.port === port)) out.push({ host, port });
  }
  return out;
}

function blankClaude(base, carryOffReason, unsupported = []) {
  return {
    ...base, carry: false, carryOffReason, sources: [], notes: [], routing: {}, pathVars: {}, model: null, smallModel: null,
    auth: { kind: 'oauth-or-none', secret: null, secretName: null, helper: null, awsAuthRefresh: null, awsCredentialExport: null, rejected: false, origin: null },
    noToolSecrets: {}, localGateway: null, gateways: [], denyRead: [], unsupported, dropped: [],
  };
}

function claudeProvider({ env = {}, loginEnv = {}, home, platform, readFile, readDir = () => null }) {
  const p = flavor(platform);
  const unsupported = [];
  const managedDir = MANAGED_DIRS[platform] || null;
  const configDirSet = env.CLAUDE_CONFIG_DIR || loginEnv.CLAUDE_CONFIG_DIR || '';
  const configDir = expandHome(configDirSet || p.join(home, '.claude'), home, p);
  const base = { configDir, managedDir };

  if (!managedDir) return blankClaude(base, 'platform_unsupported');
  if (!p.isAbsolute(configDir)) {
    return blankClaude(base, 'claude_config_dir_relative', [{ code: 'claude_config_dir_relative', message: 'CLAUDE_CONFIG_DIR is not an absolute path' }]);
  }

  // Managed: the base file, then the drop-in folder in name order, later files overriding earlier ones.
  // (Drop-in order is the CLI's, to be re-verified against the pinned version.)
  const managedPath = p.join(managedDir, 'managed-settings.json');
  const managedFiles = [managedPath];
  let dropIns = null;
  const unsupportedBefore = unsupported.length;
  try { dropIns = readDir(p.join(managedDir, 'managed-settings.d')); } catch { unsupported.push({ code: 'claude_settings_unreadable', message: 'managed-settings.d could not be listed' }); }
  for (const n of [...(Array.isArray(dropIns) ? dropIns : [])].filter((f) => typeof f === 'string' && f.endsWith('.json')).sort()) managedFiles.push(p.join(managedDir, 'managed-settings.d', n));
  const managed = { env: {} };
  let managedSeen = false;
  for (const f of managedFiles) {
    const j = readJson(readFile, f, unsupported);
    if (!j) continue;
    managedSeen = true;
    for (const k of ['model', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport']) if (str(j[k]) != null) managed[k] = str(j[k]);
    if (isObj(j.env)) Object.assign(managed.env, j.env);
  }

  // An unreadable company policy must not be bypassed by carrying the user's own routing.
  if (unsupported.length > unsupportedBefore) return blankClaude(base, 'managed_settings_unreadable', unsupported);

  const userPath = p.join(configDir, 'settings.json');
  const user = readJson(readFile, userPath, unsupported);
  const claudeJsonPath = p.join(configDirSet ? configDir : home, '.claude.json');
  const claudeJson = readJson(readFile, claudeJsonPath, unsupported, 'claude_global_config_unreadable');

  const layers = [
    { kind: 'managed', path: managedSeen ? managedPath : null, env: managed.env, top: managed },
    { kind: 'user', path: user ? userPath : null, env: isObj(user?.env) ? user.env : {}, top: user || {} },
    { kind: 'global-config', path: claudeJson ? claudeJsonPath : null, env: isObj(claudeJson?.env) ? claudeJson.env : {}, top: {} },
    { kind: 'app-env', path: null, env, top: {} },
    { kind: 'login-shell', path: null, env: loginEnv, top: {} },
  ];
  const sources = layers.filter((l) => l.path || l.kind === 'app-env' || l.kind === 'login-shell').map((l) => ({ kind: l.kind, path: l.path }));

  const dropped = [];
  const allowed = (name) => ROUTING.has(name) || PATH_KEYS.has(name) || CLAUDE_SECRET_KEYS.includes(name) || name.startsWith(VERTEX_REGION_PREFIX);
  for (const l of layers.slice(0, 3)) for (const name of Object.keys(l.env)) if (!allowed(name) && !dropped.includes(name)) dropped.push(name);

  const pick = (name) => {
    for (const l of layers) {
      const v = str(l.env[name]);
      if (v != null && v !== '') return { value: v, origin: l.kind };
    }
    return null;
  };
  const pickTop = (key) => {
    for (const l of layers) { const v = str(l.top[key]); if (v != null && v !== '') return { value: v, origin: l.kind }; }
    return null;
  };

  const routing = {};
  const pathVars = {};
  const noToolSecrets = {};
  const names = new Set([...ROUTING, ...PATH_KEYS, ...CLAUDE_SECRET_KEYS]);
  for (const l of layers) for (const k of Object.keys(l.env)) if (k.startsWith(VERTEX_REGION_PREFIX)) names.add(k);
  for (const name of names) {
    if (CLAUDE_SECRET_KEYS.includes(name)) continue;
    const hit = pick(name);
    if (!hit) continue;
    if (PATH_KEYS.has(name)) {
      const abs = expandHome(hit.value, home, p);
      if (!p.isAbsolute(abs)) { unsupported.push({ code: 'path_var_relative', message: `${name} is not an absolute path` }); continue; }
      routing[name] = abs;
      pathVars[name] = abs;
    } else if (name === 'ANTHROPIC_CUSTOM_HEADERS') {
      const headerNames = hit.value.split(/\r?\n/).map((line) => line.split(':')[0].trim()).filter(Boolean);
      if (findSecrets(hit.value).length || headerNames.some((h) => SECRET_HEADER_NAME.test(h))) {
        noToolSecrets[name] = hit.value;
        unsupported.push({ code: 'secret_custom_headers', message: 'ANTHROPIC_CUSTOM_HEADERS carries a credential' });
      } else routing[name] = hit.value;
    } else if (secretish(hit.value)) {
      noToolSecrets[name] = hit.value;
      unsupported.push({ code: 'secret_in_routing', message: `${name} carries a credential` });
    } else routing[name] = hit.value;
  }

  const bedrockToken = pick('AWS_BEARER_TOKEN_BEDROCK');
  if (bedrockToken) {
    noToolSecrets.AWS_BEARER_TOKEN_BEDROCK = bedrockToken.value;
    unsupported.push({ code: 'secret_bedrock_token', message: 'AWS_BEARER_TOKEN_BEDROCK is set' });
  }

  // C7: the CLI records keys the user rejected as the last 20 characters. API key only.
  const apiKey = pick('ANTHROPIC_API_KEY');
  const rejectedList = Array.isArray(claudeJson?.customApiKeyResponses?.rejected) ? claudeJson.customApiKeyResponses.rejected : [];
  const rejected = !!apiKey && rejectedList.includes(apiKey.value.slice(-20));
  const authToken = pick('ANTHROPIC_AUTH_TOKEN');
  const helper = pickTop('apiKeyHelper');
  const awsAuthRefresh = pickTop('awsAuthRefresh');
  const awsCredentialExport = pickTop('awsCredentialExport');
  const model = pickTop('model');

  // Order is the effective one for a run, not the interactive CLI's: a policy (managed) helper beats
  // the run's --settings file inside the CLI, so it comes before the token and key.
  let kind = 'oauth-or-none';
  let secret = null;
  let secretName = null;
  let origin = null;
  if (TRUTHY.test(routing.CLAUDE_CODE_USE_BEDROCK || '')) kind = 'bedrock';
  else if (TRUTHY.test(routing.CLAUDE_CODE_USE_VERTEX || '')) kind = 'vertex';
  else if (TRUTHY.test(routing.CLAUDE_CODE_USE_FOUNDRY || '')) kind = 'foundry';
  else if (helper?.origin === 'managed') { kind = 'helper'; origin = 'managed'; }
  else if (authToken) { kind = 'auth-token'; secret = authToken.value; secretName = 'ANTHROPIC_AUTH_TOKEN'; origin = authToken.origin; }
  else if (apiKey && !rejected) { kind = 'api-key'; secret = apiKey.value; secretName = 'ANTHROPIC_API_KEY'; origin = apiKey.origin; }
  else if (helper) { kind = 'helper'; origin = helper.origin; }
  if (kind === 'bedrock' || kind === 'vertex' || kind === 'foundry') origin = (pick(`CLAUDE_CODE_USE_${kind.toUpperCase()}`) || {}).origin || null;

  const denyRead = [p.join(home, '.config', 'gcloud'), p.join(home, '.azure'), ...Object.values(pathVars)];
  return {
    ...base,
    carry: true,
    carryOffReason: null,
    sources,
    notes: [],
    routing,
    pathVars,
    model: model?.value ?? null,
    smallModel: routing.ANTHROPIC_DEFAULT_HAIKU_MODEL || routing.ANTHROPIC_SMALL_FAST_MODEL || model?.value || null,
    auth: {
      kind, secret, secretName, helper: helper?.value ?? null,
      awsAuthRefresh: awsAuthRefresh?.value ?? null, awsCredentialExport: awsCredentialExport?.value ?? null,
      rejected, origin, managedHelper: helper?.origin === 'managed',
      awsCredentialExportOrigin: awsCredentialExport?.origin ?? null,
    },
    noToolSecrets,
    localGateway: routing.ANTHROPIC_BASE_URL ? localGatewayOf(routing.ANTHROPIC_BASE_URL) : null,
    gateways: gatewaysOf(routing),
    denyRead: [...new Set(denyRead)],
    unsupported,
    dropped,
  };
}

const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
function tomlValue(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isObj(v)) return `{${Object.entries(v).map(([k, x]) => `${tomlKey(k)}=${tomlValue(x)}`).join(',')}}`;
  return null;
}

function blankCodex(codexHome, unsupported = []) {
  return { codexHome, providerId: null, model: null, overrides: [], cliEnv: {}, missingEnv: [], burst: { detected: false }, unsupported, dropped: [] };
}

function codexProvider({ env = {}, loginEnv = {}, home, readFile }) {
  const codexHome = expandHome(env.CODEX_HOME || loginEnv.CODEX_HOME || path.join(home, '.codex'), home, path);
  if (!path.isAbsolute(codexHome)) return blankCodex(codexHome, [{ code: 'codex_home_relative', message: 'CODEX_HOME is not an absolute path' }]);
  const file = path.join(codexHome, 'config.toml');
  let text;
  try { text = readFile(file); } catch { text = null; }
  if (text == null) return blankCodex(codexHome);
  if (Buffer.byteLength(text) > CONFIG_TOML_MAX_BYTES) return blankCodex(codexHome, [{ code: 'codex_config_too_large', message: `${file} is larger than ${CONFIG_TOML_MAX_BYTES} bytes` }]);
  let doc;
  try { doc = parse(text); } catch (e) {
    const where = Number.isInteger(e?.line) ? ` at line ${e.line}, column ${e.column}` : '';
    return blankCodex(codexHome, [{ code: 'codex_config_unparseable', message: `${file} is not valid TOML${where}` }]);
  }

  const profile = isObj(doc.profiles) && typeof doc.profile === 'string' && isObj(doc.profiles[doc.profile]) ? doc.profiles[doc.profile] : {};
  const providerId = str(profile.model_provider) ?? str(doc.model_provider);
  const model = str(profile.model) ?? str(doc.model);
  const out = blankCodex(codexHome);
  out.providerId = providerId || null;
  out.model = model || null;
  if (secretish(providerId) || secretish(model)) {
    out.providerId = null;
    out.model = null;
    out.unsupported.push({ code: 'codex_secret_in_field', message: 'model or model_provider carries a credential' });
    return out;
  }
  if (providerId) out.overrides.push(`model_provider=${tomlValue(providerId)}`);
  if (model) out.overrides.push(`model=${tomlValue(model)}`);

  const table = providerId && isObj(doc.model_providers) && isObj(doc.model_providers[providerId]) ? doc.model_providers[providerId] : null;
  if (providerId && table && CODEX_BUILTIN_PROVIDER_IDS.includes(providerId)) {
    out.unsupported.push({ code: 'codex_builtin_provider_override', message: `model_providers.${providerId} redefines a built-in provider` });
  } else if (table) {
    const prefix = `model_providers.${tomlKey(providerId)}`;
    const fields = {};
    for (const f of CODEX_PROVIDER_FIELDS) if (table[f] !== undefined) fields[f] = table[f];
    for (const f of Object.keys(table)) if (!CODEX_PROVIDER_FIELDS.includes(f) && f !== 'http_headers' && f !== 'experimental_bearer_token' && !out.dropped.includes(f)) out.dropped.push(f);

    const bad = (name) => typeof name !== 'string' || !ENV_NAME.test(name);
    const envValue = (name) => { const v = env[name] ?? loginEnv[name]; return typeof v === 'string' && v !== '' ? v : null; };
    const need = (name) => {
      const v = envValue(name);
      if (v == null) { if (!out.missingEnv.includes(name)) out.missingEnv.push(name); } else out.cliEnv[name] = v;
    };

    if (fields.env_key !== undefined && table.experimental_bearer_token !== undefined) {
      out.unsupported.push({ code: 'codex_env_key_and_bearer_token', message: `model_providers.${providerId} sets both env_key and experimental_bearer_token` });
      delete fields.env_key;
    } else if (typeof table.experimental_bearer_token === 'string' && table.experimental_bearer_token) {
      fields.env_key = 'PLEXIFORM_PROVIDER_KEY';
      out.cliEnv.PLEXIFORM_PROVIDER_KEY = table.experimental_bearer_token;
    } else if (fields.env_key !== undefined) {
      if (bad(fields.env_key)) { out.unsupported.push({ code: 'codex_env_name_invalid', message: 'env_key is not a valid variable name' }); delete fields.env_key; } else need(fields.env_key);
    }

    const headerEnv = isObj(fields.env_http_headers) ? { ...fields.env_http_headers } : {};
    for (const [h, name] of Object.entries(headerEnv)) {
      if (bad(name)) { out.unsupported.push({ code: 'codex_env_name_invalid', message: 'env_http_headers names a variable that is not valid' }); delete headerEnv[h]; } else need(name);
    }
    if (isObj(table.http_headers)) {
      let n = 0;
      for (const [h, v] of Object.entries(table.http_headers)) {
        if (typeof v !== 'string') continue;
        n += 1;
        headerEnv[h] = `PLEXIFORM_PROVIDER_H${n}`;
        out.cliEnv[`PLEXIFORM_PROVIDER_H${n}`] = v;
      }
    }
    if (Object.keys(headerEnv).length) fields.env_http_headers = headerEnv; else delete fields.env_http_headers;

    if (isObj(fields.query_params) && Object.entries(fields.query_params).some(([k, v]) => findSecrets(`${k}=${v}`).length || secretish(String(v)))) {
      out.unsupported.push({ code: 'codex_query_params_secret', message: `model_providers.${providerId}.query_params carries a credential` });
      delete fields.query_params;
    }

    for (const [f, v] of Object.entries(fields)) {
      if (f !== 'env_key' && (isObj(v) ? Object.entries(v).some(([k, x]) => findSecrets(`${k}=${x}`).length || secretish(String(x))) : secretish(v))) {
        out.unsupported.push({ code: 'codex_secret_in_field', message: `model_providers.${providerId}.${f} carries a credential` });
        continue;
      }
      const t = tomlValue(v);
      if (t == null) { if (!out.dropped.includes(f)) out.dropped.push(f); continue; }
      out.overrides.push(`${prefix}.${f}=${t}`);
    }
    const hay = [providerId, ...Object.values(fields).filter((v) => typeof v === 'string')];
    out.burst.detected = BURST_CODEX_MARKERS.some((m) => hay.some((h) => h === m || h.includes(m)));
  } else if (providerId) {
    out.burst.detected = BURST_CODEX_MARKERS.includes(providerId);
  }
  return out;
}

module.exports = {
  claudeProvider, codexProvider, boundedReadFile, readDirOrNull,
  CLAUDE_ROUTING_KEYS, CLAUDE_PATH_KEYS, CLAUDE_SECRET_KEYS, CLAUDE_READ_NAMES,
  CODEX_PROVIDER_FIELDS, CODEX_BUILTIN_PROVIDER_IDS, CODEX_TOP_KEYS,
  BURST_CODEX_MARKERS, CONFIG_TOML_MAX_BYTES, CLAUDE_JSON_MAX_BYTES,
};
