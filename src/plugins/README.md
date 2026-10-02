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

## Private transaction kernel — held pending native acceptance

`transactions.js` extends this groundwork without activating a product feature.
There is no IPC or renderer entry point, production native plugin writer, packaged
helper, catalog-signing key, Codex CLI invocation or provider connection in this
packet. The original public planner remains read-only and always reports
`install_available:false`. Its new `takeForTransaction()` is a private, one-use
handoff from a freshly rechecked signed plan, consumed before awaits. Source,
canonical profile, config/cache observations, approved host and exact current
account/team/member/device remain bound to the handoff. A public discovery row
or forged plan DTO cannot mint it.

The factory accepts exactly `{planner,adapter,confirm,now?,clock?}` from trusted
main code. No path, principal, device, executable, trust key, filesystem writer
or crypto bridge comes from a caller. Every authority-bearing method is
unavailable without a branded adapter and fresh attestation. Cancellation and
close still invalidate local handles when the adapter is unavailable, and report
that unavailability. The only implemented platform is Darwin; Windows and Linux
fail closed. A private `fixture:true` constructor accepts the distinct
`synthetic-plugin-fixture` attestation kind and marks all replies `fixture:true`.
It is used solely for explicitly labelled inert temp-profile tests, never as a
production fallback. A production constructor instead requires
`darwin-native-plugin`; neither that string nor a test verdict is native
acceptance. ROOT must provide and independently review the actual signed helper,
physical root validation, attestor, verified receipt bridge and OS wrapping.

Only signed bundled Markdown skill packages are eligible. Remote MCP, provider
connections, hooks, executable components, archives, package managers and
project scope remain unavailable. Installs and updates always write
`enabled=false`. Update requires an exact previously owned package, the same
signed descriptor/catalog/source family and a strictly newer semantic version.
An exact existing package is a no-op with no new ownership, Apply or Undo. An
ambiguous, foreign or modified package is refused. A 1 MiB aggregate preview cap
bounds full exact UTF-8 source review; a larger otherwise valid package remains
unsupported. Each public plan contains full relative-file text and hashes,
source/version/capabilities, user scope and the exact disabled config intent,
never the private source/profile root or another provider's configuration.

### Controller calls and native confirmation

These are closed **main-only** methods; future IPC must validate its own smaller
closed DTOs and rederive sender/view/selection/current authority in main.

| Method | Caller request | Result and consumption |
| --- | --- | --- |
| `plan(descriptorId,{operation,scope})` | bounded supported ID; operation `install` or `update`; scope `user` | full review DTO, opaque handle and hash; or unavailable/no-op |
| `apply(handle,{plan_hash,reviewed_files,reviewed_config})` | exact hash and both explicit acknowledgements `true` | handle consumed synchronously before confirmation/queue; verified disabled transaction or retained unknown effect |
| `listLocked()` | none | opaque local transaction IDs with `undo_available:false`; no wrapping availability probe or unwrap |
| `recover(id)` | UUID only | explicit recovery modal and OS unwrap; fresh entire journal and owned-target inspection; opaque one-use recovery handle only for verified unchanged targets |
| `undo(handle,{inspection_hash})` | exact inspected hash | handle consumed before separate native Undo confirmation/queue; fresh journal and target checks, conditional restore, actual inspection and durable undone event |
| `invalidate()` / `close()` | none | destroy handles, cancel outstanding operations, retain unobserved exits in renewal gate |

`confirm` must use the genuinely foreground, exact main-owned view and an
isolated native modal. It receives `{kind,plan_hash,summary}` and must return
exactly `{approved:true,plan_hash}` for the same hash. Kinds are `plugin-install`,
`plugin-update`, `plugin-recovery` and `plugin-undo`; echoing a renderer flag is
insufficient. Main must invalidate on view loss, selection change, denied or
removed current membership/source, logout, device identity change, binary/root
change and app close. Recovery may be explicitly authorized by the current local
OS owner while the account is offline, but foreground/root/host/OS-owner fences
still apply. It grants no cross-profile/account installation authority.

A profile queue serializes operations across controller instances. Handles are
bounded to 32 and ten minutes. Source/currentness and fresh inventory are
rechecked after native confirmation and queue acquisition, then again after
staging and before write intent. Each automated phase has one 60-second cutoff;
native confirmation time is outside that automated budget while plan expiry
continues. Cleanup waits no longer than 250 ms or the original remaining cutoff.
A worker's `reaped` promise alone does not prove exit. Success requires actual
`exited() === true`; unobserved workers and crypto promises remain in a shared
process-wide renewal gate through invalidate/close and another controller. The
actual native adapter must additionally hold an exclusive physical profile lease
across processes/restarts until its writer is gone. This JavaScript gate does not
claim to solve another process or a blocked OS syscall.

### Closed native adapter contract

`createNativePluginAdapter()` accepts exactly
`{observe,attest,begin,verifyReceipt,wrapping,fixture?}` from trusted main.
Attestation is exactly `{kind,protocol:1,helper_hash,roots_hash,current:true}`;
`observe()` returns `{profile_root,platform:'darwin',os_user,generation,
foreground:true,host_hash,account}`. The root must be canonical, privately owned
and physically verified by the native adapter, not merely an absolute string.
`host_hash` is the canonical private planner host-object hash. `account` is null
or the exact current `{user_id,team_id,member_id,device_id,generation}`.
The helper/executable, entitlements, executable/hash identity, permission modes,
OS owner, no-follow root handles, every target identity and current authorization
must be checked afresh. Main may not manufacture successful attestation from a
configured path or cached user assertion.

`begin({kind,input,cutoff},guard)` receives copied, frozen object/array inputs
(Buffer bytes are copied) and returns exactly
`{result,cancel,exited,reaped}`. No method takes argv or an arbitrary file opcode.
`result` resolves to `{receipt_hash,payload}`. `verifyReceipt(kind,result,input)`
must authenticate the actual owned native operation, exact input, nonce/ticket,
current physical roots and payload; matching caller-provided hashes is not proof.
Every receipt must be bounded and contain no config/provider/auth/CLI output.
Cancellation must independently revoke writes, and observed exit must come from
the real native process/transport. Guard and cutoff must be honored at each
physical effect and before any late publication.

| Fixed operation | Exact controller input | Required physical behavior / payload |
| --- | --- | --- |
| `inventory` | `{}` | bounded known metadata and current owned-target receipts; payload `{items,receipt_hash}`; each item `{metadata,inspection}` |
| `stage` | `{id,after,before,source}` | independently verify the fixed signed bundled source and inert files; copy to private no-follow staging; backup only an exact previously verified owned skill package; payload `{package_hash,backup_hash}` (`null` before fresh install) |
| `install-disabled` | `{id,after,before,expected_inventory}` | compare current inventory, config/cache identities and native ownership at effect time; conditionally publish only staged verified inert package and owned `enabled=false` range; no provider/CLI execution; payload `{package_hash,disabled:true}` |
| `inspect` | `{metadata}` | fresh complete owned config/cache file census and hashes; payload the closed inspection below |
| `restore` | `{id,after,before,expected_receipt,retain_marketplace}` | compare the fresh owned-target receipt immediately before every effect; restore only the exact private verified backup or remove only the exact new owned package; preserve current foreign config bytes/comments; independently recheck marketplace dependents and retain shared namespace whenever occupied; payload `{restored:true,retained_marketplace:boolean}` |
| `journal-create` | `{id,profile_hash,bytes}` | exclusive canonical transaction parent, private owner/modes, no links, bounded sealed header, full file+directory durability; payload `{bytes_hash}` |
| `journal-append` | `{id,profile_hash,expected_previous,sequence,bytes}` | exact canonical parent and current full record census; exclusive next record only; compare previous hash/sequence, bounded fsync and directory publication; payload `{bytes_hash}` |
| `journal-read` | `{id,profile_hash}` | fresh canonical entire ordered census, reject unknown/duplicate/gapped/linked/temp entries and high-water/head rollback; payload `{header:Buffer,records:Buffer[],census_hash}` |
| `journal-list` | `{profile_hash}` | bounded owner-controlled canonical IDs only; payload `{ids:UUID[]}`; never unwrap or infer Undo readiness |

Inspection is exactly `{status,package_hash,cache_hash,config_enabled,
foreign_hash,receipt_hash,owned,live_dependents}`, where status is
`exact|changed|missing|unknown`, hashes are validated SHA-256, booleans are typed
and dependents are an integer 0..1000. Inventory metadata is exactly
`{descriptor,marketplace,enabled}`: descriptor is the closed signed-index schema;
namespace is `plexiform-` plus the first 24 package-hash characters. `owned:true`
requires authentic local provenance from a previous independently verified
transaction and a current exact ownership ledger/receipt bound to the complete
journal head; a coincidentally matching user-created cache/config is unowned.
Existing failed/unknown transactions cannot be advertised as owned verified
update inputs. The native/main bridge must authenticate previously signed source
metadata/provenance and retain its original package backup. It cannot derive
ownership from path/name/hash equality alone.

The native physical operations above are a **separately reviewed prerequisite**.
This packet defines their closed requests and checks their verified responses;
it does not implement arbitrary Codex cache mutation by pretending existing
Setups recipe opcodes authorize those paths. Supported cache layout, disabled
installation behavior, management/version compatibility and no implicit
provider/ON_INSTALL connection require actual isolated Codex/native acceptance.

### Config ownership and encrypted journal

`toml-owned.js` lexes bounded valid-UTF8 statement ranges, quoted/escaped/dotted
keys, multiline strings and nested values. It owns only the exact plugin's
`enabled` scalar and an unannotated table header. Unknown owned fields, provider
values, nested owned tables, duplicate decoded keys, parent/value collisions,
array tables and inline parent/owned tables are refused. Human comments attached
to the owned field/header are refused. Foreign values remain opaque private
bytes in memory; no whole TOML or provider table is persisted. Removal preserves
all current foreign bytes including comments and CRLF. An unterminated foreign
final line is refused for installation because ownership of an added separator
cannot be proved; there is no formatting-normalization fallback.
This range lexer is not a complete TOML scalar/type validator. The actual native
adapter must additionally validate the whole current config with the supported
Codex-compatible TOML parser, in memory, before any effect. A lexically readable
foreign value is not a claim that the whole config is valid or writable.

`journal-codec.js` uses separate `PFPLUG01` AES-256-GCM envelopes and a random
per-transaction key. Header AAD binds the wrapped-key digest, local profile/OS
owner/plan and transaction identity; each event binds sequence and previous raw
record hash. Wrapping must be the actual reviewed OS bridge, with no plaintext
or unavailable fallback. Plain key copies and plaintext buffers are wiped.
Schema 1 is skills-only and cannot be reinterpreted as Setups or remote-MCP
recovery authority. The encrypted manifest contains only closed signed package
metadata, before/after enabled state, operation, time and index hash. It never
contains the live config, source content, provider credentials, cache bytes,
argv, output, chats or an arbitrary diagnostic string. Typed SHA fields remain
digests; recognized secret scanning applies to source/human strings.

Phases are `prepared → staged → install_intent → observed → verified →
undo_intent → undone`. An event is published only after its exact sealed bytes
receive a native durable-publication receipt. Recovery decrypts and authenticates
the whole current census after explicit native confirmation, checks current OS
owner/profile, then freshly inspects all owned targets. Only `verified` grants
an Undo handle. Partial/unknown/changed/undone states retain evidence and grant
no automatic repair/Undo. A valid prefix is still visibly unverified; a native
current census/high-water guarantee is required against storage rollback.

Undo compares the unchanged owned fingerprint and current journal head again
inside the queue, while allowing current foreign bytes to differ. The native
restore request uses the fresh full receipt to close a race before the effect.
Live marketplace dependents retain the namespace. No error auto-cleans a journal,
backup, package or unknown effect. An unavailable wrapping bridge before any
publication attempt reports unavailable without inventing a retained record;
unknown publication/effect attempts retain their transaction ID for review.

The official [Codex plugin documentation](https://developers.openai.com/plugins/build/plugins)
provides the plugin/skill and disabled-config format. That documentation does not
prove this adapter's current physical cache layout or safe native install/Undo.
The test suite exercises real inert temp-file bytes and explicitly synthetic
adapter receipts, including signed review, disabled Apply, restart recovery,
conditional Undo/update, human edits, hostile TOML, AEAD corruption, replay,
current authority, deadlines and held exits. Passing those tests is source and
synthetic-kernel evidence only; no packaged product, provider, Windows or native
plugin installation acceptance is claimed.
