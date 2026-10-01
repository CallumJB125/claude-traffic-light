# What a pattern scrubber cannot catch

The scrubber (`src/borrow/scrub.js`) works from `board/shared/secret-patterns.mjs`
plus structure-aware redaction, machine-value templating and entropy. Every class
below is text a person would call "a secret" or "private" that none of those
layers can recognise from the text alone. The zero-leak corpus and fuzz tests do
not assert on these classes (they cannot pass), so the user-review step is the
only control. For each class: what it looks like, why detection fails, and what
the review screen has to show so the owner can catch it by eye.

General rule for the review step: show the **post-scrub text that would be
uploaded**, never the original, with every "kept literal" visibly marked (see the
last section). The owner can then only approve what is on screen, and a miss is a
visible line instead of a silent one.

## 1. Credentials

| # | Class | Example | Why it is missed | Review step must show |
|---|---|---|---|---|
| 1 | Plain-word password on a line with no key name | `mysql -u root hunter2`, `echo hunter2 \| sudo -S true`, `sshpass -p hunter2 ssh box`, `mysql -phunter2`, `curl -u bob:hunter2 https://x` | No prefix, low entropy, and the flag or position is not in the keyed list (`-p`, `-u user:pass`, bare positional args). | Every command line (shell function bodies, aliases, JSON/TOML `command` and `args`, hooks) that still holds a literal argument of 4 or more characters after a flag or user name. Highlight the literal. |
| 2 | Secret split across variables or concatenation | `A=ghp_abcdefgh; B=ijklmnop; export TOKEN=$A$B`, Lua `"sk-" .. suffix`, `${PREFIX}${TAIL}` | Neither half matches a token format, and halves under 8 characters are never entropy-flagged. | Every assignment whose value is a literal fragment of 4 or more characters next to another assignment used in a concatenation. At minimum, list all literal assignments to names that are later interpolated (`$A$B`, `..`, `+`). |
| 3 | Encoded or transformed secrets | base64 of `user:token` under `"auth"` (Docker `config.json`), `printf c2stYW50... \| base64 -d`, hex, URL-encoded, rot13, reversed | The decoded form would match; the encoded form matches no pattern. `auth` without a scheme word is not in the keyed list. | Every kept string of 16 or more base64/hex characters that is not a recognised git SHA, with the key it sits under. |
| 4 | Secrets under key names outside the word list | `smtpPass = x`, `pw: x`, `auth: x`, `key = x`, `sk = x`, `hmac: x`, `salt`, `seed`, `cred`, `otp`, `rclone pass = x`, `PIN=4471`, `export FOO=hunter2` | `passw(or)?d`, `token`, `secret`, `api_key` and friends are matched; abbreviations and neutral names are not. Short values have no entropy. | Every `name = literal` or `name: literal` left in the output whose value is not a number, boolean, path, `$VAR`, or known public string. Group them so the owner can scan the list in seconds. |
| 5 | Secret in a shape the line scanner does not join | value on the next line after `\`; `"--api-key", "value"` (args arrays, two elements); multi-line YAML or TOML strings; non-PEM heredoc bodies (`cat <<EOF` with `user:pass`) | The keyed patterns read one line at a time; the trigger and the value are on different lines or array elements. Structure-aware layers cover common cases, not all. | Continuation lines (`\` at end of line) and heredoc bodies in full. For JSON or TOML arrays, show any element that follows a flag-like element (`--x`, `-x`) as a pair. |
| 6 | Provider tokens with no distinctive format | Cloudflare API token (40 chars, no prefix), Vercel and Linode tokens, Azure client secrets (`abc~Def...`), Heroku legacy UUID keys, AWS session tokens under neutral names, Mapbox `sk.` tokens, TOTP seeds (bare base32) | No fixed prefix, under 32 hex characters, and no key name that triggers the keyed layer. The entropy layer is a heuristic and will miss short or word-like values. | Every kept literal of 20 or more characters mixing letters and digits, with its key name, even if it looks like an ID. |
| 7 | Secrets in prose comments | `# staging key is hunter2-2024`, `# pw: hunter2`, `# login with bob / hunter2` | Only `password is x` is matched. Free text has no structure. | All comments in the output, in full. Comments are the most common hiding place for pasted credentials. |
| 8 | Real secrets that look like what is kept on purpose | a 40-hex API signature under a key named `commit`, `rev`, `sha`; a `$(...)` that embeds a literal, e.g. `$(echo hunter2)`; `op://` paths that are really the vault item name | README guarantee 5 keeps SHAs under those keys and command substitutions that fetch secrets. A disguised secret inherits the exemption. | Kept command substitutions and `$VAR` references with their full text; kept 40-hex values with the key. The owner can see that `$(echo hunter2)` is not `$(security ...)`. |
| 9 | Tokens that were damaged but still work | zero-width characters or line wraps inside a token, a token in a UTF-16 file, NUL bytes, a token broken by a soft hyphen | The pattern does not match the damaged text; a human or a lenient tool may still reassemble it. | Whether the file was decoded cleanly (encoding shown). For any file with non-ASCII or control characters, list those lines. |

## 2. Private but not credentials

The shared list targets secrets. A dotfile also holds identity, employer and
location data that must not be published to a team hub without a decision.
Only the machine's own values (`home`, `user`, `hostname`, `emails`, `names`) and
the README's placeholder classes (other emails, private IPs, internal hostnames)
are removed.

| # | Class | Example | Why it is missed | Review step must show |
|---|---|---|---|---|
| 10 | Employer, client and project names | `cd ~/work/acme-internal-billing`, `alias deploy-bigclient=...`, `Host bigclient-prod` | Free-form words; no pattern. | Every path, alias name, function name and `Host` alias that is not part of a known public tool list, as a flat list the owner can edit. |
| 11 | Internal URLs on public domains | `https://jira.acme.co.za`, `https://grafana.acme.com`, Git remotes, registry hosts | Only `*.internal`, private IPs and known internal suffixes are templated. A public DNS name is indistinguishable from a public service. | All URLs and hostnames with the allow-listed public ones (github.com, registry.npmjs.org, ...) dimmed, so the remaining ones stand out. |
| 12 | Org, repo and account identifiers | `github.com/acme-private/repo`, AWS account IDs (12 digits), ARNs, GCP project IDs, S3 bucket names, tailnet names (`tail8f3a2.ts.net`), Slack channel and user IDs, Sentry org slugs | Identifiers look like ordinary words or numbers. | All kept numbers of 10 or more digits, all `arn:` strings, all `org/repo` pairs, each with the key they sit under. |
| 13 | Personal data | full name in prose or `git config` comments, phone numbers, SA ID numbers, addresses, birthdays in commit templates, other people's names in `Host` or alias lines | Only the provided `machine.names` and `machine.emails` are known. | Every line containing a capitalised two-word sequence or a digit run that looks like a phone or ID number. |
| 14 | Hardware and machine identifiers | serial numbers, hardware UUIDs, MAC addresses, `scutil` names, volume names (`/Volumes/Tonde's SSD`) | Not in `machine`, not secrets. | UUID, MAC and `/Volumes/...` matches in the output. |
| 15 | Paths to other files that hold secrets | `source ~/.secrets`, `include ~/.aws/credentials`, `SSH_ASKPASS=~/bin/pw.sh` | The path is kept on purpose (guarantee 5), and it tells a reader where to look. The file itself is not shared. | Every `source`, `.`, `include`, `IdentityFile` and `*_FILE` target, as a list, so the owner knows what the setup expects the borrower to create. |

## 3. What the review screen must show, all in one place

1. The scrubbed text that will be uploaded, file by file, with placeholders
   highlighted and the borrower prompt each `{{SECRET:name}}` will produce.
2. A **kept literals** panel for each file: every value the scrubber left in the
   output that is not a number, boolean, `$VAR`, `~` path, git SHA, or an
   allow-listed public host. Group by key name. This is the one panel that
   covers classes 1, 3, 4, 6, 8, 10, 11, 12 and 13.
3. A **commands** panel: every shell command line, hook `command`, `args` array
   and heredoc body, in full (classes 1, 2, 5).
4. A **comments** panel: all comments in full (class 7).
5. A **pointers** panel: `source`/`include`/`*_FILE` targets (class 15).
6. Per-file approve and "leave this file out", with a count of redactions and
   blocked files so a file that lost half its text is visible as such.
7. A hard stop before upload that states the residual risk in one sentence:
   "Automatic scrubbing removes known secret formats and your machine's names. It
   cannot recognise a plain password or a name, so read the highlighted lines."

## 4. What the automated tests do and do not promise

- The corpus and fuzz tests assert guarantees 1 to 4 and 6 from the README for
  secret classes the shared list knows, in the contexts listed in the corpus
  manifest. They are evidence for those classes only.
- A clean run says nothing about classes 1 to 15 above. Do not cite the test
  suite as a reason to shorten the review step.
- Cases in the corpus that depend on the structure-aware layer rather than the
  shared patterns (Docker `auth`, rclone `pass`, `--api-key` followed by a value
  in an args array, a value continued after `\`) are there on purpose: they are
  catchable with structure, and they are the boundary between classes 3, 4, 5
  above and what the scrubber is expected to handle itself.

## 5. Deferred from the review round (security FAIL / code review REQUEST CHANGES)

Found by the reviewers' probes, not fixed in that round, and why:

| Input | What happens | Why deferred |
|---|---|---|
| A non-PEM heredoc body: `cat > ~/.pgpass <<EOF` then `db.acme.com:5432:*:app:Zq7xW2rT9vLm4Kp8` | The password (16 chars, no key name) is kept. | Class 5 above: a colon-separated line has no key and too little entropy. Recognising `.pgpass`-shaped lines needs a heredoc-target rule (the redirect names the format); left to the review screen, which shows heredoc bodies in full. |
| `user:password@host` with no scheme: `export X=callum.baker.125@gmail.com:Zq7xW2rT9vLm4Kp8@host` | The email is templated; the password is kept. | Class 1 above (`curl -u bob:hunter2`). Without `scheme://` the shape is also every `user@host:path` scp target; a rule would redact paths. |
| A machine `user` shorter than 3 characters (`al`) | Not templated, not rechecked. | Too many false matches in ordinary text. A 3–4 character user (`tonde` is 5) is templated and rechecked as a whole word only; a 5+ character user blocks the file even inside a longer word. |
| Hostname look-alikes: `callums-macbook-pro2` for `Callums-MacBook-Pro` | The file is blocked, not templated. | Blocking is the fail-closed answer; templating near-misses would guess at identity. |
| Names inside a file with very many secrets | Past a 32 MB search budget every `{{SECRET:name}}` is its kind (`keyed`, `github_token`). | The "name is part of a redacted value" check is defense in depth (a name is text outside every span by construction); the budget keeps scrubbing linear. Not a leak, only less helpful names. |
| Case folding on exotic characters | `fold()` is NFKC + upper → lower, wider than APFS's own table. | It errs toward blocking; a character APFS folds that this misses would still have to get past the per-hop link checks and the fixed registry paths. |
| Windows descriptor check | `O_NOFOLLOW` does not exist on Windows; the scan relies on its own link walk plus the dev/ino comparison. | Windows symlinks need privileges to create; revisit with a Windows test machine. |
