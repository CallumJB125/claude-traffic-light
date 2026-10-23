const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const W = require('../src/work-organise.js');
const { BUCKETS, FALLBACK, MAX_TITLE, bucketOf, projectOf, titleOf, group, createGitInfoResolver } = W;

const HOME = '/Users/sam';
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'work-organise.js'), 'utf8');

test('work-organise: five buckets, fixed order and plain headings', () => {
  assert.deepEqual(BUCKETS.map((b) => b.heading), ['Needs you', 'Working on it', 'Finished — check it', 'Stuck or failed', 'Idle']);
  assert.deepEqual(BUCKETS.map((b) => b.order), [0, 1, 2, 3, 4]);
  assert.deepEqual(BUCKETS.filter((b) => b.collapsed).map((b) => b.id), ['idle']);
  assert.ok(Object.isFrozen(BUCKETS) && Object.isFrozen(BUCKETS[0]));
});

test('work-organise: bucketOf maps hook signals, capture phases, board states and today\'s labels', () => {
  const cases = {
    needs: ['permission-ask', 'user-question', 'question-ask', 'plan-approval', 'blocked', 'failed_limit', 'limit-hit', 'budget', 'waiting', 'input', 'Waiting on you', 'Needs input', 'Need input', 'Needs you', 'Limit reached', 'Waiting for your input'],
    working: ['prompt-submit', 'tool-use', 'tool-done', 'tool-failed', 'permission-denied', 'compact', 'Compacting', 'subagent-start', 'subagent-done', 'running', 'claimed', 'queued', 'quiet', 'Working', 'reconnecting', 'handing_over'],
    check: ['stop', 'review', 'in_review', 'Turn stopped', 'Ready for review', 'In review'],
    stuck: ['stuck', 'Stuck?', 'turn-failed', 'Turn failed', 'failed', 'stalled', 'orphaned', 'unresponsive'],
    idle: ['idle', 'idle-nudge', 'Ready', 'session-start', 'ended', 'session-end', 'Ended', 'stale', 'Status unknown', 'todo', 'parked', 'suspended', 'done', 'Last reported: Needs input'],
  };
  for (const [want, inputs] of Object.entries(cases)) {
    for (const s of inputs) assert.equal(bucketOf(s), want, s);
  }
});

test('work-organise: bucketOf objects, ids pass through, unknown is Idle', () => {
  assert.equal(bucketOf({ state: 'failed', fail_kind: 'limit' }), 'needs');
  assert.equal(bucketOf({ run_state: 'failed', fail_kind: 'budget' }), 'needs');
  assert.equal(bucketOf({ state: 'failed', fail_kind: 'network' }), 'stuck');
  assert.equal(bucketOf({ signal: 'stop', changes: false }), 'idle');
  assert.equal(bucketOf({ signal: 'stop', changes: true }), 'check');
  assert.equal(bucketOf({ status: 'review' }), 'check');
  for (const b of BUCKETS) assert.equal(bucketOf(b.id), b.id);
  for (const v of [undefined, null, 42, '', '   ', 'zzz', {}, [], 'x'.repeat(10_000), { state: 7 }]) assert.equal(bucketOf(v), 'idle');
  assert.equal(bucketOf('  PERMISSION-ASK  '), 'needs');
  assert.equal(bucketOf('constructor'), 'idle');
  assert.equal(bucketOf('__proto__'), 'idle');
});

test('work-organise: projectOf — repo first, worktrees fold, folder leaf, then one fallback', () => {
  const main = projectOf({ commonDir: '/Users/sam/dev/claude-traffic-light/.git', toplevel: '/Users/sam/dev/claude-traffic-light', branch: 'main', home: HOME });
  const wt = projectOf({ commonDir: '/Users/sam/dev/claude-traffic-light/.git', toplevel: '/Users/sam/work/awareness-p4', branch: 'codex/views-plan', home: HOME });
  assert.equal(main.heading, 'claude-traffic-light');
  assert.equal(wt.heading, 'claude-traffic-light');
  assert.equal(main.key, wt.key, 'a worktree is the same project as its repo');
  assert.equal(main.sub, null, 'default branch: no sub-label');
  assert.equal(wt.sub, 'views-plan');

  const origin = projectOf({ repoName: 'github.com/acme/claude-traffic-light', commonDir: '/elsewhere/clone/.git' });
  const origin2 = projectOf({ repoName: 'github.com/acme/claude-traffic-light', commonDir: '/other/clone/.git' });
  assert.equal(origin.heading, 'claude-traffic-light');
  assert.equal(origin.key, origin2.key, 'two clones of one origin are one project');
  assert.equal(projectOf({ repoName: 'gitlab.com/g/sub/proj.git' }).heading, 'proj');
  assert.equal(projectOf({ repoName: '../../etc/passwd', cwd: '/srv/app' }).heading, 'app', 'a malformed origin is ignored');

  assert.equal(projectOf({ commonDir: '/srv/repos/tools.git' }).heading, 'tools', 'bare repo');
  assert.equal(projectOf({ cwd: '/Users/sam/scratch/notes' }).heading, 'notes', 'no git: folder leaf');
  assert.equal(projectOf({ cwd: 'C:\\Users\\sam\\code\\api\\' }).heading, 'api');
  assert.equal(projectOf({ toplevel: '/x/app', cwd: '/x/app/src', branch: 'feat/a' }).heading, 'app');
  for (const o of [{}, null, undefined, { cwd: '/' }, { cwd: HOME, home: HOME }, { cwd: `${HOME}/`, home: HOME }, { commonDir: `${HOME}/.git`, home: HOME }, { cwd: 'a\0b' }, { cwd: 42 }]) {
    assert.deepEqual(projectOf(o), { key: 'other', heading: FALLBACK, sub: null }, JSON.stringify(o));
  }
});

test('work-organise: projectOf keys and sub-labels never carry a path', () => {
  const p = projectOf({ commonDir: '/Users/sam/secret-client/app/.git', branch: 'claude/feat/big/idea', home: HOME });
  assert.doesNotMatch(p.key, /[\\/]|sam|secret/);
  assert.equal(p.sub, 'big › idea');
  assert.equal(projectOf({ cwd: '/a/b', branch: 'HEAD' }).sub, null);
  assert.equal(projectOf({ cwd: '/a/b', branch: 'release-x', defaultBranch: 'release-x' }).sub, null);
});

const T = (input, want, source) => ({ input, want, source });
const TITLES = [
  // 1–2: typed and reported titles win, cleaned.
  T({ human: '  Ship   grouping ', card: 'Card', reported: 'Rep' }, 'Ship grouping', 'human'),
  T({ card: 'Board card title', reported: 'Rep' }, 'Board card title', 'card'),
  T({ reported: 'Reported task', firstPrompt: 'do x' }, 'Reported task', 'reported'),
  T({ human: '<system-reminder>x</system-reminder>  ', card: 'Card wins' }, 'Card wins', 'card'),
  T({ human: '\u202eevil\u202c title' }, 'evil title', 'human'),
  // 3: tickets.
  T({ branch: 'feat/ABC-123-add-grouping' }, 'ABC-123 · Add grouping', 'ticket'),
  T({ branch: 'gh-12-fix-login' }, '#12 · Fix login', 'ticket'),
  T({ branch: 'codex/PLX-7' }, 'PLX-7', 'ticket'),
  T({ firstPrompt: 'Please fix #45 where the login loops' }, '#45 · Fix where the login loops', 'ticket'),
  T({ firstPrompt: 'KEY-9: tidy the settings page' }, 'KEY-9 · Tidy the settings page', 'ticket'),
  T({ firstPrompt: 'Make the parser UTF-8 safe' }, 'Make the parser UTF-8 safe', 'prompt'),
  T({ firstPrompt: 'Check SHA-256 sums in the release' }, 'Check SHA-256 sums in the release', 'prompt'),
  // 4: branches humanised.
  T({ branch: 'codex/work-organise-2026-10-23' }, 'Work organise', 'branch'),
  T({ branch: 'feat/organised-views' }, 'Organised views', 'branch'),
  T({ branch: 'claude/fix/retry_backoff-3f9a2c1d' }, 'Retry backoff', 'branch'),
  T({ branch: 'main', firstPrompt: 'Add dark mode' }, 'Add dark mode', 'prompt'),
  T({ branch: 'wip/2026-10-01', firstPrompt: 'Add dark mode' }, 'Add dark mode', 'prompt'),
  // 5: first prompt summarised.
  T({ firstPrompt: 'ok so can you please fix the login redirect bug in /Users/sam/app/src/login.ts thanks' }, 'Fix the login redirect bug', 'prompt'),
  T({ firstPrompt: 'Hi! Hello. Can you add a CSV export to the reports page? Then email me.' }, 'Add a CSV export to the reports page', 'prompt'),
  T({ firstPrompt: '<command-name>/review</command-name> ok now do the same for the other one but keep the tests' }, 'Do the same for the other one but keep the tests', 'prompt'),
  T({ firstPrompt: 'look at https://example.com/a?q=1 and summarise it' }, 'Look at and summarise it', 'prompt'),
  T({ firstPrompt: 'look at https://example.com/a?token=abc and summarise it' }, 'Look', 'prompt'),
  T({ firstPrompt: '```js\nconst x = 1;\n```\nrefactor the loader' }, 'Refactor the loader', 'prompt'),
  T({ firstPrompt: 'update src/foo/bar.js and the docs' }, 'Update and the docs', 'prompt'),
  T({ firstPrompt: 'let\'s migrate C:\\Users\\sam\\db to postgres' }, 'Migrate to postgres', 'prompt'),
  T({ firstPrompt: 'i need you to rename ~/notes/today.md to tomorrow' }, 'Rename to tomorrow', 'prompt'),
  T({ firstPrompt: 'ＦＩＸ the ｆｕｌｌ-width text' }, 'FIX the full-width text', 'prompt'),
  T({ firstPrompt: 'refactor\u0007the\u001b caching\u0000 layer' }, 'Refactor the caching layer', 'prompt'),
  T({ firstPrompt: 'refac\u200btor the\u00ad cache' }, 'Refactor the cache', 'prompt'),
  T({ firstPrompt: 'ok', provider: 'claude', project: 'app' }, 'Claude session in app', 'fallback'),
  T({ firstPrompt: '/clear', provider: 'codex' }, 'Codex session', 'fallback'),
  T({ firstPrompt: '   ', provider: 'gemini', project: FALLBACK }, 'Gemini session', 'fallback'),
  // 6: cron.
  T({ cronJob: 'nightly-digest', provider: 'hermes' }, 'Scheduled: nightly-digest', 'cron'),
  T({ cronJob: 'jobs/sync', provider: 'hermes' }, 'Scheduled: jobs sync', 'cron'),
  // 7: fallback, never the bare folder.
  T({ provider: 'codex', project: 'work' }, 'Codex session in work', 'fallback'),
  T({ provider: 'mystery' }, 'AI session', 'fallback'),
  T({}, 'AI session', 'fallback'),
];

test('work-organise: titleOf rule table', () => {
  for (const { input, want, source } of TITLES) {
    assert.deepEqual(titleOf({ team: false, ...input }), { title: want, source }, JSON.stringify(input));
  }
});

test('work-organise: first prompt, not last, so a title is stable across turns', () => {
  const a = titleOf({ team: false, firstPrompt: 'Add CSV export', lastPrompt: 'turn 1' });
  const b = titleOf({ team: false, firstPrompt: 'Add CSV export', lastPrompt: 'turn 9: change everything' });
  assert.deepEqual(a, b);
  assert.equal(a.title, 'Add CSV export');
});

test('work-organise: team titles never come from prompts or cron without share_summaries', () => {
  const base = { firstPrompt: 'Fix KEY-4 in the billing flow for our biggest client', cronJob: 'nightly', provider: 'claude', project: 'billing', team: true };
  assert.deepEqual(titleOf(base), { title: 'Claude session in billing', source: 'fallback' });
  assert.deepEqual(titleOf({ ...base, shareSummaries: false }), { title: 'Claude session in billing', source: 'fallback' });
  assert.deepEqual(titleOf({ ...base, branch: 'feat/KEY-4-billing' }), { title: 'KEY-4 · Billing', source: 'ticket' }, 'branch stays usable: presence already shares it');
  assert.equal(titleOf({ ...base, shareSummaries: true }).source, 'ticket');
  assert.deepEqual(titleOf({ ...base, card: 'Billing fixes' }), { title: 'Billing fixes', source: 'card' });
});

test('work-organise: secrets and personal numbers are scrubbed out of every title source', () => {
  const secrets = ['sk-abcdefghijklmnopqrstuvwx', 'ghp_' + 'a1B2'.repeat(9), 'AKIAIOSFODNN7EXAMPLE', 'hunter2', 'sam@example.com', '4111 1111 1111 1111'];
  const inputs = [
    { firstPrompt: 'Deploy with sk-abcdefghijklmnopqrstuvwx and ghp_' + 'a1B2'.repeat(9) },
    { firstPrompt: 'use AKIAIOSFODNN7EXAMPLE to upload the build' },
    { firstPrompt: 'the password is: hunter2 so log in and fix the cart' },
    { firstPrompt: 'email sam@example.com about card 4111 1111 1111 1111' },
    { human: 'token=ghp_' + 'a1B2'.repeat(9) + ' rotate' },
    { card: 'Rotate sk-abcdefghijklmnopqrstuvwx today' },
    { branch: 'fix/ghp_' + 'a1B2'.repeat(9) },
    { cronJob: 'push sk-abcdefghijklmnopqrstuvwx' },
    { provider: 'codex', project: 'sk-abcdefghijklmnopqrstuvwx' },
  ];
  for (const input of inputs) {
    const { title } = titleOf({ team: false, ...input });
    for (const s of secrets) assert.ok(!title.includes(s), `${JSON.stringify(input)} → ${title}`);
    assert.doesNotMatch(title, /\[redacted\]|\[email\]|\[card\]/);
  }
  assert.ok(!projectOf({ cwd: '/x/sk-abcdefghijklmnopqrstuvwx' }).heading.includes('abcdefghijklmnop'));
  assert.ok(!(projectOf({ cwd: '/x/app', branch: 'fix/ghp_' + 'a1B2'.repeat(9) }).sub || '').includes('a1B2a1B2'));
});

test('work-organise: normalised before scrubbing — a split or full-width secret is still caught', () => {
  const zw = titleOf({ team: false, firstPrompt: 'use sk-abcdefghij\u200bklmnopqrstuvwx to deploy' }).title;
  assert.ok(!/abcdefghij/.test(zw), zw);
  const wide = titleOf({ team: false, firstPrompt: 'use ｓｋ-ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔ to deploy' }).title;
  assert.ok(!/abcdefghij/i.test(wide), wide);
});

test('work-organise: without a scrubber (a renderer), prompt text is never used', () => {
  const none = { redact: null };
  assert.deepEqual(titleOf({ team: false, firstPrompt: 'Add dark mode', provider: 'claude' }, none), { title: 'Claude session', source: 'fallback' });
  assert.deepEqual(titleOf({ team: false, firstPrompt: 'Fix #4', cronJob: 'x', provider: 'hermes' }, none), { title: 'Hermes session', source: 'fallback' });
  assert.deepEqual(titleOf({ team: false, card: 'Card title' }, none), { title: 'Card title', source: 'card' });
  assert.equal(projectOf({ cwd: '/x/app', branch: 'feat/y' }, none).sub, null, 'an unscrubbed branch is not shown');
});

test('work-organise: an injected scrubber is used', () => {
  const seen = [];
  const redact = (t) => { seen.push(t); return t.replace(/banana/g, '[redacted]'); };
  assert.equal(titleOf({ team: false, firstPrompt: 'Peel the banana and ship it' }, { redact }).title, 'Peel the and ship it');
  assert.ok(seen.length > 0);
});

// Deterministic pseudo-random inputs, so a failure reproduces.
function rng(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x100000000; }; }
const PIECES = ['/Users/sam/', `${HOME}/code/x.ts`, 'C:\\Users\\sam\\a', '\\\\server\\share\\f', '~/notes', './rel/p', '../up', 'src/a/b.js', 'https://h.example/p?q=1',
  'file:///etc/hosts', 'ok', 'please', 'fix', 'the', 'bug', 'ABC-12', '#7', 'é', '😀', '中文', '\u0000', '\u001b[31m', '\u202e', '\u200b', '<tag>', '</tag>',
  '```', '`code`', ' sk-abcdefghijklmnopqrstuvwx ', ' ', '\n', '.', '!', '?', '-', '/', '\\', 'a/b', 'and/or', 'x'.repeat(80), '\ud800', '\udc00'];
const randomText = (r, n) => Array.from({ length: 1 + Math.floor(r() * n) }, () => PIECES[Math.floor(r() * PIECES.length)]).join(r() < 0.5 ? ' ' : '');

test('work-organise: property — no title or heading has a path, the home folder, a control character, or is over 60', () => {
  const r = rng(20261023);
  const bad = (s, label) => {
    assert.equal(typeof s, 'string', label);
    assert.ok(Array.from(s).length <= MAX_TITLE, `${label} too long: ${s}`);
    assert.ok(!s.includes(HOME) && !/\/Users\/|C:\\|\\\\/.test(s), `${label} has a path: ${s}`);
    assert.doesNotMatch(s, /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/, `${label} has a control character`);
    assert.doesNotMatch(s, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, `${label} has a lone surrogate`);
    assert.ok(!s.includes('abcdefghijklmnop'), `${label} leaked a secret: ${s}`);
  };
  for (let i = 0; i < 1500; i++) {
    const firstPrompt = randomText(r, 12);
    const branch = randomText(r, 4);
    const cwd = r() < 0.5 ? `${HOME}/${randomText(r, 3)}` : randomText(r, 3);
    const out = titleOf({ team: false, firstPrompt, branch, cronJob: r() < 0.2 ? randomText(r, 3) : undefined, provider: 'codex', project: randomText(r, 2) });
    bad(out.title, `title(${JSON.stringify({ firstPrompt, branch })})`);
    // Derived titles never contain a separator; a person's own title may ("CI/CD").
    if (out.source !== 'human' && out.source !== 'card' && out.source !== 'reported') assert.doesNotMatch(out.title, /[\\/]/, `${out.source}: ${out.title}`);
    const p = projectOf({ cwd, toplevel: r() < 0.3 ? cwd : undefined, commonDir: r() < 0.3 ? `${cwd}/.git` : undefined, branch, home: HOME });
    bad(p.heading, 'heading');
    assert.doesNotMatch(p.heading, /[\\/]/, p.heading);
    if (p.sub !== null) { bad(p.sub, 'sub'); assert.doesNotMatch(p.sub, /[\\/]/, p.sub); }
    assert.doesNotMatch(p.key, /[\\/]/);
  }
});

test('work-organise: long Unicode input is cut on a code point and word boundary, bounded in time', () => {
  const long = '修复 '.repeat(5000) + '😀'.repeat(5000);
  const t0 = process.hrtime.bigint();
  const { title } = titleOf({ team: false, firstPrompt: long });
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 2000);
  assert.ok(Array.from(title).length <= MAX_TITLE);
  assert.ok(title.endsWith('…'));
  const emoji = titleOf({ team: false, human: 'Ship ' + '😀'.repeat(200) }).title;
  assert.ok(Array.from(emoji).length <= MAX_TITLE);
  assert.doesNotMatch(emoji, /[\ud800-\udbff](?![\udc00-\udfff])/);
});

test('work-organise: group by project, then bucket, with counts', () => {
  const ctl = { commonDir: '/d/claude-traffic-light/.git' };
  const rows = [
    { id: 1, project: projectOf({ ...ctl, branch: 'main' }), state: 'permission-ask', provider: 'claude' },
    { id: 2, project: projectOf({ ...ctl, branch: 'codex/views' }), state: 'tool-use', provider: 'codex' },
    { id: 3, project: projectOf({ cwd: '/d/zeta' }), status: 'Idle', provider: 'claude' },
    { id: 4, project: projectOf({}), state: 'stop', provider: 'hermes' },
    { id: 5, project: projectOf({ cwd: '/d/Alpha' }), bucket: 'stuck', provider: 'gemini' },
    { id: 6, project: projectOf(ctl), state: 'Waiting on you', provider: 'claude' },
  ];
  const g = group(rows, 'project', { then: 'bucket' });
  assert.deepEqual(g.map((x) => x.heading), ['Alpha', 'claude-traffic-light', 'zeta', FALLBACK], 'alphabetical, Other work last');
  const ctlGroup = g[1];
  assert.deepEqual(ctlGroup.rows.map((r) => r.id), [1, 2, 6], 'worktrees fold; order kept');
  assert.equal(ctlGroup.count, 3);
  assert.deepEqual(ctlGroup.counts, { needs: 2, working: 1, check: 0, stuck: 0, idle: 0 });
  assert.equal(ctlGroup.sub, null, 'different branches in one group: no single sub-label');
  assert.deepEqual(ctlGroup.groups.map((x) => [x.heading, x.count]), [['Needs you', 2], ['Working on it', 1]]);

  const byBucket = group(rows, 'status');
  assert.deepEqual(byBucket.map((x) => x.key), ['needs', 'working', 'check', 'stuck', 'idle']);
  assert.equal(byBucket.find((x) => x.key === 'idle').collapsed, true);

  const byTool = group(rows, 'tool');
  assert.deepEqual(byTool.map((x) => [x.heading, x.count]), [['Claude', 3], ['Codex', 1], ['Gemini', 1], ['Hermes', 1]]);

  assert.deepEqual(group([], 'project'), []);
  assert.deepEqual(group(null), []);
  assert.deepEqual(group([null, 7, 'x']), []);
  assert.equal(group([{ project: { cwd: '/d/raw' } }])[0].heading, 'raw', 'raw project info is resolved');
  assert.equal(group([{ project: projectOf({ toplevel: '/a', branch: 'feat/x' }) }])[0].sub, 'x');
});

test('work-organise: git resolver — one call per cwd, cached, worktree folding, newline guard', async () => {
  let t = 1000;
  const calls = [];
  const answers = {
    '/w/awareness-p4': '/w/awareness-p4\n/d/claude-traffic-light/.git\ncodex/views\n',
    '/d/claude-traffic-light': '/d/claude-traffic-light\n.git\nmain\n',
    '/d/claude-traffic-light/src': '/d/claude-traffic-light\n../.git\nHEAD\n',
    '/d/bad\nname': '/d/bad\nname\n/d/bad\nname/.git\nmain\n',
  };
  const git = async (dir, args) => {
    calls.push([dir, args]);
    if (!Object.hasOwn(answers, dir)) { const e = new Error('not a repo'); e.code = 128; throw e; }
    return answers[dir];
  };
  const repoFor = async (cwd) => (cwd.startsWith('/d/claude') || cwd.startsWith('/w/') ? 'github.com/acme/claude-traffic-light' : null);
  const r = createGitInfoResolver({ git, repoFor, now: () => t, ttlMs: 60_000 });

  const wt = await r.resolve('/w/awareness-p4');
  assert.deepEqual(wt, { repoName: 'github.com/acme/claude-traffic-light', toplevel: '/w/awareness-p4', commonDir: '/d/claude-traffic-light/.git', branch: 'codex/views' });
  assert.deepEqual(calls[0][1], ['rev-parse', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD']);
  const main = await r.resolve('/d/claude-traffic-light');
  assert.equal(main.commonDir, '/d/claude-traffic-light/.git', 'relative common dir resolved against cwd');
  const sub = await r.resolve('/d/claude-traffic-light/src');
  assert.equal(sub.commonDir, '/d/claude-traffic-light/.git');
  assert.equal(sub.branch, null, 'detached HEAD: no branch');
  assert.equal(projectOf(wt).key, projectOf(main).key);

  const bad = await r.resolve('/d/bad\nname');
  assert.deepEqual([bad.toplevel, bad.commonDir, bad.branch], [null, null, null], 'a newline in a path shifts the lines: unresolved');

  const none = await r.resolve('/tmp/not-a-repo');
  assert.deepEqual(none, { repoName: null, toplevel: null, commonDir: null, branch: null });

  const n = calls.length;
  await Promise.all([r.resolve('/w/awareness-p4'), r.resolve('/w/awareness-p4'), r.resolve('/tmp/not-a-repo')]);
  assert.equal(calls.length, n, 'cached, failures included');
  t += 60_001;
  await r.resolve('/w/awareness-p4');
  assert.equal(calls.length, n + 1, 'expires after the TTL');
});

test('work-organise: git resolver — in-flight calls share one lookup; bad input never reaches git; bounded cache', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  let count = 0;
  const git = async (dir) => { count++; await gate; return `${dir}\n${dir}/.git\nmain\n`; };
  const r = createGitInfoResolver({ git, max: 3 });
  const a = r.resolve('/x/a');
  const b = r.resolve('/x/a');
  release();
  assert.deepEqual(await a, await b);
  assert.equal(count, 1);

  for (const cwd of [undefined, '', 'relative/dir', 'a\0b', '/' + 'x'.repeat(3000), 7]) {
    assert.deepEqual(await r.resolve(cwd), { repoName: null, commonDir: null, toplevel: null, branch: null });
  }
  assert.equal(count, 1);

  const sync = createGitInfoResolver({ git: (d) => `${d}\n.git\nmain`, repoFor: () => 'not a canonical url', max: 3 });
  for (const d of ['/1', '/2', '/3', '/4', '/5']) await sync.resolve(d);
  assert.equal(sync.size(), 3);
  assert.equal((await sync.resolve('/5')).repoName, null, 'an origin that is not canonical is dropped');
  const throwing = createGitInfoResolver({ git: () => { throw new Error('spawn failed'); }, repoFor: () => { throw new Error('x'); } });
  assert.deepEqual(await throwing.resolve('/x'), { repoName: null, commonDir: null, toplevel: null, branch: null });
  assert.throws(() => createGitInfoResolver({}), /git runner/);
});

test('work-organise: pure and browser-safe — no fs, exec or network, loads without require', () => {
  assert.doesNotMatch(SRC, /require\((['"])(?:node:)?(?:fs|child_process|net|http|https|os)\1\)|\bfetch\(|XMLHttpRequest|process\.env/);
  assert.match(SRC, /require\('\.\/scrub\.js'\)/, 'the existing scrubber is the one used');
  const sandbox = {};
  vm.runInNewContext(SRC, sandbox);
  const api = sandbox.PlexiformWorkOrganise;
  assert.ok(api && Object.isFrozen(api));
  assert.equal(api.bucketOf('blocked'), 'needs');
  assert.equal(api.projectOf({ commonDir: '/d/app/.git' }).heading, 'app');
  assert.equal(api.titleOf({ team: false, firstPrompt: 'Add dark mode', provider: 'codex' }).title, 'Codex session', 'no scrubber in a page: no prompt titles');
});

// Wall time on a shared machine is noisy: best of three after a warm-up.
const best = (fn, n = 3) => { fn(); let min = Infinity; for (let i = 0; i < n; i++) { const t0 = process.hrtime.bigint(); fn(); min = Math.min(min, Number(process.hrtime.bigint() - t0) / 1e6); } return min; };
const blob = (seed, bytes = 3072, enc = 'base64') => { const r = rng(seed); return Buffer.from(Array.from({ length: bytes }, () => Math.floor(r() * 256))).toString(enc); };
// The shapes people paste as a first prompt: an image data URI, a token, a blob with a key glued on.
const pasted = (i) => [`data:image/png;base64,${blob(i, 3072, 'base64url')}`, `eyJ${blob(i, 3000, 'base64url')}.eyJ${blob(i + 1, 300, 'base64url')}`, `${blob(i, 3072, 'base64url')}sk-abcdefghijklmnopqrstuvwx`, blob(i)][i % 4];

test('work-organise: H1 — no-space and NFKC-expanding input stays linear (under 50 ms each)', () => {
  const cases = {
    'U+3315 ×4000 (5× after NFKC)': String.fromCodePoint(0x3315).repeat(4000),
    'U+3300 ×4000 (4× after NFKC)': String.fromCodePoint(0x3300).repeat(4000),
    '4 KB base64 blob': blob(1),
    '4 KB data URI': pasted(0),
    '4 KB token-shaped blob': pasted(1),
    '4 KB blob with a key glued on': pasted(2),
    'x ×4000': 'x'.repeat(4000),
    'a. ×2000': 'a.'.repeat(2000),
    'redacted run': 'sk-abcdefghijklmnopqrstuvwx'.repeat(150),
  };
  for (const [label, firstPrompt] of Object.entries(cases)) {
    const ms = best(() => titleOf({ team: false, firstPrompt, branch: firstPrompt, human: undefined }));
    assert.ok(ms < 50, `${label}: ${ms.toFixed(1)} ms`);
    for (const k of ['human', 'card', 'reported', 'cronJob', 'project']) {
      const t = best(() => titleOf({ team: false, [k]: firstPrompt }));
      assert.ok(t < 50, `${label} as ${k}: ${t.toFixed(1)} ms`);
    }
    assert.ok(best(() => projectOf({ cwd: `/x/${firstPrompt}`, branch: firstPrompt })) < 50, `${label} as project`);
  }
  assert.ok(Array.from(titleOf({ team: false, firstPrompt: cases['U+3315 ×4000 (5× after NFKC)'] }).title).length <= MAX_TITLE);
});

test('work-organise: H1 — 100 sessions of pasted blobs title in under 500 ms', () => {
  const sessions = Array.from({ length: 100 }, (_, i) => ({ firstPrompt: pasted(100 + i), provider: 'claude', project: 'app' }));
  const ms = best(() => { for (const s of sessions) titleOf({ team: false, ...s }); }, 2);
  assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
});

test('work-organise: H1 — the prompt is scrubbed once per title', () => {
  let calls = 0;
  const redact = (t) => { calls++; return t; };
  titleOf({ team: false, firstPrompt: 'Fix the login loop for good' }, { redact });
  assert.equal(calls, 1);
});

test('work-organise: M1 — a path after any delimiter is removed, and no home folder name is left', () => {
  const probes = {
    'see [/Users/sam]': 'see',
    'log at {/home/sam}': 'log at',
    'cfg|/etc/shadow': 'cfg',
    'open ~sam/notes': 'open',
    'x,/Users/sam/secret': 'x',
    'a;/Users/sam/b': 'a',
    'path=(C:\\Users\\sam\\db) ok': 'path= ok',
    'go to ~sam': 'go to',
  };
  for (const [human, want] of Object.entries(probes)) {
    assert.deepEqual(titleOf({ team: false, human }), { title: want, source: 'human' }, human);
  }
  assert.deepEqual(titleOf({ team: false, firstPrompt: 'fix the bug in [/Users/sam]' }), { title: 'Fix the bug', source: 'prompt' });
  assert.doesNotMatch(titleOf({ team: false, firstPrompt: 'fix the bug in fix/Users/sam' }).title, /Users|sam/, 'a home folder glued to a word goes too');
  assert.equal(titleOf({ team: false, human: 'Set up CI/CD and/or docs' }).title, 'Set up CI/CD and/or docs', 'a slash inside words stays');
});

test('work-organise: M1 property — typed, card and reported titles, with and without a scrubber, never show a path or the user', () => {
  const r = rng(424242);
  for (let i = 0; i < 1500; i++) {
    const text = randomText(r, 10);
    for (const source of ['human', 'card', 'reported', 'firstPrompt', 'cronJob', 'project', 'branch']) {
      for (const opts of [{}, { redact: null }]) {
        const { title } = titleOf({ team: false, [source]: text, provider: 'codex' }, opts);
        const label = `${source}${opts.redact === null ? ' (renderer)' : ''}: ${JSON.stringify(text)} → ${title}`;
        assert.ok(Array.from(title).length <= MAX_TITLE, label);
        assert.ok(!/\/Users\/|\/home\/|[A-Za-z]:\\|\\\\|~\//i.test(title), label);
        assert.doesNotMatch(title, /(?<![A-Za-z])sam(?![A-Za-z])/i, label);
        assert.doesNotMatch(title, /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/, label);
        if (opts.redact !== null) assert.ok(!title.includes('abcdefghijklmnop'), label);
      }
    }
  }
});

test('work-organise: M2 — the team gate fails closed: prompt and cron titles only when plainly local or share_summaries === true', () => {
  const p = { firstPrompt: 'Add dark mode to settings', cronJob: 'nightly', provider: 'claude', project: 'app' };
  const closed = { title: 'Claude session in app', source: 'fallback' };
  for (const extra of [{}, { team: true }, { team: 1 }, { team: 'true' }, { team: 'yes' }, { team: {} }, { team: null }, { team: undefined },
    { shareSummaries: false }, { shareSummaries: 'true' }, { shareSummaries: 1 }, { team: true, shareSummaries: 'true' }, { team: true, shareSummaries: 1 },
    { team: false, shareSummaries: false }, { team: false, share_summaries: false }, { team: 0 }, { team: '' }]) {
    assert.deepEqual(W.titleOf({ ...p, ...extra }), closed, JSON.stringify(extra));
  }
  for (const extra of [{ team: false }, { team: true, shareSummaries: true }, { team: true, share_summaries: true }, { shareSummaries: true }]) {
    assert.equal(W.titleOf({ ...p, ...extra }).source, 'prompt', JSON.stringify(extra));
  }
  assert.equal(W.titleOf({ cronJob: 'nightly', team: false }).source, 'cron');
  assert.equal(W.titleOf({ cronJob: 'nightly', team: 1 }).source, 'fallback');
});

test('work-organise: L1 — invisible fillers and tag characters are removed before scrubbing', () => {
  const fillers = [0xe0061, 0xe0020, 0xe007f, 0x034f, 0x115f, 0x1160, 0x3164, 0xffa0, 0xfe0f, 0xe0100, 0x180b, 0x17b4, 0x2800];
  const sk = 'sk-abcdefghijklmnopqrstuvwx';
  const ghp = 'ghp_' + 'a1B2'.repeat(9);
  for (const cp of fillers) {
    const f = String.fromCodePoint(cp);
    for (const token of [sk, ghp]) {
      const split = token.slice(0, 6) + f + token.slice(6, 14) + f + token.slice(14);
      for (const input of [{ team: false, firstPrompt: `deploy with ${split} today` }, { human: `rotate ${split}` }, { team: false, branch: `fix/${split}` }]) {
        const { title } = W.titleOf(input);
        const visible = title.replace(/[^\x20-\x7e]/gu, '');
        assert.ok(!visible.includes(token.slice(6, 14)), `U+${cp.toString(16)} ${JSON.stringify(input)} → ${JSON.stringify(title)}`);
        assert.ok(!title.includes(f), `U+${cp.toString(16)} left in ${JSON.stringify(title)}`);
      }
    }
  }
});

test('work-organise: L3 — lower-case Linear-style tickets count in branches, never in prompts', () => {
  const t = (branch) => W.titleOf({ team: false, branch });
  assert.deepEqual(t('sam/abc-123-fix-login'), { title: 'ABC-123 · Fix login', source: 'ticket' });
  assert.deepEqual(t('abc-123-fix-login'), { title: 'ABC-123 · Fix login', source: 'ticket' });
  assert.deepEqual(t('claude/eng-42'), { title: 'ENG-42', source: 'ticket' });
  assert.deepEqual(t('codex/work-organise-2026-10-23'), { title: 'Work organise', source: 'branch' }, 'a word then a date is no ticket');
  assert.deepEqual(t('feat/utf-8-paths'), { title: 'Utf 8 paths', source: 'branch' }, 'standards stay excluded');
  assert.deepEqual(t('fix/v-2-layout'), { title: 'V 2 layout', source: 'branch' });
  assert.equal(t('fix/beta-90-notes').source, 'branch');
  assert.equal(t('fix/issue-42-crash').source, 'branch');
  assert.equal(W.titleOf({ team: false, firstPrompt: 'abc-123 fix login' }).source, 'prompt', 'prompts still need capitals');
});

test('work-organise: L4 — the board column in_progress is Working on it', () => {
  for (const s of ['in_progress', 'In progress', 'in-progress']) assert.equal(W.bucketOf(s), 'working', s);
});
