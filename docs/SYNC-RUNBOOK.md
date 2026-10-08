# Sync runbook (encrypted sync across a user's own computers, W3-C)

The code for sync is in place but switched off. Every step below is
**OWNER-GATED**: it involves cloud storage, credentials, costs, legal text or
production infrastructure, so only the owner does it. No agent creates
buckets, keys or alarms, or deploys.

## What the code does today

- **Desktop** (`src/sync/`): `keys.js` (keyring, wraps, recovery code, blob
  sealing), `log.js` (the doc set and its op log: last-writer-wins per doc id
  under a Lamport clock, secret scrubbing, field allowlists, no transcripts
  unless a caller opts in), `client.js` (the `/api/sync` client),
  `index.js` (`register(ctx)` from `src/paid-wiring.js`: the Sync page's IPC
  and a 15-minute loop, only while sync is turned on here and signed in).
  The Sync page (`sync.html`) is listed under Settings once the entitlement
  key is pinned (same gate as Plan & billing), or with `PLEXIFORM_SHOW_SYNC=1`.
- **Hub** (`board/hub/sync.js`, `board/hub/sync-store.js`, migration
  `062_sync.sql`): devices and opaque key wraps, hub-signed upload tickets,
  the blob log with per-device cursors, quotas from the plan (3 devices,
  5 GiB per user; `SYNC_PLANS`, pinned equal to `src/entitlements.js` by a
  test), and the hourly sweep: plan lapse → read-only for 30 days with an
  email notice → every object and row deleted, with a second notice. Account
  deletion purges at the next sweep without a notice. With no
  `BOARD_SYNC_R2_BUCKET`, every sync route answers `METHOD_DISABLED`.
- **Object store**: `memoryStore()` (tests) and `R2SyncStore` (R2 through the
  S3 API, endpoint pinned to `*.r2.cloudflarestorage.com`, `IfNoneMatch` on
  put, one attempt per request). The SDK is loaded only when a bucket is
  configured; it is not a `board/` dependency.

## Security model (summary)

- The hub stores ciphertext, opaque wraps, device public keys and generic
  names, sizes, hashes, times, epochs and cursors. Never a key, the recovery
  code or plaintext (tests grep the hub DB, its logs, stored objects and mail).
- Keyring = every content-key generation + the trusted device public keys +
  the recovery public key, wrapped (ECDH P-256 → HKDF-SHA-256 → AES-256-GCM)
  to each trusted device and to the recovery key. Blobs: AES-256-GCM under
  HKDF(content key, random salt), AAD binds user, device and epoch.
- Recovery code: 160 random bits, shown once; `scrypt(code, user id)` seeds
  the recovery key pair. Losing every computer and the code loses the data.
- New computers join only when approved on a trusted one (compare the
  fingerprint both show) or with the recovery code. The hub can list a fake
  device key, but rotation only wraps to keys in the encrypted keyring.
- Revoking rotates: new content key, epoch + 1, rewrapped to the remaining
  devices and the recovery key; the hub refuses the revoked device and any
  upload under an old epoch. The revoked device keeps what it already had.
- Residual risks: metadata (sizes, timing, device count) is visible; a hub
  can withhold or replay blobs (merges are idempotent, nothing is forged);
  keys sit in 0600 files in the data folder, not the OS keychain; no forward
  secrecy for data at rest. **An independent security review is needed
  before launch**, as for W2-A.

## Owner-gated steps, in order

1. **Create the R2 bucket** (Cloudflare dashboard → R2): private, no public
   access, no custom domain, a jurisdiction/location hint that matches what
   `PRIVACY.md` will say (fill its `[Callum to confirm the R2 bucket's region…]`
   placeholder).
2. **Lifecycle rules** on the bucket: abort incomplete multipart uploads after
   1 day. Do **not** add an expiry rule on `sync/`: deletion is the hub's job
   (30 days after a lapse, with the email notice); an R2 expiry would delete
   paying users' data.
3. **API token** scoped to that bucket only, with Object Read & Write
   (includes delete). Note the account id, access key id and secret.
4. **Cost / quota alarm**: a Cloudflare billing notification on R2 storage
   (for example at 50 GB and 200 GB) and on Class A operations, so a bug or
   abuse that bypasses the per-user 5 GiB quota is noticed.
5. **Hub environment** on the production hub (secrets, never in the repo):
   `BOARD_SYNC_R2_BUCKET`, `BOARD_SYNC_R2_ENDPOINT=https://<account id>.r2.cloudflarestorage.com`,
   `BOARD_SYNC_R2_ACCESS_KEY_ID`, `BOARD_SYNC_R2_SECRET_ACCESS_KEY`. Install
   `@aws-sdk/client-s3` with the hub deployment (the offsite tooling already
   uses it). The hub refuses to start with a non-R2 endpoint or a missing key.
6. **Deploy migration 062** to the production hub (it runs at start) and
   confirm the Litestream/R2 database backup includes `sync_accounts`,
   `sync_devices` and `sync_blobs`.
7. **Mail**: lapse and deletion notices use the hub's configured mailer
   (Resend or SES). Check one of each arrives from a staging hub.
8. **Legal**: move the sync entries in `PRIVACY.md` from draft to shipped,
   fill the R2 region/transfer placeholder, and add Cloudflare R2 to the
   processor list.
9. **Security review** sign-off (see above) before the Sync page is listed
   (pinning the entitlement key lists it).
