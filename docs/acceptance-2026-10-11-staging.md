# Two-account acceptance: staging, 2026-10-11

Run of `docs/ACCEPTANCE-TWO-ACCOUNTS.md` plus the agent-mail rows (board/MESSAGING.md §6a) by `board/hub/scripts/acceptance/acceptance.mjs`, over the hub's HTTP API only.

| Item | Value |
|---|---|
| Hub | buddy-hub-staging on the Pi, reached over an SSH tunnel (`/api/health`: `"auth":"accounts"`) |
| Hub SHA | 14f5445e (migration 72 `message_hold`) |
| Methods | google, github, email (`BOARD_EMAIL_SIGNIN=1`; `BOARD_SIGNUP=open` for the run) |
| Accounts | A and B: two plus-addresses of the owner's mailbox, signed in by email code (client `buddy_desktop`). C: a throwaway flow spent on wrong codes. |
| Teams | `acceptance-2026-10-11`, `acceptance-2026-10-11-b` (deleted in Part 4) |

Result: **30 PASS, 0 FAIL, 6 N/A**.

| Row | Result |
|---|---|
| 0.1 health, 0.2 methods | PASS |
| 1.4 email code, 1.5 reuse refused, 1.6 wrong codes dead after 5 | PASS |
| 1.1, 1.3 (desktop app), 1.2, 1.8 (Google in a browser) | N/A here. Google sign-in from the desktop app was verified live against production on 2026-10-10 (board page reached, identity row created). |
| 1.7 SIGNUP_CLOSED | N/A: a refused address gets a 200 and no mail, so it is not observable over the API. |
| 2.1–2.9 invites, roles, second team | PASS |
| 2.10 expired invite | N/A: invites last 7 days, no short-expiry setting. |
| 3.1–3.10 board share, viewer refusals, archive, removal, re-invite, non-member leaks, API token | PASS (3.3 checked by API read, live push not checked) |
| M.1–M.6 held ask, release once, delivery, answer, held handoff accepted | PASS |

Mail: SES delivered every code and notice within seconds (out of sandbox).

To repeat: `node board/hub/scripts/acceptance/selftest.mjs` runs the same stages against a local hub; the header of `acceptance.mjs` gives the staged commands for a real hub.
