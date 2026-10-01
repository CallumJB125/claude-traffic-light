# Plugins verification groundwork

This slice provides local discovery data, signed Codex descriptor verification,
exact bundled source checks and private read-only plans. It does not install,
remove, execute or connect a plugin. There is no renderer or IPC entry point.

The imported legacy catalog is discovery material. Its display instructions and
the legacy loader's `canInstall` catalog-signature result are not installation
authority. Only a separately signed closed Codex index can authorize a supported
descriptor. Unsigned entries, unknown keys and the legacy development key fail
closed. Production public keys and a signed index are deliberately absent until
the separately reviewed release signing stage; tests inject ephemeral fixture
trust into private module construction.

`index-verify.js` verifies Ed25519 signatures over exact raw index bytes before
parsing. It refuses duplicate decoded JSON keys, unknown fields, stale or future
dates, ambiguous paths, unsupported sources/components and mismatched package
hashes. Package hashes use ASCII path ordering and canonical JSON over each
file's relative path, byte count and SHA-256. The signed index also binds the
exact raw discovery catalog hash. Paths are portable ASCII and refuse encoded,
absolute, traversal, reserved-device and case-conflicting names.

`source-verify.js` accepts only fixed bundled directories under the main-owned
bundle root. It checks every declared regular file's exact bytes and identity,
refuses links and undeclared files/directories, checks bounded UTF-8 manifests
and skills, and scans for recognized embedded secrets. The first supported
components are portable Markdown skills and URL-only remote MCP descriptions;
hooks, agents, executable files, stdio definitions and credential/header fields
are refused. Remote descriptions must contain canonical HTTPS public DNS URLs.
They are parsed locally; no DNS lookup or connection is made. All archives,
remote retrieval and package-manager sources are unsupported and refused before
filesystem traversal, so this stage never extracts an archive.

File opens require the platform's no-follow and nonblocking flags before the
opened regular-file identity check. A platform without either flag fails closed;
it cannot silently turn a replaced FIFO into an unbounded wait. Directory/file
replacement probes run in bounded real child processes as well as in-process
identity checks.

Bounds are 8 MiB/index, 1,024 bytes/signature, 1,000 index entries,
1,000 files/package, 4 MiB/file, 128 MiB/package, 32 path levels,
4,000 traversal operations and a five-second source-check deadline. Plans have
a ten-minute lifetime, a 32-plan cap and four concurrent operations.

`plan.js` requires a private main adapter that observes the approved Codex binary,
six supported plugin-management commands, user profile, config/cache identities
and current account/team/member/device generation. It canonicalizes profile and
binary paths and binds these observations, signed index, descriptor and source
identities to an opaque in-memory plan. The adapter must not take observations,
hashes, paths or current-owner callbacks from a renderer. Each awaited operation
checks the captured current-owner callback again; a fresh snapshot and repeated
exact source check precede a reply. `check()` repeats the bindings and invalidates
stale plans. Neither method reads arbitrary profile files, writes a journal,
invokes a CLI or provides an execution capability.

Plans expose relative file hashes, source attribution, capabilities, user scope
and explicit limits only. Installation is always reported unavailable. Project
scope, mutation, conditional Undo, provider consent and tool approval require
their separate implementations and independent acceptance. Future Apply must
consume a one-use plan inside its canonical-profile queue and recheck current
authority before every mutation; this read-only plan is not that capability.
