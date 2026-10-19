// Shared by test/borrow-corpus.test.js and test/borrow-fuzz.test.js.
// Builds format-valid fake secrets at run time from fragments, so no literal
// token sits in the repository, and finds what leaked into a scrubbed file.
'use strict';

const j = (...p) => p.join('');

function mulberry32(a) {
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s) {
  let h = 0x811c9dc5;
  for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
const seedFrom = (v, dflt) => (v == null || v === '' ? dflt : /^\d+$/.test(v) ? Number(v) >>> 0 : hashSeed(v));

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SETS = {
  alnum: ALNUM,
  hex: '0123456789abcdef',
  upnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  digits: '0123456789',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  b64url: `${ALNUM}-_`,
  b64: `${ALNUM}+/`,
  pw: `${ALNUM}-_.+!`,
};
const pick = (r, a) => a[(r() * a.length) | 0];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const take = (r, set, n) => { let s = ''; for (let i = 0; i < n; i++) s += set[(r() * set.length) | 0]; return s; };
// Alphanumeric at both ends: a leading '-' would read as a flag, a trailing '=' as padding.
const body = (r, n, set = 'b64url') => take(r, SETS.alnum, 1) + take(r, SETS[set], n - 2) + take(r, SETS.alnum, 1);

const tok = (prefix, ...rand) => ({ value: prefix + rand.join(''), rand: rand.filter((x) => x.length >= 8) });
const tokParts = (parts) => ({ value: parts.map((p) => (Array.isArray(p) ? p[0] : p)).join(''), rand: parts.filter(Array.isArray).map((p) => p[0]).filter((x) => x.length >= 8) });

function pem(r, nl) {
  const type = pick(r, ['RSA ', 'EC ', 'OPENSSH ', '', 'ENCRYPTED ']);
  const lines = [];
  const n = int(r, 4, 12);
  lines.push(j('MII', take(r, SETS.b64, 61)));
  for (let i = 1; i < n; i++) lines.push(take(r, SETS.b64, 64));
  lines.push(take(r, SETS.b64, int(r, 10, 60)) + '=');
  const head = j('-----BEGIN ', type, 'PRIVATE KEY-----');
  const foot = j('-----END ', type, 'PRIVATE KEY-----');
  return { value: [head, ...lines, foot].join(nl), rand: lines };
}

// Each generator returns { value: the text that goes in the file, rand: [the random runs to window-check] }.
const GEN = {
  private_key: (r) => pem(r, '\n'),
  private_key_escaped: (r) => pem(r, '\\n'),
  age_key: (r) => tok(j('AGE-SECRET-', 'KEY-1'), take(r, SETS.upnum, 58)),
  anthropic_key: (r) => tok(j('sk-', 'ant-', pick(r, ['api03-', 'admin01-', 'oat01-'])), body(r, 93)),
  openai_key: (r) => tok(j('sk-', pick(r, ['proj-', 'svcacct-', 'admin-', 'or-v1-', ''])), body(r, 48)),
  stripe_key: (r) => tok(j(pick(r, ['sk_', 'rk_']), pick(r, ['live_', 'test_'])), take(r, SETS.alnum, 24)),
  stripe_webhook: (r) => tok('whsec_', take(r, SETS.alnum, 32)),
  aws_access_key: (r) => tok(pick(r, ['AKIA', 'ASIA']), take(r, SETS.upnum, 16)),
  github_token: (r) => tok(j('gh', pick(r, ['p', 'o', 'u', 's', 'r']), '_'), take(r, SETS.alnum, 36)),
  github_pat: (r) => tokParts([j('github_', 'pat_'), [take(r, SETS.alnum, 22)], '_', [take(r, SETS.alnum, 59)]]),
  gitlab_token: (r) => tok(j('glpat', '-'), body(r, 20)),
  slack_token: (r) => tokParts([j('xox', pick(r, ['b', 'p', 'a']), '-'), [take(r, SETS.digits, 11)], '-', [take(r, SETS.digits, 12)], '-', [take(r, SETS.alnum, 24)]]),
  slack_app_token: (r) => tokParts([j('xapp', '-1-A'), [take(r, SETS.upnum, 10)], '-', [take(r, SETS.digits, 13)], '-', [take(r, SETS.hex, 64)]]),
  slack_webhook: (r) => tokParts([j('https://hooks.', 'slack.com/services/T'), [take(r, SETS.upnum, 10)], '/B', [take(r, SETS.upnum, 10)], '/', [take(r, SETS.alnum, 24)]]),
  discord_webhook: (r) => tokParts([j('https://discord.', 'com/api/webhooks/'), take(r, SETS.digits, 18), '/', [body(r, 68)]]),
  google_api_key: (r) => tok(j('AI', 'za'), body(r, 35)),
  google_oauth_secret: (r) => tok(j('GOCSP', 'X-'), body(r, 28)),
  npm_token: (r) => tok('npm_', take(r, SETS.alnum, 36)),
  pypi_token: (r) => tok(j('pypi-', 'AgEIcHlwaS5vcmc'), body(r, 70)),
  huggingface_token: (r) => tok('hf_', take(r, SETS.alnum, 34)),
  twilio_key: (r) => tok(j('S', 'K'), take(r, SETS.hex, 32)),
  sendgrid_key: (r) => tokParts([j('S', 'G.'), [body(r, 22)], '.', [body(r, 43)]]),
  digitalocean_token: (r) => tok(j('dop_', 'v1_'), take(r, SETS.hex, 64)),
  doppler_token: (r) => tok(j('dp.', pick(r, ['pt', 'st', 'sa', 'ct']), '.'), take(r, SETS.alnum, 44)),
  vault_token: (r) => tok(j('hv', 's.'), body(r, 60)),
  shopify_token: (r) => tok(j('sh', 'p', pick(r, ['at', 'ca', 'pa', 'ss']), '_'), take(r, SETS.hex, 32)),
  linear_key: (r) => tok(j('lin_', pick(r, ['api', 'oauth']), '_'), take(r, SETS.alnum, 40)),
  atlassian_token: (r) => tok(j('ATAT', 'T3'), body(r, 180)),
  databricks_token: (r) => tok('dapi', take(r, SETS.hex, 32)),
  telegram_bot_token: (r) => tokParts([String(int(r, 100000000, 9999999999)), ':AA', [body(r, 33)]]),
  figma_token: (r) => tok('figd_', body(r, 40)),
  supabase_key: (r) => tok('sbp_', take(r, SETS.hex, 40)),
  postman_key: (r) => tokParts(['PMAK-', [take(r, SETS.hex, 24)], '-', [take(r, SETS.hex, 34)]]),
  grafana_token: (r) => tok(j('gl', pick(r, ['sa', 'c']), '_'), take(r, SETS.alnum, 32), pick(r, ['', `_${take(r, SETS.hex, 8)}`])),
  sentry_token: (r) => tok(j('sntry', pick(r, ['s', 'u']), '_'), take(r, SETS.alnum, 64)),
  tailscale_key: (r) => tok(j('tskey-', pick(r, ['auth', 'api', 'client']), '-'), `k${take(r, SETS.alnum, 10)}CNTRL-`, take(r, SETS.alnum, 32)),
  groq_key: (r) => tok('gsk_', take(r, SETS.alnum, 52)),
  xai_key: (r) => tok('xai-', take(r, SETS.alnum, 80)),
  replicate_token: (r) => tok('r8_', take(r, SETS.alnum, 37)),
  perplexity_key: (r) => tok('pplx-', take(r, SETS.alnum, 48)),
  notion_token: (r) => tok(pick(r, ['ntn_', j('sec', 'ret_')]), take(r, SETS.alnum, 46)),
  airtable_token: (r) => tokParts(['pat', [take(r, SETS.alnum, 14)], '.', [take(r, SETS.hex, 64)]]),
  heroku_token: (r) => tok('HRKU-', body(r, 36)),
  fly_token: (r) => (r() < 0.5 ? tok('fo1_', body(r, 40)) : tok(j('fm', '2_'), body(r, 70, 'b64'))),
  netlify_token: (r) => tok(j('nf', pick(r, ['p', 'c']), '_'), take(r, SETS.alnum, 36)),
  onepassword_service_token: (r) => tok(j('ops_', 'eyJ'), body(r, 120)),
  jwt: (r) => tokParts([j('ey', 'J'), [body(r, 20)], '.', j('ey', 'J'), [body(r, 40)], '.', [body(r, 43)]]),
  jwt_like: (r) => tokParts([j('ey', 'J'), [body(r, 16)], '.', [body(r, 24)], '.', [body(r, 30)]]),
  hex_secret: (r) => tok('', take(r, SETS.hex, 64)),
  dash_key: (r) => tok(pick(r, ['pk-', 'rk-']), take(r, SETS.alnum, 36)),
  google_refresh_token: (r) => tok(j('1/', '/0'), body(r, 50)),
  pem_base64: (r) => tok(j('LS0tLS1C', 'RUdJTi'), take(r, `${ALNUM}+/`, 120)),
  putty_key: (r) => { const b = take(r, SETS.alnum, 64); return { value: j('PuTTY-User-', 'Key-File-3: ssh-ed25519\nEncryption: none\nPrivate-Lines: 1\n', b, '\nPrivate-MAC: ', take(r, SETS.hex, 64)), rand: [b] }; },
  discord_bot_token: (r) => tokParts([pick(r, ['M', 'N']), [take(r, SETS.upper, 3) + take(r, SETS.alnum, 20) + take(r, SETS.digits, 1)], '.', [take(r, SETS.alnum, 6)], '.', [take(r, SETS.lower, 2) + take(r, SETS.alnum, 26) + take(r, SETS.upper, 2)]]),
  google_access_token: (r) => tok(j('ya', '29.'), body(r, 60)),
  docker_pat: (r) => tok(j('dckr_', 'pat_'), body(r, 27)),
  pinecone_key: (r) => tok(j('pc', 'sk_'), body(r, 60)),
  planetscale_token: (r) => tok(j('pscale_', pick(r, ['tkn_', 'pw_', 'oauth_'])), body(r, 43)),
  langsmith_key: (r) => tokParts([j('lsv2_', pick(r, ['pt_', 'sk_'])), [take(r, SETS.hex, 32)], '_', [take(r, SETS.hex, 10)]]),
  mapbox_secret: (r) => tokParts([j('sk.', 'eyJ'), [body(r, 40)], '.', [body(r, 22)]]),
  basic_auth_header: (r) => { const b = Buffer.from(`${take(r, SETS.alnum, 8)}:${take(r, SETS.alnum, 20)}`).toString('base64'); return { value: b, rand: [b.replace(/=+$/, '')] }; },
  bearer_short: (r) => tok('', take(r, SETS.lower, 4) + take(r, SETS.digits, 3) + take(r, SETS.alnum, 8)),
  url_userinfo: (r) => tok('', take(r, SETS.alnum, 1) + take(r, SETS.alnum, 6)),
  url_token_user: (r) => tok('', take(r, SETS.upper, 2) + take(r, SETS.digits, 2) + take(r, SETS.alnum, 30)),
  cli_secret_arg: (r) => tok('', take(r, SETS.alnum, 24)),
  netrc: (r) => tok('', take(r, SETS.alnum, 20)),
  netrc_line: (r) => tok('', take(r, SETS.alnum, 20)),
  keyed_exact: (r) => tok('', take(r, `${ALNUM}+/`, 30)),
  // Contextual kinds: the value is only the secret; the file or FRAG supplies the trigger.
  url_credentials: (r) => tok('', take(r, SETS.alnum, 1) + take(r, `${ALNUM}-._~`, 16) + take(r, SETS.alnum, 1)),
  bearer: (r) => tok('', body(r, 40)),
  basic_auth: (r) => {
    const raw = `${take(r, SETS.alnum, 8)}:${take(r, SETS.alnum, 20)}`;
    const b = Buffer.from(raw).toString('base64');
    return { value: b, rand: [b.replace(/=+$/, '')] };
  },
  cf_access_secret: (r) => tok('', take(r, SETS.hex, 64)),
  env_secret: (r) => tok('', take(r, SETS.alnum, 1) + take(r, SETS.pw, 22) + take(r, SETS.alnum, 1)),
  aws_secret: (r) => tok('', take(r, SETS.alnum, 1) + take(r, `${ALNUM}/+`, 38) + take(r, SETS.alnum, 1)),
  auth_header: (r) => tok('', take(r, SETS.alnum, 24)),
  url_query_secret: (r) => tok('', take(r, SETS.alnum, 28)),
  cli_secret_flag: (r) => tok('', take(r, SETS.alnum, 20)),
  said_password: (r) => tok('', take(r, SETS.alnum, 14)),
  keyed: (r) => tok('', take(r, SETS.alnum, 1) + take(r, SETS.pw, 18) + take(r, SETS.alnum, 1)),
  keyed_spaced: (r) => { const v = [int(r, 5, 8), int(r, 5, 8), int(r, 5, 8)].map((n) => take(r, SETS.lower, n)).join(' '); return { value: v, rand: [v] }; },
  keyed_set: (r) => tok('', take(r, SETS.alnum, 20)),
  xml_secret: (r) => tok('', take(r, SETS.alnum, 16)),
};

// Kinds whose detection depends on the surrounding text. FRAG wraps a value in
// the smallest trigger context the shared pattern list recognises.
const FRAG = {
  url_credentials: (v) => `https://ci-bot:${v}@git.example.com/org/repo.git`,
  bearer: (v) => `Bearer ${v}`,
  basic_auth: (v) => `Basic ${v}`,
  cf_access_secret: (v) => `CF-Access-Client-Secret: ${v}`,
  auth_header: (v) => `Authorization: Token ${v}`,
  url_query_secret: (v) => `https://api.example.com/v2/items?user=7&access_token=${v}&page=2`,
  cli_secret_flag: (v) => `mytool login --token ${v} --verbose`,
  said_password: (v) => `the password is ${v}`,
  aws_secret: (v) => `aws_secret_access_key = ${v}`,
  xml_secret: (v) => `<password>${v}</password>`,
  keyed_set: (v) => `set -gx DB_PASSWORD ${v}`,
  basic_auth_header: (v) => `Authorization: Basic ${v}`,
  bearer_short: (v) => `authorization: bearer ${v}`,
  url_userinfo: (v) => `https://ci:${v}@git.example.com/org/repo.git`,
  url_token_user: (v) => `https://${v}@dev.azure.com/org/project/_git/repo`,
  cli_secret_arg: (v) => `"args": ["-y", "some-mcp", "--api-key", "${v}"]`,
  netrc: (v) => `machine api.example.com login bot password ${v}`,
  netrc_line: (v) => `machine api.example.com\n  login bot\n  password ${v}`,
  keyed_exact: (v) => `pass = ${v}`,
};
const KEYED_KINDS = ['keyed', 'keyed_spaced', 'env_secret'];
const CANON = { ...FRAG, keyed: (v) => `db_password = ${v}`, keyed_spaced: (v) => `password: ${v}`, env_secret: (v) => `MY_SERVICE_TOKEN=${v}` };
const kindClass = (k) => (k in FRAG ? 'frag' : KEYED_KINDS.includes(k) ? 'keyed' : 'token');

// ── this machine ────────────────────────────────────────────────────────────
const MACHINES = [
  { label: 'host-local', home: '/Users/tonde', user: 'tonde', hostname: 'Tondes-MacBook-Pro.local', emails: ['tonde@acme.co.za'], names: ['Tonde Moyo'] },
  { label: 'host-short', home: '/Users/tonde', user: 'tonde', hostname: 'Tondes-MacBook-Pro', emails: ['tonde@acme.co.za'], names: ['Tonde Moyo'] },
];
const machineValues = (m) => [m.home, m.user, m.hostname, ...m.emails, ...(m.names || [])];
// Templated by the README's placeholder list but not among the numbered guarantees.
const SECONDARY = ['jane.doe@othercorp.io', '10.0.4.12', '192.168.1.50', 'build01.acme.internal', 'mini-2.tail8f3a2.ts.net', 'tondes-mini.tail8f3a2.ts.net'];
const slotsOf = (m) => ({
  HOME: m.home, USER: m.user, HOST: m.hostname, HOSTSHORT: 'Tondes-MacBook-Pro', HOSTLOCAL: 'Tondes-MacBook-Pro.local',
  EMAIL: m.emails[0], EMAIL2: 'jane.doe@othercorp.io', NAME: m.names[0],
  IP: '10.0.4.12', IP2: '192.168.1.50', TSHOST: 'mini-2.tail8f3a2.ts.net', TSHOST2: 'tondes-mini.tail8f3a2.ts.net', INTHOST: 'build01.acme.internal',
});

function makeSecret(kind, rng, machine) {
  const g = GEN[kind];
  if (!g) throw new Error(`test bug: unknown seed kind "${kind}"`);
  for (let i = 0; i < 20; i++) {
    const s = g(rng);
    const low = s.value.toLowerCase();
    if (!machineValues(machine).some((v) => low.includes(v.toLowerCase()))) return { kind, ...s };
  }
  throw new Error(`test bug: could not generate ${kind} free of machine values`);
}

function fillSeeds(text, rng, machine) {
  const secrets = [];
  let out = text.replace(/@@SEED:([a-z0-9_]+)@@/g, (_, kind) => { const s = makeSecret(kind, rng, machine); secrets.push(s); return s.value; });
  const slots = slotsOf(machine);
  out = out.replace(/@@([A-Z0-9]+)@@/g, (m, name) => { if (!(name in slots)) throw new Error(`test bug: unknown machine slot ${m}`); return slots[name]; });
  return { text: out, secrets };
}

// ── what leaked ─────────────────────────────────────────────────────────────
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
const snippet = (text, idx) => { const l = text.split('\n')[lineOf(text, idx) - 1] || ''; return l.length > 110 ? `${l.slice(0, 110)}...` : l; };

function findProblems({ out, secrets, machine, secondary = false }) {
  const problems = [];
  const low = out.toLowerCase();
  for (const s of secrets) {
    const at = out.indexOf(s.value);
    if (at >= 0) { problems.push({ type: 'SECRET', kind: s.kind, detail: 'whole value survives', line: lineOf(out, at), text: snippet(out, at) }); continue; }
    for (const seg of s.rand) {
      let hit = -1;
      let count = 0;
      for (let i = 0; i + 8 <= seg.length; i++) {
        const w = seg.slice(i, i + 8);
        const k = out.indexOf(w);
        if (k >= 0) { count++; if (hit < 0) hit = k; }
      }
      if (hit >= 0) { problems.push({ type: 'WINDOW', kind: s.kind, detail: `${count} of ${seg.length - 7} eight-char windows survive`, line: lineOf(out, hit), text: snippet(out, hit) }); break; }
    }
  }
  for (const v of machineValues(machine)) {
    const k = low.indexOf(v.toLowerCase());
    if (k >= 0) problems.push({ type: 'MACHINE', kind: v, detail: 'machine value survives', line: lineOf(out, k), text: snippet(out, k) });
  }
  if (secondary) {
    for (const v of SECONDARY) {
      const k = low.indexOf(v.toLowerCase());
      if (k >= 0) problems.push({ type: 'TEMPLATED', kind: v, detail: 'README placeholder value survives', line: lineOf(out, k), text: snippet(out, k) });
    }
  }
  return problems;
}

function renderTable(rows, cols) {
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const fmt = (r) => cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join(' | ');
  return [fmt(Object.fromEntries(cols.map((c) => [c, c]))), w.map((n) => '-'.repeat(n)).join('-+-'), ...rows.map(fmt)].join('\n');
}

// The scrubber must fail closed, never throw, and stay synchronous.
function callScrub(scrubFile, args) {
  let res;
  try { res = scrubFile(args); } catch (e) { return { threw: `scrubFile threw ${e && e.message}` }; }
  if (res && typeof res.then === 'function') return { threw: 'scrubFile returned a Promise; the contract is synchronous' };
  if (!res || typeof res !== 'object') return { threw: `scrubFile returned ${typeof res}` };
  return { res };
}

// Everything a scrub result may expose besides `content`: reason and the record lists.
function sideChannels(res) {
  return [res.reason, JSON.stringify(res.redactions ?? null), JSON.stringify(res.templates ?? null)].filter((x) => typeof x === 'string').join('\n');
}

const PLACEHOLDER_RE = /\{\{(?:SECRET:[^}]+|HOME|USER|HOSTNAME|EMAIL(?::\d+)?|IP:\d+|HOST:\d+)\}\}/;

module.exports = {
  j, mulberry32, hashSeed, seedFrom, SETS, pick, int, take, GEN, FRAG, CANON, KEYED_KINDS, kindClass,
  MACHINES, machineValues, SECONDARY, slotsOf, makeSecret, fillSeeds, findProblems, renderTable, callScrub, sideChannels, lineOf, PLACEHOLDER_RE,
};
