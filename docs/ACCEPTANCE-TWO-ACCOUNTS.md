# Two-account acceptance script: sign-in, team invite, board share

A scripted test run by one person with two real accounts, A and B, against an **accounts-mode hub** (`"auth":"accounts"` in `/api/health`). Use a staging hub or a disposable team; never run it in a team people use. Nothing here was run when this was written, so the expected results come from the code and docs named in each section, not from a recorded pass.

Scope: sign-in (Part 1), team invite (Part 2), board share (Part 3), clean-up (Part 4). Sharing live AI **sessions** between the two accounts is a separate, longer record: `docs/release-readiness-2026-10-03.md`, "Two real accounts: acceptance record" (11 steps). Do that after this script passes.

References: `board/ACCOUNTS-API.md` (sign-in, teams, invites, roles), `docs/CUTOVER.md` (hub setup and signup policy), `board/hub/identity/invites.js`, `board/hub/permissions.js`.

## Setup

| Item | Value |
|---|---|
| Hub | URL under test: `________________` (health shows `"auth":"accounts"`) |
| Build | Plexiform version and platform: `________________` |
| Account A | An address on the signup allowlist (or the hub runs `BOARD_SIGNUP=open`). Becomes the team owner. |
| Account B | A different address you can read mail for. **Not** on the allowlist if the hub is `allowlist`, so Part 2 proves an invite lets a new person in. |
| Devices | Two clients: A in the desktop app, B in a second desktop profile, or B in a private browser window on the hub's web app. Use separate profiles so A's and B's sign-ins never share storage. |
| Team name | A throwaway name, for example `acceptance-<date>` |

Record the date, hub SHA (`DEPLOYED_SHA`) and the pseudonym for each account. Do not write sign-in codes, tokens or invite links into the results.

Hub prerequisites to confirm before starting:

- [ ] `curl -fsS <hub>/api/health` returns `"ok":true` and `"auth":"accounts"`.
- [ ] `curl -fsS <hub>/api/auth/methods` lists the methods you intend to test (Google, GitHub, email code).
- [ ] Email code testing needs a working mailer (`BOARD_EMAIL_SIGNIN=1`, mail configured). While the mail service is in the sandbox, only verified recipient addresses receive codes. If email is not configured, mark the email rows `N/A: mail off` rather than FAIL.

## Part 1. Sign-in

| # | Action | Expected result | Result |
|---|---|---|---|
| 1.1 | A opens Plexiform with no saved sign-in and opens **Team**. | The Team page is visible before sign-in and offers sign-in. No error. | |
| 1.2 | A chooses **Continue with Google** (or GitHub). Complete the provider page in the browser. | The browser returns to the app, the window shows A signed in with A's name and email. A personal team and board exist if A has no pending invite. | |
| 1.3 | A quits and reopens the app. | A is still signed in (the device token is sealed in the Keychain and survives restarts). | |
| 1.4 | A signs out, then signs in again with **an email code** (needs mail). Enter A's address, then the 6-digit code from the mail. | The mail names A's Mac and platform, the code works once. A is signed in as the same user (same teams as in 1.2). | |
| 1.5 | Re-enter the **same code** after it worked. | Refused. A code is single use and expires after 10 minutes. | |
| 1.6 | Enter a wrong code. Repeat until the sign-in attempt dies (5 wrong codes per flow). | Each wrong code answers `INVALID_TOKEN` with `attempts_left`; after 5 the flow is dead and you must start again. The message does not reveal whether the address has an account. (The per-address budget is 20 wrong codes in 24 hours; do not spend it on a real account.) | |
| 1.7 | B, on the allowlist-closed hub, tries to create a brand-new account with no invite (email code). | `SIGNUP_CLOSED`: "Sign-up is invite-only right now. Ask a team owner for an invite." No account is created. (On a `BOARD_SIGNUP=open` hub, skip: B signs up and Part 2 tests joining, not signing up.) | |
| 1.8 | A: Cancel an in-progress Google sign-in (press Cancel while the browser is open). | The app returns to the sign-in screen, no token is stored. Retrying works. | |

## Part 2. Team invite

A is the owner of the team created in 1.2. Roles an invite can carry: `admin`, `member`, `viewer`. An invite never makes an owner.

| # | Action | Expected result | Result |
|---|---|---|---|
| 2.1 | A opens the team, **Members**, and invites B's address as **member**. | A link and a code are shown **once**. The hub sends no mail (A shares them, or uses "Email it", which only opens a draft in A's mail app). | |
| 2.2 | A invites B's address a second time. | `409 CONFLICT` naming the existing invite (resend that one instead). There is one invite per address per team at a time. | |
| 2.3 | A invites A's own address. | `409 ALREADY_MEMBER`. | |
| 2.4 | A tries to invite someone as **owner** (via the role control or the API). | Refused: "invites never make owners: invite, then change the role". | |
| 2.5 | Someone signed in as a different address (any other account) opens B's invite link and tries to accept. | `403 WRONG_ACCOUNT`; the message names no address, and the invite stays usable by B. | |
| 2.6 | B opens the invite link, signs in (Google, GitHub or email code, using the invited address), accepts. | B lands in A's team. B's role is **member**. In A's Members list, B appears with role member. | |
| 2.7 | B reopens the same invite link. | The invite is spent: refused as already used or expired. B is still a single member (no duplicate row). | |
| 2.8 | A changes B's role to **viewer**, then back to **member**. | Each change is reflected in B's session within a minute (refresh B's view). The changes show in the team history. | |
| 2.9 | A invites B's address as **viewer**, in a second throwaway team owned by A (optional second team). | B sees two teams in the account switcher; each team lists only its own boards and members. | |
| 2.10 | A creates an invite, waits for its expiry (or uses an invite with a short expiry if the test hub allows), then B tries it. | Refused as expired. | |

## Part 3. Board share

"Board share" here means a team board that B can see and use because B is a team member, and that stays hidden from anyone who is not. A owns the team from Part 2. B is a **member** unless a row says otherwise.

| # | Action | Expected result | Result |
|---|---|---|---|
| 3.1 | A creates a board named `Acceptance board` (admins and owners can add boards) and a card `A-1 from A`. | The board appears for A with a key prefix and the card has a key (for example `ACC-1`). | |
| 3.2 | B opens the team's board list. | B sees `Acceptance board` and card `A-1 from A` without A doing anything more. | |
| 3.3 | B adds a comment `B was here` on the card, and creates a card `B-1 from B`. | A sees the comment and the new card appear without a manual reload (live update), and each is attributed to B. | |
| 3.4 | A changes B to **viewer**. B tries to comment, create a card and move a card. | B can still read the board. Every write attempt is refused (the controls are disabled, and a forged request answers an authority error). | |
| 3.5 | A changes B back to **member**. | B can write again, no re-invite needed. | |
| 3.6 | A archives `Acceptance board`. | The board leaves both A's and B's active board lists; its cards are no longer shown as active work. (Unarchive from the archived list if you want to continue.) | |
| 3.7 | A removes B from the team. | B's open session ends. B can no longer see the team, its boards or cards; the old invite link does not re-add B. B's other teams, if any, are unaffected. | |
| 3.8 | A invites B again as member and B accepts. | B is a member again and sees the boards. History from before the removal is intact for A. | |
| 3.9 | **Isolation.** B (or a third account) with no membership in A's team requests one of A's board URLs or card ids directly. | The answer is the same as for an id that does not exist ("not found"). No board name, key or title is leaked. | |
| 3.10 | **Public API token (optional; needs migration 070).** Promote B to **admin**, B creates an API token with `read:boards` and reads `/api/public/v1/boards` with it; then A removes B from the team. | The read works while B is an admin. After B is removed the same token answers `401` (a token acts as its maker, and only while the maker is in the team). Mark `N/A` if 070 is not deployed. | |

## Part 4. Clean-up

- [ ] Delete the throwaway team(s) (owner types the team's short name, then confirms with an emailed code or the Google/GitHub check).
- [ ] If the account is a test account, delete it (Account, Delete my account, confirm).
- [ ] Revoke any API token and webhook created during the run.
- [ ] Sign both clients out; confirm the Keychain entry is removed with the sign-out.

## Result record

| Part | PASS / FAIL / N/A | Notes and evidence reference |
|---|---|---|
| 1 Sign-in | | |
| 2 Team invite | | |
| 3 Board share | | |
| 4 Clean-up | | |

A failure on any row of Parts 1 to 3 blocks the account-mode release until explained. Record the hub SHA, build, date and pseudonymous accounts with the result; keep screenshots and request ids, not codes, tokens or invite links.

## Not covered here

- Sharing live AI sessions and teammate messaging: `docs/release-readiness-2026-10-03.md`.
- Owner-only setup of OAuth clients, SES and signup policy: `docs/CUTOVER.md`.
- Linear and Jira connectors: not offered in this release. Slack and Sentry are offered; their runbooks hold the acceptance steps.
