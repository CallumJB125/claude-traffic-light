# Darwin observed replacement prototype

This is a native source library with fresh synthetic filesystem fixtures. It is
not an installed helper, IPC transport, Node mutator, Apply/Undo UI, renderer
capability, account integration or enabled feature. The encrypted app journal
remains prepared-only. Main must separately bind current actor/account/team/
device/profile generation, a validated immutable format plan and authenticated
encrypted full-set snapshots before any future app binding.

`writer.h` takes only a retained reader root, three enum recipes, previously
observed metadata and exact before/after bytes. It returns an opaque, serialized
single-attempt capability. The private reader bridge duplicates every retained
root descriptor, captures the existing fixed parent and reuses the independently
reviewed current-binding and Darwin ACL checks. Closing the original reader root
does not invalidate the writer's retained copy. No generic path, parent creation,
caller-owned hold, shell command, URL or downloaded selector is accepted.

The three supported paths are `.codex/AGENTS.md`, `.claude/settings.json` and
`.gemini/settings.json`. Missing parents and every other recipe refuse. The
native primitive does not merge, parse or sanitize content; the trusted format
adapter must supply already validated exact bytes. Fixtures prove persistence of
those exact CRLF/foreign ranges, not an independent implementation of JSON merge
or a grant to execute the resulting instructions/hooks.

Preparation rechecks exact existing bytes/stamp or an absent leaf, then creates
an exclusive random directory under the captured profile on the same volume.
It is 0700 with an empty descriptor ACL; only this newly created owned directory
has its inherited ACL removed. Existing profile, target parent and target ACLs
are never weakened. Before/after snapshots and staged bytes are declared private
plaintext recovery surfaces, separate from encrypted app snapshots. A staged
0644 approved target stays inside that private directory. Mode, group and safe
extended ACL are preserved for existing targets. Only `com.apple.provenance` and
`com.apple.quarantine` attributes are supported, each capped at8192bytes and
16384bytes total. Closed names/order, presence, length and hashes bind exact
descriptor-read opaque bytes through before/stage/observed/Undo metadata.
They are not parsed or equated with trust. Nothing is stripped: a new stage
with an unwanted automatically assigned attribute refuses rather than removing
it to force an expected absence. Additional attributes, errors, truncation,
changes, special mode bits/file flags and unsupported metadata refuse rather
than being silently discarded. Future authenticated encrypted snapshots must
also preserve these exact attribute bytes; native hashes cannot recover them.
After writing and applying metadata, the opened stage must still exactly match
the approved mode, group, flags, ACL and attributes, plus original mtime for Undo.
A safe but different permission grant or timestamp cannot silently become the
approved stage merely because its descriptor remains valid.

Stage files are created exclusive/no-follow/nonblocking. The opened inode is
retained through exact named/descriptor/bytes verification. Every native intent
and observation is an immutable, exclusive fixed-size record with schema,
sequence, recipe, captured/actual identities, hashes, phase and a checksum.
Records contain no file content, external paths, commands or provider material.
File `fsync` plus Darwin `F_FULLFSYNC`, directory `fsync` and current-binding
checks precede the next effect. These records are OS-protected observations and
incomplete-write detection; their unkeyed checksum is **not authentication**,
encryption or a replacement for the app journal. There is no reopening/adoption
or automatic crash recovery mutation API. The in-memory capability rechecks
its captured exact snapshot/record metadata and hashes before subsequent writes.
Fresh directory creation is observed through a captured named identity,
matching opened descriptor, empty-directory check and fresh full metadata/
current-binding checks before any ACL update. Unexpected contents or a retarget
after capture refuse without changing the ACL or those contents. POSIX `mkdirat` does not return
an inode capability atomically: replacement in the gap before the first identity
capture cannot be distinguished from the just-created directory. The generated
random name is never supplied/adopted by a caller; this is an observed filesystem
boundary, not protection against a malicious same-UID process controlling the
profile namespace or a claim of immutable permissions.

Apply writes durable intent, rechecks the current expected target and uses only
descriptor-relative `RENAME_EXCL` for an absent leaf or `RENAME_SWAP` for an
existing leaf. No ordinary replacing-rename fallback exists. The actual
displaced object remains inside the hold. Open/read checks reject links,
directories, FIFOs, sockets, hardlinks and unsafe metadata without traversing or
serializing them. Their actual identity/type can be reported to the trusted
native caller; their names/inodes are retained. Current target bytes/identity,
approved metadata and complete root/parent/private hold bindings are checked
after the effect. Unknown completion or failed sync/receipt is an uncertain
result, not proof that nothing changed.

`RENAME_SWAP` has no expected-inode/hash argument and can exchange different
types. A racer can move a foreign file, link or directory into the hold during
the syscall gap; that observed conflict is recoverable, but its namespace was
temporarily touched. This is not atomic content CAS, a global editor lock or a
promise that a foreign namespace never changes. Changed ancestor/root/ACL
bindings stop subsequent effects; retained descriptors do not redirect writes
into a replacement directory. An in-place ctime change cannot be distinguished
from rename's ctime update at the swap boundary; receipts bind actual observed
metadata and compare inode/content/mode/group/ACL/mtime after a move.

Undo has one separate attempt and requires the installed after object to match
the actual accepted stamp/bytes/metadata, plus unchanged retained snapshots,
records and original displaced object. Existing Undo stages the exact before
bytes and original metadata, writes intent and swaps. New-file Undo moves the
actual leaf into an exclusive hold name; it does not check then unlink. The
newly displaced actual object is verified. A foreign race yields retained
conflict, never blind swap-back or success. Close releases descriptors and
clears memory; it never deletes stages, snapshots, native records, displaced
objects or old-fd variants.

An editor holding the original fd can continue modifying the retained inode.
Check and Undo observe that conflict; snapshot-copy plus unlink is not used to
discard later edits. The prototype has no automatic hold retirement/pruning,
directory cleanup, cross-process lock or recursive foreign-object scan. Admission
caps are 256KiB per planned file, 32 matching hold names per profile, 4096 scanned
root entries and eight native records per transaction. A raced foreign directory
can contain arbitrarily many bytes; retention is bounded by admission counts,
not a false bound on all foreign directory storage. A full finite retention
policy remains a separate product requirement.
Each hold-admission scan opens its own directory description relative to the
retained profile descriptor. It does not duplicate/share a previously exhausted
directory cursor. The admission count is an observation under caller
serialization; it is not an atomic cross-process quota.

The five-second monotonic budget is checked between synchronous calls. Kernel
I/O, flushes and DirectoryService cannot be preempted here. A separately reviewed
main-owned bounded child/private pipe with deadline/kill/reap and stale-generation
withholding is required before enabling this primitive. Caller serialization is
required; the opaque C capability is not safe for concurrent close/use.

Build only with the existing official SDK/C11 clang and macOS12 minimum. Linux
and Windows return `unsupported`; they need their own rooted writer acceptance.
Production builds omit `PF_WRITER_TEST_HOOKS`. The actual fixture driver enables
closed barriers for late target/parent/root/ACL/old-fd/Undo changes and process
exit at durable intent boundaries, and closed fault points for write/flush/
record/rename refusal. Injected failures are counted separately from kernel
races. Fixture ACL cleanup applies only to the driver's own fresh synthetic
trees after assertions; the library has no cleanup/removal API.

```sh
/usr/bin/clang -std=c11 -Wall -Wextra -Werror -pedantic \
  -arch arm64 -mmacosx-version-min=12.0 -c native/setups-targets/writer.c -o work/writer-arm64.o
/usr/bin/clang -std=c11 -Wall -Wextra -Werror -pedantic \
  -arch x86_64 -mmacosx-version-min=12.0 -c native/setups-targets/writer.c -o work/writer-x86_64.o
/usr/bin/clang -std=c11 -Wall -Wextra -Werror -pedantic \
  -mmacosx-version-min=12.0 -DPF_WRITER_TEST_HOOKS \
  native/setups-targets/reader.c native/setups-targets/writer.c \
  native/setups-targets/writer-acceptance.c -o work/writer-acceptance
work/writer-acceptance
```

This source stage must receive exact complete independent review and actual
kernel acceptance before app/transport/journal bindings or release claims. The
official installed SDK `rename(2)`, `sys/stdio.h`, `fcntl(2)`, descriptor ACL and
`acl_copy_ext(3)` manuals define the primitives and explicit limits above.
