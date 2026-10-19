> Snapshot dated 2026-10-08. Statuses reflect `claude/release` at e92ba0d2 (before the w-a* merges that followed); later commits may have changed some rows. Copied verbatim from the release audit ledger v2; not updated since.

# Plexiform promised-feature ledger v2

Repo: /Users/callumbaker/Development/other-projects/plexiform-release (branch claude/release @ e92ba0d2). Re-audit 2026-10-08 after the intuitive-app WP1-WP6 merges, the Burst audit fixes and the sign-in rework. Read-only; nothing built or launched. The only command run was the test suite with `PLEXIFORM_FORCE_FREE=1` (section 7). Paths are relative to the repo root. "Changed" compares with v1: NEW = status moved, DETAIL = same status with corrected evidence, - = unchanged and not re-checked (v1 evidence carried over).

Status key: SHIPPED, PARTIAL, MISSING, OWNER-GATED (needs Callum, an external account, payment, signing or a hub deploy), UNVERIFIED, N/A.

Global gating facts (unchanged):
- `src/entitlement-keys.js:11` key list is empty, so `src/entitlements.js:73` sets `BETA_ALL_FEATURES` and every install gets all Plus/Team features. `PLEXIFORM_FORCE_FREE=1` ends the beta.
- Plan & billing, Sync and Setups pages stay `hidden:true` until a key is pinned (`buddy-window/pages.js:49,55,57,107-123`).
- `LAUNCH_CONNECTORS = ['github']` in `buddy-window/connectors.js:11` and `board/web/js/connectors.js:9`.
- `site/site.config.json`: `phone:false`, `publicSignup:false`, `windowsDownloads:false`.

## 1. Free / general promises

| Feature | Promised at | Status | Evidence | Changed since v1 |
|---|---|---|---|---|
| Traffic-light widget, Lights rules editor, poses, costumes, pets, garden, overlays | README.md:1-160 | SHIPPED | `lights.html`, `lights-view.js`, `rules.js`, `widget.js`; sidebar Widget section `pages.js:93`. README visual claims not checked one by one. | - |
| Share your rules (copy/paste code, file) | README.md:159 | SHIPPED | `lights-view.js:1190,1213,1244`. | - |
| Multi-agent support (Codex, Cursor, Gemini, Hermes) | README.md:166, site index | SHIPPED | `adapters/`, `src/ai-tools*.js`, `src/gemini-acp.js`. Gemini unit-tested only; Cursor has no approval hook. | - |
| Answer permission prompts from the widget | README.md:241 | SHIPPED | `hooks/pending-input.js`, `src/pending-inputs.js`, `src/signal-server.js`. | - |
| Sessions on another machine (remote reporter) | README.md:223 | SHIPPED | `src/remote-devices.js`; Settings "Remote devices" (`settings.html:595`). | - |
| Sync via shared `CLAUDE_TRAFFIC_LIGHT_HOME` | README.md:403 | SHIPPED (env var only) | Manual setup, no UI. | - |
| Menu bar mode | README.md:371 | SHIPPED | `main.js:226`, tray checkbox "Claude in the Menu Bar" (`main.js:3109`). | - |
| Windows build | README.md:233, docs/RELEASING.md | OWNER-GATED | `electron-builder.config.js:50-59`; excluded until native acceptance. | - |
| Voice questions (on-device STT, off by default) | help.html, PRIVACY.md | SHIPPED (macOS) | `src/voice.js`, Settings "Voice" (`settings.html:298`). | - |
| Spend budgets, runaway alerts, API-price labelling | help.html "Spend" | SHIPPED | `spend.js`, `usage.js`, `src/budget-notice.js`. | - |
| Backups and restore of local settings | release-notes (1.0.1) | SHIPPED | `src/backups.js`, Settings "Backups" (`settings.html:636`). | - |
| In-app update check and install | release-notes | OWNER-GATED | `src/updater/*`; needs signed manifest and R2 host; tray shows `updaterTrayItems()` (`main.js:3135`). | - |
| Team board (cards, handovers, Table/Dashboard/History) | site index, release notes | SHIPPED | `board/web/js/*`; sidebar Board (`pages.js:83`). Calendar/Timeline hidden (section 5). | - |
| Sign in with Google / GitHub or email code; create/join team; roles; invites | release-notes:7 | PARTIAL / OWNER-GATED | `buddy-window/oauth.js`, `board/hub/identity/oauth*.js`, `mailer.js`. Release notes keep the email-code line conditional. `docs/CUTOVER.md` not run; prod hub not on accounts migrations. Sign-in rework e92ba0d2 not separately re-verified beyond the setup path below. | DETAIL (rework merged; deploy gate unchanged) |
| Personal workspace and board auto-created after sign-in | release-notes:5 | SHIPPED in code; OWNER-GATED to take effect | Hub: `POST /api/account/setup` (`board/hub/http.js:415`) -> `TeamsService.setup` (`board/hub/identity/teams.js:136-144`) creates `personalTeamName(user)` only when the account has no teams, no pending invite, no client workspace/invite; result `setup:'created'`. Client: `buddy-window/account-flow.js:336-350` calls `setupAccount` (`accounts.js:26`) when `!r.teams.length`, switches to the new workspace and shows `firstTeamNotice`. `create()` still enforces verified email and `mayCreateTeam` (allowlist signup refuses invite-origin users, `identity/accounts.js:198-200`), so some first-time accounts get no team (the notes say "Eligible"). Tests: `board/hub/test/automatic-setup.test.js`. Needs the hub deployed. | NEW (was UNVERIFIED) |
| Team and Integrations visible before sign-in | release-notes | SHIPPED | `pages.js:40-41`, `connectors.js`. | - |
| GitHub integration (org-owned App) | site index:194, release-notes | OWNER-GATED | `board/hub/integrations/github/`, `docs/GITHUB-APP-RUNBOOK.md`. | - |
| Automatic sharing of team sessions and teammate messaging | release-readiness | OWNER-GATED | `src/team-session-sharing.js`, `board/hub/interaction-relay.js`; 11-step acceptance outstanding. | - |
| Run in the cloud | CLOUD-RUNNER-RUNBOOK | OWNER-GATED | `board/web/js/render-dialogs.js:80`; needs Pi service. | - |
| Remote MCP (`/api/mcp`) | docs/remote-mcp.md | OWNER-GATED | `board/hub/`, `sdk/remote-client.mjs`. | - |
| Local MCP bridge (buddy_* and team tools) | TEAM-CONTEXT-CONTRACT | SHIPPED | `mcp-server.js`. Its on/off toggle now lives on AI tools (see WP6). | DETAIL |
| Local Tasks (worktrees, Codex/Claude, Run tonight) | README, PRIVACY | SHIPPED | `tasks.js:570`, `src/tasks-service.js`. | - |
| Setups (personal export/import, apply with backup/undo) | release-notes draft, paid-tier F7 | SHIPPED (personal only) | `setups.html`, `src/setups-personal.js`; listed under Settings when entitled (`pages.js:105-110`). Signed native Apply helper held. | - |
| Characters: duck, octopus, CRT, blob, capybara, cactus, owl, penguin, fox, bee, axolotl, mushroom | release-notes:14 (draft) | SHIPPED in code; not announced | All 12 exist by name: `characters/builtin/starter.js:147-195` (Rubber duck, Octopus, CRT monitor, Blob, Capybara, Cactus); `wave2.js:148-203` (Owl, Penguin, Fox, Bee, Axolotl, Mushroom). Extras not in the notes: wave3 Egg, Toaster, Cloud, Astronaut, Sloth, T-rex, Cyclops (`wave3.js:146-205`); core Claude, Dog, Cat, Frog, Robot, Ghost. The notes entry is still inside an HTML comment (`docs/release-notes.md:13-18`) and omits the seven wave3 characters. | NEW (was UNVERIFIED) |
| Hatch a character (template path) | release-notes:15 (draft) | SHIPPED | `hatch.html`, `characters/hatch.js`, `hatch-view.js`; page now sits in the Widget section (`pages.js:93`, commit 24261978). | DETAIL |
| Hatch: describe a character to an AI | site index ("Hatch: coming"), hatch.html:47-49 | PARTIAL | Unchanged. `main.js:1365` still returns `ai:false`; `hatch-view.js:75` keeps `#desc` disabled; hint at `hatch.html:49` points to "Settings -> AI tools", which cannot enable it. Draft notes correctly say it is not in this release. | - (re-verified) |
| Right-click widget opens the window | release-notes:16 (draft) | SHIPPED, not announced | `main.js:3173-3180` `widget-menu`: plain right-click calls `openBuddy()`; only Shift/Option (`opts.menu===true`) pops the full menu. | NEW (was UNVERIFIED) |
| Usage pop-out from tray/widget menu | release-notes:17 (draft); `site/src/changelog.html:18` | MISSING | `src/app-menu.js:5,15,25` supports a `popOuts` map, but `main.js` never passes it (`main.js:3092` call has no `popOuts`) and no pop-out window or "busiest model" code exists anywhere (grep for popout/pop-out/busiest model finds only app-menu.js and the docs). The tray lists sections that open the page. The draft release note and changelog comment describe something that is not built. | NEW (was UNVERIFIED; now confirmed absent) |
| Send feedback | release-notes:18 (draft) | SHIPPED, not announced | `feedback.html`, `main.js` `createFeedbackWindow`, tray item "Something's off / Idea..." (`main.js:3092`), sidebar footer. | DETAIL |
| Waitlist on the website | PRIVACY.md | OWNER-GATED | `site/functions`; site deploy pending. | - |
| Free team limits (25 members / 10 boards; 5,000 cards / 50,000 comments) | site index:268, docs/team-row-quotas.md | PARTIAL | Row caps implemented; storage-pressure admission and HTTP byte budget do not exist. | - |

## 2. Features the site/PRIVACY says are "coming" or "not yet shipped"

| Feature | Promised at | Status | Evidence | Changed since v1 |
|---|---|---|---|---|
| Agents that talk to each other | site index:154,171 | PARTIAL | Building blocks only (`board/hub/messaging.js`, remote MCP task message, relay); no autonomous flow. | - |
| Slack connector | site index:194, release-notes:24, PRIVACY | OWNER-GATED | `board/hub/integrations/slack/`; "built and tested, not offered". | - |
| Sentry connector | same | OWNER-GATED | `board/hub/integrations/sentry/`. | - |
| Linear and Jira connectors | site index:194 | MISSING | Only a comment in `board/hub/integrations/index.js:1-2`. | - |
| Crash reporting (opt-in, scrubbed) | PRIVACY.md:210 | MISSING | `main.js:14` "no crash reporter". | - |
| Accounts on the hub | PRIVACY.md:211 | SHIPPED in code, notice stale | PRIVACY.md still lists "Accounts on your team's hub ... are not built yet" under "Not yet shipped" while the same bullet's sub-flows describe the shipped sign-in. Hub deploy is OWNER-GATED. | DETAIL |
| Desktop sign-in flow, runner enrolment, integration connect | PRIVACY.md:212-214 | SHIPPED | `buddy-window/accounts.js`, `account-flow.js`, `device.js`, `connect-life.js`. | - |
| Automatic work tracking (off by default, per-repo/board switches, tray pause) | PRIVACY.md (Not yet shipped list, "Automatic work tracking") | PARTIAL | Default: a fresh install starts OFF (`src/work-capture.js:74-77`, `createWorkCapture({startEnabled=false})` at :136; `buddy-window/index.js:247` passes no `startEnabled`); only a pre-existing `work-capture.json` without the key keeps the old ON behaviour (comment at :75-76). `main.js:1462` `captureEnabled: !DEMO` only means the feature is wired, not on. Opt-in toggle and per-repo choices: `buddy-window/account.js:575`, `index.js:939-944`. Tray pause: none exists (tray menu `main.js:3092-3150` has no capture item; the only "pause" code is widget-motion gating). PRIVACY.md still promises "a pause in the tray" and lists the feature as not shipped even though it is. | NEW detail (default confirmed OFF; tray pause confirmed absent) |
| Phone app on its own fixed address | PRIVACY.md:216, paid-tier F1 | OWNER-GATED | Hub still serves `board/web/phone.html`. | - |
| Phone companion | site index:273, download.html:31 | PARTIAL / OWNER-GATED | `src/remote-approvals-main.js`, `phone-pairing.html`, `board/hub/push.js`; needs VAPID, origin, DNS, security review. | - |
| Public signup | site index | OWNER-GATED | `publicSignup:false`. | - |
| Windows downloads | site index:272,287 | OWNER-GATED | Same as Windows row. | - |
| Signed and notarised Mac app | release-notes "Known limits" | OWNER-GATED | Ad-hoc builds. | - |
| Email-code sign-in without sandbox limits | release-notes "Known limits" | OWNER-GATED | Mail service sandbox. | - |

## 3. Paid-tier promises (gates in `src/entitlements.js:35-63`; all on for everyone in the beta, none purchasable)

| Feature | Promised at | Status | Evidence | Changed since v1 |
|---|---|---|---|---|
| Billing and entitlements (Plus/Team, Stripe or MoR, signed token) | paid-tier F8, BILLING-RUNBOOK | OWNER-GATED | `board/hub/billing/*`, `upgrade.html`; page hidden until a key is pinned (`pages.js:113-117`). | - |
| Enforced budget caps | F3 | SHIPPED | `src/spend-enforce.js`, `hooks/spend-gate.js`, `usage-waste-view.js:61`. | - |
| Waste detection | F3 | SHIPPED | `src/waste.js`. | - |
| Monthly savings receipt | F3 | SHIPPED (on Usage, not Home) | `src/receipt.js`. | - |
| Checkpoints, "What changed", restore | F4 | SHIPPED | `src/checkpoints.js`, `checkpoints.html`. | - |
| Second-opinion diff reviewer | F4 | SHIPPED | `src/diff-review.js`. | - |
| Overnight queue + morning report | F5 | SHIPPED | `tasks.js:570`, `src/morning-report.js`, `home.js:35-39`. | - |
| Queue push notifications | F5 | OWNER-GATED | Phone push stack. | - |
| Cross-tool "Search everything" | F2 | SHIPPED | `src/memory/*`, `memory.html`. | - |
| "Hand to Codex / Claude" | F2 | SHIPPED | `memory.js:40-90`, `src/handoff.js`. | - |
| Encrypted multi-device sync | F2 | OWNER-GATED | `src/sync/*`, `board/hub/sync.js`; page hidden (`pages.js:121-124`). | - |
| Phone: approvals, answers, push, start a task | F1 | OWNER-GATED | See section 2. | - |
| Client billing (CSV free; PDF + rate cards Plus) | F6 | SHIPPED | `src/clients.js`, `src/invoice.js`. | - |
| Setups team library | F7 | PARTIAL | `board/hub/setups.js`; native Apply helper held. | - |
| Team plan: hosted boards at pro quotas | paid-tier §2 | OWNER-GATED | `board/hub/quotas.js`. | - |
| Relay E2E for phone/approvals | F1 | PARTIAL | `src/e2e/relay-envelope.js`; shared-session relay plaintext to hub operator. | - |

## 4. Plan work packages

### Intuitive-app plan (`.omc/plans/intuitive-app-plan.md`)

| WP | Status | Evidence | Changed since v1 |
|---|---|---|---|
| WP1 First-run onboarding | SHIPPED | `onboarding.html/js`, `main.js` `createOnboardingWindow`; commit 8b363b18 (fresh install writes no hooks / login item before Connect). Tray: `test/onboarding.test.js:193-202` asserts the default tray menu is 20 items or fewer, and that test passes in the suite run. Default tray = budget/scope/Burst items (conditional), Open Plexiform, 7 section entries (home, board, tasks, usage, team, widget, settings; `menu:false` sections are skipped at `main.js:3088`), feedback, Open Claude, snooze/mute, Reset Widget Position, Floating Widget, Menu Bar, "What does this mean?", Open at Login, updater items, Quit. Override/Knock/Bigger/Smaller/Reinstall hooks/Health only when `IS_DEV_RUN` or widget Option/Shift menu (`main.js:3096`). The item count was derived from the code and the passing test, not by building the menu. | NEW (tray trim verified; was UNVERIFIED) |
| WP2 Sidebar IA ("exactly 6 sections", footer, optimiser Burst-gated) | PARTIAL | Still 14 `SECTIONS` entries (`pages.js:82-95`: home, board, tasks, sessions, checkpoints, memory, usage, optimiser, clients, team, aitools, widget, phone, settings). Seven are `menu:false` and appear only in the sidebar; 7 appear in the tray. Plan acceptance is exactly 6. Improvements since v1: Usage is titled "Usage & cost" and Stats folds into it; Hatch moved into Widget (24261978); Home carries Waiting and My day (`pages.js:82`); footer Help/Feedback/What's new exists (`pages.js:64-66`). Optimiser gating: `sidebar.js:137` supports `p.burstOnly`, but no page in `pages.js` sets it (only a comment at :46), so Usage optimiser is shown to everyone. | DETAIL (shape closer; count still 14; burstOnly still unused) |
| WP3 Home page | SHIPPED | `home.html/js`, `src/home-main.js`; "Waiting on you" now one list (40c8d59c). | DETAIL |
| WP4 Usage and cost consolidation | PARTIAL, mostly done | Done: one sidebar entry "Usage & cost" with Stats folded in (35fc7859, `pages.js:88`); heatmap renamed "Busiest hours"; limit bar links to optimiser; Auto-answer tab is now gated: `lights-preload.js:23` `showAutoAnswer = PLEXIFORM_SHOW_AUTOANSWER==='1'`, `lights-view.js:1311,1328` (tab hidden by default). No ccusage/npm hint exists in app UI (only main.js internals and README/PRIVACY prose; the `npm test *` string at `lights.html:1294` is an auto-answer placeholder). Not verified: inline budget editor on the Usage page, single "Today" number, optimiser sub-item name clashes. | NEW (Auto-answer gating verified; consolidation shipped; remainder unchecked) |
| WP5 Board / This Mac / Team copy and Codex-memories fix | SHIPPED (fix) / PARTIAL (copy) | Fix: `BACKGROUND_TITLE` in `src/work-capture.js:108` filters at observe (:206), backfill (:280), handover rows (:376); the 7-day prune and duplicate grouping were not found. Copy: running-task messages reworded (1feca982); "Plan limit reached" amber (`board/shared/cardface.js:28`); "Send to AI..." (`board/web/js/palette.js:76`, `render-board.js:298`). Remaining runner vocabulary: "Macs that run this team's cards" is plain, but `account.js:726` maps raw runner states, and the plan's grep acceptance (no "Runner"/"observed"/"hub" strings) was not run. This Mac reorder not checked. | NEW (was UNVERIFIED; fix and several copy items confirmed) |
| WP6 Settings split | PARTIAL | Done: Claude integration (MCP) moved to AI tools (68185fbc): `aitools.js:107-122` `mcpBlock()` on the Claude row, toggle `#mcp-toggle`; Settings no longer has MCP controls (`settings.html` only mentions MCP at :307 in a voice hint). "Account & team" section removed from Settings; no Save button remains (Voice is "saves on change", `settings.html:297`). Not done: `settings.html` is still one page with 16 `<h2>` sections (Sessions :241, Spend :270, Voice :298, Alerts :313, Runaway sessions :364, Busy & Focus :378, Widget :404, Agents :448, Privacy :482, Boards in your AI apps :529, Git and CI :549, Compactor :569, Remote devices :595, Other tools :630, Backups :636, Health :652); there are no General/Notifications/Widget/Privacy/Advanced sub-pages or in-page nav, the "Agents" section still exists, and Settings' first screen has far more than 10 controls. Autosave for every control and the duplicated Burst card were not fully verified. | NEW (v1 said MISSING; MCP move and Account removal landed, split itself still missing) |

### Burst ecosystem plan

| WP | Status | Evidence | Changed since v1 |
|---|---|---|---|
| WP0 contract/scaffold | SHIPPED | `src/burst-client.js`, `burst-ipc.js`, `burst-actions.js`. | - |
| WP1 notices + Health, console fallback, Diagnose | SHIPPED | `src/burst-notices.js`, `src/health.js`. Burst status vocabulary tightened (63643277, 3b9b9eb0). | DETAIL |
| WP2 Route + Requests tabs in the optimiser | PARTIAL | Normalisers exist; native tabs not built (`optimiser.html` Dashboard and Tools only; `optimiser.js:11`). Not re-checked in depth after the audit fixes. | - |
| WP3 Sessions inspector, drop-summary, coordination | SHIPPED | `sessions.js`, `src/context-breakdown.js`. "Compact now" blocked on Burst maintainer. | - |
| WP4 MCP burst tools + runner `network` failure kind | SHIPPED | `mcp-server.js:609-611`, `board/runner/run.js:46,379`. | - |
| WP5 This Mac keep-awake/hotspot + PII detectors | SHIPPED | `buddy-window/account.js:237-255`, `src/scrub.js:131-164`. | - |
| Burst "X" features | N/A | Deliberately not built. | - |
| Burst maintainer API additions | OWNER-GATED | `docs/burst-partnership-asks.md`. | - |

### Finish-and-offerings plan

| Item | Status | Evidence | Changed since v1 |
|---|---|---|---|
| Phase 0 rebuild/install, backfill, screenshots, cleanup | UNVERIFIED | Runtime steps; not checked. | - |
| Phase 1 intuitive plan | PARTIAL | See WP2, WP4, WP5, WP6. | DETAIL |
| Phase 2 Burst | SHIPPED | See above. | - |
| Phase 3 Slack and Sentry | OWNER-GATED | Section 2. | - |
| Phase 4 two-account acceptance | OWNER-GATED | Steps 1-11 not recorded as done. | - |
| Parked owner items | OWNER-GATED | Stripe/MoR, key pin, VAPID, phone origin, R2 host, Developer ID, phone review, Windows, legal, GitHub release. | - |

## 5. Reachability gaps

1. Plan & billing (`upgrade`) hidden until a key is pinned (`pages.js:55,113-117`).
2. Sync hidden (`pages.js:57,121-124`).
3. Board Calendar and Timeline hidden unless `PLEXIFORM_SHOW_PLANNER=1` (`pages.js:28-29,128`).
4. Unlisted pages: Waiting, My day, Stats (`pages.js:32,33,44`); now reached from Home and Usage & cost. Improved by WP2/WP3 merges.
5. Hatch "Describe it" permanently disabled (`main.js:1365`) and the hint points at a place that cannot enable it.
6. Settings still a 16-section single page (was 17); Remote devices controls split between Settings and Phone.
7. Seven sections have `menu:false` (sessions, checkpoints, memory, optimiser, clients, aitools, phone; `pages.js:85-94`): sidebar only, not in the tray. AI tools being off the tray matters because it now also holds the Claude MCP toggle.
8. Setups only under Settings when entitled (`pages.js:105-110`).
9. Burst Route and Requests have no native tab.
10. Receipt, enforce-cap toggle and waste findings on Usage, not Home.
11. Site flags (phone, windows, publicSignup) all false.
12. NEW: Usage pop-out and Characters/Hatch/feedback/right-click all remain unannounced in `docs/release-notes.md` (draft block commented out), and the Usage pop-out does not exist.
13. NEW: Auto-answer tab is hidden by default (`PLEXIFORM_SHOW_AUTOANSWER`), so auto-answer rules can only be edited by setting an env var, though the rules engine and the "make it a rule?" card exist (`main.js:509`).

## 6. Stale or inconsistent claims

- PRIVACY.md "Not yet shipped" still lists accounts ("not built yet"), automatic work tracking with "a pause in the tray" (no tray pause; the feature itself exists and defaults off for new installs) and crash reporting (genuinely unbuilt).
- `docs/HANDOVER-2026-10-07.md` and `docs/BILLING-RUNBOOK.md` say "every install is free"; the code is full-featured in the beta.
- `docs/release-notes.md:7` keeps a conditional email-code claim; the draft block (:13-18) lists the Usage pop-out, which does not exist, and omits seven wave3 characters.
- `site/src/changelog.html:18` comment also mentions the Usage pop-out.
- Intuitive-plan acceptance "exactly 6 sections" conflicts with the 14-section sidebar.
- `.omc/plans/paid-tier-plan.md` F1/F3/F7 "Exists today" text predates the implementation.

## 7. Test run with the beta flag off

Command: `PATH=/opt/homebrew/opt/node@22/bin:$PATH PLEXIFORM_FORCE_FREE=1 node --test test/*.test.js test/adapters/*.test.js`. Result: 4292 tests, 4284 pass, 1 fail (the rest are skipped/todo). Full log at `scratchpad/forcefree.log`.

| Failing test | Cause |
|---|---|
| `test/entitlements.test.js:110` "the shipped build pins no key yet, so every install is in the beta: the top plan, every feature" (assertion at :115, `false !== true`) | The test asserts the beta is on; `PLEXIFORM_FORCE_FREE=1` turns it off by design, so this is the expected inversion, not a regression. It passes without the flag. |

No other test depends on the beta being on.
