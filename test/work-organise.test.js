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
  assert.deepEqual(BUCKETS.map((b) => b.label), ['Needs you', 'Working on it', 'Check it', 'Stuck or failed', 'Idle'], 'Review is "Check it" on a badge');
});

test('work-organise: headingOf names any state with its bucket heading; unknown is Idle', () => {
  assert.equal(W.headingOf('permission-ask'), 'Needs you');
  assert.equal(W.headingOf({ state: 'in_review' }), 'Finished — check it');
  assert.equal(W.headingOf('turn-failed'), 'Stuck or failed');
  assert.equal(W.headingOf('no-such-state'), 'Idle');
  assert.equal(W.headingOf(null), 'Idle');
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

test('work-organise: git resolver — one lookup per cwd, cached, worktree folding, newline guard', async () => {
  let t = 1000;
  const { git, calls } = fakeGit({
    '/w/awareness-p4': { top: '/w/awareness-p4', common: '/d/claude-traffic-light/.git', branch: 'codex/views' },
    '/d/claude-traffic-light': { top: '/d/claude-traffic-light', common: '.git', branch: 'main' },
    '/d/claude-traffic-light/src': { top: '/d/claude-traffic-light', common: '../.git' },
    '/d/bad\nname': { top: '/d/bad\nname', common: '/d/bad\nname/.git', branch: 'main' },
  });
  const repoFor = async (cwd) => (cwd.startsWith('/d/claude') || cwd.startsWith('/w/') ? 'github.com/acme/claude-traffic-light' : null);
  const r = createGitInfoResolver({ git, repoFor, now: () => t, ttlMs: 60_000, jitter: 0 });

  const wt = await r.resolve('/w/awareness-p4');
  assert.deepEqual(wt, { repoName: 'github.com/acme/claude-traffic-light', toplevel: '/w/awareness-p4', commonDir: '/d/claude-traffic-light/.git', branch: 'codex/views' });
  assert.deepEqual(calls.slice(0, 2).sort(), ['rev-parse --show-toplevel --git-common-dir', 'symbolic-ref --short -q HEAD']);
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
  assert.equal(await r.resolve('/w/awareness-p4'), wt, 'an expired answer is still served while it is looked up again');
  await r.idle();
  assert.equal(calls.length, n + 2, 'expires after the TTL');
});

test('work-organise: git resolver — in-flight calls share one lookup; bad input never reaches git; bounded cache', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  let count = 0;
  const inner = fakeGit({ '/x/a': { top: '/x/a', common: '/x/a/.git', branch: 'main' } }).git;
  const git = async (dir, args) => { count++; await gate; return inner(dir, args); };
  const r = createGitInfoResolver({ git, max: 3 });
  const a = r.resolve('/x/a');
  const b = r.resolve('/x/a');
  release();
  assert.deepEqual(await a, await b);
  assert.equal(count, 2, 'one rev-parse and one symbolic-ref');

  for (const cwd of [undefined, '', 'relative/dir', 'a\0b', '/' + 'x'.repeat(3000), 7]) {
    assert.deepEqual(await r.resolve(cwd), { repoName: null, commonDir: null, toplevel: null, branch: null });
  }
  assert.equal(count, 2);

  const sync = createGitInfoResolver({ git: (d, args) => (args[0] === 'rev-parse' ? `${d}\n.git` : 'main'), repoFor: () => 'not a canonical url', max: 3 });
  for (const d of ['/1', '/2', '/3', '/4', '/5']) await sync.resolve(d);
  assert.equal(sync.size(), 3);
  assert.equal((await sync.resolve('/5')).repoName, null, 'an origin that is not canonical is dropped');
  let looks = 0;
  const lru = createGitInfoResolver({ git: (d, args) => { looks++; return args[0] === 'rev-parse' ? `${d}\n.git` : 'main'; }, repoFor: () => null, max: 3 });
  for (const d of ['/1', '/2', '/3']) await lru.resolve(d);
  await lru.resolve('/1'); await lru.resolve('/4');
  const seen = looks; await lru.resolve('/1');
  assert.equal(looks, seen, 'a recently used entry survives eviction');
  await lru.resolve('/2');
  assert.ok(looks > seen, 'the least recently used one was evicted');
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
// CPU time, not wall time: on a loaded machine the wall clock also counts time spent waiting to run.
const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1e3; };
const best = (fn, n = 3) => { fn(); let min = Infinity; for (let i = 0; i < n; i++) { const t0 = cpuMs(); fn(); min = Math.min(min, cpuMs() - t0); } return min; };
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

test('work-organise: H1 — pasted blobs cost linearly: 100 titles about 10× of 10, a 4× blob at most about 8× (load-tolerant)', () => {
  const sessions = Array.from({ length: 100 }, (_, i) => ({ team: false, firstPrompt: pasted(100 + i), provider: 'claude', project: 'app' }));
  const run = (list) => () => { for (const s of list) titleOf(s); };
  // Interleaved rounds, fastest of each: a load spike on a busy machine hits one round,
  // not every round, so it cannot decide the ratio.
  let t10 = Infinity;
  let t100 = Infinity;
  for (let round = 0; round < 6; round++) {
    t100 = Math.min(t100, best(run(sessions), 1));
    t10 = Math.min(t10, best(run(sessions.slice((round % 10) * 10, (round % 10) * 10 + 10)), 1));
  }
  assert.ok(t100 / Math.max(t10, 1) < 20, `100 titles ${t100.toFixed(0)} ms vs 10 titles ${t10.toFixed(0)} ms`);
  assert.ok(t100 < 5000, `backstop: ${t100.toFixed(0)} ms`);
  // Per-title cost against input size: a quadratic pass makes the 4 KB blob ~16× the 1 KB one.
  const shapes = (n) => [0, 1, 2].map((k) => pasted(k).slice(0, n));
  const per = (n) => best(() => { for (const p of shapes(n)) titleOf({ team: false, firstPrompt: p }); }, 15);
  const small = per(1000);
  const large = per(4000);
  assert.ok(large / Math.max(small, 0.5) < 8, `4 KB ${large.toFixed(1)} ms vs 1 KB ${small.toFixed(1)} ms`);
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

test('work-organise: L3/N2 — lower-case Linear-style tickets count only after a person segment, never in prompts', () => {
  const t = (branch) => W.titleOf({ team: false, branch });
  assert.deepEqual(t('sam/abc-123-fix-login'), { title: 'ABC-123 · Fix login', source: 'ticket' });
  assert.deepEqual(t('sam.lee/eng-42'), { title: 'ENG-42', source: 'ticket' });
  assert.deepEqual(t('feat/node-22-upgrade'), { title: 'Node 22 upgrade', source: 'branch' }, 'a runtime version is no ticket');
  assert.equal(t('release-2-prep').source, 'branch', 'a release number is no ticket');
  assert.equal(t('abc-123-fix-login').source, 'branch', 'no person segment');
  assert.equal(t('sam/node-22-upgrade').source, 'branch');
  assert.equal(t('sam/python-3-12').source, 'branch');
  assert.equal(t('sam/ios-17-fix').source, 'branch');
  assert.equal(t('sam/v-2-layout').source, 'branch');
  assert.equal(t('sam/x/abc-123').source, 'branch', 'only directly after the first segment');
  assert.deepEqual(W.titleOf({ team: false, branch: 'feat/ENG-42-fix' }), { title: 'ENG-42 · Fix', source: 'ticket' }, 'capitals still count anywhere');
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

// A fake git that answers like the real one: rev-parse fails with 128 on --abbrev-ref HEAD in a repo with no commits.
function fakeGit(repos) {
  const calls = [];
  const fail = (code) => { const e = new Error(`git exited ${code}`); e.code = code; throw e; };
  const git = async (dir, args) => {
    calls.push(args.join(' '));
    const r = repos[dir];
    if (!r) fail(128);
    if (args[0] === 'rev-parse') {
      if (args.includes('--abbrev-ref') && r.unborn) fail(128);
      return [args.includes('--show-toplevel') ? r.top : null, args.includes('--git-common-dir') ? r.common : null, args.includes('--abbrev-ref') ? (r.branch ?? 'HEAD') : null].filter((x) => x !== null).join('\n') + '\n';
    }
    if (args[0] === 'symbolic-ref') return r.branch ? `${r.branch}\n` : fail(1);
    return fail(129);
  };
  return { git, calls };
}

test('work-organise: L5 — a repo with no commits still resolves; the cwd and its dirs are realpath-ed', async () => {
  const { git } = fakeGit({
    '/real/new': { top: '/real/new', common: '.git', branch: 'main', unborn: true },
    '/real/app': { top: '/real/app', common: '/real/app/.git', branch: 'main' },
  });
  const links = { '/link/new': '/real/new', '/tmp/app': '/real/app' };
  const realpath = async (p) => { if (Object.hasOwn(links, p)) return links[p]; return p; };
  const r = W.createGitInfoResolver({ git, realpath });
  assert.deepEqual(await r.resolve('/real/new'), { repoName: null, toplevel: '/real/new', commonDir: '/real/new/.git', branch: 'main' });
  const viaLink = await r.resolve('/tmp/app');
  assert.equal(viaLink.commonDir, '/real/app/.git', 'a symlinked cwd folds with the real path');
  assert.equal(W.projectOf(viaLink).key, W.projectOf(await r.resolve('/real/app')).key);
  assert.equal((await r.resolve('/link/new')).toplevel, '/real/new');
});

test('work-organise: L5 — real git in a temp dir: unborn repo, worktree and symlink all fold to one project', async (t) => {
  const os = require('node:os');
  const { execFile } = require('node:child_process');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const git = (dir, args) => new Promise((res, rej) => execFile('git', ['-C', dir, ...args], { env, timeout: 10_000, encoding: 'utf8' }, (e, out) => (e ? rej(e) : res(out))));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'work-organise-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'proj');
  fs.mkdirSync(repo);
  await git(repo, ['init', '-q', '-b', 'main']);
  const resolver = () => W.createGitInfoResolver({ git, realpath: (p) => fs.promises.realpath(p) });

  const unborn = await resolver().resolve(repo);
  assert.equal(unborn.branch, 'main', 'no commits yet: still a repo on main');
  assert.equal(unborn.commonDir, path.join(fs.realpathSync(repo), '.git'));
  assert.equal(W.projectOf(unborn).heading, 'proj');

  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  await git(repo, ['add', 'a.txt']);
  await git(repo, ['commit', '-q', '-m', 'a']);
  const wt = path.join(root, 'proj-wt');
  await git(repo, ['worktree', 'add', '-q', '-b', 'feat/views', wt]);
  const link = path.join(root, 'link');
  fs.symlinkSync(repo, link);
  fs.mkdirSync(path.join(repo, 'sub'));

  const r = resolver();
  const [main, tree, viaLink, sub] = await Promise.all([repo, wt, link, path.join(repo, 'sub')].map((d) => r.resolve(d)));
  assert.equal(tree.branch, 'feat/views');
  assert.equal(W.projectOf(tree).sub, 'views');
  for (const x of [tree, viaLink, sub]) assert.equal(W.projectOf(x).key, W.projectOf(main).key);
  await git(wt, ['checkout', '-q', '--detach']);
  assert.equal((await resolver().resolve(wt)).branch, null, 'detached HEAD: no branch');
});

test('work-organise: L6 — markup is stripped before redaction, so a tag cannot split a secret past the scrubber', () => {
  const sk = 'sk-abcdefghijklmnopqrstuvwx';
  const ghp = 'ghp_' + 'a1B2'.repeat(9);
  for (const tag of ['<i/>', '<x>', '</b>', '<span class="a">']) {
    for (const token of [sk, ghp]) {
      const split = token.slice(0, 6) + tag + token.slice(6);
      for (const input of [{ team: false, firstPrompt: `deploy with ${split} today` }, { human: `rotate ${split} now` }, { card: `rotate ${split}` }]) {
        const { title } = W.titleOf(input);
        assert.ok(!title.includes(token.slice(6, 14)), `${JSON.stringify(input)} → ${title}`);
      }
    }
  }
  assert.equal(W.titleOf({ team: false, firstPrompt: 'Fix the lo<wbr>gin loop' }).title, 'Fix the login loop', 'a lone tag inside a word joins it');
});

test('work-organise: renderer mode (no scrubber) still strips paths, control and invisible characters from typed titles', () => {
  const none = { redact: null };
  const zw = String.fromCodePoint(0x200b), tagA = String.fromCodePoint(0xe0061), rlo = String.fromCodePoint(0x202e), bel = String.fromCharCode(7);
  for (const source of ['human', 'card', 'reported']) {
    const { title } = W.titleOf({ [source]: `Fix${zw} the${tagA} [/Users/sam/app] ${rlo}cfg|/etc/hosts loop${bel} ~sam/x C:\\Users\\sam\\y` }, none);
    assert.equal(title, 'Fix the cfg loop', `${source}: ${JSON.stringify(title)}`);
  }
  assert.equal(W.titleOf({ provider: 'codex', project: `a${zw}pp${bel}` }, none).title, 'Codex session in app');
  assert.equal(W.titleOf({ provider: 'codex', project: '/Users/sam/app' }, none).title, 'Codex session', 'a path is not a project name');
  assert.equal(W.projectOf({ cwd: `/x/a${tagA}pp${bel}` }, none).heading, 'app');
});

test('work-organise: N3 — percent-encoded, bare and $HOME home folders leave no name behind', () => {
  const probes = [
    'check %2FUsers%2Fsam%2Fx', 'check %2Fhome%2Fsam', 'check file%3A%2F%2F%2FUsers%2Fsam', 'check %252FUsers%252Fsam',
    'see Users/sam', 'see Users\\sam\\x', 'check home/sam/x', 'check home/sam/notes.txt', 'check x$HOME/sam', 'check ${HOME}/sam/x', 'check $HOME',
  ];
  for (const text of probes) {
    for (const [label, title] of [
      ['typed', titleOf({ team: false, human: text }).title],
      ['typed (renderer)', titleOf({ team: false, human: text }, { redact: null }).title],
      ['prompt', titleOf({ team: false, firstPrompt: text }).title],
    ]) {
      assert.doesNotMatch(title, /sam|Users|home|HOME|%2F/i, `${label}: ${JSON.stringify(text)} → ${title}`);
      assert.match(title, /^(?:check|see)\b/i, `${label}: ${JSON.stringify(text)} keeps its words → ${title}`);
    }
  }
  const keep = (text, want) => assert.equal(titleOf({ team: false, human: text }).title, want, text);
  keep('fix 100% of CI/CD and/or tests', 'fix 100% of CI/CD and/or tests');
  keep('go home now', 'go home now');
  keep('50%2F50 split', '50/50 split');
  keep('$HOMEBREW_PREFIX check', '$HOMEBREW_PREFIX check');
  assert.equal(titleOf({ team: false, human: 'ok %0Aevil %E2%80%AE' }).title, 'ok %0Aevil %E2%80%AE', 'only printable ASCII is decoded');
});

test('work-organise: N4 — runs of slashes and crafted nested tags stay fast (under 50 ms best-of-3, and near plain prose)', () => {
  // Plain prose of the same length is the yardstick: a quadratic pass costs ~20× it, while the
  // 50 ms ceiling alone is loose enough for a fast machine to pass one.
  const prose = 'fix the login loop in the settings page and tidy up the tests '.repeat(70).slice(0, 4000);
  let nested = 'x';
  while (nested.length < 4000) nested = `<a></a${nested}>`;
  const cases = {
    'slashes': '/'.repeat(4000),
    'backslashes': '\\'.repeat(4000),
    'slashes then Users': `${'/'.repeat(3990)}Users`,
    'nested <a></a<…>>': nested,
    'nested blocks': `${'<b>'.repeat(600)}x${'</b>'.repeat(600)}`,
  };
  for (const [name, text] of Object.entries(cases)) {
    for (const key of ['human', 'firstPrompt']) {
      const base = best(() => titleOf({ team: false, [key]: prose }));
      const ms = best(() => titleOf({ team: false, [key]: text }));
      assert.ok(ms < 50, `${name} as ${key}: ${ms.toFixed(1)} ms`);
      assert.ok(ms < 8 * Math.max(base, 1), `${name} as ${key}: ${ms.toFixed(1)} ms vs prose ${base.toFixed(1)} ms`);
    }
  }
  assert.equal(titleOf({ team: false, human: 'fix C:\\Users\\sam\\x now' }).title, 'fix now', 'a drive home folder still goes');
  assert.equal(titleOf({ team: false, human: 'fix //Users/sam now' }).title, 'fix now', 'a doubled slash still goes');
});

test('work-organise: R1 — runtime and release words are skipped only as lower-case branch keys', () => {
  const t = (input) => W.titleOf({ team: false, ...input });
  assert.deepEqual(t({ branch: 'feat/IOS-12-dark-mode' }), { title: 'IOS-12 · Dark mode', source: 'ticket' });
  assert.deepEqual(t({ branch: 'API-77' }), { title: 'API-77', source: 'ticket' });
  assert.deepEqual(t({ human: 'SDK-3 retry' }), { title: 'SDK-3 retry', source: 'human' });
  assert.match(t({ firstPrompt: 'Fix SDK-3 retry loop' }).title, /^SDK-3 · /, 'a capital key in a prompt counts');
  assert.equal(t({ branch: 'feat/NODE-22' }).source, 'ticket');
  assert.equal(t({ branch: 'sam/node-22-upgrade' }).source, 'branch', 'lower case it is still a version');
  assert.equal(t({ branch: 'sam/ios-17-fix' }).source, 'branch');
  assert.equal(t({ branch: 'feat/UTF-8-paths' }).source, 'branch', 'standards stay excluded in capitals');
});

test('work-organise: R2 — lower-case Linear keys count after an agent prefix, not after a kind', () => {
  const t = (branch) => W.titleOf({ team: false, branch });
  assert.deepEqual(t('claude/eng-42'), { title: 'ENG-42', source: 'ticket' });
  assert.deepEqual(t('codex/abc-123-fix-login'), { title: 'ABC-123 · Fix login', source: 'ticket' });
  assert.deepEqual(t('Cursor/eng-7-tidy'), { title: 'ENG-7 · Tidy', source: 'ticket' });
  assert.equal(t('feat/eng-42').source, 'branch', 'a kind prefix still is not a person');
  assert.equal(t('fix/abc-123-login').source, 'branch');
  assert.equal(t('codex/node-22-upgrade').source, 'branch', 'release words still skipped');
  assert.deepEqual(t('codex/work-organise-2026-10-23'), { title: 'Work organise', source: 'branch' });
});

test('work-organise: a bare home folder goes whatever its case', () => {
  for (const text of ['see users/sam/x', 'see USERS/sam/notes', 'see Home/sam/x', 'see HOME\\sam\\notes']) {
    for (const opts of [{}, { redact: null }]) {
      assert.equal(W.titleOf({ team: false, human: text }, opts).title, 'see', `${JSON.stringify(text)}${opts.redact === null ? ' (renderer)' : ''}`);
    }
    assert.equal(W.titleOf({ team: false, firstPrompt: text }).title, 'See', text);
  }
  assert.equal(W.titleOf({ team: false, human: 'go home now' }).title, 'go home now', 'no separator, no path');
});

test('work-organise: a "." or ".." folder is no project name', () => {
  for (const cwd of ['..', '.', '/a/b/..', 'C:\\x\\.', '../']) assert.equal(W.projectOf({ cwd }).heading, 'Other work', cwd);
  assert.equal(W.projectOf({ cwd: '/a/.config' }).heading, '.config');
});

test('work-organise: bucketOf reads its own headings and labels back', () => {
  for (const b of W.BUCKETS) {
    assert.equal(W.bucketOf(b.heading), b.id, b.heading);
    assert.equal(W.bucketOf(b.label.toUpperCase()), b.id, b.label);
  }
});

test('work-organise: views name a project with projectOf — the folder-leaf copies and their fallbacks are gone', () => {
  const files = ['session-overview', 'session-card-view', 'input-view', 'home-alerts', 'guardrails-main', 'cost-rollup', 'setup-checklist', 'explain-main'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', `${f}.js`), 'utf8');
    assert.match(src, /require\('\.\/work-organise(?:\.js)?'\)/, `${f} uses work-organise`);
    assert.match(src, /projectOf\(/, `${f} names projects with projectOf`);
    assert.doesNotMatch(src, /'(?:Local project|Unknown project|a project|your project|A session|a session)'/, `${f} keeps no fallback of its own`);
  }
  assert.equal(W.SENTENCE_FALLBACK, 'a session', 'the in-sentence fallback lives here, next to FALLBACK');
});

test('work-organise: a bare home folder goes from prompts in any form; typed titles keep an ordinary route', () => {
  const bare = ['see home/sam', 'see home/sam/', 'see (home/sam)', 'see users/sam', 'see USERS/sam', 'see Home/sam', 'see users\\sam', 'see users/sam/notes'];
  for (const text of bare) {
    assert.equal(W.titleOf({ team: false, firstPrompt: text }).title, 'See', `prompt: ${text}`);
    for (const opts of [{}, { redact: null }]) {
      assert.equal(W.titleOf({ team: false, human: text }, opts).title, 'see', `typed: ${text}`);
    }
  }
  for (const opts of [{}, { redact: null }]) {
    const typed = (human) => W.titleOf({ team: false, human }, opts).title;
    assert.doesNotMatch(typed('cd home/sam; ls'), /sam/);
    assert.equal(typed('Fix home/about page'), 'Fix home/about page');
    assert.equal(typed('Update users/settings tab'), 'Update users/settings tab');
    assert.equal(typed('open Home/sam/projects/app now'), 'open now');
    assert.equal(typed('see Users/sam page'), 'see page', 'macOS Users/<name> goes even with words after it');
  }
  assert.doesNotMatch(W.titleOf({ team: false, firstPrompt: 'cd home/sam; ls' }).title, /sam/);
});

test('work-organise: a branch verb after an agent prefix is never a ticket; copilot/fix-<n> is issue #<n>', () => {
  const t = (branch) => W.titleOf({ team: false, branch }).title;
  assert.equal(t('copilot/fix-1234'), '#1234');
  assert.equal(t('codex/fix-12-bugs'), '12 bugs');
  for (const b of ['codex/fix-12-bugs', 'codex/FIX-12', 'claude/feat-9-login', 'agent/add-3-tests', 'codex/hotfix-7', 'cursor/chore-4-deps', 'bot/bug-5', 'codex/issue-6', 'codex/refactor-2-auth', 'codex/docs-1', 'codex/test-3']) {
    assert.doesNotMatch(t(b), /^(?:FIX|FEAT|ADD|HOTFIX|CHORE|BUG|ISSUE|REFACTOR|DOCS|TEST)-\d/, b);
  }
  assert.equal(t('codex/eng-42'), 'ENG-42');
  assert.equal(t('sam/abc-123-fix-login'), 'ABC-123 · Fix login');
});

test('work-organise: session, agent, deps and other non-work words after an agent prefix are not tickets', () => {
  const t = (branch) => W.titleOf({ team: false, branch }).title;
  for (const b of ['claude/session-2026-10-23', 'claude/agent-3', 'bot/deps-2', 'codex/wip-4', 'codex/tmp-5', 'codex/ci-6', 'codex/release-7', 'codex/SESSION-9']) {
    assert.doesNotMatch(t(b), /^[A-Z]+-\d/, b);
  }
  assert.equal(t('codex/eng-42'), 'ENG-42');
});

test('titleOf: the default redaction is the hub title scrub (review L2)', () => {
  const { title } = W.titleOf({ team: false, reported: 'call +27 82 555 0199 about db1.internal.example.com fe80::1ff:fe23:4567:890a' });
  assert.doesNotMatch(title, /555 0199|db1\.internal|fe80::/, title);
  assert.equal(W.titleOf({ team: false, reported: 'Bump node 22.4.1 for ENG-42 at 10:30' }).title, 'Bump node 22.4.1 for ENG-42 at 10:30');
});

// Organised views PR 3 (review C1/C2): the Sessions page asks for groups on every render, so the
// resolver answers synchronously from its last good value and never lets a failed lookup replace it.
const timeout = () => { const e = new Error('timed out'); e.killed = true; e.signal = 'SIGTERM'; return e; };
test('work-organise: resolver — a good answer survives a failed lookup; a failure retries after 5 s, not the TTL', async () => {
  let t = 0, down = false;
  const inner = fakeGit({ '/r/app': { top: '/r/app', common: '/r/app/.git', branch: 'main' } }).git;
  let n = 0;
  const git = async (d, a) => { n++; if (down) throw timeout(); return inner(d, a); };
  const repoFor = async () => (down ? null : 'github.com/acme/app');
  const r = createGitInfoResolver({ git, repoFor, now: () => t, jitter: 0 });
  const cold = r.groupOf('/r/app');
  assert.equal(cold.pending, true, 'no answer yet: the folder, marked pending');
  assert.deepEqual(Object.keys(cold).sort(), ['heading', 'key', 'pending', 'sub']);
  await r.idle();
  const good = r.groupOf('/r/app');
  assert.equal(good.pending, false);
  assert.match(good.key, /^repo-/);

  down = true; t += 60_001;
  assert.equal(r.groupOf('/r/app').key, good.key, 'expired: still the good answer while it is looked up');
  await r.idle();
  assert.equal(r.groupOf('/r/app').key, good.key, 'git timed out: the good answer is kept');
  const before = n;
  t += 4_000; r.groupOf('/r/app'); await r.idle();
  assert.equal(n, before, 'inside the 5 s backoff: no new lookup');
  down = false; t += 1_000; r.groupOf('/r/app'); await r.idle();
  assert.ok(n > before, 'retried after 5 s');
  assert.equal(r.groupOf('/r/app').key, good.key);

  // Cold and failing: pending, then recovers on the first retry rather than after 60 s.
  let off = true;
  const r2 = createGitInfoResolver({ git: async (d, a) => { if (off) throw timeout(); return inner(d, a); }, repoFor, now: () => t, jitter: 0 });
  r2.groupOf('/r/app'); await r2.idle();
  assert.equal(r2.groupOf('/r/app').pending, true, 'failed cold lookup stays pending');
  off = false; t += 5_000; r2.groupOf('/r/app'); await r2.idle();
  assert.deepEqual([r2.groupOf('/r/app').pending, r2.groupOf('/r/app').key], [false, good.key], 'recovered within 5 s');
});

test('work-organise: resolver — losing the origin is believed only when the next lookup agrees', async () => {
  let t = 0, origin = 'github.com/acme/app';
  const { git } = fakeGit({ '/r/app': { top: '/r/app', common: '/r/app/.git', branch: 'main' } });
  const r = createGitInfoResolver({ git, repoFor: async () => origin, now: () => t, jitter: 0 });
  r.groupOf('/r/app'); await r.idle();
  const repoKey = r.groupOf('/r/app').key;
  origin = null; t += 60_001; r.groupOf('/r/app'); await r.idle();
  assert.equal(r.groupOf('/r/app').key, repoKey, 'one slow git config does not move the project');
  t += 5_000; r.groupOf('/r/app'); await r.idle();
  assert.match(r.groupOf('/r/app').key, /^git-/, 'said twice: the origin really is gone');
});

test('work-organise: resolver — at most 4 lookups at once, one per cwd; TTLs are jittered', async () => {
  let live = 0, peak = 0;
  const release = [];
  const git = (d, a) => new Promise((res) => { live++; peak = Math.max(peak, live); release.push(() => { live--; res(a[0] === 'rev-parse' ? `${d}\n${d}/.git\n` : 'main\n'); }); });
  const r = createGitInfoResolver({ git, now: () => 0 });
  const dirs = Array.from({ length: 20 }, (_, i) => `/q/${i}`);
  for (const d of dirs) { r.groupOf(d); r.groupOf(d); }
  const settle = async () => { while (release.length) { release.shift()(); await new Promise((res) => setImmediate(res)); } };
  await new Promise((res) => setImmediate(res));
  assert.equal(peak, 8, "two git calls per lookup, four lookups at once");
  await settle(); await r.idle();
  assert.ok(dirs.every((d) => !r.groupOf(d).pending));

  // ±20 %: the same answer looked up at 0 lives 48 s with the lowest draw and 72 s with the highest.
  const looks = async (draw) => {
    let t = 0, count = 0;
    const q = createGitInfoResolver({ git: (d, a) => { count++; return a[0] === 'rev-parse' ? `${d}\n.git` : 'main'; }, now: () => t, random: () => draw });
    q.groupOf('/j'); await q.idle();
    t = 50_000; q.groupOf('/j'); await q.idle();
    return count;
  };
  assert.deepEqual([await looks(0), await looks(1)], [4, 2], 'expired at 48 s, still fresh at 72 s');
});
