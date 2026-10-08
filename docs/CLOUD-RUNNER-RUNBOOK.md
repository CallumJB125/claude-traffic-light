# Cloud runner runbook (single team, on the hub Pi)

A cloud runner is the board runner run as an always-on service (`buddy-runner.service`) instead of
inside the desktop app. A card handed to it with **Run in the cloud** keeps working while laptops are
closed. This MVP is one runner for one team, on the same Pi as the hub, sharing nothing with the hub
except the loopback socket.

What is in the repo:

| Piece | Where |
|---|---|
| Unit, env template, tailnet-model drop-in, install + deploy scripts | `board/deploy/pi/` (`buddy-runner.service`, `runner.env.example`, `hermes-dgx.conf`, `install-runner.sh`, `deploy-runner.sh`) |
| Hosted mode (caps, per-run cgroup, checkout, provider keys) | `board/runner/hosted/` |
| Hub side (enrolment, placement, sealed provider keys) | `board/hub/hosted-runners.js`, migration `067_hosted_runners.sql`, `ACCOUNTS-API.md` "Cloud runners" |
| Board UI | Team page > Cloud runner; the hand-off dialog's "Run in the cloud" |

## What the Pi has today (read 2026-10-08, nothing changed)

Pi 5, Debian 13, kernel 6.12 aarch64, 4 cores, 15 GiB RAM, root on the 1 TB NVMe (about 845 GB
free). systemd 257, Node 24 at `/usr/bin/node`, git 2.47. Hub on `127.0.0.1:8787`, staging on
`:8788`, plus cloudflared, litestream, tailscaled. Docker is installed but disabled; there is no
podman, bubblewrap, uidmap or firejail. No AI CLI is installed. The kernel boots with
`cgroup_disable=memory` (from the firmware, not `cmdline.txt`), so the memory controller is off:
only `cpuset cpu io pids`. No LSM beyond `capability` (no Landlock, no AppArmor). DNS is MagicDNS.

## Owner steps, in order

Each step is safe to stop after. Nothing here touches staging.

### 1. Ship the hub with migration 067

The runner needs the hub's `hosted` enrolments, `placement` on dispatches, and the
`team_provider_configs` table.

```sh
ssh bondly-pi 'sudo -u buddyhub node /opt/buddy-hub/board/deploy/pi/backup.mjs'   # a rollback cannot undo a migration
PI="ssh bondly-pi" board/deploy/pi/deploy.sh        # the hub's usual deploy; migrations run on start
ssh bondly-pi 'curl -fsS http://127.0.0.1:8787/api/health'
```

Check that the hub has its encryption key (`BOARD_ENC_KEY`, the one that already seals integration
secrets). Without one, storing a provider key answers `POLICY_DENIED`.

### 2. The repo-token endpoint (blocking for real runs)

The runner clones and pushes with short-lived GitHub App installation tokens from
`GET /api/runner/v1/repo-token?repo_id=` (`{token, expires_at}`, authenticated by the runner token).
**That endpoint is being built separately and is not in this branch.** Until it ships, a hosted
offer cannot clone: the runner logs `NOT_AVAILABLE` and the offer stays queued (it is not failed).
The GitHub App needs `contents: write` on the repos you list in step 6.

### 3. Packages on the Pi

```sh
ssh bondly-pi
sudo apt install bubblewrap socat          # Claude Code's sandbox on Linux needs both
sudo install -d -m 0755 /opt/buddy-runner/cli
sudo npm i -g --prefix /opt/buddy-runner/cli @anthropic-ai/claude-code @openai/codex
/opt/buddy-runner/cli/bin/claude --version; /opt/buddy-runner/cli/bin/codex --version
```

The unit's `PATH` puts `/opt/buddy-runner/cli/bin` first. The install script never installs packages.

### 4. Optional: turn the memory controller on

Without it a run's memory is policed by a watchdog (it reads each process's RSS and kills the run's
cgroup over the cap) and the service as a whole has no hard memory limit. To get real `memory.max`:

```sh
sudo cp /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.bak
sudo sed -i '1 s/$/ cgroup_enable=memory/' /boot/firmware/cmdline.txt
sudo reboot        # the hub restarts too; plan a quiet moment
cat /sys/fs/cgroup/cgroup.controllers   # should now list memory
```

Unverified whether `cgroup_enable=memory` overrides the firmware's `cgroup_disable=memory` on this Pi.

### 5. Create the runner on the Team page

In the **desktop app** (a browser session cannot), as a team admin: Team > Cloud runner > Add a cloud
runner. It shows the runner token **once** and the team id. Then on the Pi:

```sh
sudo install -d -m 0700 /etc/buddy-runner
sudo sh -c 'umask 077; cat > /etc/buddy-runner/runner.token'   # paste the token, then Ctrl-D
```

The token is a credential file (`LoadCredential`), never an environment variable or a line in the env
file. Revoking the runner on the Team page (or `DELETE /api/teams/:id/enrolments/:id`) ends it.

### 6. Write runner.env

```sh
sudo cp /etc/buddy-runner/runner.env.example /etc/buddy-runner/runner.env   # the example lands there on step 7's first run; or copy board/deploy/pi/runner.env.example
sudoedit /etc/buddy-runner/runner.env
```

Set `BUDDY_RUNNER_TEAM` (the team id from step 5) and `BUDDY_RUNNER_REPOS` (the GitHub repos, each also
linked to one of the team's boards). Keep `BUDDY_RUNNER_HUB=http://127.0.0.1:8787`. Review the caps
(wall clock, tokens, dollars, CPU, tasks, memory per run). The install refuses to start while a
placeholder is left.

### 7. Install and start

From the laptop, at the commit you want:

```sh
PI="ssh bondly-pi" board/deploy/pi/deploy-runner.sh
```

It ships `board/` at HEAD, runs `npm ci` in the stage, and calls `install-runner.sh` as root, which
creates `buddyrunner` (system user, no shell, not in sudo/docker/adm), `/var/lib/buddy-runner` (0700),
`/opt/buddy-runner/board` (root-owned) and the unit, and starts it only if steps 5 and 6 are done. It
never touches `/var/lib/buddy-hub*`, `/etc/buddy-hub` or the hub's units.

### 8. Check it

```sh
ssh bondly-pi 'sudo systemctl status buddy-runner --no-pager; sudo journalctl -u buddy-runner -n 50 --no-pager -o cat'
ssh bondly-pi 'sudo systemd-analyze security buddy-runner'
ssh bondly-pi 'cd /opt/buddy-runner/board && sudo -u buddyrunner env $(sudo cat /etc/buddy-runner/runner.env | grep -v "^#" | xargs) BUDDY_RUNNER_HOME=/var/lib/buddy-runner HOME=/var/lib/buddy-runner/home PATH=/opt/buddy-runner/cli/bin:/usr/bin:/bin node runner/cli.js hosted-check'
```

`hosted-check` prints the sandbox, CLIs and hub reachability it would use, with no secrets. Run outside
the unit it cannot see the delegated cgroup, so "sandbox: unavailable" there is expected; the journal
of the real service is the proof. The Team page shows the runner **online** once it connects.

### 9. Provider keys

Team > Cloud runner > Provider keys: store a Claude (Anthropic API) key and/or a Codex (OpenAI) key, and
optionally a model. Keys are sealed on the hub and only ever sent to the cloud runner for one run's own
AI. With no stored key the CLI has nothing to sign in with and the run fails; the Team page shows which
providers have a key.

Hermes on the DGX (optional): store `hermes-dgx` with base URL `http://100.68.66.98:<port>`, set
`BUDDY_RUNNER_AIS=claude,codex,hermes-dgx` and `BUDDY_RUNNER_ALLOW_UNSANDBOXED=1`, then let the unit
reach it:

```sh
sudo install -m 0644 /etc/buddy-runner/hermes-dgx.conf.example /etc/systemd/system/buddy-runner.service.d/hermes-dgx.conf
sudo systemctl daemon-reload && sudo systemctl restart buddy-runner
```

Hermes has no sandbox of its own; its tools run as `buddyrunner` inside the run's cgroup only.

### 10. Smoke test

On a scratch card on a linked repo: Hand off > tick **Run in the cloud** > Run in the cloud. The card
shows "(cloud runner)", the run streams like any other, ends by pushing a branch, and the Team page's
recent runs show its cost (Claude only; Codex and Hermes report tokens, not dollars). Then cancel a
second run mid-way and check the journal shows its cgroup killed.

## Rollback

```sh
ssh bondly-pi 'sudo systemctl stop buddy-runner && sudo systemctl disable buddy-runner'
# previous code:
ssh bondly-pi 'sudo rm -rf /opt/buddy-runner/board && sudo mv /opt/buddy-runner/board.prev /opt/buddy-runner/board && sudo systemctl start buddy-runner'
```

Stopping the runner leaves hosted offers queued; ordinary (desktop) dispatches are unaffected.
Migration 067 is additive; the hub runs fine with no cloud runner. To remove everything: revoke the
runner on the Team page, delete the provider keys, then `sudo rm -rf /var/lib/buddy-runner
/etc/buddy-runner /opt/buddy-runner /etc/systemd/system/buddy-runner.service*` and `sudo userdel
buddyrunner`.

## Residual risks (accepted for the single-team MVP)

- **Same uid for every run.** All runs are `buddyrunner`. The per-run directory, cgroup and the CLIs'
  own sandboxes separate them, but a run that escaped its CLI sandbox could read another run's
  checkout. One team only, for that reason.
- **The git token in `/proc/<pid>/environ`** while one `git` process runs. Only `buddyrunner` processes
  can read it, the AI's shell never gets it, and it expires within the hour.
- **Hermes is unsandboxed** (opt-in, owner's own dispatches only).
- **No Landlock or AppArmor** on this kernel, so the Claude and Codex sandboxes rely on namespaces
  (bubblewrap) and seccomp; unverified on this arm64 kernel.
- **Egress:** the unit denies private ranges and the tailnet (except loopback, MagicDNS and the opt-in
  DGX address) but allows the public internet, which the AIs, npm and GitHub need.
- **Gemini** is not offered in the cloud (no headless sandboxed mode to rely on).
