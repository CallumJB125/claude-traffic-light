# Waiting inputs: what Buddy can see, answer, or only point at

Pet-features plan, P3 and the "P3+ addendum" (the widget as the middleman).
This is the reference for which waiting inputs Claude Code lets a hook answer,
how Buddy captures each one, and the `PendingInput` shape the bubble renders.

Checked on **2026-09-30** against the official docs (raw pages fetched from
`code.claude.com/docs/en/*.md`) and the installed CLI, **Claude Code 2.1.286**.
Anything the docs don't state is marked **UNVERIFIED**.

## Hookability table

| Waiting input | Hook / event | Can a hook answer it? | Answer shape (exact) | Source (checked 2026-09-30) |
| :- | :- | :- | :- | :- |
| Tool permission prompt (Bash, Edit, Write, WebFetch, MCP tools…) | `PermissionRequest` (blocking; Buddy installs it with `timeout: 60` when "answer from the widget" is on) | **Yes** | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`; optional `updatedInput` and `updatedPermissions` (allow only); `{"behavior":"deny","message":"…"}` with optional `interrupt` | [hooks#permissionrequest](https://code.claude.com/docs/en/hooks#permissionrequest), [#permissionrequest-decision-control](https://code.claude.com/docs/en/hooks#permissionrequest-decision-control) |
| "Allow for this session" on a permission prompt | `PermissionRequest`: the input's optional `permission_suggestions` | **Yes** | `decision.updatedPermissions: [<one of permission_suggestions>]`. Buddy only offers `addRules` (allow), `addDirectories` and `setMode` (acceptEdits/default/plan), and always rewrites `destination` to `"session"`, so a widget click never writes a settings file | [hooks#permission-update-entries](https://code.claude.com/docs/en/hooks#permission-update-entries) ("A hook can echo one of the `permission_suggestions` it received as its own `updatedPermissions` output") |
| Read or edit outside the working directories | `PermissionRequest` for the file tool (`Read`, `Edit`…), with an `addDirectories` suggestion | **Yes, with a caveat.** The docs say PermissionRequest runs "when Claude Code is about to ask you for permission" and list `addDirectories` as a suggestion type. They don't name this dialog specifically, so **UNVERIFIED** that every variant of it goes through the hook. The tmux detector covers it when it doesn't | `{"behavior":"allow","updatedPermissions":[{"type":"addDirectories","directories":["/path"],"destination":"session"}]}` | [hooks#permissionrequest-input](https://code.claude.com/docs/en/hooks#permissionrequest-input), [permissions#working-directories](https://code.claude.com/docs/en/permissions#working-directories) |
| Sandboxed command's **network** request | none. The docs say PermissionRequest hooks don't run for it; there's only a `permission_prompt` Notification | **No** | none | [hooks#permissionrequest](https://code.claude.com/docs/en/hooks#permissionrequest) |
| `ExitPlanMode` (plan approval) | `PermissionRequest` with `tool_name: "ExitPlanMode"`. `tool_input.plan` and `planFilePath` are injected | **Yes** | allow: `{"behavior":"allow"}`, or with `"updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]`. Keep planning: `{"behavior":"deny","message":"…"}` | [hooks-guide](https://code.claude.com/docs/en/hooks-guide) (auto-approve ExitPlanMode example), [hooks#exitplanmode](https://code.claude.com/docs/en/hooks#exitplanmode) |
| `AskUserQuestion` | `PreToolUse` (`tool_name: "AskUserQuestion"`) | **Yes** | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"questions":[…the original…],"answers":{"<question text>":"<label>"}}}}`. "allow" on its own is not enough. Multi-select answers join labels with commas. Decline: `permissionDecision: "deny"` + `permissionDecisionReason` | [hooks#askuserquestion](https://code.claude.com/docs/en/hooks#askuserquestion), [#pretooluse-decision-control](https://code.claude.com/docs/en/hooks#pretooluse-decision-control) (allow with `updatedInput`) |
| `AskUserQuestion` via `PermissionRequest` | `PermissionRequest` | **UNVERIFIED** whether PermissionRequest fires for AskUserQuestion in an interactive session at all. If it does, Buddy passes it straight through with no output, so the person never waits twice | none | none found |
| MCP elicitation (form or URL) | `Elicitation` (blocking; Buddy installs it with `timeout: 60` alongside PermissionRequest) | **Yes** | `{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"accept","content":{…}}}`; `action` is one of `accept`, `decline`, `cancel` (`content` only with accept) | [hooks#elicitation](https://code.claude.com/docs/en/hooks#elicitation), [#elicitation-output](https://code.claude.com/docs/en/hooks#elicitation-output) |
| Notification `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog` | `Notification` (after about 6 s of no typing) | **No** (informational). Buddy records `message`/`title` as a shown-only ask | none | [hooks#notification](https://code.claude.com/docs/en/hooks#notification), [#notification-input](https://code.claude.com/docs/en/hooks#notification-input) |
| Notification `idle_prompt` | `Notification` (about 60 s after a turn ends) | **No**. It isn't a pending input, just "your turn" | none | same |
| Notification `agent_needs_input` | `Notification` | **No**. Buddy doesn't map it yet: the payload's `session_id` may be the agent-view session, not the waiting one (**UNVERIFIED**) | none | same |
| `--permission-prompt-tool <mcp tool>` (headless `-p` only) | MCP tool call | **Yes** (it is the answer channel) | The docs don't give the tool's input/output contract (**UNVERIFIED in docs**). Board verified it empirically against 2.1.285 (`board/mcp/tools.js approvalReply`): one text block whose JSON is `{"behavior":"allow","updatedInput":{…}}` or `{"behavior":"deny","message":"…"}` | [cli-reference](https://code.claude.com/docs/en/cli-reference) ("in non-interactive mode"), [headless#turn-off-permission-prompts…](https://code.claude.com/docs/en/headless#turn-off-permission-prompts-in-unattended-runs) |
| Workspace trust ("Quick safety check: Is this a project you created or one you trust?") | **none**. In an interactive session Claude Code "holds back hooks from every settings file, including your own `~/.claude/settings.json`, until you accept the workspace trust dialog", so not even SessionStart has fired | **No** (a hook can't see it). Buddy detects it from the tmux pane of a Buddy-owned launch (the launch record carries the pane). `-p` runs never show it | none. Pre-trust by hand: `projects["<path>"].hasTrustDialogAccepted: true` in `~/.claude.json` (documented; Buddy doesn't do this) | [hooks#workspace-trust](https://code.claude.com/docs/en/hooks#workspace-trust), [permissions#project-allow-rules-and-workspace-trust](https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust) |
| New MCP servers found (`.mcp.json` approval) | **none** documented | **No**. The tmux detector catches it. Whether it comes before or after SessionStart is **UNVERIFIED**, so the detector looks at both sessions waiting in `session-start` and unclaimed Buddy launches. `-p` shows no per-server prompt | none. Pre-approve with `enableAllProjectMcpServers` / `enabledMcpjsonServers` in a settings file you own (a committed project file is ignored until the folder is trusted) | [mcp#project-server-approvals-and-workspace-trust](https://code.claude.com/docs/en/mcp#project-server-approvals-and-workspace-trust), [settings-reference](https://code.claude.com/docs/en/settings-reference) |
| Auto mode classifier denial | `PermissionDenied` (fires **only** in auto mode: not for a manual deny, a PreToolUse block, or a deny rule) | Not a prompt. The hook can only return `{"hookSpecificOutput":{"hookEventName":"PermissionDenied","retry":true}}`, which lets the model retry. Buddy never sends it | Input has `reason`, e.g. `"[Irreversible Local Destruction]"`, `"Auto mode could not evaluate this action…"` (no verdict), or `"Classifier unavailable"` | [hooks#permissiondenied](https://code.claude.com/docs/en/hooks#permissiondenied) |

Timeouts and fall-back (verified): command hooks default to **600 s** on most
events. UserPromptSubmit gets 30 s, and SessionEnd gets 1.5 s ([hooks](https://code.claude.com/docs/en/hooks)).
Buddy's blocking hooks wait at most `min(55 s, hook timeout − 5 s)`, except
AskUserQuestion's PreToolUse (askFromWidget on), which waits at most **20 s**:
Claude Code only draws the question in the terminal once that hook returns, so
with the widget's answering on, a question shows up in the terminal up to 20 s
late if nobody answers it from the widget first. When nobody
answers, the hook claims the answer slot with a timeout marker, deletes the
request and prints nothing. The docs say only the `decision` object can grant
or deny a PermissionRequest. They say PreToolUse with no decision leaves "the
normal permission flow". For a PermissionRequest hook that prints nothing, the
docs are silent (**UNVERIFIED**). The existing widget design has always
relied on the terminal dialog showing in that case (set-status.js), and this
change doesn't alter that.

Classifier denials: **yes**, a hook signal exists (`PermissionDenied`, with
`reason`), so no transcript parsing is needed. In `-p` runs with
`--output-format stream-json`, denials also appear as `permission_denied`
system messages and in the result's `permission_denials`
([headless](https://code.claude.com/docs/en/headless#turn-off-permission-prompts-in-unattended-runs)).
Buddy records the last denial as `session.blocked` until the next prompt. It
surfaces as a `blocked` PendingInput for 30 minutes.

## How each kind reaches the widget

| Kind | Captured by | Answerable in the widget | Where the answer goes |
| :- | :- | :- | :- |
| `permission` | PermissionRequest hook → `requests/<id>.json` | yes | answer file → hook → `decision` |
| `plan` | PermissionRequest (ExitPlanMode) → `requests/<id>.json` | yes | same |
| `question` | PreToolUse (AskUserQuestion) → `requests/<id>.json` when askFromWidget is on; otherwise `session.ask` (shown only) | yes / no | answer file → hook → `updatedInput.answers` |
| `elicitation` | Elicitation hook → `requests/<id>.json` | yes | answer file → hook → `action`/`content` |
| `notification` | Notification hook → `session.ask` | no ("Open it") | none |
| `blocked` | PermissionDenied hook → `session.blocked` | no | none (see the options below) |
| `dialog` | tmux `capture-pane -p` of the session's recorded pane (`src/pane-dialogs.js`) | no ("Open it") | none |

Security model (unchanged from remote/THREAT_MODEL.md §1): random request ids;
0600 request files in a 0700 dir, now created whole before their names appear;
a single-use `.answer` created by `link()`; every answer is bound to the
request's `decisionHash` (SHA-256 of the canonical kind, channel, tool, input
and permission suggestions) and carries an HMAC under a per-request key the
hook hands only to the running app (never to disk), so a same-user writer,
the agent included, can't forge one; the hook claims the answer slot at its
deadline; `.taken`/`.refused` acks. The answer may carry a shape-checked
`extra` (`answers`, `permissionIndex` + `suggestionHash`, `mode`, `message`,
`content`), and the hook refuses an answer that doesn't fit the request's
kind, so the answerer hears `refused`. The phone path (`remote/`) only offers
`permission` and `plan` requests.

## `PendingInput` schema (for the bubble)

`state.inputs` (from `get-aggregate-status`, pushed on `status-changed`) is an
array sorted by `created_at`:

```ts
type PendingInput = {
  v: 1;
  id: string;              // request id for hook items; "ask-…", "blocked-…", "dialog-…" otherwise
  session: string | null;  // Claude session id (null for a launch stuck before its first hook)
  host: string | null;
  cwd: string | null;
  kind: 'permission' | 'plan' | 'question' | 'elicitation' | 'notification' | 'blocked' | 'dialog';
  source: 'hook' | 'session' | 'tmux';
  tool: string | null;     // "Bash", "ExitPlanMode", "AskUserQuestion", "mcp:<server>", …
  title: string;
  text: string;            // full text; hidden/bidi characters shown as ⟨U+XXXX⟩
  options: Array<{ id: string; label: string; description?: string; needsContent?: boolean }>;
  created_at: string | null;   // ISO
  expires_at: string | null;   // ISO; when the hook stops waiting (hook items only)
  answerable: boolean;         // true only for hook items with a decision hash
  actions: Array<'answer' | 'open'>;
  // kind-specific
  headline?: string;           // permission: one-line summary (request-view.js)
  questions?: Array<{ id: string; question: string; header: string; multiSelect: boolean;
                      options: Array<{ id: string; label: string; description?: string }> }>;
  freeText?: true;             // question: free-text answers are allowed
  schema?: object;             // elicitation: requested_schema (form mode)
  reason?: string | null;      // blocked: the classifier's reason
  notification_type?: string | null;   // notification
  dialog?: 'trust-folder' | 'mcp-servers' | 'plan' | 'permission';  // dialog
  launch?: string | null;      // dialog: Buddy launch id when the session has none yet
};
```

Options per kind:

- `permission`: `allow` (Allow once), `allow-session-<i>` (one per safe
  suggestion, labelled "Allow … for this session"), `deny`.
- `plan`: `allow` (Approve), `allow-accept-edits`, `deny` (Keep planning).
- `question`: for a single single-select question, one option per answer
  (`q0o0`, `q0o1`, …), plus `deny` (Decline to answer). For several questions
  or multi-select, build the answers from `questions` and send them with
  option id `answers`.
- `elicitation`: `accept` (Submit / Done; `needsContent` means send form
  `content`), `decline`, `cancel`.
- `blocked`: `run-yourself`, `switch-mode`, `add-rule`. These are
  suggestions for the UI (open the terminal, the mode switch, the rules
  editor). None of them is sent to Claude Code.
- `dialog`, `notification`: the dialog's own options, for display only
  (`answerable: false`).

IPC (preload `window.trafficLight`):

- `answerInput(id, optionId, { answers?, content?, message? })` →
  `{ ok: true } | { ok: false, error }`. main.js rebuilds the answer from the
  request file (the renderer never supplies a decision), writes it through
  `hooks/answer-file.js` (first answer wins), and logs `[answer] …`.
  `message` is the optional reason on a deny.
- `openInput(id)` → `{ ok, app }`: jump to the session's pane or tab through
  the existing terminal jump. It never types.
- The old `answerRequest(id, 'allow'|'deny')` still works for permissions.

Races: once the hook has consumed the answer or timed out, the request file
is gone, so the item drops out of `inputs` on the next poll, and a late click
gets `no longer waiting`. If the question was answered in the terminal first,
the hook's wait ends when Claude Code kills or moves past it, and the item
disappears the same way.

## Unhookable dialog detection

- SessionStart records `TMUX` (`<socket>,<server pid>,<session>`) and
  `TMUX_PANE` in `session.terminal.env` (hooks/terminal-id.js). This existed
  already; tests now pin it.
- `src/pane-dialogs.js` looks at a session only when (a) it has sat in
  `permission-ask` or `session-start` for 20 s or more with no pending hook
  request, or (b) it is a Buddy launch record with a tmux pane that no
  session has claimed after 20 s (a CLI stuck on the trust dialog runs no
  hook).
- It runs only `tmux -S <socket> capture-pane -p -J -t <pane>`: one capture per
  pane per 15 s and at most 4 per scan, with a scan every 5 s. It only reads a
  socket that belongs to this user in a directory nobody else can write
  (`tmuxServerOk`), and pane ids and socket paths are strictly validated.
- The patterns use Claude Code 2.1.286's own strings (the fixtures in
  `test/fixtures/panes/` are laid out from them, not live captures). A
  wording change in a later CLI shows up as no detection, never as a wrong
  answer, because nothing is answered from a pane.

## Buddy-owned sessions

`hooks/owned.js`: the launcher calls `recordLaunch(root, {launcher, cwd, tmux})`
and starts the CLI with `BUDDY_OWNED=<launchId>`. At SessionStart the hook
calls `checkOwned`. It accepts the id only if the matching record exists (the
user's own file, not writable by group or others), the session's cwd is under
the record's cwd, and the claim window (10 minutes) is open. It then claims
the record once. The same process (`/clear`) or the same session id
(`--resume`) keeps ownership; anyone else is refused. The result is stored as
`session.owned = {launchId, launcher, since}`.

The board runner writes the same record format for every run when Buddy is
installed, and sets `BUDDY_OWNED`. Board runs are `-p` runs that don't load
Buddy's hooks (`--setting-sources ""`), so their ownership is known to the
runner directly. The record is there for Buddy's own view and for later
launchers.

## Engine launch flags (board runner)

- Worktree root: `permissions.additionalDirectories: [worktree]` in the run's
  `--settings` file. We don't use `--add-dir`. The docs say `--add-dir`
  directories also load `enabledPlugins` and `extraKnownMarketplaces` from
  that directory's `.claude/settings.json`, and the worktree is
  agent-editable. Settings-file directories "grant file access only"
  ([permissions#additional-directories-grant-file-access-not-configuration](https://code.claude.com/docs/en/permissions#additional-directories-grant-file-access-not-configuration)).
  **UNVERIFIED in docs**: that a `--settings` file is still honoured with
  `--setting-sources ""`. The docs list only `user`, `project` and `local`
  as sources. The runner's whole isolation profile (sandbox, hooks, allow
  rules) already depends on the flag file loading, and that was verified by
  the board spikes on 2.1.285.
- Permission prompts: `--permission-prompt-tool mcp__board__approval` is on
  every launch (new, resume, any model), and tests pin it.
- `BUDDY_OWNED`: see above.

## Out of scope: interfaces only

- **Send-keys answering** (needs Callum's explicit OK): only for
  `session.owned` sessions or unclaimed Buddy launch records, and only for
  `kind: 'dialog'` items. A future `answerDialog(id, optionId)` would re-capture
  the pane, check that the same dialog and option list are still showing, and
  send the option's digit to that pane only. It never touches a session
  without `owned`. Nothing in the codebase does this today.
- **Auto-answer rules**: a pure `matchRule(rules, request) → optionId | null`
  run inside the blocking hook before it waits. Its input is the request
  record (`kind`, `tool`, `toolInput`, `cwd`), and it answers through the same
  `answerOutput`. Destructive commands and the deny list always need a human.
  The rules editor (Lights → Auto-answer) and storage exist:
  `config.autoAnswer = { v: 1, sealed: null, rules: [{ id, enabled,
  action: 'allow'|'deny', tools: [...], command?, path?, cwd?, note,
  createdAt }] }` (final; `sealed` is reserved for the safeStorage HMAC),
  validated on every read and save by `src/auto-rules.js` (`refusal`,
  `sanitize`), which also holds a reference `matchRule` and the agreed
  evaluator design. **Not switched on for go-live**: nothing evaluates them.
- **Escalation push**: a consumer of `state.inputs` that pushes any item
  still present after about 5 minutes. For answerable kinds it uses the same
  option ids via `answerInput`. The phone path already exists for
  `permission`/`plan` (remote/).
- **Bubble UI** (built): `input-bubble.js` renders `state.inputs` in the
  widget (two rows, then "+N more") and on the "Waiting on you" page
  (`waiting.html`, standalone and in the Plexiform window). main adds
  `danger` (a reason string or null) to hook permission inputs: the deny-list
  or a destructive command, so Enter never allows them.
