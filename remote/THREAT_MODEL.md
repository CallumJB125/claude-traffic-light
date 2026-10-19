# Buddy on your phone — remote approvals threat model (F6 security core)

Scope: approving or denying a Claude Code permission request (the blocking
`PermissionRequest` hook) from a phone, through the team hub, without the hub
being trusted. This covers pairing, signed decisions, the remote deny-list and
the relay contract in `remote/src`. The PWA UI, hub endpoints, Web Push and
Slack buttons come later and must follow this document.

Status: reference implementation. First independent review (2026-09-30):
crypto core sound, integration not safe to ship; its findings are fixed in
this revision (§11) and need a re-review before merge. Ground rule: nothing
that approves actions remotely merges before an
`oh-my-claudecode:security-reviewer` pass.

## 1. Protocol in one page

**Algorithms.** ECDSA P-256 with SHA-256 (WebCrypto, IEEE P1363 `r‖s`
signatures) for every key; HMAC-SHA-256 for the pairing MAC; SHA-256 for
hashes. Why P-256 and not Ed25519: iOS/iPadOS Safari 16.4 (the first version
with home-screen Web Push) has ECDSA P-256 in WebCrypto but no Ed25519, which
WebKit only added later (Safari 17 — re-verify on a real device when the PWA is
built). Node ≥22 implements the same WebCrypto API, so one isomorphic module
runs on both sides. The phone's private key is generated **non-extractable**
and kept as a `CryptoKey` in IndexedDB; it never exists as bytes in JS.

**Ids are key fingerprints.** `deviceId` and `desktopId` = first 32 chars of
base64url(SHA-256(raw public key)). An id can't be re-pointed at another key.

**Canonical JSON** (RFC 8785 / JCS subset): sorted keys, no whitespace, ES
number/string forms; `undefined`, NaN, sparse arrays, non-plain objects and
depth > 64 are errors. Signed objects travel as the exact canonical text; the
verifier re-canonicalises and rejects any mismatch (duplicate keys,
whitespace, reordering), so two parsers can't disagree about what was signed.
Every signed object carries a type `t` (domain separation).

**Pairing** (`pairing.js`):

```
desktop screen  QR {v, t:'buddy.pair', hub, did, dpk, pid, s(32-byte secret), exp(+3 min)}
phone → desktop pair-init      {pid, devicePub, deviceName, commit=H(nP)}  mac=HMAC(s, …did…)  pop=sig_device(…)
desktop → phone pair-challenge {pid, did, devicePub, commit, nD}           sig_desktop
phone → desktop pair-reveal    {pid, nP}                                   mac=HMAC(s, …)
phone screen    SAS = 6 digits of H(pid, did, dpk, devicePub, nP, nD)
desktop UI      human TYPES the phone's code; desktop compares with its own SAS (never shown)
                → registry.add(device)                                     (local only; not reachable via the relay)
desktop → phone pair-complete  {pid, did, devicePub, deviceId, ownerId}    sig_desktop
```

Single-use, 3-minute expiry, at most 4 open pairings, every failure (including
one wrong typed code) burns the pairing. The QR secret is read optically and
never crosses the hub. The device name is phone-chosen and shown on the desktop
as an untrusted label (control/bidi characters stripped). A revoked key can
never be registered again.

**Decision** (`decision.js`, `approvals.js`):

```
desktop → phone buddy.request  {did, requestId, sessionId, cardId, toolName, toolInput, toolInputHash, cwd, repoLabels, deskOnly, issuedAt, expiresAt}  sig_desktop
phone → desktop buddy.decision {aud=desktopId, requestId, sessionId, cardId, toolName, toolInputHash, decision, deviceId, issuedAt, expiresAt(≤120 s), nonce}  sig_device
desktop → phone buddy.result   {did, aud=deviceId, requestId, nonce, status applied|rejected|unknown, decision, reason, at}  sig_desktop
```

`buddy.result` is signed only for devices the desktop has authenticated;
rejections before that (malformed, wrong audience, unknown/revoked device, bad
signature) get an unsigned `{unsigned:true, reason}` that the phone treats as a
hint only. The phone checks a notice's signature, `did` and `expiresAt`, and
renders hidden characters visibly (`revealHidden`).

The phone computes `toolInputHash` itself from the input it displays; it never
signs a hash it was handed.

Desktop verification order (first failure wins, every outcome audited):
shape/size → `aud` → device known & not revoked → signature → expiry sanity
(TTL ≤ 120 s, ≤ 30 s future skew, not expired) → nonce unused (replay cache) →
request still pending with matching sessionId/cardId/toolName → SHA-256 of the
pending request's canonical tool input equals the signed hash → injected
policy (session owner only by default) → **allow only:** input ≤ 8 KB, deny-list,
then the remote allow-list → first-wins settle → the hook confirms it took the
answer (`.taken`) before the desktop signs `applied`.

**Answer files** (`hooks/answer-file.js`, shared by the hook, the widget
buttons and the phone path):

```
<id>.json     hook, O_EXCL 0600 in a 0700 dir: full toolInput + toolInputHash (the phone's hash)
              + decisionHash = sha256(canonical {kind, channel, tool, toolInput, permissionSuggestions,
              cwd, sessionId, host});
              id = host-UUID
<id>.answer   created once via temp file + link() (EEXIST = someone else won):
              {v, id, decision, decisionHash, by, ack, nonce, extra?, mac}; the hook
              claims it with a `timeout` marker at its deadline, or honours an answer that beat it
<id>.taken    hook renamed an ack-wanting answer after acting on it (refused → .refused)
```

**Per-request key.** Before `<id>.json` exists, the hook generates 32 random
bytes and hands them to the running app over the local signal server. It
finds the server through `~/.claude-traffic-light/port` (written 0600,
atomically, by the app), and before sending anything secret it makes the
listener prove it holds the per-install token: the hook sends a random
nonce (no secret) to `POST /request-key/challenge`, the server replies
`HMAC-SHA256(token, "buddy.request-key.v1|" ‖ its own port ‖ "|" ‖ nonce)`,
and the hook checks it with a timing-safe compare for the port it connected
to (so a listener can't relay the challenge to the real app and reuse the
answer). Only then does it `POST /request-key` with `{id, key}`,
token-authenticated; first registration per id wins. The key is
held in the app's memory only (`requestKeys`) and never written to disk. Every
answer carries `mac = HMAC-SHA256(key, canonical answer fields)`; the hook
verifies it with a timing-safe compare against the key it kept in memory. No
app, or an app that won't take the key → no request file, no wait: the
terminal prompt shows.

The hook only honours an answer whose mac verifies and whose `decisionHash`
equals the request it is holding. A `permissionIndex` answer also names the
hash of the suggestion shown; the hook applies it only if the suggestion at
that index hashes the same, so the label clicked is the rule applied. The app
recomputes `decisionHash` from the request file before showing it and again
before answering, and drops any request that no longer matches. The desktop
reports `applied` only on seeing its own nonce in `.taken` within ~1.5 s;
otherwise `unknown` ("not applied — check at your desk").

## 2. Assets

| Asset | Why it matters |
|---|---|
| A1 The ability to answer a waiting permission prompt with **allow** | Equivalent to running the tool call on the member's laptop: shell, file writes, git push |
| A2 Device private keys (phone) | Whoever can use one can sign decisions for that member |
| A3 Desktop identity private key | Signs pairing challenges/completions, request notices and results; forging it lets an attacker pair devices or fake "applied" |
| A4 Device registry on the desktop | Decides whose signatures count; tampering adds a trusted key |
| A5 QR pairing secret | Proves "this phone scanned my screen" |
| A6 Request content (tool input, cwd, repo labels) | Can contain secrets (commands with tokens, file contents in `Write`) |
| A7 Audit trail (card activity feed) | Accountability for who approved what |

## 3. Actors

| Actor | Capability assumed |
|---|---|
| **Owner** | Legitimate member; owns the desktop and paired phones. Can make mistakes (approve without reading) |
| **Teammate** | Another member; may approve on cards they're assigned to (runner sessions) but not on the owner's interactive sessions. May be phished |
| **Hub operator** | Runs the hub. Sees and routes all relay traffic; may be curious or coerced |
| **Network attacker** | On the path between phone/hub/desktop; can observe/replay/drop/modify traffic outside TLS, or inside it if TLS is terminated at a proxy they control |
| **Stolen phone** | Physical possession of an unlocked or later-unlocked paired phone |
| **Malicious PWA update** | Attacker-controlled JavaScript served to the phone at the PWA's origin (compromised hub, compromised CDN/build, or a malicious operator) |
| **Compromised hub** | Full control of the hub process and data: arbitrary messages to phones and desktops, arbitrary drops, delays and replays |
| Prompt-injected agent | The model itself may try to get risky actions approved (by making them look benign in the prompt the human sees) |

## 4. Trust boundaries

```
 ┌───────── phone ─────────┐        ┌──── hub (untrusted) ────┐        ┌──────────── member's desktop ────────────┐
 │ PWA JS  ── non-extract. │  TLS   │ routes by desktopId;    │  TLS   │ Buddy app (Electron main)                │
 │ CryptoKey (device key)  │ ─────▶ │ sees request notices,   │ ─────▶ │  RemoteApprovals: verify + policy +      │
 │ shows desktop-signed    │ ◀───── │ decisions, results;     │ ◀───── │  deny-list + first-wins settle           │
 │ notices, signs decisions│        │ can drop/delay/replay   │        │  registry (0600), identity key (0600)    │
 └─────────────────────────┘        └─────────────────────────┘        │        │ .answer file (O_EXCL)            │
        ▲  B1: QR (optical, secret never on the network)               │        ▼                                  │
        └──────────────── desktop screen ──────────────────────────────│ PermissionRequest hook (set-status.js)   │
                                                                       │   waits ≤55 s on requests/<id>.answer    │
                                                                       └──────────────────────────────────────────┘
```

- **B1 desktop screen → phone camera**: the only channel the hub can't touch.
  Carries the desktop key and the pairing secret.
- **B2 phone ↔ hub**: untrusted. Nothing the hub says is believed unless
  desktop-signed (notices, challenges, completions, results).
- **B3 hub ↔ desktop app**: untrusted. Nothing the hub delivers is acted on
  unless device-signed and verified against the local registry.
- **B4 desktop app ↔ waiting hook**: local filesystem (`~/.claude-traffic-light/requests`,
  `port`, `token`) plus the per-request key over the local signal server.
  The question is whether the agent can approve its own permission prompt,
  least of all with a session-wide rule. The answer depends on what the agent
  can already do:
  - **Protected: an agent limited to Claude Code's file tools** (Read, Edit,
    Write…, including under acceptEdits) **and sandboxed Bash** (writes
    confined to the project, no listener it can point Buddy at). It can
    read `requests/` but that gives nothing to sign with, so a forged
    `<id>.answer` is refused and the terminal prompt stays; the request file
    is bound by `decisionHash` (kind, channel, tool, input, suggestions, cwd,
    session, host), so
    editing it only gets the request dropped; and the
    deny rule the hook installer adds to `~/.claude/settings.json`,
    `Edit(<state dir>/**)` (`~/.claude-traffic-light` unless
    `CLAUDE_TRAFFIC_LIGHT_HOME` moves it; Edit rules cover every built-in file
    editing tool, Write included), keeps its file tools out of Buddy's state
    altogether. The settings file is written atomically; a malformed
    `permissions` block is left alone with a warning (no rule added); and
    uninstall removes the rule only if Buddy recorded adding it, so a
    person's identical rule stays.
  - **Not protected: unsandboxed Bash or any other arbitrary code execution
    as the user.** Such an agent can read `token` and talk to the app like
    the app's own hook, or rewrite `port` and run a listener that holds the
    token too, so the challenge (which stops a listener that *doesn't* know
    the token, e.g. whatever grabbed port 47172 after the app quit) no longer
    helps; it can also race the hook's key registration or read the app's
    memory. None of that is worth defending further: an agent with that
    power can run the tool call it is asking about directly, without any
    prompt. What stays exposed there is exactly that: an allow (including a
    session rule) can be forged, and the terminal prompt is not a boundary.
    The real bound for such agents is Claude Code's own permission rules and
    the sandbox, not Buddy.
  - Other same-user processes are out of scope for the same reason.

## 5. What the hub can and cannot do

**Cannot:**
- Forge an approval. Decisions are signed by a device key that never leaves
  the phone, and verified on the desktop against a registry the hub can't
  write. The hub holds no key that the desktop trusts.
- Turn a deny into an allow, or change which request/tool input a decision
  applies to (signature covers decision, requestId, sessionId, cardId,
  toolName, input hash, audience, expiry, nonce).
- Get an old approval applied again (nonce replay cache; request single-use;
  ≤ 120 s expiry; `aud` binds to one desktop).
- Get a harmless-looking input approved for a harmful pending one: the phone
  hashes what it shows; the desktop compares against the real pending input.
  The notice is also desktop-signed, so a tampered display fails on the phone
  before the human is even asked.
- Pair its own device, even with a relay MITM: it lacks the QR secret (MAC),
  and if it somehow has the secret the desktop-signed challenge exposes the
  swap to the phone and the code the human types from the phone won't
  match the desktop's session; commit/reveal stops code grinding.
- Confirm a pairing: confirm is only callable from the local desktop UI.
- Fake success to the phone: only a desktop-signed `applied` result bound to
  this requestId + nonce counts. Offline, timeout or an unsigned "ok" is shown
  as **not applied**.
- Get anything outside the remote allow-list, or on the deny-list, approved remotely.

**Can:**
- Deny service: drop, delay or refuse to deliver anything (the desk prompt
  still works; the hook falls back to Claude Code's own dialog after 55 s).
- Burn pairings (send junk with a seen `pid`) — the user re-scans.
- **Read request content** (A6): tool inputs, cwd, repo labels in notices go
  through the hub in cleartext (inside TLS). See R3.
- See metadata: who approves what and when.
- **Serve the PWA** — see R1; this is the one way around everything above.

## 6. STRIDE threats and mitigations

| # | STRIDE | Threat | Mitigation (where) |
|---|---|---|---|
| S1 | Spoofing | Hub/network forges a decision from a device | ECDSA signature by device key, verified on desktop against local registry (`approvals.js`); ids are key fingerprints |
| S2 | Spoofing | Relay MITM during pairing registers attacker key | HMAC with optically-shared secret; device proof-of-possession; desktop-signed challenge binding the received key; the human types the phone's code into the desktop (one try); commit/reveal against SAS grinding (`pairing.js`) |
| S3 | Spoofing | Hub impersonates the desktop to the phone (fake challenge / completion / notice / result) | All desktop→phone messages signed by the desktop key pinned from the QR; QR `did` must equal fingerprint(`dpk`) |
| S4 | Spoofing | Teammate's device acts on the owner's session; hub injects an assignee | Default policy `ownerOnly`. `makeOwnerPolicy({allowTeammates, teammates})`: assignees only on runner sessions AND on the desktop's own teammate list (hub list is intersected, never trusted); off by default until §12.1 exists; throws → deny |
| T1 | Tampering | Hub edits a decision (deny→allow, other request) | Signature over canonical bytes; exact key set; non-canonical payloads rejected |
| T2 | Tampering | Tool input changes between prompt and decision (TOCTOU) | Decision binds SHA-256(canonical input); desktop recomputes from the pending request at apply time |
| T3 | Tampering | Hub alters what the phone displays | Desktop-signed `buddy.request`; phone recomputes the hash from the displayed input before signing |
| T4 | Tampering | Parser differentials (duplicate keys, number forms) | Canonical round-trip check; strict JCS subset; schema with exact key set |
| T5 | Tampering | Registry / identity files edited | 0600 files in 0700 dir; a corrupt registry fails loudly. Local same-user attacker out of scope |
| T6 | Tampering | The agent forges `<id>.answer`, edits `<id>.json` to change what the answer applies, or rewrites `port` to collect the key | Covers agents limited to file tools or sandboxed Bash (§4 B4): per-request key held only in the app's memory; HMAC-SHA256 over the whole answer, timing-safe verify in the hook; `decisionHash` binds kind, channel, tool, input, suggestions, cwd, session and host (so the allow-list's cwd is the hook's); a suggestion index is bound to that suggestion's hash; the key goes only to a listener that proves the token for its own port (challenge, §1); port file 0600; installer deny rule `Edit(<state dir>/**)`. **Not covered:** an agent with unsandboxed Bash or other code execution can read the token (or be the listener), so it can forge an allow; it could equally run the tool itself |
| R1 | Repudiation | "I never approved that" / who approved; log tampering | Audit event per outcome with deviceId, device name, owner, requestId, card, tool, input **hash**, reason, rule, and the signed decision envelope as evidence; events are hash-chained (`seq`, `prevHash`, `hash`); unauthenticated junk is rate-limited (20/min, overflow counted) |
| I1 | Info disclosure | Request content visible to the hub | Accepted for v1 (R3); audit logs carry only the hash |
| I2 | Info disclosure | Pairing secret leaks via the hub | Secret never sent; only HMAC tags cross the hub (tested) |
| D1 | DoS | Hub drops/delays; burns pairings; floods desktop | Desk path unaffected; phone shows "desktop offline — not applied"/"unknown"; envelope ≤ 4 KB; replay cache bounded and fails closed when full; ≤ 4 open pairings |
| E1 | Elevation | Remote approval of destructive actions, or of anything that runs repo-controlled code | **Remote allow-list** (`allowlist.js`): Read/Grep/Glob (not credential paths), Edit/Write inside the session dir (not credentials, hooks, shell rc, CI, package.json), Bash only for read-only programs (ls/cat/grep/rg/find/…, `git status/diff/log/show/blame/ls-files/rev-parse` with no `-c`/`-C`, `--ext-diff`, `--textconv`, `--output`, pager or upload-pack options, read-only `gh`) with no expansion/redirect/subshell/wrapper/interpreter. Package scripts, test runners, compilers, and `git commit/push/add/fetch/checkout` (hooks) are desk-only; a repo can opt in to remote *test* commands (`trustTestCommands`, off by default), never commit/push. Everything else → "approve at your desk". Deny-list (tokenised, `shell.js`) behind it: destructive shell, any force/delete push, `git -c alias`, interpreter `-c/-e`, writes to code-running paths, prod-labelled repos. Inputs > 8 KB desk-only |
| E2 | Elevation | Replay of a captured approval | Per-device nonce cache until expiry+skew; requests single-use (first-wins); `aud` binding; TTL ≤ 120 s |
| E3 | Elevation | Revoked/stolen device keeps acting | Revoke one / revoke all on the desktop, effective immediately and offline (local registry) |
| E4 | Elevation | Concurrent answers (desk, phone, MCP) both applied; one answer releases a parallel call | Random request ids; link-based exclusive `.answer`; hash- and key-bound answers; hook's deadline claim; `.taken` ack (§1) |

## 7. Actor-by-actor

- **Owner:** mistakes are bounded by the allow-list, deny-list and a short TTL; the phone
  shows desktop-signed content, so what they read is what's pending.
- **Teammate:** disabled by default. When enabled: card assignees on runner
  sessions who are also on the desktop's local teammate list. Getting a
  teammate's device key onto the desktop needs §12.1 — never hub TOFU.
- **Hub operator / compromised hub:** §5. The only way past the model is R1.
- **Network attacker:** strictly weaker than the hub (TLS + all of §5).
- **Stolen phone:** can sign decisions while the phone is unlocked and the PWA
  is logged in. Mitigation: revoke from the desktop (tray action, works
  offline), short TTL, allow-list. Residual R2 (closed by the WebAuthn step, §11).
- **Malicious PWA update:** R1.
- **Prompt-injected agent:** can craft a command that reads benign; the phone
  shows the full input with hidden characters revealed, only allow-listed
  shapes are remotely approvable, and the hash binding stops a switch after
  display. Residual R4.

## 8. Residual risks (accepted or open)

- **R1 — The PWA's origin controls the device key.** Non-extractable keys can't
  be stolen, but JS served from the PWA origin can *use* them to show one thing
  and sign another. **Decided (§11):** separate static origin + a WebAuthn
  passkey per approval. Until the PWA ships with both, this stays open.
- **R2 — Stolen unlocked phone** can approve allow-listed requests until
  revoked. Closed by per-approval WebAuthn user verification (§11).
- **R3 — Hub sees request content.** Commands and `Write` contents can contain
  secrets. Next step specified in §12.2 (E2E encryption). Until then keep the
  hub Tailscale-only (ground rule). For the interaction relay (phone control)
  the envelope is built (W2-A, `docs/relay-e2e-threat-model.md`, review
  pending); approval notices reuse it in W2-B.
- **R4 — Shell judgement is heuristic.** The allow-list makes the default
  "desk" and admits only read-only programs; the tokeniser handles quoting,
  wrappers, `sh -c`, `$(…)` and backticks. Remaining: `git diff/log/show` can
  still run a diff/textconv driver that the repo's own `.git/config` +
  `.gitattributes` define (writing those remotely is desk-only, but the agent
  could have set them earlier); and a repo that opts in to
  `trustTestCommands` accepts that `npm test` & co. run repo code. The real
  bound remains Claude Code's own permission rules and the runner sandbox.
- **R5 — Desktop restart forgets the replay cache.** Mitigated because a
  settled request is gone (single-use) and decisions expire in ≤ 120 s.
- **R6 — Clock skew.** A phone clock more than ~2 min behind makes every
  decision arrive expired (fails safe, annoying). Desktop tolerates 30 s ahead.
- **R7 — ECDSA signature malleability** (`s` vs `n−s`) is harmless: replay
  identity is the nonce inside the signed payload, never the signature bytes.
- **R8 — Pairing code is 6 digits** (~20 bits), one typed try per pairing, and
  only useful to an attacker who already has the QR secret.
- **R9 — Audit trail is local** until the hub's card activity feed exists;
  events are hash-chained and forwardable as-is (no tool input). The chain
  detects edits/truncation in the middle, not deletion of the tail — anchor
  the head periodically on the hub.
- **R10 — Hook ack window.** The desktop waits ~1.5 s for `.taken`; a very
  slow machine reports `unknown` although the hook did act. Fails safe (the
  phone says "not applied — check at your desk").
- **R11 — Old hooks.** A hook installed before the per-request key writes no
  `decisionHash` and registers no key; the new app refuses to answer such
  requests from the widget or phone (the terminal dialog still works). The
  hook scripts are run from the app, so an app update updates them too.
- **R12 — Junk key registration only costs the widget.** Anything that holds
  the token can `POST /request-key` for ids of its choosing: fill the store
  (1024 keys, each kept ≤ 75 s), or guess an id first. Ids are random UUIDs
  the hook registers before the request file exists, so a guess never
  matches, and a full store or a taken id makes the hook's registration fail.
  Either way the hook writes no request and doesn't wait: the terminal prompt
  shows, as when the app is down. Never an allow; at worst the widget and
  phone can't answer until the junk expires.

## 9. Integration notes (for whoever wires this into the widget/hub)

1. Done in the widget: random ids, full input + hash in the request file, the
   link/ack answer protocol for the widget buttons (`src/signal-server.js`);
   no request at all for an unreadable payload; the hook's whole run fits in
   the installed 60 s timeout minus a 5 s margin; request files older than any
   live hook are swept. The widget strip shows the real command with a
   "+N chars" marker and a full, scrollable view, and a diff summary for edits
   (`src/request-view.js`). The MCP server is read-only: `buddy_answer_request`
   was removed (it could only ever approve *another* session's call).
2. The desktop identity key and registry: `node/file-store.js`
   (`~/.claude-traffic-light/remote/{identity,devices}.json`, 0600). macOS
   Keychain / Windows DPAPI for the identity key is a later hardening step.
   Resume the audit chain with `readAuditHead()`.
3. Remote answers must go through `RemoteApprovals.handleDecision` only; never
   add a hub endpoint that writes `.answer` files directly.
   Construct `WidgetRequestStore` in the app process with
   `keyFor: signalServer.keyFor`; without it every settle is refused (no key,
   no answer), which is the safe failure.
4. `repoLabels`, `cwd` for the allow-list, and the teammate list must come
   from desktop-side configuration, never from the hub or phone. The allow-list's
   `cwd` is the request file's, which `decisionHash` binds: an edited cwd makes
   the request unanswerable (the store drops it, or the hook, which holds the
   original hash, refuses the answer). Taking it from the session record instead
   would add nothing: `sessions/` is the same same-user-writable directory.
   `WidgetRequestStore`'s `describe()` can add card fields but can't override
   the input, owner or ids.
5. The hub's relay endpoint must be authenticated (Cloudflare Access / Tailscale
   identity) for DoS reasons, but **no security property here depends on it**.

## 10. Open items

- **O1** Teammate device certificates (§12.1). Not built; teammates off.
- **O2** PWA built and passkey wired as a required second factor (W2-B);
  the separate origin with CSP/SRI is still to do (owner-gated, `docs/PHONE-RUNBOOK.md`).
- **O3** E2E encryption of request notices (§12.2).
- **O4** Verify P-256 WebCrypto, non-extractable `CryptoKey` in IndexedDB, and
  platform passkeys (UV) on a real iOS 16.4+ home-screen PWA.

## 11. Decision record: R1 (who controls the signing code)

Decided after the first review (2026-09-30):

1. **The PWA is served from a separate static origin built from pinned
   releases** (e.g. a versioned static host the hub operator can't write). The
   hub is only a `connect-src` for that page: it never serves the document or
   the service worker. Strict CSP (`default-src 'none'; script-src 'self'`
   with SRI on every script, `connect-src <hub>`), no inline script, no
   third-party code. The desktop pins that origin.
2. **Every approval is also a WebAuthn assertion** from a user-verified
   platform passkey (Face ID / Touch ID) registered at pairing:
   `challenge = sha256(canonical decision payload)`. The desktop
   (`webauthn.js verifyAssertion`, built and tested) checks `type =
   webauthn.get`, challenge, origin ∈ pinned origins, not cross-origin,
   `rpIdHash = sha256(rpId)`, UP and UV flags, no attested data, sign count
   not regressing, and the ES256 signature (DER → r‖s) over
   `authenticatorData ‖ sha256(clientDataJSON)`.
3. Together: malicious JS on the PWA origin (1) can't be shipped by the hub,
   and (2) even if it runs, it needs a fresh user verification per decision
   and the OS prompt is tied to the pinned origin, so no silent batch signing.

W2-B wires (2): `RemoteApprovals` takes a `secondFactor` (`passkeyFactor` in
`webauthn.js`), the PWA registers a passkey right after pairing
(`verifyRegistration`, one per pairing, within 10 minutes) and every decision
carries an assertion (`src/remote-approvals-main.js`, `docs/PHONE-RUNBOOK.md`).
(1), the separate origin, is owner-gated and still open: until it exists the
hub serves the PWA and the passkey origin pinned is the hub's own.

## 12. Future designs (specified, not built)

### 12.1 Teammate device certificates
- Each member's desktop identity key is **pinned** by teammates out of band
  (fingerprint compared in person or over a trusted channel), never learned
  from the hub.
- A teammate's desktop issues **short-lived device certificates** (≤ 7 days):
  signed `{t:'buddy.devcert', deviceId, devicePub, name, issuedAt, expiresAt,
  seq}` by the teammate's pinned desktop key.
- **Signed revocations with a sequence number**: `{t:'buddy.devrevoke',
  deviceId, seq, at}`; the receiving desktop keeps the highest `seq` per
  issuer and rejects certificates at or below a revoked `seq`.
- The receiving desktop assigns **`ownerId` locally** from the pinned key
  (never from the certificate text or the hub), and the teammate must be on
  its local teammate list; then `makeOwnerPolicy({allowTeammates: true})`.

### 12.2 End-to-end encryption of request notices
- At pairing each device also creates a non-extractable **ECDH P-256** key and
  sends its public half in `pair-init` (covered by the MAC and signature).
- Per notice: the desktop makes an ephemeral ECDH key, derives
  `HKDF-SHA-256(shared, salt = random 32 B, info = "buddy.notice.v1" ‖ did ‖
  deviceId)` → AES-256-GCM key; encrypts the canonical notice with a random
  96-bit IV and **AAD = canonical {did, deviceId, requestId, expiresAt}**; the
  whole ciphertext envelope is signed by the desktop key. One ciphertext per
  device.
- Decisions stay signed plaintext (they carry only the hash). The hub then
  sees routing metadata only.
