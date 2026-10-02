# Darwin native interface source packet

This is a native library and fresh synthetic acceptance driver. It supplies full
snapshot/receipt codecs, private one-use journal gates, conditional local recovery,
a fixed app-store library and authenticated fixture frames. It does not install or
launch a helper, implement MAIN account/foreground checks, encrypt the Node journal,
expose Electron IPC, or enable Setups Apply/Undo. The existing Node transaction core
remains prepared-only. Windows and Linux implementation, remaining formats, missing
parents and explicit retained-snapshot management are still required.

The mutable-target scope remains the first three existing-parent recipes:
`.codex/AGENTS.md`, `.claude/settings.json`, `.gemini/settings.json`. A format adapter
must supply exact reviewed bytes; this packet does not parse or merge formats,
fill secrets or execute their instructions/hooks. The old `writer.h` prototype
functions are trusted native calls and are not dispatcher operations.

## Authority

An encoded/decoded `PFSnapshot` or `PFObservedReceipt` is data. It cannot construct
an opaque grant or live filesystem capability. Retained root descriptors establish
current canonical OS/profile and named ancestor bindings. Private dispatcher
constructors accept authority only on a fresh owned session, authenticated by an
HMAC key from a future MAIN-owned bootstrap. There is no public key setter, argv/env
bootstrap, path selector, hold adoption, command or renderer capability.

That session MAC identifies the trusted peer. It does **not** authenticate an app
journal, prove AEAD, verify provider identity or prevent a compromised same-UID
process reading process memory. The future private worker must verify AEAD, exact
transaction/selection/record chain and durable whole-selection snapshots. MAIN must
check fresh current actor/account/team/device/profile/repository/dialog generation
before each grant/permit, after asynchronous work and before displaying a projection.
These production responsibilities are not implemented or accepted by this packet.

A preparation grant binds one canonical v4 UUID, target index, recipe, plan,
before/after/ancestor hashes, prepared encrypted record hash, session generation,
nonce and absolute cutoff. It is consumed before attempting private staging and
cannot replace the target. The dispatcher admits only one preparation attempt per
session, including failed attempts. Apply requires a separate one-use permit for
that exact pending native intent, full stage digest and durable encrypted record.
Unknown fields/operations/schemas refuse. Invalid payloads terminate the session.

Recovery inspection requires a separately confirmed own-local context (`mode=2`),
same canonical OS/profile, authenticated old full before snapshot and observed
anchor, with old-account/dialog generations invalidated before unwrap/preview.
The native constructor reopens only the generated hold recorded in that
**authenticated** anchor and positively checks its descriptor/name identity,
empty ACL and full bindings; a recognizable name/checksum alone grants nothing.
Inspection creates no stage or intent and cannot authorize Undo. Restoration
staging additionally requires a distinct fresh confirmation bound to the exact
inspected receipt and authenticated record hash. A new durable encrypted intent
then precedes a separate one-use Undo permit. Attempts and earlier cutoffs cannot
be extended by retries. A completed Undo may be classified read-only; it cannot
be repeated. Already authenticated Undo staging can be rebound after a restart
only while its full current stage, installed/displaced objects and records match.
Unsealed native tail records are observational checksum data, never authority.

## Exact bytes and metadata

`SnapshotV1` uses explicit big-endian field encoding, not C padding or pointers.
It carries Darwin OS/architecture/ACL-format tags; fixed recipe; absent/regular tag;
canonical profile hash; stable ancestor permission/identity bindings; exact leaf
stamp, UID/GID/mode/flags; content/hash; supported raw native ACL; and exactly
`com.apple.provenance`/`com.apple.quarantine` presence/length/hash/raw bytes. Empty
values differ from absence. Unsupported format/architecture, unknown attributes,
unsafe ACLs, truncation and hash disagreement refuse. Supported raw ACLs are
bounded and structurally checked before the size-argumentless native ACL decoder,
validated by principal/rights policy and required to roundtrip exactly.

The digest domain is the ASCII `PF-SNAPSHOT-V1` **including its terminating NUL**,
followed by the complete canonical snapshot encoding. Binding hashes similarly
encode a 16-byte `PF-BINDINGS-V1` zero-padded domain and individually encoded
bindings. Directory size/mtime/ctime may change through admitted child creation;
permanent bindings retain device/inode/type/UID/GID/mode/flags/exact ACL hash, and
individual descriptor reads recheck full stamps. Existing safe read/deny grants on
ordinary target ancestors remain usable; safe but changed ACLs invalidate a
previous binding. Raw source/private values never become a renderer projection.

Full observed receipts include immutable native state and at most two objects:
actual installed plus actual displaced safe regular content, with exact raw
metadata. Nonregular/hardlinked/unsafe objects have identity-only or unavailable
content tags and are never traversed. Current binding failure withholds all bytes.
A refused preparation can still report a captured retained hold; no observed
identity is invented before first capture. Partial native state has phase zero
until preparation is established and cannot become recovery authority.

## Closed frame operations

Header: 8-byte `PFFRME02`, u16 version 2, u16 operation, 16-byte request nonce,
u32 sequence, u32 zero flags, u32 payload length. Payload is followed by a 32-byte
HMAC-SHA256 over `PF-CHANNEL-V1` including NUL, session nonce and header/payload.
Nonces are nonzero/unique, sequence starts at zero, and replies use operation OR
0x8000 plus the original request nonce/sequence. A reply body starts with u32
PFResult, u32 effects, u32 encoded body length. Effects: zero no target effect,
one observed target effect, two uncertain target effect, four possible private
staging/store effects. These describe observations, not physical-holder proof.

| Operation | Payload and result |
| --- | --- |
| 0x30 FullSnapshot | u32 recipe → u32 snapshot length + full snapshot |
| 0x31 Prepare | preparation fields + sized full-before + sized exact-after → sized preparation receipt + sized native intent; no target replacement |
| 0x32 Advance | exact permit fields → sized full Apply receipt |
| 0x33 Observe | empty → sized current writer/recovery receipt |
| 0x34 RecoveryInspect | fresh recovery fields + compact authenticated native anchor + sized full-before → sized read-only current receipt |
| 0x35 RecoveryRestore | phase 0 + fresh restore-confirmation fields → sized current receipt + sized native Undo intent; phase 1 + durable permit fields → sized conditional Undo receipt |
| 0x40 OpenFixed | empty → open/create fixed private store root |
| 0x41 List | empty → bounded count + opaque UUIDs; no decrypt |
| 0x42 CreateTxn / 0x43 OpenTxn | canonical UUID → exclusive create / current private open |
| 0x44 Read | fixed role/index/sequence → sized closed sealed-role blob |
| 0x45 WriteExclusive | fixed role/index/sequence + sized sealed blob → exclusive durable write |
| 0x46 Sync / 0x47 Close | empty → sync held transaction/root / close descriptors only |

The compact recovery anchor references old snapshots by authenticated hashes; no
third full snapshot is put into one frame. Codec field order is defined by the
private typed codecs. Public `pf_protocol_process` accepts only a complete bounded
frame, on an already privately bootstrapped opaque protocol. The private pipe loop
requires FIFO descriptors already nonblocking and supplied by a trusted owning
caller. It validates the declared header size before allocating/reading a body;
fragmented reads, responses under backpressure, EOF and cancellation share the same
absolute deadline. `F_SETNOSIGPIPE` prevents a closed output from killing the fixture.
FIFO type does not prove anonymous provenance: the future launcher must create and
own those pipes and prove the peer. No packaged launcher exists here. Windows peer
SID/process/pipe controls are a separate contract, not replaced by a MAC.

## Fixed private app store

The store is only `setups-transactions` under the retained app-data parent. It
accepts canonical v4 UUIDs and fixed role/index/sequence combinations, not arbitrary
names or caller paths. Root/transactions require current UID-owned0700, no flags,
positively empty ACL and same volume. Every file requires regular/single-link,
current UID-owned0600, empty ACL, no flags and exact opened/named identity. Reads
open NOFOLLOW|NONBLOCK before fstat, check EOF/exact bytes/current metadata and
bindings, then clear bytes read on failure. Creation/writes are exclusive; no
existing object/ACL is rewritten, no transaction is pruned, and partial effects
remain retained on failure.

Closed filenames are `manifest.sealed`, `targetNNN-{before,base,after,metadata}.sealed`
and `eventNNNNNN.sealed`. The schema-2 outer header is exactly 44 bytes: magic
`PFSEAL02`, schema/role/index/sequence u32, UUID16, body-size u32; its body remains
opaque to native code. Native checks closed roles/lengths, **not AEAD**. Fixture
ciphertext bytes are test injection only. The future worker must encrypt and
authenticate a binary body (including snapshots and exact ACL/xattr bytes), bind
these header fields as AAD, reject malformed/foreign chain/key records and preserve
schema-1 prepared-only recovery semantics explicitly. Native hashes/checksums are
not authenticated recovery and there is no plaintext or silent legacy fallback.

Writes fsync/F_FULLFSYNC the opened file, verify descriptor bytes/metadata, fsync
the directory and recheck bindings. Quotas sum logical sealed-file lengths,
conservatively bounding stored payload rather than claiming measured allocated
filesystem blocks. Sampling/admission is not atomic against another process.

| Bound | Limit |
| --- | --- |
| Content / raw ACL / fixed attrs | 256 KiB / 32 KiB / 8 KiB each, 16 KiB total |
| Bindings / full snapshot / full receipt | 64 / 320 KiB / 704 KiB |
| Frame payload / one-target aggregate | 768 KiB / 4 MiB including requests and responses |
| Frames / live target capabilities | 64 / one writer or one recovery; two roots, one retained snapshot |
| Native records / encrypted event roles | 8 native observations / 64 encrypted lifecycle roles |
| Store targets / children / transactions | 128 nominal targets / 512 children / 16 namespaces |
| Store transaction / total / blob | 64 MiB / 128 MiB / 704 KiB |
| Cutoffs | native 5s between-call budget; private session ≤8s absolute, all narrower grants/permits reduce it |

Worst-case reply/aggregate admission occurs before dispatcher effects. Whole-plan
worst-case record/byte admission and MAIN's8s child/60s automated total budget,
kill/reap, stale-generation withholding, authenticated sealing and private snapshot
retention remain production integration requirements. No bounds are reset by
progress. A nominal128-target count never overrides tighter byte/event bounds.

## Physical limits and acceptance

The independently reviewed empty-ACL hold policy remains intact. `mkdirat` has no
atomic created-inode result: an indistinguishable empty same-UID/empty-ACL
replacement before first capture can still be accepted. Safe foreign read/deny
ACLs refuse untouched. Checks cannot atomically freeze mutable permissions.
`RENAME_SWAP` is observed replacement without expected inode/hash CAS; a raced
foreign file/link/directory may move into the hold. All actual displaced objects,
stages, native records and old-open-fd variants remain retained. An old fd may
still modify the retained inode and invalidate conditional recovery. No cleanup,
blind swap-back, private-hold adoption or never-touched-foreign-namespace claim.
Synchronous kernel and DirectoryService calls cannot be preempted by this library;
future MAIN must own external process termination/reaping. A failure may follow an
actual filesystem effect and must remain uncertain until authenticated observation.
The earlier independent unclassified native assertion stop remains a reported
reproducibility limit; later successful declared fixtures do not relabel it a flake.

`interface-acceptance.c` uses only fresh canonical synthetic temporary profiles and
app roots. Its private factory/key injection is enabled only in the fixture build.
It covers actual raw ACL/xattr/CRLF/NUL roundtrips, immutable store/type/quota
boundaries, exact session/permit authority and retries, old-fd retention, full framed
Apply→fresh confirmed recovery→Undo, anonymous-pipe child deadlines/cancellation,
and actual child exits after namespace effects before receipt sealing. Production
objects omit PF_PACKET_FIXTURE/PF_WRITER_TEST_HOOKS and expose no fixture frame factory.

Compile each library module with existing official clang/SDK, C11,
Wall/Wextra/Werror/pedantic, macOS12 minimum for arm64 and x86_64; actual acceptance
is arm64 only on this host. No external libraries, installation or provisioning.
The library modules are reader, snapshot, writer, receipt, journal-gate, recovery,
store, protocol and protocol-transport. The fixture build additionally defines
PF_PACKET_FIXTURE and PF_WRITER_TEST_HOOKS and links interface-acceptance.c. Separate
original reader/ACL/writer drivers remain unchanged. Full independent source and
actual acceptance precede helper/build/MAIN/journal/UI enablement.
