# Recorded CLI failures

Real outputs from the DGX lab (2026-10-26), copied from `dogfood-lab/fixtures/` (see its README for how each case ran):
Claude Code **2.1.310** and codex-cli **0.164.0**, against litellm-lab on `127.0.0.1:4001`, model `glm-5.3-flash`.
Each case is `<cli>-<version>-<case>.{stdout,stderr,exit}`: the exact stdout and stderr (keys, tokens and IDs already
redacted by the lab; temp paths normalised to `/tmp/fx-home` and `/tmp/fx-work`) and the exit code.

| Case | What it shows |
|---|---|
| `claude-…-no-auth-json`, `-stream-json` | logged out: `subtype:"success"` with `is_error:true`, `result:"Not logged in · Please run /login"` (C11) |
| `claude-…-no-auth-text` | the same, as text mode prints it on stdout |
| `claude-…-unreachable-text` | `API Error: Connection refused … (ECONNREFUSED)` after about 172 s |
| `claude-…-wrong-key-text` | `API Error: 400 No connected db.` (a lab proxy quirk: never rely on 401) |
| `codex-…-no-provider-hang` | no provider: DNS fails against `api.openai.com`, `Reconnecting…` forever; the lab killed it at 300 s (exit 124) |
| `codex-…-env-key-unset-json` | `Missing environment variable: PLEXLAB_KEY`, exit 1 in 0.1 s |
| `codex-…-wrong-key-json` | `turn.failed` carrying the 400 `No connected db.` JSON body |

`board/tasks-engine/test/failure-reasons.test.js` runs `findSecrets` over every file here and checks the classifier
against each case. To record a new one, run the CLI under `env -i` with stdin from `/dev/null` and a hard timeout,
redact, and add the three files.
