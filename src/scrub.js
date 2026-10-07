// Makes text safe to paste into a bug report: home paths become "~", the
// names of your own folders, repos and hosts become short hashes, and
// anything shaped like a secret, an email or an IP address is redacted.
// Shared by Copy diagnostics (the Health panel), crash reports and
// onboarding, so it is a pure function of the text and a few facts about the
// machine.
//
// Fail closed: when unsure whether something is a path, it is hashed. A
// path swallows the words after it up to a clear break, a line too long to
// scrub in bounded time is dropped whole, and a quoted secret with no closing
// quote is redacted to the end of the line.
//
// Every pattern runs in linear time. A pattern that starts with a run of
// characters only starts where that run starts (a lookbehind on the run's
// own class), and runs are taken whole with (?=(x+))\1, which cannot give
// characters back; so a long line of "ab-ab-…" is read once, not once per
// character. test/scrub.test.js times each pattern on its worst input.
//
// It does not try to recognise prompts or transcript content: callers must
// never hand it any. It only makes paths, names and secrets unrecoverable.
//
// It is best-effort defence in depth, not a guarantee: callers must feed it
// only allow-listed fields and show the person exactly what will be sent
// before anything leaves the machine. Known limits, accepted: a secret split
// across a line break; a PEM block whose BEGIN line was cut; a quoted value
// longer than 2048 characters; token formats not in the shared list; and a
// hashed stack frame can lose its :line:col.
// UUIDs stay: they are random session ids, name nobody, and are how log
// lines about one session are matched up.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const R = '[redacted]';
const MAX_LINE = 4000;
// Secret shapes the pinned shared list (src/secret-patterns.js) still misses, each a value-only
// span like the shared ones. Each is here because a probe in
// test/scrub-probes.test.js fails without it; drop one when the shared list
// covers it.
const KEY_WORDS = 'token(?!s)|secret|passw(?:or)?d|passphrase|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|cookie';
const EXTRA_SECRETS = [
  // "password is: X".
  /(?<![\w])(?:password|passphrase|pin)\s{1,8}is\s{0,8}:\s{0,8}(?<v>\S{1,256})/gi,
  // Env style with a space: PASSWORD hunter2.
  /(?<![\w-])(?=[A-Z0-9_]{0,64}?(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_KEY|PRIVATE_KEY|CREDENTIALS?))[A-Z][A-Z0-9_]{0,127}[ \t]{1,8}(?![:=\s])(?<v>[^\s"',;}]{1,256})/g,
  // mysql -phunter2: a -p glued to its value.
  /(?<![\w-])-p(?<v>[^\s"'-][^\s"']{0,255})/g,
  // An OpenAI-style key the shared list reads as an identifier (all one case).
  /(?<![\w-])sk-(?:proj-|svcacct-|admin-)?(?<v>[\w-]{16,256})/g,
  // A Google key a few characters short of the exact shape.
  /(?<![\w-])AIza(?<v>[\w-]{30,64})/g,
  // A key name longer than the shared list reads (128): glued to other text,
  // as in a cut or minified line. The run is taken whole, so still linear.
  new RegExp(`(?<![\\w.-])(?=[\\w.-]{129})(?=[\\w.-]*?(?:${KEY_WORDS}))(?=([\\w.-]+))\\1["']?[ \\t]{0,8}[:=][ \\t]{0,8}(?<v>"(?:[^"\\\\\\n]|\\\\.){0,2048}"?|'[^'\\n]{0,2048}'?|[^\\s"'\x60][^\\n\\r"'\x60]{0,2047})`, 'gi'),
];

const PATTERNS = {
  LONG_LINE: new RegExp(`^[^\\n]{${MAX_LINE + 1},}$`, 'gm'),
  EXTRA_SECRETS,
  JSON_SNIPPET: /\b(?:Unexpected token|Unexpected non-whitespace character|Bad control character|Unterminated string)\b/,
  URL_QUOTED: /(["'`])([a-z][a-z0-9+.-]{0,30}:\/\/[^"'`\n]*)\1/gi,
  // A path may run on through spaces (an unquoted "My Docs") up to a clear
  // break: the line's end, a quote, a bracket, " — ", " - " or another URL.
  URL: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,30}):\/\/([^\s/"'`<>()\u0001\u0002]*)([^\s"'`<>()\u0001\u0002]*)((?: +(?![—-] |[a-z][a-z0-9+.-]{0,30}:\/\/)[^\s"'`<>()[\]\u0001\u0002]+)*)/gi,
  // A host with no scheme: dotted names (corp.globex.internal, db.acme.io:5432).
  BARE_HOST: /(?<![\w.@/:\\-])(?=([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,8}))\1(?![\w-]|\.\w)(:\d{1,5}(?!\d))?/gi,
  GIT_SSH: /(?<![\w.-])(?=([\w.-]+))\1@(?=([\w-]+(?:\.[\w-]+)+))\2:(?!\d)(?=([\w.~-]+(?:\/[\w.~-]+)*))\3/g,
  EMAIL: /(?<![\w.+-])(?=([\w.+-]+))\1@[\w-]+(?:\.[\w-]+)+/g,
  IPV4: /(?<![\w.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\w.]*\d)/g,
  IPV6: /(?<![\w:.])(?=[0-9a-f:]{0,45}::|(?:[0-9a-f]{1,4}:){5})(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi,
  DASH_HOME: /(?<![\w-])-(?:Users|home)-(?=([\w.-]+))\1/gi,
  REPO_REF: /(?<![\w./#-])(?=([\w.-]+))\1\/(?=([\w.-]+))\2#(\d+)\b/g,
  QUOTED: /(['"`])((?:[A-Za-z]:|\.{1,2})?[~/][^'"`\n]*)\1/g,
  // A path starts at "/", "~/", "X:/" or "//" (UNC, once "\" reads as "/"),
  // and not inside a word: "and/or" is no path, "cwd:/opt/x" and "@/x" are.
  // It then runs over spaces, up to a quote, bracket, the end of the line,
  // or a separator followed by a space or digit ("main.js:12:5", "a, b").
  PATH: /(?<![\w.~%-])((?:[A-Za-z]:|~)?\/(?=\S)(?:[^\n"'`()[\]{}<>\u0001\u0002:,;|]|[:,;|](?![\s\d]|$))*)/g,
  // Relative: "./x", "../x", "proj/plan.md" — any word/word token left over.
  // It may only start where its first segment's run starts (after a space,
  // quote or bracket), so a long "a:a:a:…" is read once.
  RELATIVE: /(?<![^\s"'`()[\]{}<>\u0001\u0002])(?=([^\s/"'`()[\]{}<>\u0001\u0002]+))\1\/(?=[^\s/])([^\s"'`()[\]{}<>\u0001\u0002]*)/g,
};

// Path segments that say where something is without saying whose it is.
const KEEP_DIRS = [
  '~', 'Users', 'home', 'private', 'tmp', 'var', 'folders', 'usr', 'local', 'opt', 'bin', 'etc', 'System', 'Volumes',
  'Applications', 'Claude Buddy.app', 'Claude Buddy', `${require('../brand.js').name}.app`, require('../brand.js').name, 'Contents', 'Resources', 'MacOS', 'Frameworks', 'app.asar', 'app.asar.unpacked',
  'Library', 'Application Support', 'Logs', 'Caches', 'Preferences', 'LaunchAgents', 'AppData', 'Roaming',
  '.claude', '.claude.json', 'settings.json', 'projects', 'todos', 'teams', 'tasks',
  '.claude-traffic-light', 'sessions', 'requests', 'app.log', 'app.log.old', 'config.json', 'last-hook.json', 'port', 'token',
  'hooks', 'adapters', 'src', 'node_modules', 'electron', 'dist', 'native', 'build', 'signal', 'claude-buddy',
];
// Public services, which name no one. Every other host is hashed.
const KEEP_HOSTS = new Set(['github.com', 'api.github.com', 'gitlab.com', 'bitbucket.org', 'anthropic.com', 'api.anthropic.com', 'claude.ai', 'npmjs.org', 'registry.npmjs.org', 'sentry.io', 'localhost']);
const KEEP_IPS = new Set(['127.0.0.1', '0.0.0.0', '::1', '::', '[::1]']);

// The app's own file names (main.js, set-status.js, …) keep stack traces
// readable; anything else in a path might name a project.
function ownFiles() {
  const root = path.join(__dirname, '..');
  const out = [];
  for (const dir of ['', 'hooks', 'adapters', 'src']) {
    try { out.push(...fs.readdirSync(path.join(root, dir)).filter((f) => /\.(?:js|html|json)$/.test(f))); } catch { /* not shipped */ }
  }
  return out;
}
let keepCache = null;
const defaultKeep = () => (keepCache = keepCache || new Set(KEEP_DIRS.concat(ownFiles())));

const hashName = (name, salt) => `#${crypto.createHash('sha256').update(`${salt}\0${name}`).digest('hex').slice(0, 6)}`;
// What a hash looks like once written, so a later pass leaves it alone.
const HASHED = /^(?:~-|-Users-)?#[0-9a-f]{6}$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const IP_EXACT = new RegExp(`^(?:${PATTERNS.IPV4.source}|\\[?[0-9a-f:]*:[0-9a-f:]*\\]?)$`, 'i');
const isIp = (h) => IP_EXACT.test(h);

// Secrets become [redacted], value only: a key name, the "Bearer" or
// "Basic" word and the quotes stay. The shared list is the mirror of
// board/shared/secret-patterns.mjs; when that lands on main this line becomes
//   const Shared = require('../board/shared/secret-patterns.mjs');
// and src/secret-patterns.js is deleted.
const Shared = require('./secret-patterns.js');
// With docExamples off, a scrubber redacts ghp_xxxx… and AKIA…EXAMPLE too
// (fail closed). Stand-ins are ignored by default upstream, so a token
// wrapped as {{GH:…}} is found without any help from us.
const redactShared = (s) => Shared.redactSecrets(s, { classes: ['credential', 'likely'], docExamples: false, replace: () => R });

// Personal numbers, each a pattern plus a check so that random digits in logs and hashes survive:
// a bank card (Luhn and a known issuer prefix), a South African ID (a real date and Luhn), an IBAN
// (mod 97), a US SSN, a UK National Insurance number and a passport machine-readable line (check
// digits). Every pattern is bounded, so reading is linear.
const luhn = (d) => {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
};
const CARD_PREFIX = /^(?:4|5[1-5]|2(?:2[2-9][1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720)|3[47]|6011|65|3[68]|35)/;
const validDate = (yy, mm, dd) => [1900, 2000].some((c) => { const d = new Date(Date.UTC(c + yy, mm - 1, dd)); return d.getUTCMonth() === mm - 1 && d.getUTCDate() === dd; });
const ibanOk = (raw) => {
  const v = raw.replace(/ /g, '');
  if (v.length < 15 || v.length > 34) return false;
  let rem = 0;
  for (const ch of v.slice(4) + v.slice(0, 4)) {
    const n = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const c of n) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
};
const mrzDigit = (s) => {
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const v = c === '<' ? 0 : /\d/.test(c) ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 55;
    sum += v * [7, 3, 1][i % 3];
  }
  return sum % 10;
};
const NINO_BAD = new Set(['BG', 'GB', 'NK', 'KN', 'TN', 'NT', 'ZZ']);
const PII_RULES = [
  [/(?<![A-Z0-9<])[A-Z0-9<]{9}\d[A-Z]{3}\d{6}\d[MF<]\d{6}\d/g, (m) => mrzDigit(m.slice(0, 9)) === +m[9] && mrzDigit(m.slice(13, 19)) === +m[19] && mrzDigit(m.slice(21, 27)) === +m[27], '[passport]'],
  [/(?<![A-Za-z0-9])[A-Z]{2}\d{2}[A-Z0-9]{11,30}(?![A-Za-z0-9])/g, ibanOk, '[iban]'],
  [/(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?(?![A-Za-z0-9])/g, ibanOk, '[iban]'],
  [/(?<![\w-])(\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{4}[01][89]\d(?![\w-])/g, (m) => validDate(+m.slice(0, 2), +m.slice(2, 4), +m.slice(4, 6)) && luhn(m), '[sa-id]'],
  [/(?<![\w.-])(?:\d[ -]?){12,18}\d(?![\w-])/g, (m) => { const d = m.replace(/[ -]/g, ''); return d.length >= 13 && d.length <= 19 && CARD_PREFIX.test(d) && luhn(d); }, '[card]'],
  [/(?<![\w-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\w-])/g, () => true, '[ssn]'],
  [/(?<![A-Za-z0-9])[A-CEGHJ-PR-TW-Z]{2}[ ]?\d{2}[ ]?\d{2}[ ]?\d{2}[ ]?[A-D](?![A-Za-z0-9])/g, (m) => !NINO_BAD.has(m.slice(0, 2)), '[nino]'],
];

function maskPii(text) {
  let out = String(text == null ? '' : text);
  for (const [re, ok, tag] of PII_RULES) out = out.replace(re, (m) => (ok(m) ? tag : m));
  return out;
}

function redactSecretsPass(text) {
  let out = redactShared(String(text == null ? '' : text));
  for (const re of EXTRA_SECRETS) {
    out = out.replace(re, (...a) => {
      const g = a[a.length - 1];
      let v = g.v;
      if (!v) return a[0];
      const at = a[0].lastIndexOf(v);
      // Quotes stay, as in the shared list's spans.
      const q = v[0] === '"' || v[0] === "'" || v[0] === '`' ? v[0] : '';
      const head = a[0].slice(0, at) + q;
      const tail = (q && v.length > 1 && v.endsWith(q) ? q : '') + a[0].slice(at + v.length);
      v = v.slice(q.length, v.length - (tail.startsWith(q) && q ? 1 : 0));
      if (!v.trim() || v === R) return a[0];
      return `${head}${R}${tail}`;
    });
  }
  return maskPii(out);
}

// For a JSON.parse error shown to the person or logged: newer Node quotes
// the start of the input, which can be anything a session wrote.
function cleanJsonError(message) {
  return String(message || '').split('\n').map((line) => {
    const m = PATTERNS.JSON_SNIPPET.exec(line);
    return m && /JSON/.test(line.slice(m.index)) ? `${line.slice(0, m.index)}invalid JSON (input not shown)` : line;
  }).join('\n');
}

// text → scrubbed text.
//   home:     the home folder, replaced by "~" in either separator style and
//             any case (also its dash-encoded form, as in
//             ~/.claude/projects/-Users-me-work-app)
//   user:     the login name, redacted wherever a word starts with it
//   hostname: this machine's name (session file names start with it)
//   names:    more strings to hash wherever they appear, e.g. "owner/repo"
//             (each part is hashed on its own too)
//   salt:     makes the hashes unguessable; pass one per bundle so the same
//             folder hashes the same everywhere in it
//   keep:     path segments left readable (default: the app's own)
function scrub(text, { home = null, user = null, hostname = null, names = [], salt = crypto.randomBytes(8).toString('hex'), keep = defaultKeep() } = {}) {
  const P = PATTERNS;
  const hashWord = (w) => (!w.trim() || keep.has(w) || HASHED.test(w) || /^\d+$/.test(w) || w.length === 1 ? w : hashName(w, salt));
  const hashSeg = (seg) => (!seg || keep.has(seg) || HASHED.test(seg) || /^[A-Za-z]:$/.test(seg) ? seg : seg.split(/( +)/).map(hashWord).join(''));
  const hashPath = (p) => p.split('/').map(hashSeg).join('/');
  // Finished pieces are parked behind placeholders so later passes can't
  // rewrite them (a URL's host read as a UNC path, say). Hashes that may sit
  // inside a path are written in place instead, so the path still reads as
  // one and its tail is hashed with it.
  const parked = [];
  const park = (s) => `\u0001${parked.push(s) - 1}\u0002`;
  const hashHost = (hostport) => {
    const at = hostport.lastIndexOf('@');
    const who = at < 0 ? '' : hostport.slice(0, at + 1);
    const hp = at < 0 ? hostport : hostport.slice(at + 1);
    const m = /^(\[[^\]]*\]|[^:]*)(:\d+)?$/.exec(hp) || [hp, hp, ''];
    const h = m[1];
    const host = !h ? '' : KEEP_IPS.has(h) || KEEP_HOSTS.has(h.toLowerCase()) || /\.ts\.net$/i.test(h) ? h : isIp(h) ? '[ip]' : hashName(h.toLowerCase(), salt);
    // Only git@ is generic; anyone else's login is theirs (and a password
    // after it was already redacted by the secret pass).
    const shownWho = !who ? '' : who === 'git@' ? who : '[user]@';
    return `${shownWho}${host}${m[2] || ''}`;
  };
  const url = (scheme, host, rest) => {
    const tail = /^file$/i.test(scheme) ? (/(:\d+(?::\d+)?)$/.exec(rest) || [''])[0] : '';
    const body = tail ? rest.slice(0, -tail.length) : rest;
    const p = body.replace(/[^/?&=#;]+/g, (seg) => hashSeg(decode(seg)));
    return `${scheme}://${hashHost(host)}${p}${tail}`;
  };

  let out = String(text == null ? '' : text);
  out = out.replace(/\\\\/g, '\\').replace(/\\\//g, '/');
  out = out.replace(P.LONG_LINE, (m) => `[long line omitted: ${m.length} chars]`);
  out = cleanJsonError(out);
  out = redactSecretsPass(out);

  // Windows reads as POSIX from here: every backslash is a separator.
  out = out.replace(/\\/g, '/').replace(/%2F/gi, '/').replace(/%5C/gi, '/').replace(/%3A/gi, ':');

  out = out.replace(P.URL_QUOTED, (m, q, u) => {
    const x = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(.*)$/i.exec(u);
    return park(`${q}${url(x[1], x[2], x[3])}${q}`);
  });
  out = out.replace(P.URL, (m, scheme, host, rest, more) => (rest.startsWith('/') ? park(url(scheme, host, rest) + hashSeg(more)) : park(url(scheme, host, rest)) + more));
  out = out.replace(P.GIT_SSH, (m, u, host, p) => park(`${hashHost(`${u}@${host}`)}:${p.split('/').map((s) => hashName(s, salt)).join('/')}`));
  out = out.replace(/%20/gi, ' ');

  const list = [];
  for (const n of [].concat(names || [])) if (typeof n === 'string') list.push(n, ...n.split('/'));
  for (const n of [...new Set(list.filter((x) => x.length >= 3))].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\w.-])${escapeRe(n)}(?![\\w-]|\\.\\w)`, 'gi'), (m) => m.split('/').map((s) => hashName(s.toLowerCase(), salt)).join('/'));
  }

  if (home) {
    const h = String(home).replace(/\\/g, '/').replace(/\/+$/, '');
    if (h) out = out.replace(new RegExp(`(?:file://)?${escapeRe(h)}(?![\\w.-])`, 'gi'), '~');
    const encoded = String(home).replace(/[\\/.:]+$/, '').replace(/[\\/.:]/g, '-');
    if (encoded.length > 1) out = out.replace(new RegExp(`${escapeRe(encoded)}(?:-(?=([\\w.-]+))\\1)?(?![\\w.-])`, 'gi'), (m, rest) => (rest ? `~-${hashName(rest, salt)}` : '~'));
  }
  out = out.replace(P.DASH_HOME, (m, rest) => `-Users-${hashName(rest, salt)}`);

  out = out.replace(P.EMAIL, '[email]');
  out = out.replace(P.IPV4, (m) => (KEEP_IPS.has(m) ? m : '[ip]'));
  out = out.replace(P.IPV6, (m) => (KEEP_IPS.has(m) || !/[0-9a-f]/i.test(m) ? m : '[ip]'));
  out = out.replace(P.BARE_HOST, (m, host, port) => {
    const h = host.toLowerCase();
    const dots = h.split('.').length - 1;
    if ((dots < 2 && !port) || !/\.[a-z][a-z0-9-]{1,62}$/.test(h) || keep.has(host) || KEEP_HOSTS.has(h) || /\.ts\.net$/.test(h)) return m;
    return `${hashName(h, salt)}${port || ''}`;
  });
  out = out.replace(P.REPO_REF, (m, org, repo, n) => park(`${hashName(org, salt)}/${hashName(repo, salt)}#${n}`));

  out = out.replace(P.QUOTED, (m, q, p) => park(`${q}${hashPath(p)}${q}`));
  out = out.replace(P.PATH, (m, p) => {
    const trimmed = p.replace(/\s+$/, '');
    if (!/[^/\s]/.test(trimmed.replace(/^([A-Za-z]:|~)/, ''))) return m;
    return park(hashPath(trimmed)) + p.slice(trimmed.length);
  });
  out = out.replace(P.RELATIVE, (m, first, rest) => park(hashPath(`${first}/${rest}`)));

  if (hostname) {
    const short = String(hostname).split('.')[0];
    if (short.length >= 3) out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(short)}(?:\\.[\\w-]+)*`, 'gi'), '[host]');
  }
  if (user && String(user).length >= 3) out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(String(user))}`, 'gi'), '[user]');
  return out.replace(/\u0001(\d+)\u0002/g, (m, i) => parked[Number(i)]);
}

module.exports = { scrub, redactSecretsPass, maskPii, hashName, cleanJsonError, PATTERNS, MAX_LINE };
