// CardView builders for the web tests (CONTRACT §5.3 shapes).
export const ALICE = { member_id: 'm-alice', name: 'Alice', login: 'alice', avatar_url: null };
export const BOB = { member_id: 'm-bob', name: 'Bob', login: 'bob', avatar_url: null };
export const MEMBERS = new Map([[ALICE.member_id, ALICE], [BOB.member_id, BOB]]);

export function live(extra = {}) {
  return { hb_age_ms: 3000, child_alive: true, activity_age_ms: 5000, tool_in_flight: { name: 'Edit', summary: 'src/api/deals.ts', age_ms: 2000 }, wake_age_ms: null, post_wake_activity: false, green: true, ...extra };
}

export function view(extra = {}) {
  return {
    id: 'c-1', key: 'BDL-1', title: 'Fix the thing', labels: [], column: 'in_progress', version: 3,
    run_state: 'running', blocked_kind: null, fail_kind: null, fail_reason: null, resume_to: null, fence: 2,
    repo: { id: 'r1', short_name: 'bondly' }, base_ref: 'dev', branch: 'board/BDL-1-r2',
    assignee_ids: ['m-alice'], approvers: [], viewer_can_approve: false, target: null, queue: null,
    run: { id: 'run-1', backend: 'claude_cli', device_name: 'MacBook Pro', owner: { member_id: 'm-alice', name: 'Alice' }, dispatched_by: { member_id: 'm-alice', name: 'Alice' } },
    live: live(), state_age_ms: 60_000, ask: null, handover: null, handover_target_name: null, stopped_by_name: null,
    limit_resets_in_ms: null, device_kind: null, overlaps: [], budget: { spent_usd: 1.2, cap_usd: 5 }, pr: null, evidence: null,
    ...extra,
  };
}

export function model(entries, extra = {}) {
  return {
    me: { member: { id: 'm-alice', name: 'Alice', login: 'alice', role: 'member' } },
    board: { id: 'b', name: 'Bondly', key_prefix: 'BDL' },
    members: MEMBERS,
    entries,
    alerts: { items: [], more: 0 },
    conn: { status: 'open', lostAt: null, retryInMs: null },
    detail: null, dialog: null, busy: new Set(), theme: 'system', showAllDone: false, openCardId: null, readOnly: false,
    ...extra,
  };
}
