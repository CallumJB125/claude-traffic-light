// Mock hub fixtures: one board, four members, two repos and a card in every
// run state the card face can show. Times are stored as mock wall-clock
// instants (ms) and turned into ages at send time, like the real hub does.
import { applyPatch } from '../../shared/handover.js';

const S = 1000;
const M = 60 * S;
const H = 60 * M;

export const BOARD = { id: 'board-bdl', name: 'Bondly', key_prefix: 'BDL', settings: { team_context_budget: 700 } };
export const ORG = { id: 'org-pistor', name: 'Pistor Ventures' };

export const MEMBERS = [
  { member_id: 'm-alice', name: 'Alice', login: 'alice', avatar_url: null, email: 'alice@example.com', role: 'member', device: 'MacBook Pro' },
  { member_id: 'm-bob', name: 'Bob', login: 'bob', avatar_url: null, email: 'bob@example.com', role: 'member', device: 'Mac mini' },
  { member_id: 'm-james', name: 'James', login: 'james', avatar_url: null, email: 'james@example.com', role: 'member', device: 'MacBook Air' },
  { member_id: 'm-sam', name: 'Sam', login: 'sam', avatar_url: null, email: 'sam@example.com', role: 'member', device: 'ThinkPad' },
];

export const REPOS = [
  { id: 'repo-bondly', short_name: 'bondly', canonical_url: 'github.com/pistorventures/bondly', default_branch: 'dev' },
  { id: 'repo-web', short_name: 'bondly-frontend', canonical_url: 'github.com/pistorventures/bondly-frontend', default_branch: 'main' },
];

// Which members have a runner online per repo (drives queue.runner_online).
export const ONLINE = { 'repo-bondly': ['m-alice', 'm-james', 'm-bob', 'm-sam'], 'repo-web': [] };

const BDL142_NARRATIVE = [
  { plan: [
    { text: 'Reproduce on localhost (switch-next :5174 + backend :3000)', status: 'done' },
    { text: 'Find where body is built', status: 'done' },
    { text: 'Fix client payload builder', status: 'doing' },
    { text: 'Server-side guard: reject empty submit (400)', status: 'todo' },
    { text: 'Test + PR', status: 'todo' },
  ] },
  { done: '13:40 Server accepts `{}` and creates capp with amount 0; declared-income fallback path not involved.' },
  { done: '13:58 Reproduced: register → dashboard → Submit sends `{}` (server log `submit body keys=0`).' },
  { done: '14:21 Root cause candidate: `buildSubmitPayload()` reads `useApplicationDraft()`, empty after magic-link login because the draft is keyed by anon id, not user id.' },
  {
    hypothesis: 'Anon draft is never re-keyed to the user id on auth success, so submit reads an empty draft. Fix = re-key on auth success + server-side 400 on empty body.',
    dead_ends: '- Not the Hero UI form (values present before navigation).\n- Not nginx body size / content-type (curl with full body works).',
    next: 'Call `rekeyDraft(anonId, userId)` in the auth-success handler (apps/switch-next/lib/auth.ts), then add the empty-body 400 guard in the applications.js submit route; re-run the failing test.',
    questions: '- 400 or 422 for empty submit? (asked 14:10, unanswered)\n- A parallel session owns SwitchTracker.jsx and finance.js; do not edit those.',
  },
];

function narrativeFrom(patches, at) {
  let n = null;
  for (const p of patches) n = applyPatch(n, p, { at_ms: at });
  return n;
}

function genericNarrative(title, at, hypothesis, next) {
  return narrativeFrom([
    { plan: [{ text: 'Read the code paths involved', status: 'done' }, { text: 'Make the change', status: 'doing' }, { text: 'Test + PR', status: 'todo' }] },
    { done: `Started on “${title}”.` },
    { hypothesis, next },
  ], at);
}

/**
 * Build the card records. `now` = mock wall clock (Date.now()).
 * Record fields mirror CardView, with instants (`*_at`) instead of ages.
 */
export function buildCards(now) {
  const ago = (ms) => now - ms;
  const run = (n, owner, by, extra = {}) => ({ id: `run-${n}`, backend: 'claude_cli', owner_id: owner, dispatched_by_id: by, ...extra });
  const alive = (activityAgo, tool = null, extra = {}) => ({ hb_at: ago(4 * S), child_alive: true, activity_at: ago(activityAgo), tool, wake_at: null, post_wake_activity: false, pulse: true, ...extra });
  const feed = (...items) => items.map(([kind, at, extra = {}], i) => ({ id: `ev-${kind}-${i}-${at}`, kind, at: ago(at), ...extra }));
  const cards = [];
  const add = (c) => { cards.push({ labels: [], assignee_ids: [], overlaps: [], version: 1, fence: 0, column: null, base_ref: 'dev', repo_id: 'repo-bondly', body: '', acceptance: '', detail: {}, ...c }); };

  add({
    id: 'c-142', key: 'BDL-142', title: 'Dashboard “Submit application” posts {} → bank sees “New bond R0”',
    body: 'Submitting from the consumer dashboard sends an empty body. Bond Desk shows the loan as “New bond R0”.\n\nLikely in apps/switch-next/lib/submit.ts or the applications submit route.',
    acceptance: '- POST /api/applications/:id/submit body contains loanAmount, propertyValue, income fields\n- Bond Desk queue shows correct amount for a new submission on localhost\n- Regression test: empty-body submit returns 400',
    labels: ['bug', 'api'], run_state: 'blocked', blocked_kind: 'permission', fence: 3, branch: 'board/BDL-142-r3',
    assignee_ids: ['m-alice'], run: run(142, 'm-alice', 'm-alice', { device_name: 'MacBook Pro' }),
    live: alive(40 * S, null), state_since: ago(3 * M), budget: { spent_usd: 2.35, cap_usd: 5 },
    ask: { kind: 'permission', summary: 'npm run migrate', count: 2 },
    detail: {
      permission_requests: [
        { id: 'pr-1', tool: 'Bash', input_summary: 'npm run migrate', state: 'open', approvers: ['m-alice', 'm-bob'] },
        { id: 'pr-2', tool: 'Bash', input_summary: 'git push origin board/BDL-142-r3', state: 'open', approvers: ['m-alice', 'm-bob'] },
      ],
      asks: [{ id: 'ask-142-a', kind: 'question', text: '400 or 422 for an empty submit?', options: ['400', '422'], state: 'answered', answer: '400', answered_by_name: 'Bob' }],
      narrative: narrativeFrom(BDL142_NARRATIVE, ago(11 * M)),
      facts: {
        at_ms: ago(40 * S), branch: 'board/BDL-142-r3', head_sha: 'e41b9d0', commits_ahead: 1,
        files_touched: [
          { path: 'apps/switch-next/lib/submit.ts', op: 'edit', at_ms: ago(6 * M) },
          { path: 'apps/switch-next/hooks/useApplicationDraft.ts', op: 'read', at_ms: ago(12 * M) },
          { path: 'backend/routes/applications.js', op: 'edit', at_ms: ago(5 * M) },
        ],
        commands: [{ cmd: 'npx jest backend/__tests__/applications.submit.test.js', exit: 1, duration_ms: 4200, tail: 'expected 400, received 200' }],
      },
      snapshot: { sha: '7f3a2c1d9e', ref: 'refs/board/BDL-142/r3', status: 'pushed', at_ms: ago(10 * M) },
      comments: [
        { id: 'cm-1', author_name: 'Bob', source: 'human', trusted: true, body: '@claude a parallel session owns SwitchTracker.jsx and finance.js, leave those alone.', for_agent: true, delivered_at: ago(20 * M), created_at: ago(22 * M) },
        { id: 'cm-2', author_name: 'Claude', source: 'agent', trusted: true, body: 'Understood. I’ll keep changes to submit.ts, auth.ts and the applications route.', for_agent: false, created_at: ago(19 * M) },
      ],
      memories: [{ id: 'mem-1', text: 'r2 → r3: Alice took over (takeover); hypothesis draft keyed by anon id; next re-key on auth success' }],
      feed: feed(['dispatched', 48 * M, { actor_name: 'Alice', run_n: 3 }], ['claimed', 47 * M, { run_n: 3, text: 'Alice’s MacBook Pro' }], ['started', 47 * M, { run_n: 3 }],
        ['progress', 36 * M, { run_n: 3, text: 'Reproduced: Submit sends `{}` after magic-link login.' }], ['file', 6 * M, { run_n: 3, data: { op: 'edit', path: 'apps/switch-next/lib/submit.ts' } }],
        ['command', 5 * M, { run_n: 3, data: { cmd: 'npx jest backend/__tests__/applications.submit.test.js', exit: 1 } }],
        ['blocked', 3 * M, { run_n: 3, text: 'approval · `npm run migrate`' }]),
    },
  });

  add({
    id: 'c-146', key: 'BDL-146', title: 'Rework deals.ts pagination so Bond Desk can page past 500 deals',
    labels: ['bond-desk'], run_state: 'running', fence: 1, branch: 'board/BDL-146-r1', assignee_ids: ['m-alice'],
    run: run(146, 'm-alice', 'm-alice', { device_name: 'MacBook Pro' }),
    live: alive(12 * S, { name: 'Edit', summary: 'src/api/deals.ts', started_at: ago(3 * S) }), state_since: ago(14 * M),
    budget: { spent_usd: 1.2, cap_usd: 5 },
    overlaps: [{ other_card_id: 'c-139', level: 'high', kind: 'overlapping', reasons: ['same file'], paths: ['src/api/deals.ts'], since: ago(2 * M) }],
    detail: { narrative: genericNarrative('Rework deals.ts pagination', ago(4 * M), 'Offset pagination is O(n) on the capp table; keyset on (created_at, id) keeps page 20 as cheap as page 1.', 'Swap the list query to keyset and keep the old offset param as a fallback for one release.'),
      facts: { at_ms: ago(12 * S), branch: 'board/BDL-146-r1', files_touched: [{ path: 'src/api/deals.ts', op: 'edit', at_ms: ago(3 * S) }], commands: [] },
      snapshot: { sha: 'a91c07e22b', ref: 'refs/board/BDL-146/r1', status: 'pushed', at_ms: ago(4 * M) },
      feed: feed(['dispatched', 15 * M, { actor_name: 'Alice', run_n: 1 }], ['started', 14 * M, { run_n: 1 }], ['file', 3 * S, { run_n: 1, data: { op: 'edit', path: 'src/api/deals.ts' } }]) },
  });

  add({
    id: 'c-139', key: 'BDL-139', title: 'Deals API returns 500 when a bank filter is empty',
    labels: ['bug'], run_state: 'running', fence: 2, branch: 'board/BDL-139-r2', assignee_ids: ['m-james'],
    run: run(139, 'm-james', 'm-james', { device_name: 'MacBook Air' }),
    live: alive(8 * S, { name: 'Bash', summary: 'npm test', started_at: ago(2 * M + 4 * S), bash_timeout_ms: 5 * M }), state_since: ago(31 * M),
    budget: { spent_usd: 0.84, cap_usd: 3 },
    overlaps: [{ other_card_id: 'c-146', level: 'high', kind: 'overlapping', reasons: ['same file'], paths: ['src/api/deals.ts'], since: ago(2 * M) }],
    detail: { narrative: genericNarrative('Deals API 500', ago(9 * M), 'An empty `banks[]` builds `IN ()`, which Postgres rejects.', 'Guard the empty filter and add a test.'),
      facts: { at_ms: ago(8 * S), files_touched: [{ path: 'src/api/deals.ts', op: 'edit', at_ms: ago(6 * M) }], commands: [{ cmd: 'npm test', exit: null }] },
      feed: feed(['dispatched', 33 * M, { actor_name: 'James', run_n: 2 }], ['started', 31 * M, { run_n: 2 }]) },
  });

  add({
    id: 'c-144', key: 'BDL-144', title: 'Cache affordability results per statement hash',
    labels: ['perf'], run_state: 'quiet', fence: 1, branch: 'board/BDL-144-r1', assignee_ids: ['m-bob'],
    run: run(144, 'm-bob', 'm-bob', { device_name: 'Mac mini' }),
    live: alive(8 * M + 12 * S, null, { pulse: false }), state_since: ago(2 * M), budget: { spent_usd: 3.1, cap_usd: 4 },
    detail: { narrative: genericNarrative('Cache affordability', ago(22 * M), 'Hash the normalised statement rows, not the PDF bytes.', 'Wire the cache into assessAffordability.'), feed: feed(['started', 40 * M, { run_n: 1 }]) },
  });

  add({
    id: 'c-137', key: 'BDL-137', title: 'KYC OCR falls back to text-only model and returns nothing',
    labels: ['kyc'], run_state: 'orphaned', resume_to: 'quiet', fence: 4, branch: 'board/BDL-137-r4', assignee_ids: ['m-alice'],
    run: run(137, 'm-james', 'm-alice', { device_name: 'MacBook Air' }),
    live: { hb_at: ago(19 * M), child_alive: true, activity_at: ago(19 * M), tool: null, wake_at: null, post_wake_activity: false, pulse: false },
    state_since: ago(14 * M), handover_synced_at: ago(19 * M), handover_version: 6, budget: { spent_usd: 2.7, cap_usd: 5 },
    detail: { narrative: genericNarrative('KYC OCR', ago(19 * M), 'The OCR tier is routed to a text-only model; images never reach a vision model.', 'Route image pages to the vision tier; add a smoke test with a sample ID.'),
      snapshot: { sha: 'c0ffee1234', ref: 'refs/board/BDL-137/r4', status: 'pushed', at_ms: ago(20 * M) },
      facts: { at_ms: ago(19 * M), files_touched: [{ path: 'backend/kyc/ocr.js', op: 'edit', at_ms: ago(19 * M + 30 * S) }] },
      feed: feed(['started', 50 * M, { run_n: 4 }], ['unresponsive', 19 * M, { run_n: 4 }], ['orphaned', 14 * M, { run_n: 4 }]) },
  });

  add({
    id: 'c-140', key: 'BDL-140', title: 'Nightly statement re-parse for accounts with stale income',
    run_state: 'failed', fail_kind: 'limit', fence: 1, branch: 'board/BDL-140-r1', assignee_ids: ['m-alice'],
    run: run(140, 'm-alice', 'm-alice', { device_name: 'MacBook Pro' }), live: null, state_since: ago(9 * M), limit_resets_at: now + 47 * M,
    budget: { spent_usd: 1.9, cap_usd: 5 },
    detail: { narrative: genericNarrative('Nightly re-parse', ago(12 * M), 'Only accounts whose last parse predates the income-detector fix need a re-run.', 'Write the selection query, then the cron entry.'),
      feed: feed(['started', 50 * M, { run_n: 1 }], ['failed', 9 * M, { run_n: 1, data: { fail_kind: 'limit', reason: 'usage limit' } }]) },
  });

  add({
    id: 'c-141', key: 'BDL-141', title: 'Unsubscribe link should work without signing in',
    run_state: 'suspended', resume_to: 'blocked', blocked_kind: 'question', fence: 1, branch: 'board/BDL-141-r1', assignee_ids: ['m-bob'],
    run: run(141, 'm-bob', 'm-bob', { device_name: 'MacBook' }), device_kind: 'laptop',
    live: { hb_at: ago(12 * M), child_alive: true, activity_at: ago(13 * M), tool: null, wake_at: null, post_wake_activity: false, pulse: false },
    state_since: ago(12 * M), ask: { kind: 'question', summary: 'sign the token with the mail secret?', count: 1 },
    detail: { asks: [{ id: 'ask-141', kind: 'question', text: 'Sign the unsubscribe token with the mail secret, or mint a new one?', state: 'open' }], feed: feed(['blocked', 13 * M, { run_n: 1 }], ['suspended', 12 * M, { run_n: 1 }]) },
  });

  add({
    id: 'c-143', key: 'BDL-143', title: 'Move demo seed script to the new schema',
    run_state: 'handing_over', fence: 2, branch: 'board/BDL-143-r2', assignee_ids: ['m-sam'],
    run: run(143, 'm-sam', 'm-sam', { device_name: 'ThinkPad' }),
    live: { hb_at: ago(6 * S), child_alive: true, activity_at: ago(20 * S), tool: null, wake_at: null, post_wake_activity: false, pulse: true },
    state_since: ago(40 * S),
    detail: { feed: feed(['handing_over', 40 * S, { actor_name: 'Sam', run_n: 2 }]) },
  });

  add({
    id: 'c-138', key: 'BDL-138', title: 'Bond Desk: show the decision panel on mobile',
    run_state: 'handed_over', fence: 3, branch: 'board/BDL-138-r2', assignee_ids: ['m-sam'], run: null, live: null,
    state_since: ago(25 * M), handover_target_name: 'Sam', handover_version: 8, repo_id: 'repo-web', base_ref: 'main',
    detail: { narrative: genericNarrative('Decision panel on mobile', ago(27 * M), 'The panel’s grid collapses fine; the chart is the only fixed-width child.', 'Make the chart width follow its container.'), feed: feed(['handed_over', 25 * M, { data: { provenance: 'checkpoint_complete' } }]) },
  });

  add({
    id: 'c-148', key: 'BDL-148', title: 'Magic-link emails: add plain-text part',
    run_state: 'queued', fence: 0, run: null, live: null, assignee_ids: ['m-james'],
    target: { member_id: 'm-james', awaiting_confirm: true }, dispatched_by_id: 'm-alice', state_since: ago(2 * M), budget: { spent_usd: 0, cap_usd: 2 },
    detail: { feed: feed(['dispatched', 2 * M, { actor_name: 'Alice', data: { needs_confirm: true } }]) },
  });

  add({
    id: 'c-149', key: 'BDL-149', title: 'Bond Desk login page: remember the last bank',
    run_state: 'queued', fence: 0, run: null, live: null, repo_id: 'repo-web', base_ref: 'main', assignee_ids: ['m-alice'],
    target: { member_id: 'm-alice', awaiting_confirm: false }, dispatched_by_id: 'm-alice', state_since: ago(12 * M), queue_offline_since: ago(12 * M),
    detail: { feed: feed(['dispatched', 12 * M, { actor_name: 'Alice' }]) },
  });

  add({
    id: 'c-147', key: 'BDL-147', title: 'Rename capp.status values to the bank-facing taxonomy',
    run_state: 'claimed', fence: 1, branch: 'board/BDL-147-r1', assignee_ids: ['m-bob'], run: run(147, 'm-bob', 'm-alice', { device_name: 'Mac mini' }),
    live: { hb_at: ago(3 * S), child_alive: true, activity_at: null, tool: null, wake_at: null, post_wake_activity: false, pulse: false },
    state_since: ago(20 * S), detail: { feed: feed(['dispatched', 40 * S, { actor_name: 'Alice' }], ['claimed', 20 * S, { run_n: 1 }]) },
  });

  add({
    id: 'c-135', key: 'BDL-135', title: 'Reject applications with a zero loan amount',
    run_state: 'in_review', fence: 1, branch: 'board/BDL-135-r1', assignee_ids: ['m-alice'], run: run(135, 'm-alice', 'm-alice', { device_name: 'MacBook Pro' }), live: null,
    state_since: ago(38 * M), pr: { number: 1042, url: 'https://github.com/pistorventures/bondly/pull/1042', state: 'open' },
    evidence: { tests: 'pass', verification: 'hub_verified' }, budget: { spent_usd: 1.45, cap_usd: 5 },
    detail: { evidence: [{ id: 'evd-1', kind: 'test_run', summary: 'jest applications.submit — 14 passed' }], feed: feed(['in_review', 38 * M, { run_n: 1 }]) },
  });

  add({
    id: 'c-133', key: 'BDL-133', title: 'Copy: plain-language decline reasons on the result page',
    run_state: 'in_review', fence: 1, branch: 'board/BDL-133-r1', assignee_ids: ['m-sam'], run: run(133, 'm-sam', 'm-sam', { device_name: 'ThinkPad' }), live: null, repo_id: 'repo-web', base_ref: 'main',
    state_since: ago(3 * H), pr: { number: 88, url: 'https://github.com/pistorventures/bondly-frontend/pull/88', state: 'open' }, evidence: { tests: 'none', verification: 'self_reported' },
    detail: { feed: feed(['in_review', 3 * H, { run_n: 1 }]) },
  });

  add({
    id: 'c-130', key: 'BDL-130', title: 'Google sign-in button on Bond Desk',
    run_state: 'done', fence: 2, branch: 'board/BDL-130-r2', assignee_ids: ['m-james'], run: run(130, 'm-james', 'm-james', { device_name: 'MacBook Air' }), live: null,
    state_since: ago(2 * H), pr: { number: 1031, url: 'https://github.com/pistorventures/bondly/pull/1031', state: 'merged', merged_by: 'James', merged_at: ago(2 * H) },
    detail: { feed: feed(['merged', 2 * H, { actor_name: 'James' }]) },
  });

  add({
    id: 'c-128', key: 'BDL-128', title: 'Drop the legacy /switch teaser route',
    run_state: 'done', fence: 1, assignee_ids: ['m-sam'], run: run(128, 'm-sam', 'm-sam'), live: null, repo_id: 'repo-web', base_ref: 'main',
    state_since: ago(26 * H), pr: { number: 81, url: 'https://github.com/pistorventures/bondly-frontend/pull/81', state: 'merged', merged_by: 'Sam', merged_at: ago(26 * H) },
    detail: { feed: feed(['merged', 26 * H, { actor_name: 'Sam' }]) },
  });

  add({
    id: 'c-150', key: 'BDL-150', title: 'Server-side guard: reject an empty submit with 400',
    body: 'backend/routes/applications.js should refuse an empty body before creating a capp.', acceptance: 'A regression test covers the empty-body case.',
    labels: ['api'], run_state: 'todo', column: 'todo', assignee_ids: ['m-alice'], run: null, live: null, budget: { spent_usd: 0, cap_usd: 3 },
    detail: { feed: [] },
  });

  add({
    id: 'c-151', key: 'BDL-151', title: 'Write the release note for 2.4',
    run_state: 'todo', column: 'in_progress', repo_id: null, base_ref: null, assignee_ids: ['m-bob'], run: null, live: null,
    detail: { feed: feed(['comment', 3 * H, { actor_name: 'Bob', text: 'Drafting in the shared doc.' }]) },
  });

  add({
    id: 'c-152', key: 'BDL-152', title: 'Rate-limit the magic-link endpoint',
    body: 'Add a per-email and per-IP limit to POST /api/auth/magic-link. Paths: backend/routes/auth.js',
    acceptance: 'Six requests in a minute from one email get a 429.',
    labels: ['security'], run_state: 'todo', column: 'todo', assignee_ids: ['m-alice'], run: null, live: null, budget: { spent_usd: 0, cap_usd: 4 },
    detail: { feed: [] },
  });

  return cards;
}

// Team presence (D37b): ages instead of timestamps, turned into ISO `since`
// at send time like everything else here. Sam shares nothing; one session is
// waiting; one summary carries markup to prove it stays text.
export const PRESENCE = [
  { member_id: 'm-alice', name: 'Alice', sessions: [
    { agent: 'claude', repo_short: 'bondly', branch: 'board/BDL-142-r2', state: 'working', since_ago_ms: 18 * 60_000 + 20_000, summary: 'Re-keying the anonymous draft on auth success' },
    { agent: 'codex', repo_short: 'bondly-frontend', branch: 'feat/table-filter', state: 'idle', since_ago_ms: 41 * 60_000 },
  ] },
  { member_id: 'm-bob', name: 'Bob', sessions: [
    { agent: 'claude', repo_short: 'bondly-frontend', branch: 'feat/release-note', state: 'waiting', since_ago_ms: 4 * 60_000 + 10_000, summary: 'Needs a decision: ship 2.4 notes with or without the changelog link?' },
  ] },
  { member_id: 'm-james', name: 'James', sessions: [
    { agent: 'cursor', repo_short: 'bondly', state: 'working', since_ago_ms: 52_000, summary: '<img src=x onerror=alert(1)> tidying the auth tests' },
    { agent: 'gemini', repo_short: 'bondly', branch: 'spike/rate-limit', state: 'idle', since_ago_ms: 2 * 3_600_000 + 5 * 60_000 },
  ] },
];
