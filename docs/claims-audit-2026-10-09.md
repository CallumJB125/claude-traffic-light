# Claims audit, 2026-10-09

Claims in `PRIVACY.md`, `docs/release-notes.md` and `site/src` checked against the code on branch `claude/r2-l1docs` (based on `claude/release`). Each row names the grep or file that proves it. Docs only: no code was changed. Supersedes the stale rows of `docs/feature-ledger-2026-10-08.md` for the items below.

Verdicts: **TRUE** (code matches), **FIXED** (stale wording corrected in this change), **PENDING N1** (belongs to another branch; not claimed yet), **OWNER** (true in code; going live needs the owner), **FLAG** (left as is; needs a decision).

## Table

| # | Claim | Where | Code evidence | Verdict |
|---|---|---|---|---|
| 1 | Accounts (sign-in with Google, GitHub or email code; teams; invites) are built | `PRIVACY.md` "Not yet shipped" listed accounts as built-but-not-live | `BOARD_AUTH=accounts` mode in `board/hub/config.js:32`; `board/hub/identity/{accounts,oauth,oauth-web,invites,teams,mailer}.js`; desktop `buddy-window/{account-flow,oauth,accounts}.js` | **FIXED**: moved out of "Not yet shipped" into new "Shipped: accounts and automatic work tracking" |
| 2 | Plexiform's own hub (`app.plexiform.dev`) runs accounts | `PRIVACY.md` (retained sentence), `site/src/privacy.html` | `docs/CUTOVER.md` says "Nothing here has been run"; cutover is manual | **OWNER**: sentence kept ("has not yet been updated"). Change it the day the cutover is done |
| 3 | Automatic work tracking is off on a new install | `PRIVACY.md` | `createWorkCapture({startEnabled=false,...})` `src/work-capture.js:157`; `buddy-window/index.js:248` passes no `startEnabled`; state default `enabled:startEnabled` `src/work-capture.js:79` | **TRUE** |
| 4 | It turns on only via "Create cards from reported AI work" in This Mac, Automatic work cards | `PRIVACY.md` | `buddy-window/account.js:571,573,575` (heading "Automatic work cards", toggle label, `api.captureEnabled`); IPC `buddy:acct:captureEnabled` `buddy-window/index.js:954` | **TRUE** |
| 5 | Tray menu has "Pause automatic cards" (and Resume) | `PRIVACY.md` | `main.js:3177` (label `Pause automatic cards`, shown while capture is on), `main.js:3178` (`Resume automatic cards`) | **TRUE**. Bullet moved to the shipped section; "(shipped)" tag dropped |
| 6 | Crash reports are recorded and scrubbed locally only | `PRIVACY.md:16`, "Crash reports (local)", `site/src/privacy.html:27` | `src/crash-reports.js` (ring file `reports.jsonl`, `MAX_REPORTS`, `MAX_RING_BYTES`, `MAX_PER_RUN`); wired in `main.js:188` | **TRUE** |
| 7 | Opt-in switch "Allow sending crash reports", off by default, "View what would be sent", "Export diagnostics" exist | `PRIVACY.md` | `settings.html:594,597,601`; `settings-crash-reports.js:7`; `main.js:3491-3492` (`crash-reports:state`, `crash-reports:set-opt-in`); consent defaults false `src/crash-reports.js:97-99` | **TRUE** |
| 8 | Sending crash reports does not exist (no endpoint, no network code) | `PRIVACY.md`, `site/src/privacy.html` | `sendCrashReport` is a placeholder returning `{sent:false}` `src/crash-reports.js:72`; no `fetch`/`https`/`net.request` in the file | **TRUE**, wording sharpened. **OWNER**: the receiving endpoint is the owner's to set up; the send body is replaced then, with a privacy-flow marker and a PRIVACY.md entry |
| 9 | "Crash reports, when they arrive, will be opt-in" | `site/src/index.html:258` | Local half exists (rows 6 and 7), sending does not | **FIXED**: now says they are recorded and scrubbed on the Mac only, sending is not built, and will be opt-in |
| 10 | Usage pop-out from the tray/widget menu | `docs/release-notes.md` draft (formerly), `site/src/changelog.html` comment | `popOuts` is supported by `src/app-menu.js:5,16` but `grep popOuts main.js` has no hit; no pop-out window in `src/` | **PENDING N1**: no live claim remains. A note was added to the draft block in `docs/release-notes.md`. The changelog comment (line 4 to 7) does not list it. Add it only once N1 merges and `main.js` passes `popOuts` |
| 11 | Characters: rubber duck, octopus, CRT monitor, blob, capybara, cactus, owl, penguin, fox, bee, axolotl, mushroom, egg, toaster, cloud, astronaut, sloth, T-rex, cyclops (draft, commented out) | `docs/release-notes.md` | `characters/builtin/starter.js:147-195`, `wave2.js:148-203`, `wave3.js:146-205`: all 19 present by name | **TRUE** (draft stays commented until the tagged build includes them) |
| 12 | "Hatch a character" from templates, saved to `~/.claude-traffic-light/characters`; describing to an AI is not in this release | `docs/release-notes.md` draft | `hatch.html`, `characters/hatch.js`; `main.js:1365` returns `ai:false` (as recorded in the ledger) | **TRUE** |
| 13 | Site: "More characters are coming, and so is a way to hatch your own. Hatch: coming" | `site/src/index.html:235` | Characters and template Hatch exist (rows 11, 12); only the AI part is missing | **FLAG**: stale, but `site/test/site.test.js:133` asserts the `Hatch: coming` tag, and this change is docs only. Fix with the test in the next code pass |
| 14 | Right-click on the widget opens the window; Shift or Option right-click opens the full menu | `docs/release-notes.md` draft | `main.js:3260-3262` (`opts.menu === true` pops the menu, else `openBuddy()`) | **TRUE** |
| 15 | "Something's off / Idea" feedback saves locally; optional Send to a team's "Plexiform feedback" board | `docs/release-notes.md` draft | `feedback.html`, `src/feedback.js`, `main.js:1277` | **TRUE** (not re-read line by line for the Send path) |
| 16 | Backups and restore of local settings, in Settings, Backups | `docs/release-notes.md`, `site/src/changelog.html` | `src/backups.js`, `settings.html:634` | **TRUE** |
| 17 | The app can check for a newer version and install it | release notes, changelog | `src/updater/*` | **OWNER**: works only against a signed manifest on the R2 host (`docs/RELEASE-CHECKLIST.md`, Sections C and D) |
| 18 | Team and Integrations pages are visible before sign-in | release notes, changelog | `buddy-window/pages.js:42` (`team`), `connectors.js` | **TRUE** |
| 19 | Eligible first-time accounts get a personal team and board automatically | release notes | `board/hub/identity/teams.js:131-138` (`setup`, only an empty account with no usable invite) | **TRUE** in code, **OWNER** to take effect (needs the accounts hub) |
| 20 | Slack and Sentry are not in this release | release notes, changelog, `PRIVACY.md` | `LAUNCH_CONNECTORS = ['github']` `buddy-window/connectors.js:11` | **TRUE**; Linear and Jira exist only as a comment in `board/hub/integrations/index.js` |
| 21 | This release is not signed by Apple | release notes | `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` `.github/workflows/release.yml:166`; ad-hoc identity `electron-builder.config.js:41` | **TRUE** |
| 22 | Windows is not included | release notes | `site/site.config.json` `windowsDownloads:false`; `WINDOWS_RELEASE` gate in `release.yml` | **TRUE** |
| 23 | Release headline "Plexiform 1.0.1" | `docs/release-notes.md:1` | `package.json` version is `1.0.2` | **FLAG**: the owner chooses the tagged version; update the headline when tagging |
| 24 | Email-code sign-in line | release notes (conditional comment), changelog | Mail provider in `board/hub/identity/mailer.js` (Resend); email sign-in off unless `BOARD_EMAIL_SIGNIN=1` (`board/deploy/pi/hub.env.example:43`) | **OWNER**: the existing "keep this line only once the mail service is deployed" comment stays |
| 25 | "Plexiform keeps data on your device and we do not receive it, so today we hold no personal information about you" | `PRIVACY.md` POPIA section (~line 310) | Contradicts the same document: the hub stores name and email of signed-in users, and the website waitlist stores emails (PRIVACY.md line 11 to 13) | **FLAG**: left unedited because it is draft legal text; needs the owner's or counsel's wording |
| 26 | The phone app is "coming"; phone companion is not live | `site/src/index.html:273`, `download.html:31` | `site/site.config.json` `phone:false` | **TRUE** |
| 27 | Public sign-up not open | `site/src/download.html:77` | `site/site.config.json` `publicSignup:false` | **TRUE** |

## What was edited

| File | Change |
|---|---|
| `PRIVACY.md` | Accounts and Automatic work tracking moved from "Not yet shipped" to a new section "Shipped: accounts and automatic work tracking". "Not yet shipped" intro now names only the crash-report sending gap. Crash sending bullet states there is no receiving endpoint, the send step is a placeholder, and the endpoint is the owner's to set up. In-short bullet says the same. |
| `site/src/privacy.html` | Crash bullet: no receiving endpoint yet. |
| `site/src/index.html` | Crash bullet: recorded and scrubbed on the Mac only; sending not built; will be opt-in. |
| `docs/release-notes.md` | Comment added to the draft block: Usage pop-out is pending N1. No visible text changed. |

## Left for a code pass or the owner

- Row 13: change the `Hatch: coming` tag and `site/test/site.test.js:133` together.
- Row 23: set the headline version when tagging.
- Row 25: rewrite the POPIA paragraph.
- Row 2 and 24: update after the hub cutover and the mail service are live.
- Row 10: when N1 lands, add the Usage pop-out line to the release notes and changelog, and add its privacy entry if it sends anything (it should not).

## Tests run

`node --test test/privacy.test.js` (15 pass) and `cd site && node --test test/site.test.js` (17 pass), after the edits.
