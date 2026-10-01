# Private paired off-site recovery

This operator tool transports an existing verified paired backup to private R2 object storage and reconstructs it in a **new directory**. It uses the unchanged `../pi/backup-lib.mjs` snapshot, validation and restore contracts. It has no scheduler, cloud provisioning, bucket controls, public links, remote deletion or live cutover path. Source and loopback acceptance do not establish a deployed off-site backup.

After client artifact uploads, recovery requires the matching database **and all immutable artifact versions referenced by that database**. Database replication alone cannot recover those bytes. Matching code, environment and secret keys remain independently escrowed; this tool never reads or uploads `hub.env`.

## Runtime and private authority

Use Node 22 and the separately locked `package.json` / `package-lock.json` in this directory. Provision its dependencies in a dedicated deployment cache with `npm ci --ignore-scripts`; link that cache here if needed. Never run installation through a shared application `node_modules` link. See [PROVENANCE.md](./PROVENANCE.md) for the exact verified SDK and age release used in local acceptance. Linux deployment needs its own architecture-matching, officially verified age binary; the recorded Darwin binary is for local acceptance.

The uploader holds an age **public** recipient, a private Ed25519 signing key and bucket-scoped object credentials. The independently escrowed recovery identity and trusted public signing keys must be available on the recovery host. A downloaded bundle cannot choose its own trusted key. Keep old identities/public verification keys until the corresponding retained backups expire. The recovery credential should be read-only and separate from the uploader credential.

All config/key files must be regular private `0600` files, with no final symlink. Outbox/recovery parent directories must be `0700`, normalized absolute paths with no symlink ancestors. age is invoked only through an operator-configured trusted absolute executable, with no shell, native X25519 recipient/identity and no plugin or SSH keys. Do not point these commands at application renderer state or real user dotfiles.

## Configuration

Create private JSON configurations under operator control. There is no committed live configuration or credential template. Keys are closed: unknown fields fail.

| Field | Used by | Value |
| --- | --- | --- |
| `installation_id` | every command | Stable lowercase UUID, independently known on recovery host |
| `outbox` | prepare/upload/fork/prune | Private absolute persistent directory |
| `trusted_signing_keys` | every command | Map of key identifiers to private-mode public Ed25519 PEM paths; at most 16 |
| `signing_key_id`, `signing_private_key` | prepare/fork | Pinned identifier and private Ed25519 PEM path; private/public pair must agree |
| `recipient_id`, `public_recipient` | prepare | Nonsecret escrow identifier and native age public recipient |
| `age_executable` | prepare/retrieve | Trusted absolute verified executable |
| `recovery_identity` | retrieve only | Private native age identity file, independently escrowed |
| `storage` | upload/retrieve/prune | `{endpoint,bucket,accessKeyId,secretAccessKey,sessionToken?}`; credentials remain inside private config |
| `policy` | optional | Reduced finite limits described below |

The production adapter accepts only the authenticated HTTPS account R2 S3 origin (`<32-hex-account>.r2.cloudflarestorage.com`, optionally an R2 jurisdiction), with no userinfo, port, path, query or fragment. It fixes region `auto`; it exposes only conditional `PutObject` and `GetObject`. The CLI cannot enable the loopback adapter used by tests. No arbitrary return/download URL or browser credential is accepted.

## Explicit commands

Use the installed Node 22 path and the absolute `cli.mjs` path. The following operands are descriptions, to replace with private operator-owned paths/IDs; no credentials belong in command arguments.

```
node cli.mjs --prepare UPLOADER_CONFIG EXISTING_VERIFIED_PAIRED_BUNDLE
node cli.mjs --upload UPLOADER_CONFIG TRANSPORT_UUID
node cli.mjs --fork UPLOADER_CONFIG TRANSPORT_UUID
node cli.mjs --retrieve RECOVERY_CONFIG TRANSPORT_UUID NEW_DIRECTORY
node cli.mjs --prune UPLOADER_CONFIG TRANSPORT_UUID
```

`--prepare` verifies and copies the paired snapshot into its own private working directory, splits the database into bounded chunks, encrypts those chunks/artifacts/manifest, fsyncs ciphertext and directories, removes the temporary plaintext, and publishes `ready.json` last. Only referenced immutable bytes enter the set. It returns the random transport UUID, original snapshot time and object count. Retaining the outbox makes upload independent of later local backup retention.

`--upload` holds a single outbox lock and reuses the exact prepared ciphertext. Remote keys are `paired/v1/<installation>/<transport>/<ordinal>.age`, `manifest.age` and `completion.json`. The signed completion descriptor binds the namespace and the encrypted manifest, which binds the exact ordered file/chunk mapping. Only opaque UUIDs, times, sizes/hashes and signing identifier are outside encryption. No account, team, repository or artifact narrative is in remote object names.

Every object is conditionally created with `If-None-Match: *` and read back with bounded length and SHA-256 checks. Existing identical bytes resolve uncertain/lost responses; different bytes fail without overwrite. ETags are not used as SHA-256. The completion descriptor is published last, after all data and encrypted-manifest readbacks. A durable local `receipt.json` follows only its exact readback. Authentication/schema/signature/byte errors are not retried. Network/429/5xx/conditional conflicts have at most three bounded attempts. Socket/stream requests and age processes have deadlines; SIGINT/SIGTERM close active runtime resources and leave crash recovery to the next invocation.

An unfinished namespace expires 24 hours after its first upload attempt; clock rollback refuses publication. `--fork` is an explicit fresh UUID/signature using the retained exact ciphertext and original snapshot time. The encrypted inner manifest is namespace-independent, so its exact bytes can be retained; the fresh signature binds the new namespace. The old pending set is kept. A completed retry only rechecks remote bytes; it never recreates a missing old object or treats a stale receipt as current authority.

`--prune` is **local-only, explicit cleanup of one selected completed outbox**. It requires a matching local receipt and freshly verifies the signed remote completion plus every encrypted object before removing that entire local set. It cannot prune pending or damaged remote sets; it never PUTs or deletes remote bytes. Other outboxes and original paired backups remain intact. Do not remove pending data to hide quota/failure alerts.

`--retrieve` fetches a bounded completion and verifies the externally pinned signature/expected namespace before trusting the manifest. It checks/decrypts every bounded ciphertext, rejects extra/missing/reordered or arbitrary file mappings, verifies complete database/artifact hashes, publishes the original manifest last, and calls `validateBackup`. Output is a **new verified paired bundle**, not a running hub. Wrong key, corruption, missing/oversized/slow stream or failed write leaves no complete destination. Existing destinations are refused, including concurrent reservations. Cleanup removes only this operation's new temporary directory.

## Limits, failure and retention

Default hard caps: database 4 GiB, artifact 8 MiB, 10,000 artifacts, internal manifest 16 MiB, total plaintext 8 GiB, persistent outbox 32 GiB, database chunk 16 MiB, and 10,256 data objects. Ciphertext has a small bounded age framing allowance. Policy may reduce these limits, never increase them or truncate data. Budget is checked before copying; upload/prune reserve a readback/state rewrite. Streams and actual decrypted bytes are checked again. One transfer runs at a time.

Commands print metadata JSON to stdout and sanitized error codes to stderr; provider responses, tool text, headers, private paths, keys and source bytes are omitted. Node 22 may also emit its generic SQLite experimental warning. A receipt states what was confirmed at its recorded time; it does not promise those objects remain present forever.

The outbox lock has a private PID/token record. Only a known dead owner can be reclaimed automatically; an unknown owner or interrupted `.reaper` requires explicit operator diagnosis. Incomplete preparation without `ready.json` cannot upload. After confirming no live job, operators can move an incomplete set to private quarantine; do not publish it. Pending valid sets remain until retry/fork/operator resolution. If budget is full, stop and report failure, then resolve/prune completed sets deliberately. Never silently evict pending recovery data or prune in parallel outside the tool.

ROOT/operator must independently configure a dedicated private bucket, public access/custom domains/r2.dev disabled, no browser CORS, restricted credentials and private key escrow. The proposed initial **35-day R2 bucket lock and 90-day lifecycle are future deployment settings**, not implemented or implied by this source. A 24-hour initial publication window yields at least 34 days of common initial lock coverage **only when that 35-day policy is actually configured**. Conditional writes and bucket locks are separate controls. Ordinary R2 object credentials are not intrinsically deletion-proof; account/control-plane compromise can change lock policy. Existing local 14-set paired retention and Litestream remain separate.

## Production recovery gate

Before claiming live off-site recovery, ROOT must provision/verify the actual policy and run an independently evidenced download/decrypt/validate drill from the real private bucket, after removing the drill's original local source/outbox. Check exact artifact SHA and its corresponding database approval/version record. Successful upload, HEAD, ETag or database-only restore does not satisfy this gate.

For a live cutover, ROOT/operator prepares a new working set with `stageRestore`, stops **hub and Litestream**, preserves failed data, swaps database **and** artifact directory together, restores matching code/environment/secrets/ownership, uses `BOARD_RESTORE=1` once, then verifies epoch/fences, sign-in, assigned client download and exact approval behavior. This CLI does none of those live actions.

## Local acceptance

Use the provisioned verified age/age-keygen absolute paths through `OFFSITE_TEST_AGE` and `OFFSITE_TEST_KEYGEN`, then run Node 22:

```
node --test --test-concurrency=1 board/deploy/offsite/test/*.test.mjs board/deploy/test/backup.test.js
```

The genuine age/SDK tests use temporary fixture keys, real WAL SQLite and loopback synthetic S3 only. They recover approved bytes/database after deleting the original bundle and outbox. Without both age paths, genuine tests are reported skipped: that is not complete acceptance. Fault tests additionally cover forged and correctly signed malformed manifests, fixed-path/chunk checks, overflow/stalls, interrupted/lost writes, restart/fork, source-retention races, private modes/symlinks, fsync failure, lock ownership, local confirmed-only pruning and child error/timeout/overflow. No Electron, model calls or external credentials are involved.
