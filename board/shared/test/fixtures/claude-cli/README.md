Real Claude Code 2.1.310 output recorded in the DGX lab on 2026-10-26 (already redacted: keys are `REDACTED`,
ids are placeholders). Copied from `work/dogfood-lab/fixtures/`:

- `2.1.310-no-auth-stream-json.json`: lab case 1. A gateway that lives only in `~/.claude/settings.json` `env`, run with
  `--setting-sources ''`: exit 1 in 0.5 s, `result` has `subtype:"success"` **and** `is_error:true`, text "Not logged in".
- `2.1.310-unreachable-stream-json.json`: lab case 2. `ANTHROPIC_BASE_URL=http://127.0.0.1:1`: ten api_retry events,
  exit 1 after about 172 s with ECONNREFUSED.
