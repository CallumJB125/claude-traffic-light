# Remote reporter: sessions on another machine

Claude Code running somewhere else, such as a dev server or a tmux pane over
SSH, can light the widget on your desk. That machine is a **reporter**. It runs
Buddy's usual hooks from a checkout, and each hook passes a small event to a
detached sender. The sender signs the event and posts it to the desktop
app's **device port**.

```
reporter (devbox)                                     desktop (your Mac)
Claude Code hook ─▶ emit.js --adapter claude
                    ├─ writes its local session file (agent pid, remoteSeq)
                    └─ spawns remote.js __send (detached) and exits 0
                          └─ Transport.send(envelope) ── ssh -R / Tailscale ──▶ 127.0.0.1:47173 POST /remote/event
                                                                                ├─ verify HMAC, skew, nonce, rate
                                                                                ├─ drop anything not newer (seq)
                                                                                └─ remote/<device>/<sha256>.json
remote.js heartbeat --every 30 ── state of each live session ──────────────────▶ (same route, kind: heartbeat)
```

## Set up

1. **Pair on the desktop.** Open Preferences → Remote devices, name the
   machine, and click **Pair**. Buddy shows a pairing code once
   (`buddy-pair-v1.<device id>.<64 hex>`). Use it within 10 minutes. The
   code *is* the device's key and keeps working from any machine that has
   it, so keep it private. If it leaks or you lose it, revoke the device and
   pair again. Once copied, it is cleared from the clipboard after a minute.
   The panel shows the tunnel command for that device first, then the pair
   command.
2. **Open a path from the reporter to the desktop.** See the recipes below.
3. **Install reporter mode on the other machine.** It needs a Buddy checkout
   and Node 18+:

   ```bash
   git clone <this repo> ~/claude-buddy && cd ~/claude-buddy
   node hooks/install.js --remote http://127.0.0.1:47173   # or: node hooks/remote.js pair <url | unix:/path.sock>
   # paste the pairing code when asked (it isn't echoed)
   ```

   This saves `~/.claude-traffic-light/remote.json` with mode 0600. It then
   pings the desktop and adds the reporter hooks to `~/.claude/settings.json`:
   every Claude Code event runs `emit.js --adapter claude <Event>`. Only
   those entries are ever added or removed. Restart running Claude Code
   sessions afterwards.

   `BUDDY_PAIRING_CODE=… node hooks/remote.js pair …` also works, but a code
   typed on a command line ends up in your shell history.
4. **Run the heartbeat** (recommended) so a dead session or a sleeping
   machine drops off within 90 s, and a desktop that missed events catches
   up:

   ```bash
   node ~/claude-buddy/hooks/remote.js heartbeat --every 30    # in tmux, or a systemd user unit
   ```

`node hooks/remote.js status` checks the pairing end to end. It reports
failure if something other than your Buddy answers, since every real answer
is signed with the device's key. `node hooks/remote.js unpair` removes the
pairing and the reporter hooks. Revoke the device in Buddy as well.

### Same machine as a Buddy app

On a machine that runs Buddy itself, `pair` refuses and says why. It checks
for the app's `port`/`token` file or for Buddy's own `set-status.js` hooks.
That machine's sessions already show on its own widget. `pair --force`
reports them to another Buddy as well. The app's hooks stay untouched, and
`unpair` removes only the reporter's entries.

## Transport recipes

### SSH reverse tunnel (default; the desktop listens on loopback only)

The **device port** is the signal port + 1 (47173 by default;
`CLAUDE_TRAFFIC_LIGHT_REMOTE_PORT` overrides it). It is bound to 127.0.0.1
and serves `POST /remote/event` only. The signal server on 47172 (`/status`,
`/signal`, `/hook`) doesn't serve the device route at all. A tunnel pointed
at the wrong port gets a 401 or 404 and never sees the session list.
Settings shows whether the device port is listening. If it can't bind, the
reason appears there and nothing crashes. Dev and demo runs listen only when
the port is set explicitly.

Run this on the desktop:

```bash
ssh -o ExitOnForwardFailure=yes -N -R 127.0.0.1:47173:127.0.0.1:47173 devbox
```

This binds the far end to devbox's loopback. `ExitOnForwardFailure` makes
ssh quit rather than run silently when something on devbox already holds the
port, for example another user squatting on it. Pair with
`http://127.0.0.1:47173`. To use a different remote port, run
`-R 127.0.0.1:47999:127.0.0.1:47173` and pair with `http://127.0.0.1:47999`.

In `~/.ssh/config`:

```
Host devbox
  RemoteForward 127.0.0.1:47173 127.0.0.1:47173
  ExitOnForwardFailure yes
```

**On a host you share with other users, forward to a socket instead.** Other
users can connect to any loopback port, but not to a socket in your own
0700 directory:

```bash
ssh devbox 'mkdir -p ~/.claude-traffic-light/run && chmod 700 ~/.claude-traffic-light/run'
ssh -o ExitOnForwardFailure=yes -o StreamLocalBindUnlink=yes -N \
    -R /home/you/.claude-traffic-light/run/buddy.sock:127.0.0.1:47173 devbox
# on devbox:
node hooks/remote.js pair unix:/home/you/.claude-traffic-light/run/buddy.sock
```

The reporter refuses a socket whose directory isn't 0700 and owned by you.
`StreamLocalBindUnlink` lets a reconnecting tunnel replace a stale socket;
sshd's `StreamLocalBindMask` (default 0177) makes the socket owner-only.

### Tailscale (explicit opt-in)

Open Preferences → Remote devices, tick **Also accept devices over
Tailscale**, and click Save. Buddy asks the Tailscale CLI (`tailscale ip -4`,
or the app's bundled binary) for this Mac's address. It then checks that
address against the interfaces: `utunN` on macOS or `tailscale0` elsewhere,
a /32 IPv4 in 100.64/10, and an fd7a:115c:a1e0:: IPv6 on the same interface.
Only then does it open a *second* device listener on that address, on the
device port. Without the CLI, it uses a single unambiguous candidate. It
refuses, and says why in Settings, when:
- several interfaces look alike (other VPNs use utun and CGNAT addresses too),
- the only 100.64/10 address is on a non-Tailscale interface, or
- there is none at all.

It never binds 0.0.0.0 or a LAN address. It rechecks every minute.

Pair the reporter with `http://<mac's 100.x address>:47173`. Plain http is
allowed only to a literal Tailscale IPv4. The reporter also refuses that at
pair and status time if it has no tailnet address itself, since the traffic
would then cross whatever network is actually there. A `*.ts.net` name needs
https, because a name can resolve anywhere. Use a Tailscale ACL to limit who
can reach the Mac's port 47173.

Why the bind is acceptable: it is off by default. It is scoped to the one
interface Tailscale owns and to one authenticated route, and WireGuard
encrypts the traffic underneath.

## Wire format

`POST /remote/event`. The body is the envelope JSON (16 KB at most). The
headers are:

| header | value |
|---|---|
| `x-buddy-device` | device id (`[a-z0-9-]`, ≤ 32) |
| `x-buddy-ts` | sender's clock, ms since epoch |
| `x-buddy-nonce` | 32 hex characters, fresh for each request |
| `x-buddy-signature` | hex HMAC-SHA256(device key, `buddy-remote-v1\n<device>\n<ts>\n<nonce>\n<sha256(body)>`) |

The desktop checks the signature (constant-time) before it parses the body.
An unknown device id is checked against a dummy key, so it costs the same.
It then:
- rejects skew over 60 s either way,
- rejects a timestamp more than 60 s older than the latest one it has
  accepted from that device (its high-water mark, kept in `devices.json` to
  within 10 s). Once a nonce has expired, a wall clock stepped back can't let
  an old request through,
- rejects a nonce that device has used in the last 125 s (2 × skew + 5 s,
  on the monotonic clock, so a wall-clock step can't expire one early). Each
  device has its own nonce cache of up to 1000 entries. A full cache refuses
  that device only (429) and never evicts early,
- rate-limits each device (10 requests/s, bursts of 30, then 429),
- answers every request it verified with its own `x-buddy-signature` =
  HMAC(key, `buddy-remote-v1-resp\n<request nonce>\n<status>\n<sha256(body)>`).
  The reporter treats an unsigned or wrongly signed answer, even a 200, as
  failure.

Unknown, revoked, expired-unused and forged requests all get the same
unsigned 401.

```jsonc
{ "v": 1, "kind": "session", "device": "devbox-3f9a1c", "sentAt": "…",
  "events": [ { "source": "claude", "sessionId": "…", "seq": 1790000000123, "signal": "tool-use",
                "tool": "Bash", "cwd": "/srv/app", "askKind": null, "via": "tool-use", "fromSubagent": false } ] }  // ≤ 8
{ "v": 1, "kind": "heartbeat", "device": "…", "sentAt": "…",
  "sessions": [ { "source": "claude", "sessionId": "…", "seq": …, "signal": "stop", "tool": null, "cwd": "/srv/app", "updatedAt": "…" } ] }  // ≤ 64
{ "v": 1, "kind": "ping", "device": "…", "sentAt": "…" }
```

- `device` in the body must equal the signing device.
- The whole request, including the per-device session cap (64), is checked
  before anything is written. One bad event rejects it all.
- `seq` is per session and only goes up (`max(now ms, last + 1)`, kept in the
  reporter's session file). The desktop drops any event or heartbeat entry,
  a session-end included, that isn't newer than what it holds. A session-end
  leaves a tombstone in the device's `ended` file (0600, the latest 256), so
  not even a late event after a restart can bring the session back.
- A heartbeat entry creates or updates the session only when it is newer.
  Otherwise it just vouches that the session is still alive.
- Only the signal, the tool's name and the folder leave the reporter. The
  hook payload never does: prompts, tool inputs and transcript paths stay
  on the reporter.

### Hub-ready

Hooks never talk to the network themselves. They hand an envelope to
`Transport.create(config).send(envelope)` (`hooks/transport.js`), where each
transport validates its own address and auth fields
(`TRANSPORTS[name].validate`). `direct` is the only one built. A `hub`
transport will carry the same envelope over the runner's outbound WSS, with
extra fields (`run_id`, `fence`, per the board design §1/§5). Receivers ignore
fields they don't know, so hooks don't change when the hub takes over.

Design note for the hub (§5.3, offline gate): `emit.js` prints an adapter's
reply before it dispatches, and dispatch is fire-and-forget. That's fine for
lights. A hub gate that has to block a reply on "the hub acknowledged" will
need the send result *before* the reply is written. That would be a
synchronous, time-boxed path for that adapter alone, and it must not be
retrofitted onto every hook.

## How remote sessions behave on the desktop

- They are stored under `~/.claude-traffic-light/remote/<device id>/`, one
  file per session, named by a hash of source and id (so `Case` and `case`
  can't share a file on APFS). They are never stored in `sessions/`, which
  keeps the OMC/team scanner, git signals, stats and spend (all of which read
  local folders) away from them. The stale-file sweep covers them too.
- Every remote session carries three markers, any one of which says remote:
  `remote: true`, `device: "<device id>"`, and
  `sessionId: "remote:<device id>:<source>-<id>"`. `host` and `deviceName`
  are the device's name, for display only. A device can't be named after
  this machine. Log lines show `<device>:<id prefix>`.
- `cwd` and `tool` are display strings. Buddy strips:
  - control, zero-width, line/paragraph-separator and bidi characters
  - tag characters, variation selectors, CGJ, the Hangul/Braille/Khmer
    blanks and U+180E

  No-break spaces become plain spaces, and length is capped by code point,
  so a character is never cut in half. The same goes for the device's name.
- Remote sessions are left out of everything that acts on this machine:
  - terminal jumps and "go to the session that needs me" (which instead says
    "waiting on <device>")
  - roaming and knocking, and the knock demo
  - notification click-through
  - the Finder, editor, copy-path, terminal and shell click actions
- Notifications say "… on devbox" and "Retry it on devbox" rather than
  "Retry in the terminal". The Help window counts them ("3 sessions (1 on
  devbox)").
- Pids, host apps and the SessionStart `terminal` record are never taken
  from a remote. They are dropped when the event arrives and again when the
  file is read.
- A remote ask is never a blocking PermissionRequest: approvals are answered
  on their own machine.
- **Liveness** is judged on the desktop's clock. Every event refreshes the
  session. Once a heartbeat has vouched for a session, 90 s without one means
  it is gone. The pid check happens on the reporter, where it works. Sessions
  that no heartbeat has vouched for use the usual working/waiting stale
  windows. The device list counts live sessions only.
- **Back-off.** Only an answer signed by the desktop, arriving within half
  the timeout, counts as the desktop being there. A signed refusal (400,
  429) counts too, since the desktop is up. Silence, an unsigned or wrongly
  signed answer, or a slow one makes hooks skip dispatching for 30 s. The
  heartbeat ignores the back-off and re-syncs state once the path is back.
- **Sender cap.** At most four detached senders run at once. Each claims a
  slot file in `~/.claude-traffic-light/senders/`, and a slot older than
  10 s is reclaimed. Past the cap an event is dropped, and the next event or
  heartbeat carries the state.
- Writes to a remote session never wait. A request takes every lock it
  needs first and writes only if it got them all. If any lock is held, it
  writes nothing and gets a 503, and the next event or heartbeat carries the
  state.
  Refreshes of the widget are debounced to one per 200 ms.
- The heartbeat also deletes the reporter's own session files once their
  agent is gone and they're a day old.
- Revoking deletes the key and the device's session files at once.

## Threat notes

**An attacker on the tailnet, or another user on the reporter host, without
the device key:**

- Can't forge, alter or replay events. The signature covers the body digest,
  the device, the timestamp and the nonce. The timestamp must be within 60 s
  and nonces are tracked per device on a monotonic clock.
- Can't read the desktop's sessions (`/status`) or use `/signal` or `/hook`.
  The device port serves only the signed route. The signal server stays
  loopback-only and needs the local token for writes.
- **Squatting the tunnel port** (binding 127.0.0.1:47173 on the far host
  before the tunnel): `ExitOnForwardFailure` makes the tunnel fail loudly,
  and a unix socket in your 0700 directory removes the shared port entirely.
  A squatter still can't pass as the desktop, because answers are signed.
  But events already sent to it (session state, tool names, folder names)
  are visible to it, which is why the socket recipe is advised on shared
  hosts.
- Can hold at most 32 connections to the device port, each for up to about
  5.5 s (5 s header and request timeouts, checked every 500 ms, 1 s
  keep-alive, at most 20 headers). Bodies are capped at 16 KB before
  verification. An unknown device id costs the same HMAC as a real one.
- Learns nothing about which device ids exist: every refusal to an
  unverified request is the same unsigned 401.
- Can see that a device port exists, and when events flow.

**With a stolen device key (for example, the reporter is compromised):**

- Can set lights for that device's own sessions only: at most 64, labelled
  with the device's name, rate-limited to 10/s.
- Can't write outside `remote/<device>/`. Can't overwrite local sessions or
  another device's. Can't make the desktop open a path, run a command, jump
  to or knock on a terminal, or answer a permission prompt.
- Can put misleading text in a folder or tool name. It is shown as plain
  text: control and bidi characters are stripped, and the Settings list uses
  `textContent`.
- Revoking the device ends access immediately.

**Secrets:**
- `devices.json` (desktop) and `remote.json` (reporter) are written 0600 with
  an atomic rename. The desktop keeps the raw key, because an HMAC can't be
  verified from a hash.
- The pairing code is the device's key. It is shown once, stops working if
  unused for 10 minutes (once used, it works until revoked), isn't echoed
  when pasted (the prompt stays visible), and is cleared from the clipboard
  a minute after **Copy code**. Settings drops it on **Done**.
- Setup export never includes either file.
- A full enrollment-key exchange, so the code isn't the long-term key, is on
  the backlog.
