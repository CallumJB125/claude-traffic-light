# Buddy on your phone — remote approvals threat model (F6 security core)

Scope: approving or denying a Claude Code permission request (the blocking
`PermissionRequest` hook) from a phone, through the team hub, without the hub
being trusted. This covers pairing, signed decisions, the remote deny-list and
the relay contract in `remote/src`. The PWA UI, hub endpoints, Web Push and
Slack buttons come later and must follow this document.

Status: design + reference implementation, **not yet independently reviewed**.
Ground rule: nothing that approves actions remotely merges before an
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
both screens    SAS = 6 digits of H(pid, did, dpk, devicePub, nP, nD)
desktop UI      human confirms "codes match" → registry.add(device)        (local only; not reachable via the relay)
desktop → phone pair-complete  {pid, did, devicePub, deviceId, ownerId}    sig_desktop
```

Single-use, 3-minute expiry, at most 4 open pairings, every failure burns the
pairing. The QR secret is read optically and never crosses the hub.

**Decision** (`decision.js`, `approvals.js`):

```
desktop → phone buddy.request  {did, requestId, sessionId, cardId, toolName, toolInput, toolInputHash, cwd, repoLabels, deskOnly, issuedAt, expiresAt}  sig_desktop
phone → desktop buddy.decision {aud=desktopId, requestId, sessionId, cardId, toolName, toolInputHash, decision, deviceId, issuedAt, expiresAt(≤120 s), nonce}  sig_device
desktop → phone buddy.result   {did, aud=deviceId, requestId, nonce, status applied|rejected, decision, reason, at}  sig_desktop
```

The phone computes `toolInputHash` itself from the input it displays; it never
signs a hash it was handed.

Desktop verification order (first failure wins, every outcome audited):
shape/size → `aud` → device known & not revoked → signature → expiry sanity
(TTL ≤ 120 s, ≤ 30 s future skew, not expired) → nonce unused (replay cache) →
request still pending with matching sessionId/cardId/toolName → SHA-256 of the
pending request's canonical tool input equals the signed hash → injected
policy (session owner; card assignee on runner sessions) → **allow only:**
deny-list → first-wins settle.

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
- **B4 desktop app ↔ waiting hook**: local filesystem (`~/.claude-traffic-light/requests`),
  same-user trust. A local attacker running as the user is out of scope (they
  can already answer the hook or run the tool themselves).

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
  swap to the phone and the SAS differs on the two screens; commit/reveal
  stops SAS grinding.
- Confirm a pairing: confirm is only callable from the local desktop UI.
- Fake success to the phone: only a desktop-signed `applied` result bound to
  this requestId + nonce counts. Offline, timeout or an unsigned "ok" is shown
  as **not applied**.
- Get anything on the deny-list approved remotely.

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
| S2 | Spoofing | Relay MITM during pairing registers attacker key | HMAC with optically-shared secret; device proof-of-possession; desktop-signed challenge binding the received key; SAS on both screens + human confirm on desktop; commit/reveal against SAS grinding (`pairing.js`) |
| S3 | Spoofing | Hub impersonates the desktop to the phone (fake challenge / completion / notice / result) | All desktop→phone messages signed by the desktop key pinned from the QR; QR `did` must equal fingerprint(`dpk`) |
| S4 | Spoofing | Teammate's device acts on the owner's interactive session | Injected policy `ownerOrAssignee`: owner always; assignees only when `runner === true`; throws → deny (`approvals.js`) |
| T1 | Tampering | Hub edits a decision (deny→allow, other request) | Signature over canonical bytes; exact key set; non-canonical payloads rejected |
| T2 | Tampering | Tool input changes between prompt and decision (TOCTOU) | Decision binds SHA-256(canonical input); desktop recomputes from the pending request at apply time |
| T3 | Tampering | Hub alters what the phone displays | Desktop-signed `buddy.request`; phone recomputes the hash from the displayed input before signing |
| T4 | Tampering | Parser differentials (duplicate keys, number forms) | Canonical round-trip check; strict JCS subset; schema with exact key set |
| T5 | Tampering | Registry / identity files edited | 0600 files in 0700 dir; a corrupt registry fails loudly. Local same-user attacker out of scope |
| R1 | Repudiation | "I never approved that" / who approved | Audit event per outcome (applied and every rejection) with deviceId, device name, owner, requestId, card, tool, input **hash**, reason, rule; signed decision can be retained as proof |
| I1 | Info disclosure | Request content visible to the hub | Accepted for v1 (R3); audit logs carry only the hash |
| I2 | Info disclosure | Pairing secret leaks via the hub | Secret never sent; only HMAC tags cross the hub (tested) |
| D1 | DoS | Hub drops/delays; burns pairings; floods desktop | Desk path unaffected; phone shows "desktop offline — not applied"/"unknown"; envelope ≤ 4 KB; replay cache bounded and fails closed when full; ≤ 4 open pairings |
| E1 | Elevation | Remote approval of destructive actions | Remote deny-list evaluated on the desktop against the verified input: destructive shell, force push/delete of protected branches, credential/agent-config paths, files that later run code (hooks, shell rc, CI workflows), prod-labelled repos → "approve at your desk" |
| E2 | Elevation | Replay of a captured approval | Per-device nonce cache until expiry+skew; requests single-use (first-wins); `aud` binding; TTL ≤ 120 s |
| E3 | Elevation | Revoked/stolen device keeps acting | Revoke one / revoke all on the desktop, effective immediately and offline (local registry) |
| E4 | Elevation | Concurrent answers (desk, phone, teammate) both applied | First-wins settle; the file adapter uses `O_EXCL` on the `.answer` file |

## 7. Actor-by-actor

- **Owner:** mistakes are bounded by the deny-list and a short TTL; the phone
  shows desktop-signed content, so what they read is what's pending.
- **Teammate:** only card assignees on runner sessions (policy injected, so
  the board decides). How a teammate's device key reaches the runner owner's
  desktop is **not built yet** (see O1) — it must not be trust-on-first-use
  via the hub.
- **Hub operator / compromised hub:** §5. The only way past the model is R1.
- **Network attacker:** strictly weaker than the hub (TLS + all of §5).
- **Stolen phone:** can sign decisions while the phone is unlocked and the PWA
  is logged in. Mitigation: revoke from the desktop (tray action, works
  offline), short TTL, deny-list. Residual R2.
- **Malicious PWA update:** R1.
- **Prompt-injected agent:** can craft a command that reads benign; the phone
  shows the full input, the deny-list catches the known-dangerous shapes, and
  the hash binding stops a switch after display. Residual R4.

## 8. Residual risks (accepted or open)

- **R1 — The PWA's origin controls the device key.** Non-extractable keys can't
  be stolen, but JS served from the PWA origin can *use* them: a malicious
  update (from a compromised hub, if the hub serves the PWA) could show one
  thing and sign another. This defeats "the hub can't forge approvals" whenever
  the hub also serves the PWA. Mitigations to decide before F6 ships:
  (a) serve the PWA from an origin the hub operator doesn't control (a pinned,
  versioned static release; the hub only relays); (b) move the device key to a
  **WebAuthn passkey** (user verification per signature, platform-held key,
  `clientDataJSON.challenge` = hash of the decision) — still origin-bound but
  every signature needs Face ID/Touch ID, so no silent batch signing;
  (c) native app (F6 v2). The deny-list and desktop-side checks still bound
  what any forged "allow" can do.
- **R2 — Stolen unlocked phone** can approve non-deny-listed requests until
  revoked. Consider an in-PWA re-auth (WebAuthn user verification) for allow.
- **R3 — Hub sees request content.** Commands and `Write` contents can contain
  secrets. Planned: E2E-encrypt notices to device keys (add a P-256 ECDH key at
  pairing; AES-GCM). Until then, keep the hub Tailscale-only (ground rule) and
  consider sending only a summary + hash for large inputs.
- **R4 — The deny-list is regex over free text**, not a sandbox. Obfuscation
  (`r''m -rf`, `$(printf rm)`, aliases, scripts written then run, `npx some-pkg`
  doing damage) can dodge it. It's a net for the obvious, not a guarantee;
  the real bound is Claude Code's own permission rules + the board runner's
  sandbox profile. Force-push detection parses the command line and errs to
  "force" when it can't tell the target branch.
- **R5 — Desktop restart forgets the replay cache.** Mitigated because a
  settled request is gone (single-use) and decisions expire in ≤ 120 s; a
  replay would need the *same* request still pending across a restart, and
  then it's the same decision the device already signed. Persist the cache if
  that ever changes.
- **R6 — Clock skew.** A phone clock more than ~2 min behind makes every
  decision arrive expired (fails safe, annoying). Desktop tolerates 30 s ahead.
- **R7 — ECDSA signature malleability** (`s` vs `n−s`) is harmless: replay
  identity is the nonce inside the signed payload, never the signature bytes.
- **R8 — SAS is 6 digits** (~20 bits). With commit/reveal the attacker gets
  one online guess per pairing (≈ 1e-6), and only if it already has the QR
  secret.
- **R9 — Audit trail is local** until the hub's card activity feed exists;
  events are designed to be forwarded as-is (they contain no tool input).

## 9. Integration notes (for whoever wires this into the widget/hub)

1. `hooks/set-status.js` PermissionRequest must also write the **full
   `toolInput`** (not just the 200-char summary) into `requests/<id>.json`.
   `WidgetRequestStore.get` returns null for requests without it, so remote
   answers fail closed until that's done. The file should be 0600.
2. The desk answer path (`src/signal-server.js answerRequest`) writes the
   `.answer` file with a plain overwrite. Switch it to `{ flag: 'wx' }` so desk
   vs phone is first-wins too (the remote side already uses `wx`).
3. The desktop identity key and registry: `node/file-store.js`
   (`~/.claude-traffic-light/remote/{identity,devices}.json`, 0600). macOS
   Keychain / Windows DPAPI for the identity key is a later hardening step.
4. Remote answers must go through `RemoteApprovals.handleDecision` only; never
   add a hub endpoint that writes `.answer` files directly.
5. `repoLabels` must come from desktop-side configuration (never from the hub
   or the phone). Default rules treat `prod`/`production` as desk-only.
6. The hub's relay endpoint must be authenticated (Cloudflare Access / Tailscale
   identity) for DoS reasons, but **no security property here depends on it**.

## 10. Open items

- **O1** Teammate device keys: distribute via certificates signed by the
  teammate's desktop identity, with that desktop key pinned out-of-band
  (fingerprint compare), plus signed revocations. Not built.
- **O2** R1 decision: PWA origin separation and/or WebAuthn device keys.
- **O3** E2E encryption of request notices (R3).
- **O4** Verify P-256 WebCrypto + non-extractable `CryptoKey` persistence in
  IndexedDB on a real iOS 16.4+ home-screen PWA.
