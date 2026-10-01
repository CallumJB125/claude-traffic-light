# Card planning and My day

Card planning stores all-day Gregorian `start_date` and `due_date` values, each nullable or `YYYY-MM-DD` (years 0001–9999). A complete range has start ≤ due and at most 3660 days between them. A timezone determines “today”; it never converts the stored dates into instants.

`PATCH /api/cards/:card_id/planning` accepts only:

```json
{
  "request_id": "f73cc870-b638-4dfa-9d48-9b1d7f2aa8d0",
  "version": 1,
  "start_date": "2026-10-01",
  "due_date": "2026-10-03",
  "depends_on": ["predecessor-card-id"]
}
```

At least one planning field is required. Omitted fields keep their current value; null clears a date; an empty dependency array removes predecessors. There are at most 20 predecessors, all active cards in the same board with currently linked repositories. Self links and cycles are refused. Traversal is bounded to 2000 cards and 5000 edges. Dependencies describe the plan and do not grant, start, gate or reschedule execution.

The endpoint requires a current staff writer and checks credentials, membership, board, card, repository and requested dependency scope before entering the board queue and again inside it. It updates dates, dependencies, card version and journal atomically, then broadcasts a normal card upsert. Exact retries are bound to the actor, card, original version and normalized choice. A successful retry returns the current CardView with `replayed: true`. Reusing the ID for another choice conflicts. The most recent 2000 successful planning request IDs per member survive restart; older retries still require the original card version, so they cannot silently duplicate an edit.

CardView adds `start_date`, `due_date`, `depends_on` and `planning_in_scope`. Calendar supports month/week navigation, forms, drag moves and keyboard day moves. Timeline shows a 28-day range and dependencies. Its critical path uses explicit planned durations on open work; missing dates produce an unknown state rather than an estimated delivery forecast. Per-member/board navigation and IANA timezone preferences persist in browser storage.

`GET /api/my-day` is a fixed read endpoint. Accounts mode uses the authenticated user's current staff memberships; embedded local mode uses the launch's actual local principal. It returns `principal`, `status: complete|partial`, `cards`, `decisions` and `agents`. Own relations include creator, assignee, current runner owner/dispatcher and pending dispatch target. Decisions require the existing permission-approver or question-answer authority, including eligible parked decisions. Archived boards/cards, removed memberships and unlinked repositories are excluded. Replies are bounded to 500 items per category, 32 visited boards and 2000 inspected candidate cards; display limits are reported as partial.

Desktop My day talks only to registered hub endpoints and the current embedded launch through main. Credentials and URLs stay in main. Opening an item uses an expiring opaque handle, re-reads its current own/decision scope and checks the current account before navigation. The desktop aggregate displays at most 500 items per category and at most the local board plus eight registered hubs. Signed-out or unavailable sources remain visible as unavailable.

Own run liveness requires the actual accepted current runner connection and its current authorization. Local session metadata is labeled reported, with recent/stale/unknown freshness; it does not verify completion. Calendar/focus availability comes from already-authorized BusyWatch state and is reduced to availability and permission status. My day neither reads event details nor requests calendar access.
