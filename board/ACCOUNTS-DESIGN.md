# Public accounts and teams for the board hub: design (rev 1)

Status: design, not built. Branch `feat/board-accounts` (off `feat/board` after the review fixes). Brand placeholder **Buddy**, placeholder domain **`buddy.example.com`**. Everything here extends `board/CONTRACT.md` (protocol v1). Where this document and CONTRACT.md disagree, CONTRACT.md stays authoritative for the existing Phase 1 behaviour until the §15 delta is merged into it.

Decisions already made (Callum, 2026-09-30): hub on the Pi 5 behind a Cloudflare Tunnel (public, no open ports, nightly backups), portable to Workers + Durable Objects later; sign-in with GitHub, Google and email magic link; multi-tenant; POPIA/privacy policy accepted; **the hub never holds anyone's AI credentials** (design T4, CONTRACT D26 unchanged).

---

## 0. Summary

- **People and memberships split.** A new `users` table is the person. The existing `members` row becomes "user U in team T with role R" (`members.user_id`). Every foreign key that points at `members` today (cards, runs, dispatches, comments, asks…) keeps working unchanged, so the state machine, runner protocol and journal need almost no changes. `orgs` becomes the team (adds `slug`, `plan`, `settings`, `deleted_at`).
- **The hub runs its own sessions** (`BOARD_AUTH=public`): GitHub (as a GitHub **App**), Google (OIDC) and magic link. Opaque `__Host-` session cookie, hashed at rest, rotated, revocable. Cloudflare Access stays as `BOARD_AUTH=access` for self-hosters; `dev` stays loopback-only.
- **Membership is resolved from the resource, never from a "current team".** Every route resolves `user → member` through the team that owns the board/card/device/repo in the URL. No membership → `404`. The active team is a UI preference only.
- **Desktop sign-in = device authorization bound to loopback.** The app starts a flow, opens the hub page in the browser, the signed-in user approves (choosing teams), the browser is redirected to `http://127.0.0.1:<port>` on the same machine, and only then can the app redeem the flow for a device token. This defeats device-code phishing. Token lives in Keychain via Electron `safeStorage`.
- **One physical device, many teams.** `user_devices` holds the token; `devices` (today's table) becomes the device's enrolment in one team. The runner opens one `/ws/runner` socket per enrolment (`Board-Team` header), so `RunnerConn` keeps "one device row = one member = one team".
- **Isolation is proven, not assumed:** a route-matrix test that fails when a new route isn't covered, WS/runner cross-team tests, and SQLite triggers that make a cross-team foreign key impossible to write.
- **Privacy:** user and team export; account deletion = pseudonymise (tombstone membership rows); team deletion = 7-day soft delete then hard purge, including journal rows through an explicit erasure grant the append-only triggers honour.

Estimated build: **~16.5 dev-days** in 7 phases (§13), about 15.5 of them accounts work.

---

## 1. Current state (what this changes, with evidence)

| # | Finding | Evidence | Consequence for public teams |
|---|---|---|---|
| C1 | `members` conflates person and membership: `github_id`/`github_login` NOT NULL, role `viewer`, unique per `(org_id, github_id)` | `shared/schema.sql:11-24` | Google/email users can't exist; one person in two teams = two unrelated rows. Table rebuild needed (NOT NULL + CHECK change) |
| C2 | Access auth maps email → **first** member row: `WHERE lower(email)=lower(?) ORDER BY created_at LIMIT 1` | `hub/http.js:231-234` | A person in two teams silently only ever sees the older team |
| C3 | Browser WS binds the member at upgrade, never re-checks; broadcasts filter on `boardId` only | `hub/ws-board.js:11-20,66-75`; `hub/hub.js:755-769` | A removed member (or revoked session) keeps receiving live card updates until the socket drops |
| C4 | Dev login is guarded by `config.auth==='dev'` + loopback peer; config refuses dev on non-loopback bind | `hub/http.js:74-80`; `hub/config.js:57-60` | Behind cloudflared the peer **is** loopback. Review verdict (a): refuse dev when `publicUrl`/`tunnelProbeUrl` set. §9.5 makes this structural |
| C5 | `sameOrigin` returns true when `Origin` is absent, and falls back to `Host` | `hub/http.js:32-41` | Acceptable under Access; with public cookie sessions tighten (§4.6) |
| C6 | One device = one member = one org; token hash on `devices`; WS allowlist per org | `schema.sql:26-37`; `hub/ws-runner.js:19-45,118-122` | Multi-team per device needs an extra level (§6) |
| C7 | Tenant guards exist but are per-call conventions: `boardFor`, `cardFor`, `orgMember`, `ownCard` | `hub/api.js:34-51`; `hub/ws-runner.js:188-194` | Correct today; nothing enforces that the next route uses them → tests + triggers (§7) |
| C8 | Repos are per org (`UNIQUE(org_id, canonical_url)`); overlaps, path locks and memories key on `repo_id` | `schema.sql:39-49,291-319`; `hub/hub.js:832-838,896` | Two teams linking the same GitHub repo get separate repo rows, so overlap/memory never crosses teams. Must stay true; tested explicitly (§7.3 T-OVL) |
| C9 | Migration runner turns `foreign_keys=ON` and wraps every file in `BEGIN IMMEDIATE` | `shared/migrate.js:39-55` | SQLite table rebuilds need `foreign_keys=OFF` **outside** a transaction → runner needs a directive (§2.1) |
| C10 | Journal is append-only by trigger; `card.create` payload stores `body` and `acceptance` | `shared/migrations/003_journal.sql`; CONTRACT §15 | Erasure conflicts with append-only → §10.3 |
| C11 | One hub-wide read-only `BOARD_GITHUB_TOKEN` for PR/commit verification | `hub/config.js:44`; README env table | Can't see strangers' private repos → per-installation GitHub App tokens (§5) |
| C12 | Viewers can't comment; role set `owner/admin/member/viewer` | `hub/api.js:54,370`; `hub/api.js:448-450` | `viewer` becomes `guest` with board-scoped access (§3) |
| C13 | CSP allows only GitHub avatars | `hub/http.js:18` | Needs Google avatar host + Turnstile (§11) |
| C14 | Static server serves only `/`, `/web/*`, `/shared/*` | `hub/http.js:130-141` | Path routes (`/t/:slug/...`, `/device`, `/join`) need an index.html fallback allowlist |

---

## 2. Data model

### 2.1 Migration mechanics

`004_accounts.sql` rebuilds `members` and `devices` (NOT NULL / CHECK / UNIQUE changes) using SQLite's documented 12-step procedure. **`migrate.js` change:** a first-line directive `-- migrate: foreign_keys=off` makes the runner run `PRAGMA foreign_keys=OFF` **before** `BEGIN IMMEDIATE`, run `PRAGMA foreign_key_check` before `COMMIT` (any row → ROLLBACK + throw), then `PRAGMA foreign_keys=ON`. Test: `shared/test/migrate-rebuild.test.js` (a fixture DB at v3 with cards/runs referencing members/devices migrates with zero FK violations and identical ids).

Take a `.backup` copy before running 004 on the Pi (the update procedure does this anyway, §12.5).

### 2.2 New and changed tables (SQL for `004_accounts.sql`)

```sql
-- migrate: foreign_keys=off

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  primary_email TEXT,                          -- lower-cased; NULL after deletion
  primary_email_verified_at TEXT,              -- NULL = unverified: may sign in, may NOT create teams or send invites
  avatar_url TEXT,                             -- only https://avatars.githubusercontent.com/* or https://lh3.googleusercontent.com/*
  created_at TEXT NOT NULL,
  deleted_at TEXT                              -- tombstone; row kept so members.user_id stays valid
);
CREATE UNIQUE INDEX users_email ON users(primary_email) WHERE primary_email IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users,
  provider TEXT NOT NULL CHECK (provider IN ('github','google','email','cf_access','dev')),
  subject TEXT NOT NULL,                       -- github numeric id | google `sub` | lower(email) | Access `sub` | dev login
  email TEXT,                                  -- as the provider reported it (lower)
  email_verified INTEGER NOT NULL DEFAULT 0,   -- 1 only from: GitHub /user/emails verified:true, Google email_verified:true, magic link, Access
  login TEXT,                                  -- github login (display only; never an identifier)
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  UNIQUE (provider, subject)
);
CREATE INDEX identities_by_user ON identities(user_id);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,                    -- sha256 hex of the cookie value; the value itself is never stored
  user_id TEXT NOT NULL REFERENCES users,
  auth_method TEXT NOT NULL CHECK (auth_method IN ('github','google','email')),
  created_at TEXT NOT NULL,
  auth_at TEXT NOT NULL,                       -- last full sign-in (step-up uses this)
  last_seen_at TEXT NOT NULL,
  rotated_at TEXT NOT NULL,
  prev_id_hash TEXT,                           -- previous value, accepted for 60 s after rotation (concurrent tabs)
  idle_expires_at TEXT NOT NULL,               -- last_seen + 14 d
  abs_expires_at TEXT NOT NULL,                -- created + 30 d
  session_epoch INTEGER NOT NULL,              -- must equal hub_meta.session_epoch (bumped on restore, §12.4)
  user_agent TEXT,                             -- truncated 200 chars
  ip_prefix TEXT,                              -- /24 (v4) or /48 (v6); never the full address
  revoked_at TEXT,
  revoke_reason TEXT
);
CREATE INDEX sessions_by_user ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX sessions_prev ON sessions(prev_id_hash) WHERE prev_id_hash IS NOT NULL;

CREATE TABLE email_tokens (                    -- magic links (and email-verification links)
  id_hash TEXT PRIMARY KEY,                    -- sha256(token)
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('signin','verify_email')),
  browser_nonce_hash TEXT NOT NULL,            -- sha256 of the __Host-buddy_ml cookie set at start (§4.3)
  code_hash TEXT NOT NULL,                     -- sha256 of the 6-digit fallback code, HMAC'd with the id (§4.3)
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                    -- +15 min
  used_at TEXT,
  ip_prefix TEXT
);
CREATE INDEX email_tokens_by_email ON email_tokens(email, created_at);

CREATE TABLE link_tickets (                    -- pending "link this new identity to your existing account"
  id_hash TEXT PRIMARY KEY,
  target_user_id TEXT NOT NULL REFERENCES users,
  provider TEXT NOT NULL, subject TEXT NOT NULL, email TEXT, login TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT   -- +10 min
);

-- Teams: keep the table name `orgs` (every FK and query uses org_id); the API calls them teams.
ALTER TABLE orgs ADD COLUMN slug TEXT;             -- ^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$ ; reserved list in code
ALTER TABLE orgs ADD COLUMN plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','self_hosted'));
ALTER TABLE orgs ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';   -- {cross_dispatch:'confirm'|'off', members_can_invite_guests:bool}
ALTER TABLE orgs ADD COLUMN created_by_user TEXT REFERENCES users;
ALTER TABLE orgs ADD COLUMN deleted_at TEXT;       -- soft delete: everything 404s
ALTER TABLE orgs ADD COLUMN purge_after TEXT;      -- deleted_at + 7 d
CREATE UNIQUE INDEX orgs_slug ON orgs(slug) WHERE slug IS NOT NULL;

-- members: rebuilt (was: person + membership)
CREATE TABLE members_new (
  id TEXT PRIMARY KEY,                             -- SAME ids as before (FK targets everywhere)
  org_id TEXT NOT NULL REFERENCES orgs,
  user_id TEXT NOT NULL REFERENCES users,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member','guest')),
  display_name TEXT NOT NULL,                      -- snapshot for tombstones; live name comes from users
  github_id INTEGER, github_login TEXT, email TEXT,-- legacy/Access mode only; NULL for public-mode joins
  webauthn_pubkeys TEXT,
  invited_by TEXT REFERENCES members_new,
  joined_via TEXT,                                 -- invite id | 'created_team' | 'migration' | 'access'
  created_at TEXT NOT NULL,
  removed_at TEXT,                                 -- soft remove: history keeps pointing here
  UNIQUE (org_id, user_id)
);
-- copy: see §14 (migration from Access identity); then DROP members; ALTER TABLE members_new RENAME TO members;
CREATE INDEX members_by_user ON members(user_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX members_email ON members(org_id, lower(email)) WHERE email IS NOT NULL AND removed_at IS NULL;

-- Last active owner cannot be demoted or removed.
CREATE TRIGGER members_keep_an_owner BEFORE UPDATE OF role, removed_at ON members
  WHEN OLD.role = 'owner' AND OLD.removed_at IS NULL AND (NEW.role != 'owner' OR NEW.removed_at IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM members m WHERE m.org_id = OLD.org_id AND m.id != OLD.id AND m.role = 'owner' AND m.removed_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.deleted_at IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'a team needs an owner'); END;

CREATE TABLE board_guests (                        -- guests see only boards listed here
  board_id TEXT NOT NULL REFERENCES boards,
  member_id TEXT NOT NULL REFERENCES members,
  PRIMARY KEY (board_id, member_id)
);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,
  kind TEXT NOT NULL CHECK (kind IN ('email','link')),
  token_hash TEXT NOT NULL UNIQUE,                 -- sha256(token)
  email TEXT,                                      -- kind=email: acceptance requires a VERIFIED identity with this email
  role TEXT NOT NULL CHECK (role IN ('admin','member','guest')),   -- never owner
  board_ids TEXT NOT NULL DEFAULT '[]',            -- guest: boards granted on join
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 100),    -- email: always 1
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,                        -- email: +7 d; link: 1-30 d (default 7)
  created_by TEXT NOT NULL REFERENCES members,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  CHECK (kind = 'link' OR (email IS NOT NULL AND max_uses = 1))
);
CREATE INDEX invites_by_org ON invites(org_id) WHERE revoked_at IS NULL;
CREATE TABLE invite_uses (invite_id TEXT NOT NULL REFERENCES invites, member_id TEXT NOT NULL REFERENCES members, used_at TEXT NOT NULL, PRIMARY KEY (invite_id, member_id));

-- Physical device (one token), and its enrolments (today's `devices`, one per team).
CREATE TABLE user_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users,
  name TEXT NOT NULL,
  client TEXT NOT NULL CHECK (client IN ('buddy_desktop','board_runner_cli','legacy')),
  platform TEXT,                                   -- 'darwin-arm64' etc.
  token_hash TEXT UNIQUE,                          -- sha256(bdt_…); NULL once revoked
  prev_token_hash TEXT UNIQUE,                     -- accepted 5 min after a rotation
  token_rotated_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_ip_prefix TEXT,
  revoked_at TEXT
);
CREATE INDEX user_devices_by_user ON user_devices(user_id);

CREATE TABLE devices_new (                         -- = enrolment of a user_device in one team; SAME ids as before
  id TEXT PRIMARY KEY,
  user_device_id TEXT NOT NULL REFERENCES user_devices,
  member_id TEXT NOT NULL REFERENCES members,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('runner','cloud')),
  cf_service_token_id TEXT UNIQUE,                 -- access mode only
  last_seq_acked INTEGER NOT NULL DEFAULT 0,       -- outbox seq is per enrolment (per socket)
  last_seen_at TEXT, created_at TEXT NOT NULL, revoked_at TEXT,
  form_factor TEXT CHECK (form_factor IN ('laptop','desktop')),
  UNIQUE (user_device_id, member_id)
);
-- copy devices → user_devices (1:1, client='legacy', token_hash moved) + devices_new; DROP devices; RENAME.

CREATE TABLE device_flows (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,           -- secret held only by the app
  user_code TEXT NOT NULL UNIQUE,                  -- 8 chars, alphabet BCDFGHJKLMNPQRSTVWXZ, shown as XXXX-XXXX
  code_challenge TEXT NOT NULL,                    -- S256(code_verifier)
  client TEXT NOT NULL CHECK (client IN ('buddy_desktop','board_runner_cli')),
  mode TEXT NOT NULL CHECK (mode IN ('loopback','typed')),
  redirect_port INTEGER,                           -- loopback mode: 1024-65535
  loopback_state TEXT,                             -- random, echoed to the loopback listener
  device_name TEXT NOT NULL, platform TEXT, form_factor TEXT,
  requester_ip_prefix TEXT, requester_country TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','consumed','expired')),
  approved_by_user TEXT REFERENCES users,
  approved_team_ids TEXT,                          -- JSON
  approval_code_hash TEXT,                         -- loopback mode: redeem requires this
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,   -- +10 min
  last_poll_at TEXT, poll_count INTEGER NOT NULL DEFAULT 0
);

-- Repo verification (GitHub App)
CREATE TABLE github_installations (
  installation_id INTEGER PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs,            -- which team linked it (one installation may serve one team; a 2nd team re-links → both rows via join table if needed later)
  account_login TEXT NOT NULL,
  linked_by TEXT NOT NULL REFERENCES members,
  created_at TEXT NOT NULL, removed_at TEXT
);
ALTER TABLE repos ADD COLUMN verification TEXT NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified','github_verified','lost'));
ALTER TABLE repos ADD COLUMN github_repo_id INTEGER;
ALTER TABLE repos ADD COLUMN github_installation_id INTEGER;
ALTER TABLE repos ADD COLUMN verified_by TEXT REFERENCES members;
ALTER TABLE repos ADD COLUMN verified_at TEXT;

-- Audit gets team + user attribution; security events with org_id NULL are user-level.
ALTER TABLE audit ADD COLUMN org_id TEXT;
ALTER TABLE audit ADD COLUMN actor_user_id TEXT;
ALTER TABLE audit ADD COLUMN ip_prefix TEXT;
CREATE INDEX audit_by_org ON audit(org_id, id);

-- Erasure grants (§10.3): the only way journal rows can be deleted/redacted.
CREATE TABLE erasures (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('team','card')),
  target_id TEXT NOT NULL,                         -- org id | card id
  requested_by_user TEXT, requested_at TEXT NOT NULL,
  executed_at TEXT, row_counts TEXT                -- JSON, kept forever as the tombstone
);
CREATE TABLE erasure_active (board_id TEXT, card_id TEXT, erasure_id TEXT NOT NULL REFERENCES erasures);  -- rows exist only inside the purge txn

INSERT INTO hub_meta (k, v) VALUES ('session_epoch', '1') ON CONFLICT(k) DO NOTHING;
```

Journal trigger replacement and cross-team triggers are in §10.3 and §7.2 (same migration).

### 2.3 Entity summary

```
users 1─* identities            users 1─* sessions           users 1─* user_devices 1─* devices(enrolment) *─1 members
users 1─* members *─1 orgs(team) 1─* boards 1─* cards …      orgs 1─* invites          orgs 1─* repos *─* boards (board_repos)
```

A **member** is always (user, team). All existing team-scoped rows keep pointing at members, so a user's history in team A is invisible from team B by construction.

---

## 3. Roles and the permission matrix

Roles: `owner`, `admin`, `member`, `guest` (existing `viewer` rows migrate to `guest` with `board_guests` for every board of their team, preserving what they could see).

✓ = allowed, ✗ = denied (`FORBIDDEN`, or `NOT_FOUND` where existence would leak), "own" = only their own.

| Action | owner | admin | member | guest |
|---|---|---|---|---|
| See team, board list | ✓ | ✓ | ✓ | only `board_guests` boards |
| Read board, cards, card detail, handover, feed | ✓ | ✓ | ✓ | granted boards |
| Read journal (`/journal`) | ✓ | ✓ | ✓ | ✗ |
| See member emails | ✓ | ✓ | ✗ (names + avatars) | ✗ |
| Create / edit / move cards, labels, assignees | ✓ | ✓ | ✓ | ✗ |
| Comment | ✓ trusted | ✓ trusted | ✓ trusted | ✓ **untrusted** (`trusted=0`: never delivered to an agent, shown with a "guest" badge) |
| Dispatch (Give to Claude) to **own** runner | ✓ | ✓ | ✓ | ✗ |
| Dispatch to **another member's** runner | ✓ | ✓ | ✓ | ✗ |
| … conditions | target is owner/admin/member of the same team (not removed, not guest), has an un-revoked enrolment in this team, and team `settings.cross_dispatch != 'off'`. The runner's local policy still decides (`auto_accept_from`, else confirm, CONTRACT §5.2 `needs_confirm`). The hub can only **restrict**, never force acceptance | | | |
| Be a dispatch target / enrol a runner in the team | ✓ | ✓ | ✓ | ✗ |
| Stop / cancel / retry / take over / hand over | ✓ | ✓ | ✓ | ✗ |
| Answer asks, approve Done, request changes | ✓ | ✓ | ✓ | ✗ |
| Answer permission requests | only if in `approvers` **and** role ∈ {owner,admin,member} and not removed at answer time (re-checked in `answerPermission`) | | | ✗ |
| Create / rename / archive boards | ✓ | ✓ | ✗ | ✗ |
| Add / verify / remove repos; link GitHub installation | ✓ | ✓ | ✗ | ✗ |
| Invite guests | ✓ | ✓ | if `settings.members_can_invite_guests` (default false) | ✗ |
| Invite members / admins | ✓ | ✓ | ✗ | ✗ |
| Create link invites | ✓ | ✓ | ✗ | ✗ |
| Change role (member↔admin↔guest) of non-owners | ✓ | ✓ | ✗ | ✗ |
| Promote to owner / demote an owner | ✓ | ✗ | ✗ | ✗ |
| Remove a member | ✓ | ✓ (not owners) | self (leave) | self (leave) |
| Revoke any member's **team enrolment** of a device | ✓ | ✓ | own | — |
| Revoke the physical device (all teams) | own only | own only | own only | own only |
| Team settings (name, cross_dispatch, invite policy) | ✓ | ✓ | ✗ | ✗ |
| Slug, plan, transfer ownership, delete/restore team | ✓ (step-up) | ✗ | ✗ | ✗ |
| Export team | ✓ | ✓ | ✗ | ✗ |
| Audit log (team) | ✓ | ✓ | ✗ | ✗ |

Implementation: one table in `hub/permissions.js` (`can(member, action, ctx)`), unit-tested row by row against this matrix (`hub/test/permissions.test.js`). `hub.canWrite` / `hub.isAdmin` (`hub/hub.js:162-163`) become thin wrappers. Guest board checks go into `api.boardFor` (`hub/api.js:34-37`), so every route that already calls it inherits them.

**Removal effects (one transaction, then after-commit sends):** set `members.removed_at`; revoke that member's enrolments (`devices.revoked_at`); withdraw pending dispatches targeting them (existing `offer.withdrawn` path, `hub/hub.js:608-615`); for their active runs apply `stop` (fence bump, D7) so salvage/handover proceeds normally; after commit close their browser sockets on that team (`4403`) and runner sockets for those enrolments (`4403 REVOKED`); revoke invites they created (not already used).

---

## 4. Auth flows (`BOARD_AUTH=public`)

### 4.1 Common

- All auth HTTP entry points live under `/auth/*` (browser redirects) and `/api/auth/*` (JSON). Both are rate-limited (§9).
- New code lives in `hub/identity/` and uses **WebCrypto** (`globalThis.crypto`, available in Node 22) plus injected `Store`, `Mailer`, `Clock`, `fetch` adapters, so it ports unchanged to Workers (§12.7).
- Keys: one master `BOARD_SECRET`; subkeys via HKDF-SHA256 with labels `run-token`, `csrf`, `oauth-cookie`, `email-code`, `dev-cookie`. (Run tokens keep their current format; `hub_meta.run_token_key_id` allows rotation.)
- Identities are keyed by **provider subject**, never by email. An email change at GitHub/Google never moves an account.

### 4.2 GitHub and Google (authorization code + PKCE + state)

1. `GET /auth/{github|google}/start?return_to=<path>`: `return_to` must be a relative path matching `^/(t/|account|device|join|$)` (open-redirect guard). Hub generates `state` (32 B), `code_verifier` (32 B → S256 challenge), `nonce` (Google). They go into a short-lived **signed and encrypted** cookie `__Host-buddy_oauth` (AES-GCM with the `oauth-cookie` subkey; HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=600) holding `{state, verifier, nonce, return_to, intent:'signin'|'link', link_ticket?}`. 302 to the provider with `state`, `code_challenge`, `code_challenge_method=S256`, and scopes: GitHub App: none needed beyond the app's account permission "Email addresses: read"; Google: `openid email profile`, `prompt=select_account`.
2. `GET /auth/{provider}/callback?code&state`: constant-time compare `state` with the cookie; delete the cookie either way; exchange `code` + `code_verifier` (+ client secret; both are confidential clients).
   - **GitHub:** `GET /user` (id, login, name, avatar) and `GET /user/emails` → take the `primary && verified` email; if none, `email_verified=0`. **Discard the user token immediately** (it is never stored).
   - **Google:** validate the ID token (`iss` ∈ {`https://accounts.google.com`,`accounts.google.com`}, `aud` = client id, `exp`, `nonce` matches; signature against Google JWKS, cached like `createAccessVerifier` does for Access, `hub/auth.js:28-85`). `sub` is the subject; trust `email` only if `email_verified === true`.
3. Resolve:
   - `(provider, subject)` exists → that user. Update `identities.email/login/last_used_at`.
   - else, verified email equals an existing user's verified `primary_email` or verified identity email → **do not link**. Create a `link_ticket` and redirect to `/signin/link` ("An account for c•••@gmail.com already exists. Sign in with **GitHub** (your existing method) to connect Google."). See §4.5.
   - else → create `users` + `identities` (and `primary_email_verified_at` only if verified). If the signup gate is `invite_only` (§9.4) and the user has no pending invite, create the user but show "waitlist" and allow nothing else.
4. Issue a session (§4.4) and 302 to `return_to` (default `/`).

### 4.3 Email magic link

1. `POST /api/auth/email/start {email, turnstile_token, return_to}`: verify Turnstile; normalise email (trim, lower-case, IDNA; **no** plus/dot stripping); rate limits §9.1. Always answer `200 {ok:true}` (no account enumeration). Set cookie `__Host-buddy_ml` = random nonce (HttpOnly, Secure, SameSite=Lax, Max-Age=900). Create `email_tokens` row: token = `bml_` + 32 random bytes; also a 6-digit code. At most 3 live tokens per email (the oldest is invalidated). Email contains `https://buddy.example.com/auth/email#t=<token>` and the code.
2. The token is in the **URL fragment**: it never reaches the server via GET, never appears in access logs, Cloudflare logs or `Referer`, and **link-scanners (Outlook Safe Links, Gmail prefetch) cannot consume the single-use token** because they don't execute the page's JS POST.
3. `/auth/email` page JS posts `POST /api/auth/email/verify {token}`:
   - token unknown / expired (15 min) / used → `400 INVALID_TOKEN` (generic).
   - Same browser (cookie nonce hash matches) → mark used, sign in.
   - Different browser (no/other nonce) → respond `409 CONFIRM_REQUIRED {email_masked}`; the page shows "Sign in as c•••@gmail.com? This link was requested from another browser." and a second POST with `confirm:true` completes. This blocks **login CSRF** (an attacker mailing a victim their own link) from being silent.
   - Alternative: `POST /api/auth/email/code {email, code}` for "requested on laptop, email on phone": max 5 attempts per token then the token dies; code compared as HMAC in constant time.
4. On success: find identity `('email', lower(email))` or create user + identity; `email_verified=1`, set `primary_email_verified_at` if the primary email matches. If a user with this verified email exists **via another provider** but has no email identity → this is the same person proving control of the mailbox: link automatically **only** if that user's email is verified by that provider too (both sides verified the same mailbox); otherwise treat as §4.5.

### 4.4 Sessions

- Cookie: `__Host-buddy_sid=<43-char base64url of 32 random bytes>`; `HttpOnly; Secure; SameSite=Lax; Path=/`; no `Domain` (the `__Host-` prefix forbids it, pinning the cookie to this exact host). Lax, not Strict, so arriving from an email link or from the desktop app still carries the session; CSRF is handled separately (§4.6).
- Stored: `sha256(value)` only. Lookup per request: `SELECT … WHERE id_hash=? OR prev_id_hash=?` (prev accepted ≤ 60 s after rotation), check `revoked_at IS NULL`, not idle/absolute expired, `session_epoch` current, user not deleted.
- **Fixation:** the hub never accepts a session id it didn't just mint after a successful sign-in. No pre-auth sessions exist; the OAuth/magic-link state lives in separate short cookies.
- **Rotation:** new value on every sign-in, on step-up, and when `rotated_at` is older than 24 h (sliding). Old value becomes `prev_id_hash` for 60 s.
- **Lifetimes:** idle 14 d, absolute 30 d.
- **Step-up:** `auth_at` must be ≤ 10 min old for: delete account, delete/transfer/restore team, change slug, unlink identity, export. ≤ 12 h for approving a device. Otherwise `401 STEP_UP_REQUIRED {methods}` and the web re-runs the user's sign-in with `intent=stepup`.
- **Revocation:** `DELETE /api/me/sessions/:id`, `POST /api/me/sessions/revoke-all {keep_current}` ("log out everywhere"), automatic on account deletion, identity unlink (sessions made with that method), and restore (epoch bump). Revocation also closes the live browser sockets tied to that session: `hub.browsersBySession: Map<id_hash, Set<BrowserConn>>`, close `4401` after sending `session.revoked`. Every browser socket also re-validates its session every ping (20 s) as a backstop.
- Logout: `POST /api/auth/logout` → revoke current, clear cookie (`Max-Age=0`).

### 4.5 Account linking (the takeover vector)

Threat: an attacker creates an identity at provider X claiming the victim's email (unverified, or a provider that lets you set any email), then signs in and gets auto-linked into the victim's account.

Rules:

1. **Never auto-link on email** from OAuth. A verified email match yields a `link_ticket`, not a session.
2. Linking requires proving control of the **existing** account in the same browser within 10 min: the page offers only the existing account's methods; after that sign-in succeeds, the callback sees the pending ticket (carried in `__Host-buddy_oauth.link_ticket`) and shows "Connect Google (c•••@gmail.com) to this account?" → `POST /api/auth/link/confirm {ticket}`.
3. Only `email_verified=1` identities can ever match. Unverified GitHub emails are stored but never used for matching, invites or team creation.
4. Signed-in linking from Account settings (`/auth/{provider}/start?intent=link`) requires step-up ≤ 10 min. If the new identity's `(provider, subject)` already belongs to **another** user → refuse (`CONFLICT`), never merge accounts.
5. Every link/unlink writes `audit` and emails the user's verified address ("Google was connected to your Buddy account. Not you? …").
6. Unlinking the last sign-in method is refused.

### 4.6 CSRF (cookie-authenticated mutations)

Existing: JSON content type + same-origin (`hub/http.js:159-162`). In `public` mode every mutating `/api/*` request must also pass:

1. `Origin` present **and** equal to `new URL(BOARD_PUBLIC_URL).origin` (missing Origin → `403`; the Host fallback in `sameOrigin` is removed for public mode).
2. If `Sec-Fetch-Site` is present it must be `same-origin`.
3. Header `X-CSRF-Token` equal to `base64url(HMAC(k_csrf, session.id_hash))` (returned by `GET /api/me`; stable across the session, changes on rotation, both values accepted during the 60 s grace).
4. Bearer-token (device) routes are exempt from 1–3 (no ambient credential).

WS upgrade for `/ws/board` keeps the Origin check (`hub/http.js:203`) with the same stricter rule.

### 4.7 Other auth modes

- `BOARD_AUTH=access` (self-host): Access JWT verified as today. Identity `('cf_access', claims.sub)` → user auto-provisioned with `email_verified=1` (Access verified it). Membership: users must be invited (email invites work; the invite email must equal the Access email) **or** admin-created via legacy `POST /api/members` (kept in this mode only). Multiple teams per person now work (C2 fixed by resource-based resolution). Runner connections still require the device's Access service token (`hub/ws-runner.js:25-34`). No hub sessions; CSRF rules 1–2 apply.
- `BOARD_AUTH=dev`: unchanged semantics but hardened (§9.5).

---

## 5. Repo links and GitHub-verified access

Use a **GitHub App** ("Buddy Board") rather than an OAuth App, for sign-in and repo verification (Open decision D-1):

- Sign-in: GitHub App user authorization (supports PKCE and multiple callback URLs; user tokens expire in 8 h and we discard them anyway).
- Repo verification: an admin clicks "Connect GitHub" → `https://github.com/apps/<slug>/installations/new?state=<signed {team_id, member_id, exp}>` → GitHub redirects to `/github/installed?installation_id&setup_action&state`. The hub verifies `state`, then **proves the admin can see the installation** with a fresh user token (`GET /user/installations` must list `installation_id`) before storing `github_installations`. This prevents a user from attaching someone else's installation id to their team.
- Adding a repo (`POST /api/teams/:team_id/repos {url}`): canonicalise (`scope.normalizeRemoteUrl`); if host is github.com and the team has an installation, mint an installation token (1 h, from the App private key) and `GET /repos/{owner}/{repo}`. Success → `verification='github_verified'`, store `github_repo_id` (stable across renames). Otherwise `unverified` (allowed; shown with a grey "not verified" chip).
- What verification buys: PR/commit **evidence becomes `hub_verified` only for verified repos**, using that installation's token (replaces the single `BOARD_GITHUB_TOKEN`, C11; the env var stays for `access`/`dev` modes). Merge-poll auto-Done also only for verified repos. Unverified repos: evidence stays `self_reported`, no auto-Done.
- App permissions: Repository **Metadata: read**, **Pull requests: read**, **Contents: read** (commit existence). Account: **Email addresses: read**. No write permission of any kind. The private key can read code of installed repos; it lives only in the hub's credential store (§12.3) and is a Pi-compromise asset (threat table §11).
- Runners still enforce local opt-in + `welcome.allowlist` (D14). A team linking a repo **cannot** make anyone's runner touch it; verification only affects evidence and trust chips.
- Installation removed/suspended (detected when a token mint fails with 404/403) → affected repos `verification='lost'`, banner for admins.

---

## 6. Desktop app sign-in and runner device enrolment

### 6.1 Flow (loopback-bound device authorization)

```
App                                   Hub                                Browser (signed in)
 │ listen 127.0.0.1:<random port>      │                                   │
 │ POST /api/device/authorize ────────▶│ create device_flows (pending)     │
 │   {client, device_name, platform,   │                                   │
 │    form_factor, code_challenge,     │                                   │
 │    mode:'loopback', redirect_port}  │                                   │
 │◀── {device_code, user_code,         │                                   │
 │     verification_uri_complete,      │                                   │
 │     loopback_state, interval:5,     │                                   │
 │     expires_in:600}                 │                                   │
 │ shell.openExternal(verification_uri_complete) ───────────────────────────▶│ GET /device?code=WDJB-MJHT
 │ show "Code WDJB-MJHT" in app        │◀── GET /api/device/flows/WDJB-MJHT │ (sign in first if needed)
 │                                     │ ── {device_name, platform, client, requested_age_s, country, teams_eligible}
 │                                     │                                   │ user checks code matches app,
 │                                     │                                   │ ticks teams, clicks Approve
 │                                     │◀── POST …/approve {team_ids,name} │ (step-up ≤ 12 h)
 │                                     │ state=approved, approval_code      │
 │                                     │ ── {redirect:"http://127.0.0.1:<port>/buddy/cb?code=<approval_code>&state=<loopback_state>"}
 │◀──────────── browser navigates to loopback ─────────────────────────────│
 │ check state; respond "You can close this tab"                           │
 │ POST /api/device/token {device_code, code_verifier, approval_code} ─▶│ all three must match; state→consumed
 │◀── {device_token, user_device_id, enrollments:[{device_id, team_id, team_slug, team_name}]}
 │ safeStorage.encryptString → userData/board-device.bin (0600)          │
 │ spawn runner, pass token on stdin; runner opens one /ws/runner per enrolment
```

- Polling (`POST /api/device/token` without `approval_code`) returns `authorization_pending` / `slow_down` (poll faster than `interval`) / `access_denied` / `expired_token`, so the app can show progress. In **loopback mode a token is never issued without `approval_code`**.
- **Typed mode** (`board-runner login` on a headless box, no local browser): no `verification_uri_complete` is returned at all; the user must open `https://buddy.example.com/device` themselves and **type** the code. The approval page for typed flows shows a red-bordered warning: "Only approve if you started this on your own machine just now. Buddy staff will never ask you to enter a code." Typed flows are only allowed for `client='board_runner_cli'`.
- Codes: `user_code` 8 chars from a 20-letter consonant alphabet (~34 bits), single use, 10 min; brute force is bounded by §9.1 (10 failed lookups per session per 10 min, then 15 min lock). `device_code` and `approval_code` are 32 random bytes, stored hashed.

### 6.2 Device-code phishing

Attack: the attacker starts a flow on their own machine and sends the victim the approval link ("approve to join our team"). A classic RFC 8628 flow would hand the attacker a device token for the victim's account → the attacker's "runner" receives dispatches meant for the victim, with card bodies, repo context, handovers and team context.

Mitigations:

1. **Loopback binding:** the approval redirect goes to `127.0.0.1:<port>` on the **victim's** machine. The attacker's app never sees `approval_code`, so its token request can never succeed.
2. Typed mode never offers a clickable link, needs the code typed, and shows the warning above.
3. The approval page shows device name, platform, client, approximate location (`CF-IPCountry` of the requester vs approver; mismatch shown in amber) and "requested 12 s ago"; flows older than 10 min can't be approved.
4. Every approval emails the user ("New device 'MacBook-Pro' connected to Buddy for team Acme") with a one-click "This wasn't me" → revokes the device (link token in fragment, POST to act, step-up).
5. The device list (web) shows every device and its last-seen time, and one-click revoke.

### 6.3 Token storage and use

- Desktop app: `safeStorage.encryptString(JSON{hub, user_device_id, device_token})` → `userData/board-device.bin` (0600). On macOS the encryption key sits in the Keychain item "<App> Safe Storage", ACL'd to the app's code signature. **Caveat:** unsigned/ad-hoc builds change signature each build, so Keychain prompts appear or the key becomes unreachable (the token is then lost and the user re-approves; harmless). The Apple Developer ID decision (handover) affects UX here, not security.
- The app passes the token to the runner process **on stdin** as one JSON line at spawn. Never argv (visible in `ps`), never env (CONTRACT D15/D26 keep secrets out of env), never written to `~/.board/device.json` when the app is the owner.
- CLI-only runner (`board-runner login --hub <url>`): writes `~/.board/device.json` (0600, atomic) as today, new shape `{hub, user_device_id, device_token, enrollments}`; the legacy `{hub, device_id, device_token}` shape keeps working. The sandbox already `denyRead`s `device.json` (`runner/launch.js:32`).
- **Rotation:** the runner calls `POST /api/device/rotate` when `token_rotated_at` is older than 30 d (returned in `/api/device/self`); the old token is accepted for 5 min. Limits the value of a leaked backup.

### 6.4 Multiple teams per device

- `GET /api/device/self` (bearer) → `{user_device_id, name, user:{id, display_name}, enrollments:[{device_id, team_id, team_slug, team_name, revoked:false}], rotate_after}`.
- Runner opens **one `/ws/runner` socket per enrolment**, sending `Authorization: Bearer <device_token>` and `Board-Team: <team_id>`. The hub resolves `user_device` by token, then the enrolment `devices` row by `(user_device_id, member.org_id = team_id)`. The rest of `RunnerConn` is unchanged: `this.device`, `this.member`, per-enrolment outbox `seq`, allowlist per team (`hub/ws-runner.js:118-122`), `ownCard` (`:188-194`).
- Backward compatible: no `Board-Team` header and exactly one live enrolment → use it; more than one → close `4400 TEAM_REQUIRED`.
- Local repo opt-in stays per repo on the machine (`policy.json`); a repo advertised on the team-A socket is only advertised there if it's on team A's allowlist. The same working copy can be linked by two teams; each team only sees its own runs.
- Adding a team to an existing device: web "Devices → MacBook-Pro → Add to team" (`POST /api/me/devices/:id/enrollments {team_id}`, session + step-up 12 h). The hub pushes `device.enrollments` on every open socket of that user_device; the runner opens the new socket. Removing: `DELETE …/enrollments/:team_id` → that socket closes `4403`.
- Revoking the physical device: `DELETE /api/me/devices/:id` → `user_devices.revoked_at`, `token_hash=NULL`, all enrolments revoked, all sockets `4403`, active runs stopped (fence bump), audit + email.
- Team admins can revoke **their team's** enrolment of anyone's device (`DELETE /api/teams/:team_id/devices/:device_id`), never the physical device.

---

## 7. Cross-team isolation

### 7.1 Rules

1. **Resource → team → membership.** `makeAuthMember` (`hub/http.js:223-236`) becomes `authUser(req)` (session, Access or dev) returning a **user**. Each route declares its scope: `{team: 'param:team_id' | 'board:board_id' | 'card:card_id' | 'pr:id' | 'repo:repo_id' | 'invite:id' | 'none'}`. The router resolves the owning team from the id, then `members WHERE org_id=? AND user_id=? AND removed_at IS NULL`, checks `orgs.deleted_at IS NULL`, and passes that **member** to the unchanged `api.*(member, …)` functions. Unknown id or no membership → `404 NOT_FOUND` (not 403: no existence oracle).
2. The existing guards (`boardFor`, `cardFor`, `orgMember`, `ownCard`) stay as a second layer.
3. **Browser WS:** `/ws/board` upgrade authenticates the **user**; `subscribe {board_id}` resolves the member for that board's team and stores it on the connection (`BrowserConn.member` is per subscription, not per socket). Broadcasts (`hub/hub.js:755-769`) are unchanged (filter by `boardId`), but membership removal, guest board revocation, team soft-delete and session revocation close or unsubscribe affected sockets synchronously after commit.
4. **Runner WS:** enrolment determines team; `ownCard` rejects foreign cards; run tokens already bind `(card, run, fence)` and the hub checks the run's `device_id` equals the connection's enrolment (add the check if it isn't explicit in `rpc.js`; test T-RUN-4).
5. **Idempotency cache** key stays `(member_id, request_id)` (`hub/hub.js:949-956`); member ids are per team, so a replay can't cross teams.
6. **Notifications/emails** go to members of the card's team only (`hub.recipients`, `hub/hub.js:512-525`) plus email address lookups through `members → users`.

### 7.2 Database-level backstop (triggers in 004)

Triggers that `RAISE(ABORT,'cross-team reference')` on INSERT/UPDATE when:

| Table.column | Must share team with |
|---|---|
| `cards.repo_id` | `cards.board_id` (via `board_repos` already, but enforce `repos.org_id = boards.org_id`) |
| `board_repos (board_id, repo_id)` | same org |
| `card_assignees.member_id` | card's board org |
| `dispatches.dispatched_by`, `.target_member_id` | card's board org |
| `runs.on_behalf_of`, `.dispatched_by`, `.device_id → devices.member_id` | card's board org |
| `comments.author_member_id`, `asks.answered_by`, `permission_requests.answered_by`, `cards.created_by`, `cards.stopped_by` | card's board org |
| `devices.member_id` + `user_devices.user_id` | `members.user_id = user_devices.user_id` |
| `board_guests.member_id` | board org, and member role = guest |
| `invites.created_by` | `invites.org_id` |
| `memories.repo_id`, `.card_id` | `memories.org_id` |

These make a missed guard fail loudly instead of leaking. Cost: a few indexed lookups per insert (negligible at our scale; measure in the e2e suite).

### 7.3 Tenant-isolation test suite (`hub/test/tenancy/`)

Fixture `tenancy/fixture.js`: two teams **A** and **B**, each with owner/admin/member/guest users, a board, the **same** canonical repo URL linked in both, a device enrolled in both teams for one shared user **S** (member of A and B), cards in every run state, open asks and permission requests, comments, handovers, memories, overlaps, invites, journal rows. Everything below runs in `npm test`; the WS/runner parts also run in `test:e2e` against real processes.

| Test id / file | Proves |
|---|---|
| **T-ROUTES** `routes-matrix.test.js` | Introspects the router's route table. For **every** route with an id param, calls it as A-member with B's ids (and as B with A's) → `404`, body contains no B data. For team-level routes with A's team id as a non-member → `404`. **Fails if any route is missing from the matrix** (coverage assertion on the route list), so new routes can't skip it |
| **T-ROLES** `roles-matrix.test.js` | Every row of §3 per role, including guest on non-granted board → `404` |
| **T-WS-SUB** `ws-board.test.js` | A browser `subscribe` to B's board → `error NOT_FOUND`; subscribed to A, 50 random B mutations → recorder sees **zero** frames; S subscribed to A board sees only A |
| **T-WS-REVOKE** | Remove member / revoke session / delete team / remove guest board grant → socket closed or unsubscribed within one tick; no frame after the commit |
| **T-RUN-1..6** `runner.test.js` | Enrolment A: `claim` B's card → `CLAIM_LOST`; `hb` for B's run → `current:false, RUN_ENDED`; `out` frames naming B's card are acked + dropped with no row written; `rpc` with a run token minted for B's run over A's socket → rejected; `welcome.allowlist` contains only A repos; `advertise` of a B-only repo → not stored |
| **T-DISPATCH** | A-member dispatch with `target_member_id` = a B member, a removed A member, an A guest, or an A member without an A enrolment → `VALIDATION`/`POLICY_DENIED`; S's device receives offers for A on the A socket only |
| **T-OVL** `overlap.test.js` | Same repo URL in A and B, runs touching the same file in each → no overlap row, no `context.update` across teams, `teamContext` never includes B memories |
| **T-JOURNAL** | `GET /api/boards/B/journal` as A → 404; journal rows written by S in B have `board_id` of B only |
| **T-MSG** | Task-to-task messages (TASKS-CONTRACT) and notifications addressed across teams → rejected (placeholder test, activates when the tasks engine lands) |
| **T-IDEMP** | Same `request_id` used by S in A then B → two separate effects, no replay across |
| **T-EXPORT** | Team export of A contains zero B ids (scan every string in the JSON for B's ids) |
| **T-DB** `invariants.test.js` | SQL invariant queries (one per §7.2 row) return zero rows; also executed at the end of every e2e test, beside the journal replay check (CONTRACT §13) |
| **T-TRIG** | Direct inserts violating §7.2 raise |
| **T-FUZZ** | 1,000 random (route, id-from-other-team, role) triples → never 2xx with foreign data |

---

## 8. Invites

- **Email invite** (`kind='email'`): admin enters up to 20 addresses; one invite per address, role ≤ inviter's (never owner), 7-day expiry, single use. Accepting requires a signed-in user with a **verified** identity whose email equals the invite email (so a forwarded or leaked invite email is useless to anyone else). If the invitee has no account, the link leads to sign-up, then accept.
- **Link invite** (`kind='link'`): role `member` or `guest` (admin links only by owners), `max_uses` 1–100 (default 10), expiry 1–30 d (default 7). Max 10 active links per team.
- Token format `inv_` + 32 random bytes, stored hashed. URL: `https://buddy.example.com/join#inv_…` (fragment: not logged, not in `Referer`); the page POSTs `/api/invites/preview` then `/api/invites/accept`. `Referrer-Policy: no-referrer` on all pages.
- **Leakage mitigations:** fragment tokens; single-use by default; email binding; admins see uses ("joined via link 'Design contractors' by Jo, 2 of 10 used") and can revoke at once; every join via link notifies admins; link joins land as the link's role, and **guest** is the default role for new links; a revoked or expired token gives the same generic error as an unknown one.
- Accepting with an existing (removed) membership reactivates the same `members` row (history continuity).
- Domain auto-join: **deferred** (D-6). If built later: only for a domain the admin proves (verified email at that domain + DNS TXT), never for free-mail domains, and as "request to join" (admin approves) by default.
- Invite emails come from the platform address, contain the inviter's display name and team name as **plain text** (no HTML from user input), and a footer "You got this because <name> invited <email>. Ignore to decline." (anti-spam, §9.2).

---

## 9. Abuse controls

### 9.1 Rate limits

Token buckets in memory on the Pi (single process; `hub/ratelimit.js`, injectable clock), a `RateLimiter` interface so Workers can use the Rate Limiting binding/DO. Client IP = `CF-Connecting-IP` **only** when `BOARD_TRUST_CF_IP=1` (set only when the hub binds loopback behind cloudflared, which is the only ingress); otherwise the socket address. Limit keys use the /64 for IPv6.

| Surface | Limit | On exceed |
|---|---|---|
| `GET /auth/*/start` | 30 / 10 min / IP | 429 |
| `POST /api/auth/email/start` | 3 / 15 min / email; 10 / h / email; 20 / h / IP; global 500 / h (alarm to Callum at 50 %) | 200 `{ok:true}` silently for per-email (no enumeration), 429 for IP/global |
| `POST /api/auth/email/verify`, `/code` | 10 / 10 min / IP; 5 attempts / token | 429 / token dies |
| New user creation | 10 / day / IP | 429 |
| `POST /api/device/authorize` | 10 / h / IP | 429 |
| `GET /api/device/flows/:user_code` | 10 misses / 10 min / session → 15 min lock | 429 |
| `POST /api/device/token` | `interval` 5 s per flow (`slow_down` adds 5 s) | `slow_down` |
| `POST /api/teams` | 3 / day / user; max 10 owned teams (free) | 429 / `QUOTA_EXCEEDED` |
| Invites (email) | 20 / day / team; 50 / day / user; 100 pending / team; same address re-invite once / 24 h | 429 |
| Invite accept / preview | 30 / 10 min / IP | 429 |
| All other `/api/*` (session) | 600 / min / session; 1,200 / min / IP | 429 |
| `/ws/board` upgrades | 30 / min / user; 10 open sockets / user | refuse 429 / close `4429` |
| `/ws/runner` upgrades | 20 / min / user_device; frames: outbox as today, `rpc` 60 / min / enrolment | close `4429` |

This covers review verdict (b) (per-member/IP rate limiting).

### 9.2 Email and invite spam

- Creating a team and sending any invite require `primary_email_verified_at` (email verified before inviting).
- New accounts (< 24 h) may send at most 5 email invites total.
- Invite emails never contain user-controlled HTML, links other than the hub, or free text longer than a 60-char team name.
- Bounces/complaints (Resend webhook `POST /api/hooks/resend`, signed) → suppress that address; ≥ 3 complaints from one team's invites in 7 days → team's email invites disabled + alert.

### 9.3 Quotas (per team, `free` plan; `pro` = ×10; `self_hosted` = unlimited)

| Resource | Free limit |
|---|---|
| Members (incl. guests) | 25 |
| Boards | 10 |
| Cards (not done/archived) | 2,000; total 20,000 |
| Dispatches / runs started | 200 / day |
| Enrolled devices | 50 |
| Repos | 50 |
| Comments | 50 / card / day per member; body ≤ 20 kB (existing 1 MiB body cap stays) |
| Journal + events storage | alarm at 250 MB per team (measured by a nightly `dbstat` job) |

Exceeding → `403 QUOTA_EXCEEDED {resource, limit}`. Runs cost the hub nothing in AI (members' own CLIs), so run quotas exist only to cap hub write load.

### 9.4 Bot protection and signup gate

- **Cloudflare Turnstile** (managed mode) on the email sign-in form and on "Create team". Verified server-side (`POST https://challenges.cloudflare.com/turnstile/v0/siteverify`, `remoteip`, check `hostname` and `action`). OAuth sign-in doesn't need it (the IdP is the bot check).
- `BOARD_SIGNUP=invite_only|open` (default `invite_only` at launch): anyone can sign in; creating a team requires `open`, a pending invite, or an entry in `BOARD_SIGNUP_ALLOW` (emails/domains). Flip to `open` once abuse monitoring has run for a couple of weeks (D-5).
- Cloudflare **Bot Fight Mode off** (it challenges the runner's and app's non-browser clients); use a WAF rate-limiting rule on `/auth/*` + `/api/auth/*` + `/api/device/authorize` as the outer layer.

### 9.5 Dev-login hardening (review verdict a)

- `BOARD_AUTH=dev` refuses to start if `BOARD_PUBLIC_URL`, `BOARD_TUNNEL_PROBE_URL`, `BOARD_TRUST_CF_IP`, or any OAuth client id is set, or if a `cloudflared` process ancestry/env marker is present (best-effort).
- `/api/dev/login` is **not registered** unless `auth==='dev'` (today it's registered and 404s at runtime, `hub/http.js:74-80`), and requires header `X-Board-Dev: <sha256(BOARD_SECRET)[:16]>` so a fronting proxy that forwards to loopback still can't use it.
- `public` mode refuses to start without `BOARD_PUBLIC_URL` on https, a `BOARD_SECRET`, at least one sign-in method configured, and `BOARD_BIND` loopback.

---

## 10. Privacy: export, deletion, retention

### 10.1 Export

- **User** (`GET /api/me/export`, step-up, 1/h): JSON of the user, identities (provider, email, login, dates; no tokens), sessions (metadata), devices + enrolments, memberships (team name, role, dates), cards they created, comments they wrote, asks/permission answers they gave, audit entries about them. Content-Disposition attachment; generated synchronously (small).
- **Team** (`GET /api/teams/:id/export`, owner/admin, step-up, 1/h): NDJSON stream: team, members (emails only for owners), boards, repos, cards, comments, handovers (all versions), evidence, events feed, journal, memories, invites (no tokens), audit. Never includes token hashes, device tokens, session data or other teams' ids (T-EXPORT).

### 10.2 Account deletion (`DELETE /api/me {confirm_email}`, step-up)

Blocked while the user is the **only owner** of a team that has other active members (must transfer or delete the team). Otherwise, one transaction:

1. Stop active runs on the user's devices (fence bump, D7), revoke all `user_devices`/enrolments, delete `sessions`, `email_tokens`, `link_tickets`, `identities`.
2. `users`: `display_name='Deleted user'`, `primary_email=NULL`, `avatar_url=NULL`, `deleted_at=now`.
3. Each `members` row: `removed_at`, `display_name='Deleted user'`, `github_id/github_login/email=NULL`. For teams where they were sole member → team deletion (§10.3) starts.
4. Optional checkbox "Also erase my comments": comment bodies → `'[deleted]'` (comment rows, not journal; the journal doesn't hold comment bodies, CONTRACT §15).
5. Card bodies/handovers they wrote stay: they are the team's work record (the team is the controller of board content; privacy policy says so). The journal keeps pseudonymous `actor_id` = member id, which now resolves to "Deleted user" only.
6. Audit `user.deleted` (no PII) and a confirmation email to the address captured before step 2.

### 10.3 Team deletion and the append-only journal

- `DELETE /api/teams/:id {confirm_slug}` (owner, step-up) → `deleted_at`, `purge_after = +7 d`; immediately: all routes 404 for the team, sockets closed, runners' enrolments revoked (runs stopped), invites revoked. `POST /api/teams/:id/restore` works for owners within 7 days.
- **Purge job** (hourly) for `purge_after < now`: one transaction per team: insert `erasures` + `erasure_active` rows (one per board), delete team rows in FK order (leases, path_locks, overlaps, runs, dispatches, asks, permission_requests, comments, evidence, handovers, plan_steps, events, card_assignees, cards, board_repos, board_guests, trust_policy, budgets, runner_repos, devices, memories, repos, boards, invites, members, github_installations, orgs), **delete journal rows for those boards**, record counts on `erasures.row_counts`, delete `erasure_active`. The `erasures` row is kept as the tombstone.
- Trigger changes (in 004):

```sql
DROP TRIGGER journal_no_delete;
CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal
  WHEN NOT EXISTS (SELECT 1 FROM erasure_active a WHERE a.board_id = OLD.board_id)
  BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
DROP TRIGGER journal_no_update;
CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal
  WHEN NOT (EXISTS (SELECT 1 FROM erasure_active a WHERE a.card_id = OLD.card_id)
            AND NEW.seq = OLD.seq AND NEW.kind = OLD.kind AND NEW.card_id IS OLD.card_id AND NEW.board_id IS OLD.board_id)
  BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
```

  So: deletion is possible only for a board under an active team erasure; updates only rewrite the payload of rows of a card under an active **card** erasure (redaction: `title` → `"[redacted]"`, then a `card.redact` journal row is appended). Normal code paths can do neither. Test: `hub/test/journal-erasure.test.js` (delete/update outside a grant still raise; purge removes exactly the team's rows; replay of the remaining journal still matches live cards).
- **Journal minimisation going forward:** `card.create` / `card.update` store `body` and `acceptance` as `{sha256, len}` instead of text (replay doesn't need them; `journal.replay` CREATE_FIELDS drops them, `shared/journal.js:28`). Migration 004 rewrites existing rows' `body`/`acceptance` into hashes in the same transaction (temporarily dropping and recreating the triggers). Title stays (needed for replay parity and it's short).
- Tombstone vs delete, decided: **user** deletion = tombstone (pseudonymise; history intact, no PII); **team** deletion = hard delete incl. journal after a 7-day grace; **single card** erasure (admin, for accidental personal data in a title) = redaction in place + `card.redact` row.

### 10.4 Retention

| Data | Kept |
|---|---|
| Expired/revoked sessions | deleted 30 d after expiry |
| `email_tokens`, `link_tickets`, `device_flows` | deleted 24 h after expiry/use |
| Expired/revoked invites | 90 d |
| Audit (security + team admin) | 12 months, then deleted |
| Board content | while the team exists |
| Deleted team | 7 d soft, then purged; backups age out within **35 d** (Litestream retention 7 d + R2 lifecycle 30 d on nightly snapshots) |
| Server logs | JSON stderr to journald, 14 d, never tokens/bodies (CONTRACT §14); IPs only as prefixes |

### 10.5 POPIA / GDPR notes (not legal advice; Callum is the responsible party)

- Personal information: names, emails, avatars, IP prefixes, device names, and whatever users type into cards/comments/handovers (possibly others' personal info, which the team controls).
- Lawful basis: contract (providing the service) + consent at sign-up to the privacy policy (checkbox on first sign-in, version stored on `users` as `tos_version`, `tos_accepted_at` in a follow-up migration).
- Operators/sub-processors to list: Cloudflare (tunnel, DNS, Turnstile, R2), Resend (email), GitHub and Google (IdPs). Cross-border transfer (POPIA s72): all US-based; rely on consent + their DPAs.
- Data subject rights: access = export; correction = profile edit; deletion = §10.2; objection = delete.
- Information Officer registration with the Information Regulator (Callum task, §12.1). Breach notification (s22) runbook: rotate secrets (§12.3), revoke all sessions (epoch bump), force device-token rotation, notify via email.
- Minimisation choices already made: no full IPs, no provider tokens stored, journal holds no body text, device tokens hashed, no AI credentials ever.

---

## 11. Threats and mitigations (accounts-specific; extends design §8)

| # | Threat | Mitigation |
|---|---|---|
| A1 | **Account takeover via email linking** (attacker's IdP account claims victim's email) | Link by provider subject only; email match → ticket requiring sign-in with the existing method; only `email_verified` emails count; linking emails the user (§4.5) |
| A2 | **Invite token leakage** (forwarded email, screenshot, logs, Referer) | Fragment tokens, hashed at rest, email-bound email invites, single-use default, expiry, use counts visible, revoke, guest default for links, admin notification on join (§8) |
| A3 | **Session fixation** | No pre-auth sessions; new random id at every sign-in; `__Host-` cookie can't be set by a sibling subdomain; rotation every 24 h (§4.4) |
| A4 | **Session theft** (XSS, malware) | HttpOnly; strict CSP (no inline, `script-src 'self' https://challenges.cloudflare.com` only on sign-in pages); D25 text-only rendering; idle 14 d/abs 30 d; session list with revoke; log out everywhere |
| A5 | **Device-code phishing** | Loopback binding; typed-mode warnings; approval context; email on approval (§6.2) |
| A6 | **CSRF / login CSRF** | Origin + Sec-Fetch-Site + CSRF header + JSON type; magic-link browser binding + cross-browser confirmation (§4.3, §4.6) |
| A7 | **Magic-link interception / scanner consumption** | 15-min single-use, fragment + POST, browser nonce, per-email limits |
| A8 | **Account enumeration** | Email start always 200; same error for unknown/expired/used tokens; invite errors generic |
| A9 | **Cross-tenant data access** | Resource-based membership, guards, DB triggers, test suite (§7) |
| A10 | **Removed member keeps access** (live sockets, device) | Synchronous socket closure, enrolment revocation, run stop (§3) |
| A11 | **Open redirect via `return_to`** | Relative-path allowlist (§4.2) |
| A12 | **Hub compromise → GitHub App key** | App is read-only (metadata, PRs, contents); key only in systemd credentials; rotate via GitHub UI; installation list shown to admins. Still no AI credentials, no repo write |
| A13 | **Restore resurrects revoked sessions/devices** | `session_epoch` bump on restore invalidates all sessions; Litestream RPO ≈ 1 s keeps the device-revocation window tiny; after a restore the hub emails every user whose device was revoked in the last 24 h of audit (audit survives in backups up to that point) and admins get a banner "restored to T, re-check devices" |
| A14 | **Invite/email spam using our domain** | Verified email + age limits + caps + plain-text templates + complaint suppression (§9.2) |
| A15 | **Resource exhaustion by free teams** | Quotas (§9.3), rate limits (§9.1), WAF rule |
| A16 | **Dev mode exposed through tunnel** | §9.5 |
| A17 | **Guest prompt-injects agents** | Guest comments `trusted=0` never delivered (existing `trusted` column, `hub/hub.js:479`); guests can't create/edit cards |

---

## 12. Deploy topology (Pi 5 now, Workers + DO later)

### 12.1 What Callum sets up himself (never paste secrets into chat)

Placeholders: domain `buddy.example.com`, dev port `8787`.

1. **Domain + Cloudflare zone.** Register the neutral domain (separate from bondly.co.za: cookie and reputation isolation) and add it to Cloudflare. SSL/TLS: Full; Always Use HTTPS on; HSTS after a week of stable operation.
2. **Tunnel.** On the Pi: `cloudflared tunnel login`, `cloudflared tunnel create buddy-hub`, `cloudflared tunnel route dns buddy-hub buddy.example.com`. Copy the printed tunnel UUID.
3. **GitHub App (prod)**: github.com → Settings → Developer settings → GitHub Apps → New.
   - Name "Buddy Board", Homepage `https://buddy.example.com`.
   - Callback URL: `https://buddy.example.com/auth/github/callback`. Tick "Expire user authorization tokens". Leave "Request user authorization during installation" off. Device flow off.
   - Setup URL: `https://buddy.example.com/github/installed`, tick "Redirect on update".
   - Webhook: inactive for now.
   - Permissions: Repository → Metadata: Read, Pull requests: Read, Contents: Read. Account → Email addresses: Read.
   - "Any account" can install.
   - After creating: note **App ID**, **Client ID**, **app slug**; "Generate a new client secret"; "Generate a private key" (.pem download).
4. **GitHub App (dev)**: same, name "Buddy Board Dev", callback `http://localhost:8787/auth/github/callback`, setup URL `http://localhost:8787/github/installed`.
5. **Google OAuth client**: console.cloud.google.com → new project "Buddy" → Google Auth Platform → Branding: app name, support email, authorised domain `example.com`, privacy policy URL `https://buddy.example.com/privacy`, terms `https://buddy.example.com/terms` → Audience: External → Data access: scopes `openid`, `email`, `profile` → Clients → Create → Web application: Authorised JavaScript origins `https://buddy.example.com`, `http://localhost:8787`; Authorised redirect URIs `https://buddy.example.com/auth/google/callback`, `http://localhost:8787/auth/google/callback` → note Client ID + secret → Audience → **Publish app** (basic scopes need no verification; adding a logo triggers brand verification, skip the logo initially).
6. **Resend**: sign up; Domains → add `mail.buddy.example.com`; add the shown SPF (TXT), DKIM (TXT/CNAME) and MX (bounce) records in Cloudflare DNS; add `_dmarc.buddy.example.com` TXT `v=DMARC1; p=quarantine; rua=mailto:<you>`; verify; API Keys → create with **Sending access** restricted to that domain. From address: `Buddy <signin@mail.buddy.example.com>`. Webhook (later): `https://buddy.example.com/api/hooks/resend` for bounces/complaints, note the signing secret.
7. **Turnstile**: Cloudflare dashboard → Turnstile → Add widget, hostnames `buddy.example.com`, `localhost`, mode Managed → note site key + secret.
8. **R2**: bucket `buddy-hub-backups`; lifecycle rule "delete objects under `nightly/` after 30 days"; API token with Object Read & Write on that bucket only → note access key id + secret + account endpoint.
9. **WAF**: Security → WAF → Rate limiting rule: path starts with `/auth/` or `/api/auth/` or equals `/api/device/authorize`, 30 requests / 10 s per IP → Block 60 s. Bot Fight Mode: **off**.
10. **Secrets onto the Pi** (over Tailscale SSH): create one file per secret under `/etc/buddy/credentials/` (root:root 0600): `board_secret` (`openssl rand -base64 48`), `github_client_secret`, `github_app_private_key.pem`, `google_client_secret`, `resend_api_key`, `turnstile_secret`, `r2_secret_access_key`. Non-secret ids go in `/etc/buddy/hub.env`.
11. **Legal**: publish privacy policy + terms at the URLs above (placeholders are fine for closed beta); register the Information Officer with the Information Regulator (POPIA).

### 12.2 cloudflared

`/etc/cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /etc/cloudflared/<TUNNEL_UUID>.json
ingress:
  - hostname: buddy.example.com
    service: http://127.0.0.1:8787
    originRequest:
      connectTimeout: 10s
      keepAliveTimeout: 90s
  - service: http_status:404
```

Everything on `buddy.example.com` is public; the hub itself decides auth. Nothing else on the Pi is exposed (SSH via Tailscale only; no inbound ports on the router). WebSockets: runner HB 15 s and browser ping 20 s stay under Cloudflare's ~100 s idle cut-off. No Cloudflare Access application on this hostname in `public` mode.

### 12.3 Services, secrets, health

- `buddy-hub.service` (systemd): `User=buddy`, `WorkingDirectory=/opt/buddy/current/board`, `ExecStart=/usr/bin/node hub/server.js`, `EnvironmentFile=/etc/buddy/hub.env`, `LoadCredential=board_secret:/etc/buddy/credentials/board_secret` (one line per credential; hub reads `$CREDENTIALS_DIRECTORY/<name>`, falling back to env for dev), `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `ReadWritePaths=/var/lib/buddy`, `PrivateTmp=yes`, `MemoryMax=1G`, `Restart=on-failure`.
- `hub.env`: `BOARD_AUTH=public`, `BOARD_BIND=127.0.0.1`, `BOARD_PORT=8787`, `BOARD_DATA_DIR=/var/lib/buddy`, `BOARD_PUBLIC_URL=https://buddy.example.com`, `BOARD_TRUST_CF_IP=1`, `BOARD_TUNNEL_PROBE_URL=https://buddy.example.com/api/health`, `BOARD_GITHUB_APP_ID`, `BOARD_GITHUB_CLIENT_ID`, `BOARD_GITHUB_APP_SLUG`, `BOARD_GOOGLE_CLIENT_ID`, `BOARD_MAIL_FROM`, `BOARD_TURNSTILE_SITEKEY`, `BOARD_SIGNUP=invite_only`, `BOARD_SIGNUP_ALLOW=…`.
- Secret rotation: `BOARD_SECRET` (kills run tokens and CSRF values; runs re-claim through the normal fence path; sessions survive because they're random ids, not HMACs), OAuth secrets (swap file, restart), GitHub key (generate new in GitHub, swap, delete old).
- Health: `GET /api/health` public, no secrets (adds `auth:'public'`; used by the tunnel self-probe and an external uptime check). `GET /api/health/deep` loopback-only: DB write/read, WAL size, Litestream lag (from its metrics), mailer config present, migration version, disk free.

### 12.4 Backups

- **Litestream** (continuous, RPO ≈ 1 s) of `/var/lib/buddy/board.db` → R2 `buddy-hub-backups/litestream/`, snapshot interval 24 h, retention 7 d.
- **Nightly** (systemd timer 03:00 SAST): `sqlite3 board.db ".backup /var/lib/buddy/nightly.db"` → `age`-encrypt to a key whose private half is **not** on the Pi → upload `nightly/<date>.db.age` (30-day lifecycle) and copy to the mini over Tailscale.
- **Restore** = `litestream restore` then boot with `BOARD_RESTORE=1`: existing fence bump (+1000, new epoch, `shared/migrate.js:66-80`) **plus** `session_epoch += 1` (everyone signs in again) (A13).
- Monthly restore drill onto a scratch dir: boots, `/api/health/deep` green, journal replay matches.

### 12.5 Update procedure

1. CI green on the tag (unit, tenancy, e2e).
2. On the Pi: `git -C /opt/buddy/src fetch && git worktree add /opt/buddy/releases/<sha> <sha>` → `npm ci --omit=dev` in `board/`.
3. `sqlite3 /var/lib/buddy/board.db ".backup /var/lib/buddy/pre-<sha>.db"` (kept 7 d).
4. `ln -sfn /opt/buddy/releases/<sha> /opt/buddy/current && systemctl restart buddy-hub` (migrations run at boot; boot grace + `reconnecting` handle runners, exit (g)).
5. Verify `curl -fsS https://buddy.example.com/api/health` and `/api/health/deep` locally; watch logs 5 min.
6. Rollback: re-point the symlink to the previous release. If the new release applied a migration, also restore `pre-<sha>.db` **with `BOARD_RESTORE=1`** (fence bump + session epoch), because the old code can't read the new schema.

### 12.6 What changes vs today's Access deployment

Access application removed from the hostname (or kept only on a separate `admin.` hostname if an admin UI appears later). Runner service tokens no longer needed in `public` mode.

### 12.7 Workers + Durable Objects port path

Keep the design portable now:

1. `hub/identity/*` uses WebCrypto and injected `Store`/`Mailer`/`RateLimiter`/`Clock`/`fetch`, no `node:` imports.
2. Separate **global** data (users, identities, sessions, email tokens, link tickets, device flows, user_devices, invite token index, orgs index/slug, membership index) from **team** data (everything else). All team-scoped queries go through one accessor `hub.team(teamId)` (a thin wrapper on the shared DB today). The membership resolver (§7.1) is the only place that joins the two.
3. Security checks never depend on process-local state alone (session revocation is checked in the store per request; in-memory socket maps only speed up closure).

Mapping:

| Pi piece | Workers + DO |
|---|---|
| global tables | **D1** |
| team tables (one SQLite) | **TeamDO** per team (DO SQLite storage). Design §9.1 said DO-per-board; per-team is simpler (runner sockets span boards) and makes the team the physical isolation boundary; split hot boards later if needed |
| membership index | D1 mirror, written through by TeamDO on every membership change (TeamDO authoritative) |
| per-board single-writer queue | TeamDO single-threaded execution |
| reaper, purge job | DO alarms; Cron Trigger for global retention |
| `/ws/board`, `/ws/runner` | hibernatable WebSockets on TeamDO; the Worker authenticates (session in D1 / device token in D1), resolves membership, and forwards the upgrade with a signed internal header |
| rate limits | Workers Rate Limiting binding (coarse) + a `LimiterDO` for per-email/per-device buckets |
| Litestream + nightly | DO point-in-time recovery (30 d) + nightly export to R2 |
| cloudflared | not needed |
| mail, OAuth, Turnstile | same code (fetch) |

Port triggers unchanged from design §9.1 (> ~50 active members, > 99.9 % availability need, or the Pi needed elsewhere), plus: public signup volume that one Pi can't absorb.

---

## 13. Phased build plan

Estimates are for one builder agent with review passes; each phase ends with `npm test` + `npm run test:e2e` green and a security-reviewer pass on phases 1, 3, 5.

| Phase | Scope | Est. | Exit criteria / tests |
|---|---|---|---|
| **P0 Prep** | Review fixes merged on `feat/board`; `migrate.js` FK-off directive; `BOARD_AUTH=public` config validation; dev-login hardening (§9.5); SPA fallback allowlist (C14) | 1 d | `shared/test/migrate-rebuild.test.js`; `hub/test/config.test.js` (dev refuses with public URL/tunnel/oauth set; public refuses without https URL/secret); dev route absent unless dev |
| **P1 Identity core** | Migration 004 (users, identities, sessions, tokens, member/device rebuild + data migration §14); `hub/identity/*`: GitHub + Google OAuth with PKCE/state/nonce, magic link + code, sessions (rotation, revocation, step-up), CSRF, `RateLimiter`, `Mailer` (Resend + console dev mailer); sign-in pages | 3.5 d | `identity/oauth.test.js` (fake GitHub/Google: state mismatch, PKCE mismatch, unverified email, nonce, open redirect), `identity/magic-link.test.js` (TTL, single use, scanner GET doesn't consume, cross-browser confirm, code attempts), `identity/session.test.js` (fixation, rotation grace, idle/abs expiry, epoch, revoke closes sockets), `identity/linking.test.js` (A1 scenarios), `http-csrf.test.js` |
| **P2 Teams + memberships + isolation** | Resource-based member resolution; teams CRUD, slug, soft delete; roles matrix (`permissions.js`); members page API; guests + `board_guests`; §7.2 triggers; tenancy suite v1 (T-ROUTES, T-ROLES, T-WS-*, T-JOURNAL, T-OVL, T-IDEMP, T-DB, T-TRIG) | 3 d | Tenancy suite green; route-matrix coverage assertion = 100 %; all existing hub tests green unchanged apart from fixtures |
| **P3 Invites** | Email + link invites, preview/accept, caps, admin notifications, invite UI | 1.5 d | `invites.test.js` (email binding, expiry, max uses, revoke, role ceiling, fragment flow, generic errors, caps) |
| **P4 Devices** | Device flow (loopback + typed), `/device` page, token/rotate/self routes, per-enrolment runner sockets + `Board-Team`, `device.enrollments` push, device list UI, desktop app integration (safeStorage, stdin hand-off, loopback listener), `board-runner login` | 3 d | `device-flow.test.js` (no token without approval_code in loopback mode; phishing sim: approval from another "machine" never yields a token; expiry; slow_down), T-RUN-1..6, T-DISPATCH; e2e: one runner process enrolled in two teams runs one card in each concurrently, zero cross frames (proxy recorder) |
| **P5 GitHub App + abuse + privacy** | Installation link + verification, per-installation evidence tokens; Turnstile, quotas, signup gate, email suppression; export (user/team), account deletion, team purge + journal erasure, journal minimisation, retention jobs, audit | 3 d | `github-app.test.js` (installation ownership proof, lost installation), `quotas.test.js`, `ratelimit.test.js`, `export.test.js` (T-EXPORT), `deletion.test.js`, `journal-erasure.test.js` |
| **P6 Deploy + beta** | Pi hardening, systemd + credentials, cloudflared, Litestream + nightly + restore drill, update/rollback scripts, runbook in `hub/README.md`; external pentest-style pass (auth, CSRF, IDOR via tenancy fixture on the live box with two throwaway teams) | 1.5 d | Restore drill passes; `/api/health/deep` green; security review GO; Callum + one outside user complete: sign up → create team → invite → join → enrol desktop → dispatch → Done |

Total ≈ 16.5 d including P0 (≈ 15.5 d of accounts work).

---

## 14. Migration from the Access-based identity

In 004, inside the FK-off rebuild:

1. For each distinct person in `members`: group rows by `lower(email)` when present, else by `github_id`. Create one `users` row (`display_name` from the newest member row, `primary_email` = email, `primary_email_verified_at` = now, since Access verified it).
2. Identities: `('github', github_id)` for `github_id > 0`, `email_verified=1`, `login=github_login`; `('dev', github_login)` for negative (dev stub) ids.
3. `members_new`: same ids, `user_id` from step 1, role `viewer` → `guest` (+ `board_guests` for every board of their org), legacy columns copied, `joined_via='migration'`.
4. `user_devices`: one per existing device, `client='legacy'`, `token_hash` moved; `devices_new`: same ids and `last_seq_acked` (outbox continuity), `user_device_id`.
5. `orgs.slug` = slugified name (dedupe with `-2`), `plan='self_hosted'` for existing orgs on Callum's box.
6. Journal body/acceptance → hashes (§10.3).

Cutover on the Pi: deploy with `BOARD_AUTH=access` first (identical behaviour, new schema) → verify → switch to `public`. Callum signs in with GitHub: subject = his `github_id` → same user → same memberships. Existing runners keep working (bearer token → legacy user_device → single enrolment, no `Board-Team` needed); re-enrol through the app later for Keychain storage. Remove the Access application from the hostname last.

---

## 15. API / contract delta

Conventions as CONTRACT §5.2 (JSON, `Board-Protocol: 1`, `request_id` on mutations, error shape). "session" = public-mode session cookie (or Access JWT / dev cookie in those modes). Scope column says how the team is resolved (§7.1). Protocol stays **v1**: all message changes are additive except the ones marked **(changed)**, which ship together with the web (same origin) and runner releases; old runners keep working through the legacy fallbacks noted.

### 15.1 New errors (`protocol.ERRORS`)

| Code | HTTP | When |
|---|---|---|
| `RATE_LIMITED` | 429 | any limit; `extra.retry_after_s` |
| `QUOTA_EXCEEDED` | 403 | `extra.{resource, limit}` |
| `STEP_UP_REQUIRED` | 401 | `extra.{max_age_s, methods}` |
| `EMAIL_UNVERIFIED` | 403 | team create / invite without verified email |
| `CONFIRM_REQUIRED` | 409 | exists; reused for cross-browser magic link (`extra.email_masked`) |
| `INVALID_TOKEN` | 400 | magic link / invite / link ticket unknown, used or expired (one generic code) |
| `SIGNUP_CLOSED` | 403 | team creation while `invite_only` |

New `WS_CLOSE`: `TEAM_REQUIRED: 4400`, `NOT_ENROLLED: 4404`, `RATE_LIMITED: 4429`. Existing `UNAUTHENTICATED 4401` (session revoked/expired) and `REVOKED 4403` (membership removed, enrolment/device revoked, team deleted) gain these meanings.

### 15.2 Auth routes (no session required)

| Method + path | Body / query | Response |
|---|---|---|
| `GET /api/auth/providers` | — | `{github:bool, google:bool, email:bool, turnstile_sitekey, signup:'open'\|'invite_only'}` |
| `GET /auth/:provider/start` | `?return_to=&intent=signin\|link\|stepup` | 302 to IdP; sets `__Host-buddy_oauth` |
| `GET /auth/:provider/callback` | `?code&state` | 302 to `return_to` with session, or to `/signin/link` (ticket), or `/signin?error=` |
| `POST /api/auth/email/start` | `{email, turnstile_token, return_to?}` | `{ok:true}` always (except 429); sets `__Host-buddy_ml` |
| `POST /api/auth/email/verify` | `{token, confirm?:bool}` | `{user, return_to}` + session cookie; `409 CONFIRM_REQUIRED`; `400 INVALID_TOKEN` |
| `POST /api/auth/email/code` | `{email, code}` | as verify |
| `GET /api/auth/link` | — (reads ticket cookie) | `{provider, email_masked, existing_methods:[…]}` |
| `POST /api/auth/link/confirm` | `{request_id}` (session of the target user + ticket cookie) | `{identities}` |
| `POST /api/auth/logout` | `{}` | `{ok}`; clears cookie |
| `GET /github/installed` | `?installation_id&setup_action&state` | 302 to team settings (session) |
| `POST /api/hooks/resend` | Resend webhook (signature verified) | `{ok}` |

### 15.3 Account routes (session; scope: self)

| Method + path | Body | Response |
|---|---|---|
| `GET /api/me` **(changed)** | — | `{user:{id, display_name, avatar_url, email, email_verified}, identities:[{id, provider, email, login, created_at, last_used_at}], teams:[{id, slug, name, role, plan, boards:[{id,name,key_prefix}]}], csrf_token, step_up_age_s}`. In `access`/`dev` single-team setups it **also** returns legacy `{member, org, boards}` for the first team so the old web keeps working during rollout |
| `PATCH /api/me` | `{request_id, display_name}` | `{user}` |
| `DELETE /api/me` | `{request_id, confirm_email, erase_comments?:bool}` (step-up 10 min) | `{ok}` / `CONFLICT {sole_owner_of:[team]}` |
| `GET /api/me/export` | — (step-up) | JSON attachment |
| `GET /api/me/sessions` | — | `{sessions:[{id, current, auth_method, created_at, last_seen_at, user_agent, ip_prefix}]}` (`id` = first 12 hex of id_hash) |
| `DELETE /api/me/sessions/:id` | `{request_id}` | `{ok}` |
| `POST /api/me/sessions/revoke-all` | `{request_id, keep_current:bool}` | `{revoked:n}` |
| `DELETE /api/me/identities/:id` | `{request_id}` (step-up) | `{identities}`; refuses the last one |
| `GET /api/me/devices` | — | `{devices:[{id, name, client, platform, created_at, last_seen_at, revoked_at, enrollments:[{device_id, team_id, team_name, last_seen_at, revoked_at}]}]}` |
| `PATCH /api/me/devices/:id` | `{request_id, name}` | `{device}` |
| `DELETE /api/me/devices/:id` | `{request_id}` | `{ok}` (all enrolments revoked, sockets 4403, runs stopped) |
| `POST /api/me/devices/:id/enrollments` | `{request_id, team_id}` (step-up 12 h) | `{enrollment}`; pushes `device.enrollments` |
| `DELETE /api/me/devices/:id/enrollments/:team_id` | `{request_id}` | `{ok}` |

### 15.4 Team routes (session; scope: `param:team_id` unless noted)

| Method + path | Role | Body | Response |
|---|---|---|---|
| `POST /api/teams` | any verified user (signup gate) | `{request_id, name, slug?, turnstile_token}` | `{team, member}`; creator = owner; one board "General" (`GEN`) created |
| `GET /api/teams/:team_id` | member+ / guest (limited) | — | `{team:{id, slug, name, plan, settings}, me:member, counts, quotas}` |
| `PATCH /api/teams/:team_id` | admin (slug/plan: owner, step-up) | `{request_id, name?, slug?, settings?}` | `{team}` |
| `DELETE /api/teams/:team_id` | owner, step-up | `{request_id, confirm_slug}` | `{ok, purge_after}` |
| `POST /api/teams/:team_id/restore` | owner, step-up (works while soft-deleted) | `{request_id}` | `{team}` |
| `POST /api/teams/:team_id/transfer` | owner, step-up | `{request_id, member_id}` | `{members}` (target becomes owner; caller stays owner unless `demote_self:true`) |
| `GET /api/teams/:team_id/export` | admin, step-up | — | NDJSON attachment |
| `GET /api/teams/:team_id/audit` | admin | `?before_id&limit` | `{rows, next_before_id}` |
| `GET /api/teams/:team_id/members` | member+ (emails: admin+) | — | `{members:[publicMember + {role, joined_at, last_active_at, email?}]}` |
| `PATCH /api/teams/:team_id/members/:member_id` | admin (owner changes: owner) | `{request_id, role}` | `{member}` |
| `DELETE /api/teams/:team_id/members/:member_id` | admin, or self | `{request_id}` | `{ok}` (§3 removal effects) |
| `GET /api/teams/:team_id/boards` | member+ (guest: granted) | — | `{boards}` |
| `POST /api/teams/:team_id/boards` | admin | `{request_id, name, key_prefix}` | `{board}` |
| `PATCH /api/boards/:board_id` | admin (scope board) | `{request_id, name?, archived?}` | `{board}` |
| `PUT /api/boards/:board_id/guests/:member_id` / `DELETE …` | admin | `{request_id}` | `{ok}` |
| `GET /api/teams/:team_id/repos` / `POST …` | member+ / admin | `{request_id, url, short_name?, default_branch?}` | `{repo}` incl. `verification` |
| `POST /api/repos/:repo_id/verify` | admin (scope repo) | `{request_id}` | `{repo}` |
| `GET /api/teams/:team_id/github/install-url` | admin | — | `{url}` (signed state) |
| `GET /api/teams/:team_id/devices` | admin | — | `{enrollments:[{device_id, member, name, last_seen_at, revoked_at}]}` |
| `DELETE /api/teams/:team_id/devices/:device_id` | admin, or own | `{request_id}` | `{ok}` |
| `GET /api/teams/:team_id/invites` | admin | — | `{invites:[{id, kind, email?, role, uses, max_uses, expires_at, created_by_name, label}]}` (never tokens) |
| `POST /api/teams/:team_id/invites` | admin (guest-only: member if setting) | `{request_id, kind:'email', emails:[..≤20], role, board_ids?}` or `{request_id, kind:'link', role, max_uses?, expires_in_days?, label?, board_ids?}` | email: `{invites}`; link: `{invite, url}` (**token shown once**) |
| `DELETE /api/invites/:id` | admin (scope invite) | `{request_id}` | `{ok}` |
| `POST /api/invites/preview` | none (rate-limited) | `{token}` | `{team_name, inviter_name, role, email_bound:bool, email_masked?}` or `INVALID_TOKEN` |
| `POST /api/invites/accept` | session (verified email for email invites) | `{request_id, token}` | `{team, member}` |

Existing routes: `/api/boards/:board_id…`, `/api/cards/:card_id…`, `/api/permission-requests/:id/answer` keep their shapes; scope is resolved from the id (§7.1). `GET/POST /api/repos` without a team: kept, resolved when the user has exactly one team, else `VALIDATION ("use /api/teams/:team_id/repos")`. `POST /api/members` and `POST /api/devices` (manual token) exist only in `access`/`dev` modes; `404` in `public`. `answerPermission` re-checks role (guest/removed → `FORBIDDEN`). Guest comments are stored with `trusted=0`.

### 15.5 Device routes

| Method + path | Auth | Body | Response |
|---|---|---|---|
| `POST /api/device/authorize` | none (rate-limited) | `{client:'buddy_desktop'\|'board_runner_cli', mode:'loopback'\|'typed', redirect_port?, device_name, platform?, form_factor?, code_challenge, code_challenge_method:'S256'}` | `{device_code, user_code, verification_uri, verification_uri_complete? (loopback only), loopback_state?, interval:5, expires_in:600}` |
| `GET /api/device/flows/:user_code` | session | — | `{client, mode, device_name, platform, requested_age_s, requester_country, approver_country, teams_eligible:[{id,name,role}]}`; `INVALID_TOKEN` |
| `POST /api/device/flows/:user_code/approve` | session, step-up 12 h | `{request_id, team_ids:[..], name?}` | loopback: `{redirect}`; typed: `{ok}` |
| `POST /api/device/flows/:user_code/deny` | session | `{request_id}` | `{ok}` |
| `POST /api/device/token` | none | `{device_code, code_verifier, approval_code?}` | `{device_token, user_device_id, enrollments}` or `400 {error:{code:'authorization_pending'\|'slow_down'\|'access_denied'\|'expired_token'}}` |
| `GET /api/device/self` | bearer device token | — | `{user_device_id, name, user, enrollments, rotate_after}` |
| `POST /api/device/rotate` | bearer | `{}` | `{device_token}` (old valid 5 min) |
| `GET /device` | page | `?code=` | approval page (web) |

### 15.6 `/ws/runner` changes

- Upgrade headers: `Authorization: Bearer <device_token>` + **new** `Board-Team: <team_id>` (required if > 1 live enrolment; else `4400`). Unknown team or revoked enrolment → `4404`/`4403`. In `public` mode no Access service token is checked.
- `hello` unchanged; `hello.device_id` must equal the **enrolment** id (as today).
- `welcome` **(additive)**: `+ team:{id, slug, name}`, `+ user_device_id`.
- New hub→runner frame `device.enrollments {enrollments:[{device_id, team_id, team_slug, team_name}]}`: sent on every open socket of the user_device when enrolments change; runner opens/closes sockets to match.
- New hub→runner frame `device.revoked {scope:'device'|'enrollment', reason}` sent before closing `4403` (runner stops local runs and, for `device`, deletes its stored token).

### 15.7 `/ws/board` changes

- Upgrade authenticates the **user** (session / Access / dev).
- `welcome` **(changed)**: `{protocol, hub_epoch, user:{id, display_name, avatar_url}, member?}`; `member` present only in single-team access/dev setups (legacy).
- `subscribe {board_id}` resolves the member for that board's team; `snapshot` **(additive)** `+ team:{id, slug, name}, + viewer:{member_id, role}`.
- New hub→browser frames: `membership.changed {team_id, role|null}` (web refreshes `/api/me`; `null` = removed, followed by unsubscribe), `session.revoked {}` (then close `4401`), `board.access_revoked {board_id}` (guest grant removed; then unsubscribe).

### 15.8 Config (hub/README.md env table additions)

`BOARD_AUTH=public|access|dev`, `BOARD_TRUST_CF_IP`, `BOARD_SIGNUP`, `BOARD_SIGNUP_ALLOW`, `BOARD_GITHUB_APP_ID`, `BOARD_GITHUB_CLIENT_ID`, `BOARD_GITHUB_APP_SLUG`, `BOARD_GOOGLE_CLIENT_ID`, `BOARD_MAIL_FROM`, `BOARD_MAIL_PROVIDER=resend|console`, `BOARD_TURNSTILE_SITEKEY`; credentials (file or env): `board_secret`, `github_client_secret`, `github_app_private_key.pem`, `google_client_secret`, `resend_api_key`, `resend_webhook_secret`, `turnstile_secret`.

CSP for pages served in `public` mode: `default-src 'self'; connect-src 'self'; img-src 'self' https://avatars.githubusercontent.com https://lh3.googleusercontent.com; style-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` + `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`.

### 15.9 Web board changes

Vanilla modules in `web/js/` (no framework), path routing with the index.html fallback for: `/`, `/signin`, `/signin/link`, `/auth/email`, `/welcome`, `/join`, `/device`, `/account`, `/account/{sessions,devices,identities}`, `/t/:slug`, `/t/:slug/b/:board_id`, `/t/:slug/settings/{general,members,invites,boards,repos,devices,audit,danger}`, `/privacy`, `/terms`.

- **Sign-in** (`render-signin.js` extended): "Continue with GitHub", "Continue with Google", email field + Turnstile → "Check your email" (with 6-digit code entry) → cross-browser confirm screen; the dev-login picker shows only when `/api/health` says `dev`.
- **Welcome**: pending invites to accept, or "Create a team" (name → slug preview); waitlist message when signup is closed.
- **Header**: team switcher (teams from `/api/me`; last team in `localStorage`, try/catch), board picker, avatar menu (Account, Devices, Sign out).
- **Invite dialog**: tabs Email (chips, role select, guest board picker) / Link (role, uses, expiry, label → copy once, "Anyone with this link can join as Guest until 7 Oct").
- **Members page**: list with role dropdown (per matrix), remove, leave; pending invites with revoke.
- **Team settings**: general (name, slug), cross-dispatch toggle, member guest invites toggle, GitHub connection + repo list with verification chips, danger zone (transfer, delete, restore countdown).
- **Devices** (account and team views): device, client, platform, last seen, enrolments, revoke; "Add to team".
- **Device approval page** `/device`: big code to compare, device facts, country mismatch warning, team checkboxes, Approve / Deny; typed-mode warning.
- **Guest affordances**: no Give to Claude or edit controls; comments labelled "guest · not sent to Claude".
- Dispatch dialog: target picker lists only members with a live enrolment in this team.

---

## 16. Open decisions (recommended defaults)

1. **D-1 GitHub App vs OAuth App for GitHub sign-in.** Default: **GitHub App** for both sign-in and repo verification (fine-grained read-only permissions, multiple callback URLs, per-installation tokens replace the single hub token). Cost: an extra "Connect GitHub" install step for admins who want verified repos.
2. **D-2 Shared SQLite with team scoping vs a DB file per team on the Pi.** Default: **shared DB now** with the `hub.team()` boundary, triggers and tenancy suite; the per-team split happens naturally at the DO port. Cost: isolation relies on code + triggers rather than separate files until then.
3. **D-3 Guest semantics.** Default: **board-scoped read + untrusted comments; no dispatch, no answers, no journal.** Cost: existing viewers gain commenting ability (untrusted), a small behaviour change.
4. **D-4 Cross-member dispatch default for new teams.** Default: **`confirm`** (today's behaviour: the target's runner asks unless the dispatcher is in `auto_accept_from`). Alternative `off` is safer for strangers but breaks the core "give it to Jo's Claude" flow.
5. **D-5 Signup at launch.** Default: **`invite_only`** (anyone can sign in and accept invites; team creation needs an allowlist or invite) for the first ~2 weeks, then `open` with Turnstile + quotas.
6. **D-6 Domain auto-join.** Default: **defer**; if built, only DNS-verified non-free-mail domains, as request-to-join.
