'use strict';
// One way to organise work in every view: five plain status buckets, a
// project that is the repository (worktrees fold into their repo), and a
// short human title made by rules, never by a model.
//
// Pure and browser-safe (the same UMD shape as attention-inbox.js). It never
// reads files or runs git itself: createGitInfoResolver takes the git runner
// and the origin resolver from main and caches what they answer. Renderers
// receive only heading/sub/title strings, never a path.
//
// Every title and prompt is untrusted text. It is cut, normalised (NFKC,
// control and bidi characters removed) and only then scrubbed for secrets and
// personal numbers by src/scrub.js's redactSecretsPass. Where that scrubber is
// not available (a renderer), prompt text is never used for a title.
(function (root) {
  const MAX_TITLE = 60;
  const MAX_INPUT = 4000;
  const FALLBACK = 'Other work';
  // FALLBACK is a heading; inside a sentence ("Stuck: … silent for 7 min") a view says this instead.
  const SENTENCE_FALLBACK = 'a session';

  // heading: a section or status line; label: the short form for a badge, pill or column.
  const BUCKETS = Object.freeze([
    Object.freeze({ id: 'needs', heading: 'Needs you', label: 'Needs you', order: 0, collapsed: false }),
    Object.freeze({ id: 'working', heading: 'Working on it', label: 'Working on it', order: 1, collapsed: false }),
    Object.freeze({ id: 'check', heading: 'Finished — check it', label: 'Check it', order: 2, collapsed: false }),
    Object.freeze({ id: 'stuck', heading: 'Stuck or failed', label: 'Stuck or failed', order: 3, collapsed: false }),
    Object.freeze({ id: 'idle', heading: 'Idle', label: 'Idle', order: 4, collapsed: true }),
  ]);
  const BUCKET_BY_ID = Object.freeze(Object.fromEntries(BUCKETS.map((b) => [b.id, b])));

  // Session hook signals, capture phases, board run states, team states and
  // the labels views show today, all in one table. Keys are lower-cased.
  const SIGNALS = Object.freeze({
    needs: ['permission-ask', 'user-question', 'question-ask', 'question', 'plan-approval', 'plan', 'approval', 'blocked',
      'failed_limit', 'limit-hit', 'limit', 'budget', 'budget-reached', 'waiting', 'input', 'needs-input', 'needs_input',
      'waiting on you', 'needs input', 'need input', 'needs you', 'limit reached', 'waiting for your input'],
    working: ['session-start-working', 'prompt-submit', 'tool-use', 'tool-done', 'tool-failed', 'permission-denied', 'compact',
      'compacting', 'subagent-start', 'subagent-done', 'running', 'claimed', 'queued', 'quiet', 'working', 'reconnecting',
      'handing_over', 'handed_over', 'dispatched', 'in_progress', 'in-progress', 'in progress'],
    check: ['stop', 'review', 'in_review', 'in-review', 'turn stopped', 'ready for review', 'in review', 'check it'],
    stuck: ['stuck', 'stuck?', 'turn-failed', 'turn failed', 'failed', 'stalled', 'orphaned', 'unresponsive', 'error'],
    idle: ['idle', 'idle-nudge', 'ready', 'session-start', 'ended', 'session-end', 'stale', 'status unknown', 'todo', 'parked',
      'suspended', 'done', 'merged', 'approved_done', 'last reported: needs input', 'unknown'],
  });
  // A view's own words map back too: "working on it", "check it".
  const BUCKET_OF = Object.freeze(Object.fromEntries([
    ...Object.entries(SIGNALS).flatMap(([id, keys]) => keys.map((k) => [k, id])),
    ...BUCKETS.flatMap((b) => [[b.heading.toLowerCase(), b.id], [b.label.toLowerCase(), b.id]]),
  ]));

  // signal | state | {signal|state|status, fail_kind, changes} → bucket id.
  // A failure that is a limit or budget needs the person, not a retry; a turn
  // that stopped without changing anything has nothing to check. Anything
  // unknown is Idle: never invent urgency.
  function bucketOf(input) {
    const o = input !== null && typeof input === 'object' ? input : { state: input };
    const raw = [o.signal, o.state, o.status, o.run_state].find((v) => typeof v === 'string' && v.trim());
    const k = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 60) : '';
    if (Object.hasOwn(BUCKET_BY_ID, k)) return k;
    const id = Object.hasOwn(BUCKET_OF, k) ? BUCKET_OF[k] : 'idle';
    if (id === 'stuck' && ['limit', 'budget'].includes(o.fail_kind)) return 'needs';
    if (id === 'check' && o.changes === false) return 'idle';
    return id;
  }
  // Whether a state word is one bucketOf actually knows, rather than one it files under Idle by default.
  const knowsState = (v) => typeof v === 'string' && Object.hasOwn(BUCKET_OF, v.trim().toLowerCase().slice(0, 60));
  // The same input → the bucket's heading, so a view never names a state its own way.
  const headingOf = (input) => BUCKET_BY_ID[bucketOf(input)].heading;

  // ---- untrusted text ----
  const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
  // Invisible characters (zero-width, bidi, soft hyphen, combining grapheme joiner, Hangul and
  // Braille fillers, variation selectors, tag characters) are removed, not spaced: a secret
  // split by one is whole again for the scrubber.
  const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
  const BLOCK = /<([A-Za-z][\w:.-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/g;
  const TAG = /<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?>/g;
  const URL_RE = /\b[a-z][a-z0-9+.-]{1,30}:\/\/\S*/gi;
  // A path runs to a space, quote or bracket. Home folders, UNC shares and ~ paths go
  // wherever they are, even glued to a word; any other absolute, drive or dotted path
  // starts at anything that isn't part of a word (so "CI/CD" and "and/or" stay).
  const PATH_CHARS = '[^\\s"\'`()<>\\[\\]{}|,;]*';
  const HOME_RE = new RegExp(`(?:[A-Za-z]:)?(?<![\\\\/])[\\\\/]+(?:Users|home)(?:[\\\\/]${PATH_CHARS}|(?![\\w.-]))`, 'g');
  const UNC_RE = new RegExp(`\\\\\\\\${PATH_CHARS}`, 'g');
  // A home folder named without its leading slash ("see home/sam", "users\\sam"), any case.
  const PATH_SEG = '[^\\s"\'`()<>\\[\\]{}|,;\\\\/]+';
  const ANY_HOME = '(?:[Uu][Ss][Ee][Rr][Ss]|[Hh][Oo][Mm][Ee])';
  const LEAD = '(?<![\\w.~%$-])';
  const BARE_HOME_RE = new RegExp(`${LEAD}${ANY_HOME}[\\\\/]+${PATH_SEG}${PATH_CHARS}`, 'g');
  // A title a person typed can name a route such as "Fix home/about page", so there a
  // two-segment one goes only when nothing but punctuation follows it; deeper paths
  // and macOS's own "Users/sam" always go.
  const TYPED_HOME_RE = new RegExp(`${LEAD}(?:Users[\\\\/]+${PATH_SEG}${PATH_CHARS}|${ANY_HOME}[\\\\/]+${PATH_SEG}(?:[\\\\/]+${PATH_CHARS}|(?=\\s*(?:$|[;,:!?.)\\]}>"\'\`|]))))`, 'g');
  const HOME_VAR_RE = new RegExp(`\\$(?:\\{HOME\\}|HOME(?![\\w]))${PATH_CHARS}`, 'g');
  const TILDE_RE = new RegExp(`~[\\w.-]*[\\\\/]${PATH_CHARS}|(?<![\\w.~%-])~[A-Za-z_][\\w.-]*`, 'g');
  const PATH_RE = new RegExp(`(?<![\\w.~%-])(?:[A-Za-z]:|\\.{1,2})?[\\\\/]${PATH_CHARS}`, 'g');
  // A pipe glued to a removed path (cfg|/etc/hosts) goes with it.
  const stripPaths = (t, typed = false) => t.replace(/\|(?=[~\\/]|[A-Za-z]:[\\/])/g, ' ').replace(HOME_RE, ' ').replace(HOME_VAR_RE, ' ').replace(typed ? TYPED_HOME_RE : BARE_HOME_RE, ' ').replace(UNC_RE, ' ').replace(TILDE_RE, ' ').replace(PATH_RE, ' ').replace(REL_PATH, ' ').replace(/[[{(]\s*[\]})]/g, ' ');
  // Relative paths: a word/word token with a file extension or two separators.
  const REL_PATH = /(?<![\w.-])[\w.-]+(?:[\\/][\w.-]+)*[\\/][\w-]+\.[A-Za-z0-9]{1,8}(?![\w.-])|(?<![\w.-])[\w.-]+(?:[\\/][\w.-]+){2,}[\\/]?(?![\w.-])/g;
  // Percent-encoding is undone once, for printable ASCII only, so "%2FUsers%2Fsam" is a path the
  // rules above can see; a separator still encoded after that (double-encoded) takes its token.
  const decodePercent = (t) => t.replace(/%([2-7][0-9A-Fa-f])/g, (m, h) => {
    const c = parseInt(h, 16);
    return c < 0x7f ? String.fromCharCode(c) : m;
  });
  const ENCODED_SEPARATOR = /%(?:25)*(?:2[Ff]|5[Cc])/;
  const dropEncoded = (t) => (t.includes('%') ? t.split(/(\s+)/).map((w) => (ENCODED_SEPARATOR.test(w) ? ' ' : w)).join('') : t);
  const REDACTED = /\[(?:redacted|email|ip|user|host|card|iban|sa-id|ssn|nino|passport)\]|<redacted(?::\w+)?>/i;
  // A redacted value takes the word it was glued to with it ("sk-[redacted]").
  // Token by token, so a long run without spaces is read once, not once per character.
  const dropRedacted = (t) => t.split(/(\s+)/).map((w) => (REDACTED.test(w) ? ' ' : w)).join('');

  let defaultRedact = null;
  if (typeof module === 'object' && module.exports && typeof require === 'function') {
    try {
      // The same scrub as a title bound for a team hub (review L2), so a title made here
      // can be shared later (PR 5 cards, PR 10 suggestions) without a second pass.
      defaultRedact = require('./scrub.js').scrubTitle;
    } catch { defaultRedact = null; }
  }

  // Cut, normalise, strip control characters — before any scrubbing, so a
  // secret split by a zero-width space or written in full-width letters is
  // whole again when the scrubber reads it.
  function normalise(v) {
    if (typeof v !== 'string') return '';
    // NFKC can make one character five (U+3315): cut again after it.
    const t = v.slice(0, MAX_INPUT).normalize('NFKC').slice(0, MAX_INPUT);
    return t.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/[\ud800-\udfff]/g, (c, i, s) => {
      const code = c.charCodeAt(0);
      if (code < 0xdc00) return /[\udc00-\udfff]/.test(s[i + 1] || '') ? c : ' ';
      return /[\ud800-\udbff]/.test(s[i - 1] || '') ? c : ' ';
    });
  }

  function stripMarkup(t) {
    let out = t.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
    if (out.includes('<')) {
      // Nested blocks peel one level a pass; capped, so a crafted nesting cannot run long.
      for (let i = 0, prev; i < 5 && prev !== out; i++) { prev = out; out = out.replace(BLOCK, ' '); }
      // A lone tag is dropped without a space, so a token it split is whole again.
      out = out.replace(TAG, '');
    }
    return out;
  }

  // Untrusted text → safe display text, or '' when nothing usable is left.
  // `slashes: false` also turns any remaining / or \ into a space, for text
  // that was derived (not typed as a title by a person).
  function safeText(v, { redact, max = MAX_TITLE, slashes = true, typed = false } = {}) {
    return finish(prepare(v, redact, typed), { max, slashes });
  }
  // Normalised, scrubbed and stripped, but not yet cut: one scrub serves every use of a prompt.
  function prepare(v, redact, typed = false) {
    const t = decodePercent(normalise(v));
    if (!t.trim() || typeof redact !== 'function') return '';
    // Markup goes before the scrubber reads it: a tag inside a token would hide it.
    return dropEncoded(dropRedacted(stripPaths(redact(stripMarkup(t)).replace(URL_RE, ' '), typed)));
  }
  function finish(t, { max = MAX_TITLE, slashes = true } = {}) {
    const out = (slashes ? t : t.replace(/[\\/]+/g, ' ')).replace(/\s+/g, ' ').replace(/^[\s|,;]+|[\s|,;]+$/g, '');
    return cut(out, max);
  }

  function cut(t, max = MAX_TITLE) {
    const chars = Array.from(t);
    if (chars.length <= max) return t;
    const head = chars.slice(0, max - 1).join('');
    const at = head.lastIndexOf(' ');
    const base = at >= Math.floor(max / 2) ? head.slice(0, at) : head;
    return `${base.replace(/[\s,;:.\-–—·]+$/, '')}…`;
  }

  const hasWords = (t, n = 3) => (t.match(/\p{L}/gu) || []).length >= n;

  // A small non-cryptographic hash so a group key never carries a path.
  function keyOf(prefix, s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return `${prefix}-${h.toString(36)}`;
  }

  // ---- project ----
  const DEFAULT_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'development', 'dev', 'default', 'head', 'gh-pages']);
  const CANONICAL = /^([a-z0-9.-]+)\/([A-Za-z0-9._~-]+\/)+[A-Za-z0-9._~-]+$/;
  const canonical = (v) => typeof v === 'string' && v.length <= 300 && CANONICAL.test(v) && !v.split('/').some((x) => x === '.' || x === '..');
  const leafOf = (p) => {
    if (typeof p !== 'string') return '';
    const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    const leaf = parts.length ? parts[parts.length - 1] : '';
    // "." and ".." name no folder.
    return /^\.{1,2}$/.test(leaf.trim()) ? '' : leaf;
  };
  const trimSlash = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/').replace(/\/+$/, '') : '');
  const plainName = (s) => cut(normalise(s).replace(/[\\/]+/g, ' ').replace(/\s+/g, ' ').trim());
  // A folder or repo name for a heading: scrubbed when a scrubber is there.
  const named = (s, redact) => {
    const t = plainName(s);
    if (!t || typeof redact !== 'function') return t;
    return plainName(dropRedacted(redact(t)));
  };

  // A branch name is untrusted too: normalised, then scrubbed (no path
  // stripping, its slashes are separators). Unscrubbable → unused.
  function cleanBranch(branch, redact) {
    if (typeof branch !== 'string' || typeof redact !== 'function') return '';
    const b = normalise(branch).slice(0, 200).replace(/\s+/g, ' ').trim();
    if (!b) return '';
    return dropRedacted(redact(b)).replace(/\s+/g, ' ').trim();
  }

  // Branch → sub-label: agent and kind prefixes dropped, separators shown as ›.
  const AGENT_WORDS = 'claude|codex|cursor|gemini|hermes|copilot|aider|agent|bot';
  const KIND_WORDS = 'feat|feature|fix|bugfix|hotfix|chore|docs|doc|refactor|test|tests|wip|spike|release|perf|ci|build|style';
  const BRANCH_PREFIX = new RegExp(`^(?:${AGENT_WORDS}|${KIND_WORDS})[/_-]+`, 'i');
  const KIND_WORD = new RegExp(`^(?:${KIND_WORDS})$`, 'i');
  function branchSub(branch, defaultBranch, redact) {
    const b = cleanBranch(branch, redact);
    if (!b || DEFAULT_BRANCHES.has(b.toLowerCase()) || (typeof defaultBranch === 'string' && b === defaultBranch)) return null;
    let s = b;
    for (let prev; prev !== s;) { prev = s; s = s.replace(BRANCH_PREFIX, ''); }
    s = s.split(/[\\/]+/).filter(Boolean).join(' › ').replace(/\s+/g, ' ').trim();
    return s ? cut(s, 40) : null;
  }

  // {repoName, commonDir, toplevel, cwd, branch, defaultBranch, home} → {key, heading, sub}
  function projectOf(info = {}, { redact = defaultRedact } = {}) {
    const o = info !== null && typeof info === 'object' ? info : {};
    const sub = branchSub(o.branch, o.defaultBranch, redact);
    const heading = (n) => named(n, redact);
    if (canonical(o.repoName)) {
      const name = heading(leafOf(o.repoName).replace(/\.git$/i, ''));
      if (name) return { key: keyOf('repo', o.repoName.toLowerCase()), heading: name, sub };
    }
    const home = trimSlash(o.home);
    const usable = (p) => typeof p === 'string' && p.length <= 4096 && !p.includes('\0') && trimSlash(p) && trimSlash(p) !== home;
    if (usable(o.commonDir)) {
      const dir = trimSlash(o.commonDir);
      // <repo>/.git for a checkout and every worktree of it; <name>.git for a bare repo.
      const parent = /\/\.git$/i.test(dir) ? dir.slice(0, -5) : dir;
      const name = heading(parent === dir ? leafOf(dir).replace(/\.git$/i, '') : leafOf(parent));
      if (name && parent !== home) return { key: keyOf('git', dir), heading: name, sub };
    }
    for (const p of [o.toplevel, o.cwd]) {
      if (!usable(p)) continue;
      const name = heading(leafOf(p));
      if (name) return { key: keyOf('dir', trimSlash(p)), heading: name, sub: p === o.toplevel ? sub : null };
    }
    return { key: 'other', heading: FALLBACK, sub: null };
  }

  // ---- title ----
  const AI_NAMES = Object.freeze({ claude: 'Claude', 'claude-code': 'Claude', 'claude code': 'Claude', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini', hermes: 'Hermes', copilot: 'Copilot', aider: 'Aider', ollama: 'Local model', local: 'Local model' });
  const aiName = (p) => (typeof p === 'string' && Object.hasOwn(AI_NAMES, p.trim().toLowerCase()) ? AI_NAMES[p.trim().toLowerCase()] : 'AI');

  // ABC-123 (not a standard such as UTF-8 or SHA-256), #123, gh-123.
  const NOT_TICKETS = new Set(['UTF', 'SHA', 'ISO', 'GPT', 'RFC', 'CVE', 'MD', 'AES', 'RSA', 'HTTP', 'TLS', 'SSL', 'IPV', 'ES', 'ECMA', 'PEP', 'ARM', 'X', 'GH', 'PR', 'CSS', 'H', 'MP', 'COVID', 'F', 'B', 'IE', 'WCAG', 'OAUTH', 'S3', 'EC2', 'P', 'Q', 'V', 'ISSUE', 'BUG', 'BETA', 'ALPHA', 'RC', 'STEP', 'PHASE', 'PART', 'ROUND', 'WAVE', 'DAY', 'WEEK', 'SPRINT', 'PY', 'K8S']);
  // Runtimes, platforms and release words: "node-22", "release-2", "ios-17". Written in
  // capitals they can be a real project key (IOS-12, API-77, SDK-3), so only the lower-case
  // branch path skips them.
  const RELEASE_WORDS = new Set(['NODE', 'NODEJS', 'PYTHON', 'GO', 'GOLANG', 'JAVA', 'JDK', 'JRE', 'RUBY', 'RUST', 'PHP', 'PERL', 'DOTNET', 'NET', 'DENO', 'BUN', 'NPM', 'PNPM', 'YARN',
    'TS', 'JS', 'KOTLIN', 'SWIFT', 'SCALA', 'ELIXIR', 'ERLANG', 'LUA', 'GCC', 'CLANG', 'LLVM', 'CUDA', 'REACT', 'VUE', 'ANGULAR', 'NEXT', 'NUXT', 'SVELTE', 'VITE',
    'WEBPACK', 'IOS', 'IPADOS', 'MACOS', 'ANDROID', 'WIN', 'WINDOWS', 'UBUNTU', 'DEBIAN', 'ALPINE', 'CHROME', 'FIREFOX', 'SAFARI', 'PG', 'POSTGRES', 'MYSQL', 'REDIS',
    'OPENSSL', 'LTS', 'API', 'SDK', 'RELEASE', 'VERSION', 'VER', 'REV', 'PATCH', 'MINOR', 'MAJOR', 'HOTFIX', 'BUILD', 'TAG']);
  const TICKET = /(?<![A-Za-z0-9])(?:gh-(\d{1,6})|([A-Z][A-Z0-9]{1,9})-(\d{1,6})|#(\d{1,6}))(?![A-Za-z0-9])/gi;
  // In a branch, Linear's lower-case key also counts, but only straight after a person's or an
  // agent's segment, the shapes Linear and agents generate: "sam/abc-123-fix-login",
  // "codex/eng-42". Not after a kind ("feat/node-22-upgrade"), nor "release-2-prep" or
  // "work-organise-2026-10-23".
  const BRANCH_TICKET = /^([^\\/]+)[\\/]([a-z][a-z0-9]{1,9})-(\d{1,6})(?=$|[-_./])/;
  // What a branch says it does, or what made it, is never its ticket key: "codex/fix-12-bugs",
  // "agent/add-3-tests", "claude/session-2026-10-23", "bot/deps-2".
  const BRANCH_VERB = new RegExp(`^(?:${KIND_WORDS}|bug|issue|task|add|update|remove|improve|change|session|sessions|agent|agents|deps|dep|deps-dev|tmp|temp|draft|experiment|try|attempt|run|job)$`, 'i');
  // Copilot names its branch for the GitHub issue it was given: copilot/fix-1234 is issue #1234.
  const COPILOT_ISSUE = /^copilot[\\/]fix-(\d{1,6})$/i;
  function branchTicket(branch) {
    if (typeof branch !== 'string') return null;
    const issue = COPILOT_ISSUE.exec(branch);
    if (issue) return { id: `#${issue[1]}`, match: issue[0] };
    const upper = ticketIn(branch);
    if (upper && !BRANCH_VERB.test(upper.id.split('-')[0])) return upper;
    const m = BRANCH_TICKET.exec(branch);
    const key = m && m[2].toUpperCase();
    if (!m || KIND_WORD.test(m[1]) || BRANCH_VERB.test(m[2]) || NOT_TICKETS.has(key) || RELEASE_WORDS.has(key)) return null;
    return { id: `${m[2].toUpperCase()}-${m[3]}`, match: `${m[2]}-${m[3]}` };
  }
  // Elsewhere a key must be written in capitals: lower-case "organise-2026" is a word and a year.
  function ticketIn(text) {
    if (typeof text !== 'string') return null;
    for (const m of text.matchAll(TICKET)) {
      if (m[2]) {
        const k = m[2].toUpperCase();
        if (m[2] !== k || NOT_TICKETS.has(k) || /^\d+$/.test(k)) continue;
        return { id: `${k}-${m[3]}`, match: m[0] };
      }
      return { id: `#${m[1] || m[4]}`, match: m[0] };
    }
    return null;
  }

  const DATE_OR_HASH = /(?<![A-Za-z0-9])(?:\d{4}[-_.]?\d{2}[-_.]?\d{2}(?:[-_T]?\d{2}[-_:]?\d{2}(?:[-_:]?\d{2})?)?|(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}|\d{9,})(?![A-Za-z0-9])/gi;
  function humaniseBranch(branch, drop) {
    const b = typeof branch === 'string' ? branch.trim() : '';
    if (!b || DEFAULT_BRANCHES.has(b.toLowerCase())) return '';
    let s = b;
    for (let prev; prev !== s;) { prev = s; s = s.replace(BRANCH_PREFIX, ''); }
    if (drop) s = s.split(drop).join(' ');
    s = s.replace(/^.*[\\/]/, '').replace(DATE_OR_HASH, ' ').replace(/[-_.+]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!hasWords(s)) return '';
    return sentence(s);
  }

  const sentence = (s) => s.charAt(0).toLocaleUpperCase('en') + s.slice(1);

  // Greetings and filler at the start of a prompt, peeled repeatedly.
  const FILLER = /^(?:(?:hi|hello|hey|yo|ok|okay|okey|so|alright|thanks|thank you|thx|cheers|please|pls|plz|now|then|and|also|just|actually|basically|claude|codex|gemini|cursor|hermes|good (?:morning|afternoon|evening)|can you|could you|would you|will you|can we|could we|let'?s|lets|i want you to|i need you to|i'?d like you to|i would like you to|i want to|i need to|i'?d like to|we need to|we should|you should|go ahead and|try to|help me|help me to|please can you|kindly)\b[\s,!.:;-]*)+/i;
  // Words left dangling once a path or link was taken out: "fix the bug in".
  const DANGLING = /(?:\s+(?:in|at|on|for|to|from|of|with|and|or|the|a|an|into|under|inside|via|using|like|as|by))+\s*$/i;
  const TRAILING_FILLER = /[\s,]*(?:please|pls|thanks|thank you|thx|cheers|for me|if you can|asap)[\s.!?]*$/i;

  const promptSummary = (prompt, redact) => summarise(prepare(prompt, redact));
  function summarise(prepared) {
    const safe = finish(prepared, { max: MAX_INPUT, slashes: false });
    if (!safe) return '';
    for (const part of safe.split(/(?<=[.!?])\s+|\s+[-–—]\s+|[;\n]/)) {
      let s = part.replace(FILLER, '').replace(TRAILING_FILLER, '').replace(/^[\s,.:;!?'"-]+|[\s,.:;!?'"-]+$/g, '').trim();
      s = s.replace(FILLER, '').replace(DANGLING, '').trim();
      if (hasWords(s)) return cut(sentence(s));
    }
    return '';
  }

  // Display-time title. Stored titles are never rewritten. A prompt-made or
  // cron title (rules 5–6) needs either an explicitly local session
  // (team === false, no share setting) or shareSummaries === true; anything
  // else — a missing flag, a truthy string, share off — fails closed, and the
  // ticket then comes from the branch only.
  //   {human, card, reported, branch, firstPrompt, provider, project, cronJob, team, shareSummaries}
  //   → {title, source}
  function titleOf(input = {}, { redact = defaultRedact } = {}) {
    const o = input !== null && typeof input === 'object' ? input : {};
    const shared = o.shareSummaries === true || o.share_summaries === true;
    const local = o.team === false && o.shareSummaries === undefined && o.share_summaries === undefined;
    const promptsAllowed = (shared || local) && typeof redact === 'function';
    const typed = (v) => safeText(v, { redact: typeof redact === 'function' ? redact : (t) => t, typed: true });
    for (const source of ['human', 'card', 'reported']) {
      const t = typed(o[source]);
      if (t && hasWords(t, 1)) return { title: t, source };
    }
    const branchRaw = cleanBranch(o.branch, redact);
    const prompt = promptsAllowed ? prepare(o.firstPrompt, redact) : '';
    const summary = summarise(prompt);
    const fromBranch = branchTicket(branchRaw);
    const fromPrompt = !fromBranch && prompt ? ticketIn(finish(prompt, { max: MAX_INPUT })) : null;
    const ticket = fromBranch || fromPrompt;
    if (ticket) {
      const rest = (fromBranch ? humaniseBranch(branchRaw, fromBranch.match) : '') || stripTicket(summary, ticket.match);
      return { title: cut(rest ? `${ticket.id} · ${rest}` : ticket.id), source: 'ticket' };
    }
    const named = humaniseBranch(branchRaw);
    if (named) return { title: cut(named), source: 'branch' };
    if (summary) return { title: summary, source: 'prompt' };
    if (promptsAllowed) {
      const job = plainName(safeText(o.cronJob, { redact, max: 50, slashes: false }));
      if (job && hasWords(job, 1)) return { title: cut(`Scheduled: ${job}`), source: 'cron' };
    }
    const project = typeof o.project === 'string' ? plainName(safeText(o.project, { redact: typeof redact === 'function' ? redact : (t) => t, slashes: false })) : '';
    const ai = aiName(o.provider);
    return { title: cut(project && project !== FALLBACK ? `${ai} session in ${project}` : `${ai} session`), source: 'fallback' };
  }

  function stripTicket(summary, match) {
    if (!summary || !match) return summary || '';
    const s = summary.split(match).join(' ').replace(/^[\s:·,-]+|[\s:·,-]+$/g, '').replace(/\s+/g, ' ').trim();
    return hasWords(s) ? sentence(s) : '';
  }

  // ---- grouping ----
  const BY = Object.freeze({ project: 'project', bucket: 'bucket', status: 'bucket', provider: 'provider', tool: 'provider', ai: 'provider' });
  const rowBucket = (r) => (r && typeof r.bucket === 'string' && Object.hasOwn(BUCKET_BY_ID, r.bucket) ? r.bucket : bucketOf(r && (r.signal ?? r.state ?? r.status)));

  // rows → [{key, heading, sub, count, counts, rows, groups?}]. Rows keep
  // their order within a group. Buckets come in their fixed order; projects
  // and AI tools alphabetically, with "Other work" last. `then` nests a
  // second grouping inside each group (e.g. project, then bucket).
  function group(rows, by = 'project', { then = null } = {}) {
    const kind = Object.hasOwn(BY, by) ? BY[by] : 'project';
    const list = Array.isArray(rows) ? rows.filter((r) => r !== null && typeof r === 'object') : [];
    const groups = new Map();
    for (const r of list) {
      let g;
      if (kind === 'bucket') {
        const b = BUCKET_BY_ID[rowBucket(r)];
        g = { key: b.id, heading: b.heading, sub: null, order: b.order, collapsed: b.collapsed };
      } else if (kind === 'provider') {
        const ai = aiName(r.provider);
        g = { key: `ai-${ai.toLowerCase().replace(/\s+/g, '-')}`, heading: ai, sub: null };
      } else {
        const p = r.project && typeof r.project === 'object' && typeof r.project.key === 'string' && typeof r.project.heading === 'string' ? r.project : projectOf(r.project || {});
        g = { key: p.key, heading: p.heading, sub: p.sub ?? null };
      }
      if (!groups.has(g.key)) groups.set(g.key, { ...g, rows: [] });
      const into = groups.get(g.key);
      // Worktrees of one repo on different branches share a group: no single branch then.
      if (into.sub !== g.sub) into.sub = null;
      into.rows.push(r);
    }
    const out = [...groups.values()].map((g) => {
      const counts = Object.fromEntries(BUCKETS.map((b) => [b.id, 0]));
      for (const r of g.rows) counts[rowBucket(r)]++;
      const res = { ...g, count: g.rows.length, counts };
      if (then && Object.hasOwn(BY, then) && BY[then] !== kind) res.groups = group(g.rows, then);
      return res;
    });
    if (kind === 'bucket') out.sort((a, b) => a.order - b.order);
    else out.sort((a, b) => Number(a.key === 'other') - Number(b.key === 'other') || a.heading.localeCompare(b.heading, 'en', { sensitivity: 'base' }) || (a.sub || '').localeCompare(b.sub || ''));
    return out;
  }

  // ---- git info (main only; injected runner, cached) ----
  // git(dir, args) → Promise<stdout>, the shape agent-awareness.js uses;
  // repoFor(cwd) → Promise<canonical origin | null>, work-capture.js's;
  // realpath(p) → Promise<string>, so a symlinked cwd folds with its worktrees.
  const isAbs = (p) => /^(?:\/|[A-Za-z]:[\\/])/.test(p);
  function resolveFrom(base, rel) {
    if (isAbs(rel)) return rel;
    const parts = trimSlash(base).split('/');
    for (const seg of rel.replace(/\\/g, '/').split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (parts.length > 1) parts.pop(); } else parts.push(seg);
    }
    return parts.join('/') || '/';
  }

  /**
   * @param {object} opts
   * @param {(dir: string, args: string[]) => Promise<string>} opts.git
   * @param {(cwd: string) => Promise<string|null>} [opts.repoFor]
   * @param {(p: string) => Promise<string>} [opts.realpath] The caller must pass
   *   `fsp.realpath` (node:fs/promises). The default is the identity, so without it a session
   *   started from a symlinked folder (/tmp vs /private/tmp, a linked checkout) is not folded
   *   into the same project as its real path.
   *
   * Stale-while-revalidate (organised views PR 3): a view asks groupOf(cwd) synchronously on every
   * render, so main never waits on git to draw a list. A good answer is kept until a new good one
   * arrives; a lookup git could not finish (a spawn error, a timeout, a kill) never replaces it and
   * is retried after a short backoff, not after the TTL. At most `concurrency` lookups run at once,
   * one per cwd, and each answer's TTL is jittered so a cold start does not expire on one tick.
   */
  function createGitInfoResolver({ git, repoFor = async () => null, realpath = async (p) => p, now = () => Date.now(), ttlMs = 60_000, max = 500, concurrency = 4, jitter = 0.2, random = Math.random, backoffMs = [5_000, 15_000, 30_000] } = {}) {
    if (typeof git !== 'function') throw new TypeError('git runner required');
    const cache = new Map(); // cwd → { good, expires, fails, retryAt, suspect, pending }
    const empty = Object.freeze({ repoName: null, commonDir: null, toplevel: null, branch: null });
    // A plain non-zero exit is an answer ("not a repository", "no branch"); anything else is git not answering.
    const broke = (e) => typeof e?.code !== 'number' || !!e.killed || !!e.signal;
    const call = (fn) => Promise.resolve().then(fn).then((v) => ({ v, broken: false }), (e) => ({ v: null, broken: broke(e) }));
    const real = async (p) => { const { v } = await call(() => realpath(p)); return typeof v === 'string' && isAbs(v) && !v.includes('\0') ? v : p; };
    async function look(cwd) {
      const dir = await real(cwd);
      // The branch is asked for on its own: rev-parse --abbrev-ref HEAD fails (128) in a repo
      // with no commits yet, and that must not make the whole repo unresolved.
      const [top, ref, origin] = await Promise.all([
        call(() => git(dir, ['rev-parse', '--show-toplevel', '--git-common-dir'])),
        call(() => git(dir, ['symbolic-ref', '--short', '-q', 'HEAD'])),
        call(() => repoFor(dir)),
      ]);
      const out = top.v, repoName = origin.v;
      const lines = typeof out === 'string' ? out.replace(/\n$/, '').split('\n') : null;
      // A path with a newline in it shifts every line after it: anything but two answers is unresolved.
      const ok = lines && lines.length === 2 && lines.every((l) => l && !l.includes('\0'));
      const head = typeof ref.v === 'string' ? ref.v.replace(/\n$/, '') : '';
      const [toplevel, commonDir] = ok ? await Promise.all([real(lines[0]), real(resolveFrom(dir, lines[1]))]) : [null, null];
      const value = Object.freeze({
        repoName: canonical(repoName) ? repoName : null,
        toplevel,
        commonDir,
        branch: ok && head && !head.includes('\n') && !head.includes('\0') ? head.slice(0, 200) : null,
      });
      return { value, broken: top.broken || ref.broken };
    }

    let active = 0;
    const waiting = [];
    const pump = () => { while (active < concurrency && waiting.length) { active++; const job = waiting.shift(); job().finally(() => { active--; pump(); }); } };
    const queued = (fn) => new Promise((res) => { waiting.push(() => fn().then(res, () => res(null))); pump(); });

    const life = () => Math.max(1, Math.round(ttlMs * (1 + jitter * (2 * random() - 1))));
    // Losing what the last good answer had (its origin or its repository) is believed only when the
    // next lookup says the same: one slow `git config` must not move a repo's sessions to a folder group.
    const loses = (was, next) => (was.repoName && !next.repoName) || (was.commonDir && !next.commonDir);
    function refresh(cwd, e) {
      if (e.pending) return e.pending;
      e.pending = queued(() => look(cwd)).then((r) => {
        e.pending = null;
        const t = now();
        if (r && !r.broken && !(e.good && loses(e.good, r.value) && !e.suspect)) {
          e.good = r.value; e.expires = t + life(); e.fails = 0; e.retryAt = 0; e.suspect = false;
        } else {
          if (r && !r.broken) e.suspect = true;
          e.fails++;
          e.retryAt = t + Math.min(ttlMs, backoffMs[Math.min(e.fails, backoffMs.length) - 1] ?? ttlMs);
        }
        return e.good ?? empty;
      });
      return e.pending;
    }
    const valid = (cwd) => typeof cwd === 'string' && isAbs(cwd) && cwd.length <= 2000 && !cwd.includes('\0');
    function entry(cwd) {
      let e = cache.get(cwd);
      if (e) { cache.delete(cwd); cache.set(cwd, e); } // least recently used goes first
      else {
        e = { good: null, expires: 0, fails: 0, retryAt: 0, suspect: false, pending: null };
        cache.set(cwd, e);
        while (cache.size > max) cache.delete(cache.keys().next().value);
      }
      return e;
    }
    // Starts a lookup when the answer is missing or old and no retry is waiting; returns the entry.
    function touch(cwd) {
      const e = entry(cwd), t = now();
      if ((!e.good || t >= e.expires) && t >= e.retryAt) refresh(cwd, e);
      return e;
    }
    // → Promise<info>: the good answer at once when there is one (fresh or not); a cold cwd waits for its lookup.
    function resolve(cwd) {
      if (!valid(cwd)) return Promise.resolve(empty);
      const e = touch(cwd);
      if (e.good) return Promise.resolve(e.good);
      return e.pending ?? Promise.resolve(empty);
    }
    // → {key, heading, sub, pending}, synchronously: the last good answer, or the folder while none is in yet.
    function groupOf(cwd, extra = {}) {
      if (!valid(cwd)) return { ...projectOf({}), pending: false };
      const e = touch(cwd);
      return { ...projectOf({ ...(e.good ?? {}), ...extra, cwd }), pending: !e.good };
    }
    const idle = () => Promise.all([...cache.values()].map((e) => e.pending).filter(Boolean)).then(() => (active || waiting.length ? idle() : undefined));
    return { resolve, groupOf, idle, clear: () => cache.clear(), size: () => cache.size };
  }

  // QoL4a: My sessions' "Find a session". A case-insensitive substring of the task title, project (folder name), AI
  // tool, device, board, card key, or any child agent's label or task; an empty query matches everything.
  function matchesQuery(e, query) {
    const q = typeof query === 'string' ? query.trim().toLocaleLowerCase() : '';
    if (!q) return true;
    if (!e || typeof e !== 'object') return false;
    const kids = Array.isArray(e.children) ? e.children : [];
    const hay = [e.task?.title, e.project, e.provider?.label, e.device?.label, e.board?.label, e.card?.key, ...kids.flatMap((c) => [c?.label, c?.task?.title])];
    return hay.some((x) => typeof x === 'string' && x.toLocaleLowerCase().includes(q));
  }

  const api = { BUCKETS, FALLBACK, SENTENCE_FALLBACK, headingOf, MAX_TITLE, bucketOf, knowsState, projectOf, keyOf, titleOf, group, createGitInfoResolver, safeText, promptSummary, humaniseBranch, matchesQuery };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlexiformWorkOrganise = Object.freeze(api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
