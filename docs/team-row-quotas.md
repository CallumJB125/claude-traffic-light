# Team card and comment limits

Accounts-mode teams may retain 5,000 cards and 50,000 comments on the free plan. Pro has ten times those limits. Self-hosted plans and nonaccounts local hubs have no plan row cap. Archived cards and comments from every author count across all of the team's boards.

New card creation uses the same transaction guard for ordinary API, remote and integration callers, workflow task sets, observed work capture, client feedback and authenticated runner child tasks. A refusal consumes no board key and rolls back the complete multi-row operation. Updating an existing captured card remains available at the cap.

Ordinary comments and coordination messages share the comment guard. An exact current authorized replay creates no additional row and remains available. Coordination refusal rolls back its thread, message, recipients and journal together. Task-context packets do not consume comment rows.

Outbox outcomes from already running attempts remain recordable and count toward later admissions; a plan cap does not discard observed work. Restore and migration operations are not governed by a generic row-denying trigger. Refusal reports only the fixed resource and plan limit, without private row counts or another team's information.

Migration027 adds the comment-to-card lookup index without editing applied migrations. This checkpoint implements row limits only. Storage-pressure admission and the accepted HTTP daily byte budget require separate implementation and acceptance; this document does not claim those gates exist.
