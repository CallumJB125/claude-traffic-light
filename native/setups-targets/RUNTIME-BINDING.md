# Private Darwin runtime binding

This packet adds an uncalled, unpackaged helper entrypoint and private Node
composition. It does not enable app Apply/Undo, install a helper or alter profiles.
The old transaction-core and schema-1 store remain prepared-only. A complete
independent gate and a later main-process app packet are required before activation.

`bootstrap.c` accepts only a bounded PFBOOT03 binary envelope with two canonical
roots and their stamps, fresh key/session nonce, authority hash/generation, mode and
absolute budget. `helper.c` accepts no arguments and owns fixed child descriptors
0/1/3. Existing Node22 on Darwin creates connected anonymous AF_UNIX STREAM pairs,
not FIFOs. Each endpoint must have the captured spawning parent PID/current UID,
empty local/peer paths, O_RDWR, verified NONBLOCK and NOSIGPIPE. This narrow new
adapter preserves the inherited FIFO-only protocol transport. Neither socket type
nor checks claim descriptor-alias or same-UID memory-compromise resistance.

`native-supervisor.js` owns launch, HMAC session, outstanding request, backpressure,
absolute work/termination cutoffs and child close observation. Its constructor is
trusted main-only; `open` has no executable/argv/env/descriptor override. The
constructor supplies a fixed packaged identity in the later activation packet.
Sessions whose reaping cannot be proved block new writes and report reap_pending.
A child gets at most eight seconds including termination observation; the native
writer retains its narrower five-second between-call bound. Native clocks are
returned in the authenticated ACK; Node and native clock origins are not compared.

`native-store.js` opens only fixed native store operations through fresh short
owned sessions. All share the original automated cutoff. It has no Node target
writer, filename override, replacement rename, cleanup, adoption or pruning API.
Inventory operation 0x48 returns only current bounded logical sealed sizes and
closed role/index/sequence tuples. Native ownership/type/ACL/descriptor/name checks
apply, and refusal clears output. Admission is a conservative observation, not an
atomic reservation or physical disk-block guarantee.

The schema-2 journal authenticates role/transaction/profile/owner/plan/source
context and binary envelope header as AES-256-GCM AAD. Its manifest encrypts the
wrapped-key digest, binding wrapper provenance even when a substituted wrapper
would unwrap to the same key. The trusted wrapping adapter must use the existing
OS wrapping policy; Linux basic_text/plaintext must remain unavailable. No raw key
or decrypted content is accepted from an app caller. All selected exact before,
base, after and full native metadata records are sealed before the manifest is
published and before staging. Exclusive writes and native sync ACK precede grants.

The worker owns format/crypto computation and journal keys. Its typed jobs and
strict sequenced RPC proxy permit only each job's needed IO/wrapping operations;
responses are tied to the active job/current authority/absolute cutoff. Raw buffers
cross the thread boundary through separately owned transferred copies. The main
thread can terminate a worker even if a wrapping/IO promise ignores cancellation;
termination observation is required before a successful caller projection.

The asynchronous controller captures immutable exact source/principal/selection,
explicit code/instructions and replacement choices before awaits. Its trusted
observe/current-source callbacks fence account/team/member/device/profile/dialog
and foreground authority after each await, in the profile queue and before every
native request. Apply consumes the plan before queue/confirmation. Every preparation
receipt and full native intent is encrypted and synced before one exact native
permit; every observed and verified receipt is sealed before the next target.
Only whole-selection current verification reports verified. Authority loss withholds
caller data and stops further grants. Uncertain effects and private holds remain
retained; there is no automatic rollback or silent attempt renewal.

Restart listing/status disclose opaque locked IDs only. `recover` first invalidates
old handles and requires fresh own-local foreground confirmation before unwrap. It
checks the complete authenticated chain, closed lifecycle order, every selected
snapshot/hash/binding and exact native recovery anchors before reporting an opaque
inspection handle. Local previews remain withheld on restart. Actor null is allowed
only for own-local recovery, never online planning/Apply. `confirmUndo` consumes its
handle before a separate fresh inspection-bound confirmation, reauthenticates the
unchanged journal, re-inspects exact current receipts, durably seals the fresh
restoration intent, and issues one conditional permit. Changed/foreign/truncated or
unsealed state refuses and remains retained. No boot resume or old team restoration.

Supported mutable targets remain existing-parent `.codex/AGENTS.md`,
`.claude/settings.json` and `.gemini/settings.json`; none executes instructions,
hooks, tools, AI providers or package installs. Unsupported formats and missing
parents remain unavailable. Schema1 never grants schema2 mutation. Finite retained
history management, remaining formats, Windows/Linux native support, app UI/IPC,
trusted packaging/signing and real OS-wrapping acceptance are later required work.

The accepted physical limits remain: mkdirat does not return atomic created-inode
authority; mutable ACL windows; RENAME_SWAP without expected inode/hash CAS;
retained displaced/old-FD variants; nonpreemptible kernel/DirectoryService/OS-wrapping
calls; encrypted same-store chains without full antirollback. Runtime tests on this
Mac do not prove these limitations away or provide Windows/runtime acceptance.

Focused verification uses a helper compiled from production modules with existing
clang/SDK, strict C11/Wall/Wextra/Werror/pedantic and macOS12 minimum. Compile
helper.c and bootstrap.c together with reader/snapshot/writer/receipt/journal-gate/
recovery/store/protocol/protocol-transport; no fixture defines. Compile the separate
helper-acceptance.c in place of helper.c for inventory/bootstrap guard scenarios.
Run the four new tests with Node22 and PLEXIFORM_TEST_HELPER pointing to that owned
synthetic-test binary. That environment variable is test-only and is never read by
production code. Tests retain fresh synthetic roots/evidence; they never read
real HOME, run an AI CLI or alter a user profile.
