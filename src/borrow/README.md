# Setups — local privacy engine

Plan: `.omc/plans/codex-setups-local-slice-plan.md` (main checkout). The complete
product still requires authenticated team profiles, a full per-file review
screen, exact reviewed-hash publication, update notifications, explicit apply
and safe merge/Undo. This engine checkpoint does not enable any of those flows.

Step 1 is local and read-only. Nothing here uploads anything; hub upload code
does not merge until this scrubber has passed a security review.

| file | job |
|---|---|
| `registry.js` | Data-driven setup sources: where each lives, its format, how it is merged, which parts are sensitive. Adding a source is a registry entry, not code. |
| `blocklist.js` | Paths and names that are never read, not even stat'ed. Checked on the path string before any fs call, case- and Unicode-folded (APFS opens `~/.ſsh` as `~/.ssh`). |
| `scan.js` | Read-only local scan of a HOME (injectable, so tests use a temp dir). Resolves links itself, one hop at a time, blocklist-checking each hop before it is stat'ed; reads through a no-follow descriptor that must match what was checked; skips files with other hard links. Returns sources, file records (`path`, `content`, `format`, `sensitiveKeys`) and a "what I looked at" list. |
| `scrub.js` | The multi-layer scrubber that turns one file into what may be shared. |

Secret detection is `board/shared/secret-patterns.mjs` (shared with the board
guard and the diagnostics scrubber). This folder adds only dotfile-specific
layers: structure-aware redaction, machine-value templates, entropy.

Scanner file opens require both no-follow and nonblocking platform flags, then
check the actual opened regular file's identity before reading. This prevents a
regular-to-FIFO replacement from waiting indefinitely for a writer. A platform
without either protection skips the file with a fixed unavailable reason. Real
bounded child-process tests cover FIFO, directory, link and changed regular-file
replacements; this does not provide an atomic filesystem lock or an Apply/Undo
mutation capability.

## Scrubber contract

```js
const { scrubFile } = require('./scrub.js');
scrubFile({
  path,      // the file's path as the scanner reports it: '~/.zshrc', '~/.claude.json#mcpServers'
  content,   // string, the original file
  format,    // optional (the scanner's record has it); else inferred from path, ignoring '#…':
             // 'shell'|'json'|'jsonc'|'toml'|'yaml'|'ini'|'gitconfig'|'sshconfig'|'npmrc'|'lua'|'vim'|'text'
  machine: { home, user, hostname, emails: [], names: [] },  // this machine's values to template away
  sensitiveKeys,  // optional: extra object keys whose every value is secret (the registry's field)
}) → {
  status: 'ok' | 'blocked',
  reason,            // when blocked: why (never quotes the secret)
  content,           // when ok: the shareable text
  redactions: [{ line, kind, name, placeholder }],  // 1-based line in the output; never the original value
  templates:  [{ line, placeholder }],
}
```

`scrubFile` never throws: an unexpected internal error returns `blocked` with
reason `scrubber error`; conservative format/budget refusals have fixed reasons.

Placeholders in the output:
- `{{SECRET:<name>}}` a secret; the borrower is asked for their own value, stored locally only.
  The name is the key the value sat under, or the kind; never text from another redacted
  value, a machine value, a host, an IP or an address.
- `{{HOME}}`, `{{USER}}`, `{{HOSTNAME}}`, `{{EMAIL}}` this machine's values (home in `/`, `\`
  and JSON-escaped `\\` forms, NFC or NFD)
- `{{NAME}}` the gitconfig `user.name`; `{{SSH_USER}}` an SSH config `User`
- `{{EMAIL:n}}`, `{{IP:n}}`, `{{HOST:n}}` other emails, private IPs, internal hostnames and SSH
  `HostName`s (numbered per file)
- `{{PRIVATE:n}}` one of `machine.names` (numbered per file)

Machine values that are not templated: a `user` shorter than 3 characters (too many false
matches) and a generic `hostname` such as `localhost`.

Guarantees (tested by the zero-leak corpus and fuzz tests):
1. No seeded secret, nor any 8-character run of one, survives in `content`.
2. None of `machine.home`, `machine.user`, `machine.hostname`, `machine.emails`, `machine.names`
   survives, also percent-decoded (`%2FUsers%2Fx`). An email's local part (6+ characters) and a
   `user` of 5+ characters must not survive even inside a longer word (`github.com/user125`);
   such a file is blocked rather than guessed at.
3. A file on the blocklist is `blocked` whatever its content.
4. Fail closed: if anything secret-shaped survives the layers, the file is `blocked`, not shared.
5. Kept on purpose: git SHAs in lockfiles and `commit`/`rev`/`sha` keys, public hostnames,
   variable references (`$OPENAI_API_KEY`), command substitutions that fetch a secret
   (`$(security find-generic-password …)`, `op://…`), and `~` paths.
6. A file whose original text already contains Buddy's placeholder syntax, or anything shaped
   like a stand-in (`{{GH:…}}`, `{{secret:x}}`, `<redacted:x>`), is blocked: a wrapper could
   otherwise hide a token from the final check.
7. Every layer is linear in the file's size; 1 MB of any shape scrubs in under two seconds.

Structured JSON/JSONC and TOML keys are compared against known redacted value
material, including decoded JSON spellings and nested JSON string values. YAML
block scalar properties receive the same comparison. A duplicated eight-character
fragment blocks the whole file rather than retaining it in a key or placeholder
name. Public URL protocol and hostname words are excluded from this comparison;
credentials, path, fragment and query names/values are included. Key ranges, comparison
fingerprints and nested values have finite budgets; exhaustion blocks the file.

YAML block scalars support `!!str` and one ordinary anchor, in either order,
quoted keys, list nesting, indentation/chomping modifiers and CRLF. Ambiguous
properties or modifiers, empty bodies and bodies beyond 50 lines block the file.
These conservative refusals cannot be used to obtain the original content.

TOML table/assignment/inline keys use one bounded decoded lexical representation,
including basic/literal quoted names, Unicode escapes and dotted/nested scopes.
Known env/header containers apply the same string-value policy to ordinary and
triple basic/literal bodies, arrays and nested inline tables. Original body
ranges are retained for replacement; text inside a string cannot change its
container. Unsupported or ambiguous TOML syntax, unclosed strings/containers,
invalid escapes, nesting/key paths beyond 32 components, key paths beyond 4096
decoded UTF-8 bytes or more than 32768 keys/values block
the file with a fixed reason. This reader does not evaluate TOML or execute it.

The seeded corpus and fuzz results establish these controls for the tested
classes. Unknown plain passwords under neutral names, project names and private
prose still need full human review of every post-scrub byte; see
`test/fixtures/borrow/FALSE-NEGATIVES.md`. No publication path exists here.

## Registry fields

See the header of `registry.js`: `files`/`dirs` entries may be `{ path, platforms }`,
`format` names a format where the file name does not say it, `sensitiveKeys` adds secret
tables, `allowBlocked` lists the blocklisted paths a source may read (only `~/.ssh/config`,
opt-in). The listing commands the scanner may run are exactly the registry's `exec` items.

## Read-only transaction core

`transaction-targets.js`, `transaction-core.js` and `transaction-store.js` are
private main-process modules. They are not wired to Apply, Undo, renderer IPC or
remote tools in this checkpoint. Their constructors take registered identity,
source-read and native-confirmation callbacks; a caller cannot supply a target
path, URL, token, command or execution capability.

The closed target map supports replacement planning for Codex instructions and
strict JSON object planning for Claude and Gemini settings. JSON merge keeps
untouched local bytes exactly, retains conflicting local values by default and
replaces only explicitly selected top-level value ranges. Duplicate decoded
keys, ambiguous JSON, nonfinite numbers, unknown choices and oversized files
refuse. TOML, Git includes and Ghostty includes have fixed review recipes but
remain explicitly unavailable until their format adapters are reviewed. Other
registry sources and package inventories cannot obtain a target plan here.

Plans bind the current account, team, member, device, dialog generation,
canonical OS profile, exact immutable source version, local file identity and
before/proposed hashes. Each plan lasts ten minutes and is consumed once before
its queue or confirmation waits. Current authority and expiry are checked after
every await and inside the profile queue. Instructions and code-bearing
configuration require separate explicit choices. Preparing a plan changes no
tool file and runs no process. Local values are filled only in main memory;
decoded JSON string masking prevents escaped local values appearing in previews.

The app-owned `setups-transactions` directory uses private POSIX permissions,
exclusive files, bounded regular nonblocking/nofollow reads and directory
identity checks. Each transaction has a random key wrapped with OS safeStorage,
and AES-256-GCM authenticates the encrypted manifest and before/shared/proposed
snapshots against profile, transaction, recipe, role, hash and size. Snapshot
files are synced before the prepared manifest, then the transaction directory
and its parent are synced. A crash leaves encrypted incomplete records for
review; records are never automatically discarded to make room. Limits are
128 targets, 256 KiB per snapshot, 64 MiB per transaction, 128 MiB per store and
16 incomplete transactions. This first immutable journal has only the
`prepared` phase, so no completed-transaction retention or applied claim exists.

There is no plaintext wrapping fallback. Linux `basic_text`, unknown or missing
safeStorage backends refuse; see [Electron's platform semantics](https://www.electronjs.org/docs/latest/api/safe-storage).
Windows refuses until the separately reviewed native directory privacy and
rooted reader adapters are available. POSIX chmod cannot prove a Windows DACL.
These Node pathname observations and app-owned journal writes do not provide a
user-target content CAS, descriptor-relative mutation or protection from all
competing writers. The native mutation helper, existing-file Apply,
conditional Undo and preservation of displaced foreign edits remain separate
implementation and acceptance gates.

Recovery starts with opaque locked identifiers. A fresh foreground confirmation
for the same canonical OS profile permits local content-match checks after
sign-out or team revocation without restoring remote authority. Account/device/
profile/dialog changes invalidate pending decisions and preview handles. Only
the previously reviewed shared snapshot can be previewed after confirmation in
this first core; local before/proposed previews remain withheld on restart until
their explicit local-value masking can be safely reconstructed. Recovery never
automatically changes a target file or starts a tool.

## Deferred sources

Not in the registry yet (each needs its own format or merge rules): Windows Terminal
`settings.json`, Windows PowerShell 5 profile (`~/Documents/WindowsPowerShell`), JetBrains
IDEs, Zed, Sublime Text, Karabiner-Elements, Raycast, Hammerspoon, iTerm2 preferences plist
(only DynamicProfiles is read), Ghostty on Windows (unsupported upstream), zellij and
tmux on Windows.
