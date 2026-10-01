# Darwin fixed-target reader

This is a source library and synthetic acceptance driver. It is not an installed
helper, app binding, mutation adapter or enabled Setups feature. No IPC, process
launcher, target writer, rename, Apply/Undo or account/provider integration is
added. Windows directory operations remain in `native/windows-private-directory`;
Linux and Windows calls here return `unsupported`.

A trusted native caller passes an already canonical absolute profile root, owned
by the current uid, and optionally its previously captured identity. Opening `/`
and each single component retains up to 64 directory descriptors. Every operation
checks that the original parent/name bindings still reference those descriptors.
The root must be on a local filesystem and must not be writable by another uid.
An OS alias such as `/tmp` must be canonicalized by the trusted caller first;
child links are never followed. This API must never accept renderer/downloaded
paths, argv, URL, shell or command input.

Eight enum recipes match the existing closed transaction registry:

| Enum | Recipe ID | Relative file |
| --- | --- | --- |
| CODEX_INSTRUCTIONS | codex-instructions-v1 | `.codex/AGENTS.md` |
| CLAUDE_SETTINGS | claude-settings-v1 | `.claude/settings.json` |
| GEMINI_SETTINGS | gemini-settings-v1 | `.gemini/settings.json` |
| CODEX_CONFIG | codex-config-v1 | `.codex/config.toml` |
| GIT_CONFIG | git-home-config-v1 | `.gitconfig` |
| GIT_XDG_CONFIG | git-xdg-config-v1 | `.config/git/config` |
| GHOSTTY_CONFIG | ghostty-xdg-config-v1 | `.config/ghostty/config` |
| GHOSTTY_DARWIN_CONFIG | ghostty-mac-config-v1 | `Library/Application Support/com.mitchellh.ghostty/config` |

The trusted caller must serialize each root lifetime; closing it concurrently with
a read is not supported. There is no generic relative path operation. An unknown enum refuses. Intermediate
single components use descriptor-relative directory/no-follow/close-on-exec opens;
owned children and final files must retain the profile volume. Final opens also
set nonblocking **before** `fstat`, preventing a regular→FIFO race from hanging
before type validation. Opened files must be regular, current-user-owned, singly
linked and not foreign-writable. Named/opened device/inode, owner/mode, link count,
size and modification/change timestamps must agree before and after reads.

`inspect` returns only fixed metadata. `read` requires the caller's previously
observed file stamp, caps encoded bytes at 256 KiB (caller capacity can be smaller),
checks EOF without truncation and rechecks the complete path chain. Changed or
invalid output has size/stamp zero; bytes read during a failed observation are
cleared. Results are closed reason enums; there is no content/path logging. Future
main-only private-pipe operation IDs 0x20 inspectFixedTarget and 0x21 readFixedTarget
are reserved, disjoint from Windows 0x10/0x11; no transport is implemented.

This is an observed read, not content-hash CAS, a filesystem snapshot, global
editor lock, or mutation authority. Main must compare its expected content hash
and captured account/profile generation before consuming the bytes. External
in-place writers can race after the final check. The one-second monotonic budget
is checked between local regular-file syscalls; synchronous kernel I/O itself
cannot be preempted by this library. A future separate bounded helper process/pipe
must enforce the whole-operation deadline before app enablement. Moved roots and
ancestors invalidate named bindings, while retained descriptors do not redirect
into replacement directories. No file is restored or removed on any refusal.

Build with the existing official Xcode clang/SDK, C11 and macOS 12 minimum; no
third-party dependency. Production builds do not define PF_READER_TEST_HOOKS.
Only the synthetic driver build enables the closed four syscall barriers so
actual FIFO, directory, parent/root retarget, inode replacement and in-place
write races occur at their relevant syscall boundaries.

```sh
/usr/bin/clang -std=c11 -Wall -Wextra -Werror -pedantic \
  -arch arm64 -mmacosx-version-min=12.0 -c native/setups-targets/reader.c -o work/reader-arm64.o
/usr/bin/clang -std=c11 -Wall -Wextra -Werror -pedantic \
  -arch x86_64 -mmacosx-version-min=12.0 -c native/setups-targets/reader.c -o work/reader-x86_64.o
/usr/bin/clang -std=c11 -Wall -Wextra -Werror -pedantic \
  -DPF_READER_TEST_HOOKS native/setups-targets/reader.c native/setups-targets/acceptance.c -o work/reader-acceptance
work/reader-acceptance
```

The driver uses only fresh `/tmp` fixtures canonicalized to their actual location,
never HOME. It preserves foreign file variants, checks read-call absence for
FIFO/retarget/replacement refusals, bounds the FIFO child with an alarm, and tests
all eight fixed paths, stale identities, empty/exact/overlimit files, unsafe modes,
links and root storage bounds. Native source/actual independent acceptance is a
separate ROOT gate before any writer, app import, signing or package integration.
