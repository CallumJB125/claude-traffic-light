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
// One reviewed exception: src/work-organise.js passes the first prompt (cut
// to 4 KB, normalised) through redactSecretsPass to make a short local
// display title. That is fine because the scrubber is only a defence there,
// not a disclosure decision: the title stays on this machine, and only one
// sentence (at most 60 characters) is kept. Team titles never use a prompt
// without share_summaries.
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
const [PASSWORD_IS, ...LATER_SECRETS] = EXTRA_SECRETS;

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
  // The last label starts with a letter: "react@18.3.1" is a package, not an address.
  EMAIL: /(?<![\w.+-])(?=([\w.+-]+))\1@(?:[\w-]+\.)+[A-Za-z][\w-]*(?![\w-]|\.[\w-])/g,
  IPV4: /(?<![\w.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\w.]*\d)/g,
  // A phone number, then checked by phoneOk(). Three shapes, each with one way to read it
  // so a long digit run is read once: international "+27 82 555 0199", "+27825550199",
  // "+49 (0)30 123456"; trunk "082 555 0199", "0825550199"; North American
  // "(415) 555-0100", "1-800-555-0100", "415.555.0100" (area code and exchange
  // start 2-9, as NANP numbers do, so "123-456-7890" stays).
  PHONE: /(?<![\w+#.\/\u0001-])(?:\+\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d{1,12}(?:[ .-]\d{1,8}){0,5}|0\d{8,10}|\(?0\d{1,4}\)?(?:[ .-]\d{2,8}){1,4}|(?:1[ .-])?(?:\([2-9]\d\d\) ?|[2-9]\d\d[ .-])[2-9]\d\d[ .-]\d{4})(?![\w\/\u0002]|[.-]\w|:\d)/g,
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
  // "password is: X" goes first: the shared key=value rule would take "is:" as the value and leave X.
  let out = redactShared(redactExtra(String(text == null ? '' : text), [PASSWORD_IS]));
  return maskPii(redactExtra(out, LATER_SECRETS));
}
function redactExtra(out, list) {
  for (const re of list) {
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
  return out;
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
//   hubHost:  text bound for this hub keeps only its tailnet name (default: all kept)
//   fold:     fold runs of spaces inside a line first (text that leaves as one line)
function scrub(text, { home = null, user = null, hostname = null, names = [], salt = crypto.randomBytes(8).toString('hex'), keep = defaultKeep(), hubHost, fold = false } = {}) {
  const hub = typeof hubHost === 'string' ? hubHost.toLowerCase() : undefined;
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
    const host = !h ? '' : KEEP_IPS.has(h) || KEEP_HOSTS.has(h.toLowerCase()) || tailnetKept(h.toLowerCase(), hub) ? h : isIp(h) ? '[ip]' : hashName(h.toLowerCase(), salt);
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

  // Invisible and compatibility characters go first, as in scrubText (#58 review).
  let out = plainText(String(text == null ? '' : text), { max: Infinity });
  if (fold) out = foldSpaces(out);
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
  out = out.replace(P.PHONE, (m) => (phoneOk(m) ? '[phone]' : m));
  out = out.replace(P.BARE_HOST, (m, host, port) => {
    const h = host.toLowerCase();
    const dots = h.split('.').length - 1;
    if ((dots < 2 && !port && !PRIVATE_SUFFIX.test(h)) || !/\.[a-z][a-z0-9-]{1,62}$/.test(h) || keep.has(host) || KEEP_HOSTS.has(h) || tailnetKept(h, hub)) return m;
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

// A number PATTERNS.PHONE found is a phone with 9-15 digits (E.164 allows 15). The shapes
// already need a leading +, a leading 0 or a 3-3-4 North American grouping, so versions,
// dates, times, ticket keys and counts never reach here.
function phoneOk(m) {
  const digits = m.replace(/\D/g, '').length;
  return digits >= 9 && digits <= 15;
}
// Private names that need no third label: nas.local, jenkins.corp, api.internal.
const PRIVATE_SUFFIX = /\.(?:local|lan|internal|corp|intranet|home\.arpa)$/;
// A tailnet name is kept only when it is the hub the text is going to; with no hub
// given (diagnostics) every tailnet name is kept, as before.
const tailnetKept = (h, hubHost) => /\.ts\.net$/.test(h) && (hubHost === undefined || h === hubHost);
// File names look like dotted host names (foo.test.js); a last label that is a code or
// document extension is a file, not a host.
const FILE_EXTS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'md', 'mdx', 'html', 'htm', 'css', 'scss', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'zsh', 'yml', 'yaml', 'toml', 'lock', 'txt', 'log', 'xml', 'svg', 'png', 'jpg', 'gif', 'sql', 'vue', 'svelte', 'map', 'snap', 'plist', 'env', 'ini', 'cfg', 'conf', 'pdf', 'csv', 'zip', 'gz', 'tar', 'wasm', 'dart', 'lua', 'ex', 'exs', 'erl', 'hs', 'ml', 'scala', 'gradle', 'mod', 'sum']);
const privateHost = (host, port, hubHost = null) => {
  const h = host.toLowerCase();
  const labels = h.split('.');
  if (labels.length < 3 && !port && !PRIVATE_SUFFIX.test(h)) return false;
  if (!/\.[a-z][a-z0-9-]{1,62}$/.test(h) || FILE_EXTS.has(labels[labels.length - 1])) return false;
  return !KEEP_HOSTS.has(h) && h !== hubHost;
};

// Invisible and compatibility characters can split a number or a name so no pattern sees
// it ("+27\u200b82 555 0199", full-width "＋２７", "sam＠acme.com"). Tag characters (ASCII
// smuggling), the combining grapheme joiner and Hangul fillers always go. Other format
// characters (zero-width, bidi) go next to ASCII, where they could hide a match, and stay
// between other letters, where they mean something (an emoji ZWJ sequence, Persian ZWNJ).
// NFKC then folds full-width and other compatibility forms. NFKC can grow text up to 18
// times, so the input is capped before it and the output after.
// Mongolian free variation selectors, the Khmer inherent vowels and the braille blank
// show nothing either, so they go too. After NFKC (which has already composed "e" and
// U+0301 into "é"), a mark or variation selector left on an ASCII character hides it
// ("10.0\u0301.0.5", "+27\ufe0f82"); on any other character (an emoji's U+FE0F, a
// Devanagari vowel sign) it is part of the letter and stays. A space counts as ASCII.
const TEXT_MAX = 64 * 1024;
const ALWAYS_INVISIBLE = /[\u{E0000}-\u{E007F}\u034F\u115F\u1160\u3164\uFFA0\u180B-\u180D\u180F\u17B4\u17B5\u2800]/gu;
// One pass over each run (a lookahead after \p{Cf}+ would backtrack through a long run).
const FORMAT_RUN = /\p{Cf}+/gu;
const MARK_RUN = /\p{M}+/gu;
const ASCII = /[\x20-\x7e]/;
const nearAscii = (m, at, all) => (ASCII.test(all[at - 1] ?? '') || ASCII.test(all[at + m.length] ?? '') ? '' : m);
const afterAscii = (m, at, all) => (ASCII.test(all[at - 1] ?? '') ? '' : m);
//   max: the cap before and after NFKC (Infinity for scrub(), which takes whole files)
function plainText(text, { max = TEXT_MAX } = {}) {
  const strip = (t) => t.replace(ALWAYS_INVISIBLE, '').replace(FORMAT_RUN, nearAscii);
  return strip(strip(text.slice(0, max)).normalize('NFKC').slice(0, max)).replace(MARK_RUN, afterAscii);
}
// Runs of spaces inside a line fold before the patterns run ("+27 82  555 0199");
// indentation at the start of a line stays.
const foldSpaces = (t) => t.replace(/(?<=\S)[ \t]{2,}/g, ' ');

// Text on its way to a team hub or a teammate (review L2): a title, a task's report.
// Unlike scrub() it labels what it removes ([ip], [host], [phone], [email]) instead of
// hashing, so the text still reads. Line breaks and spacing are kept.
//   hubHost: the destination hub's host name, the one tailnet name the text may keep
function scrubText(text, { hubHost = null } = {}) {
  const hub = typeof hubHost === 'string' && hubHost ? hubHost.toLowerCase() : null;
  let out = redactSecretsPass(foldSpaces(plainText(String(text ?? ''))));
  out = out.replace(PATTERNS.EMAIL, '[email]');
  out = out.replace(/\b([a-z][a-z0-9+.-]{0,30}:\/\/)([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,8})(:\d{1,5})?/gi, (m, scheme, host, port) => (privateHost(host, port, hub) ? `${scheme}[host]` : m));
  // "1.2.3.4-beta" is a version with a prerelease tag, not an address.
  out = out.replace(PATTERNS.IPV4, (m, at, all) => (KEEP_IPS.has(m) || /^-[a-z]/i.test(all.slice(at + m.length)) ? m : '[ip]'));
  // IPv6 needs a digit: "a::b" and "std::vector" are code.
  out = out.replace(PATTERNS.IPV6, (m) => (KEEP_IPS.has(m) || !/\d/.test(m) ? m : '[ip]'));
  out = out.replace(PATTERNS.BARE_HOST, (m, host, port) => (privateHost(host, port, hub) ? '[host]' : m));
  return out.replace(PATTERNS.PHONE, (m) => (phoneOk(m) ? '[phone]' : m));
}
// scrubText for a one-line title: runs of spaces left by removals fold to one.
const scrubTitle = (text, opts) => scrubText(text, opts).replace(/[ \t]{2,}/g, ' ');

module.exports = { scrub, scrubText, scrubTitle, redactSecretsPass, maskPii, hashName, cleanJsonError, PATTERNS, MAX_LINE };
