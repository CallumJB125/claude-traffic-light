#!/usr/bin/env node
// Opt-in REAL smoke test (not part of `npm test`; costs real money, < $0.10):
// runs the member's own `claude --model haiku` once end-to-end through the
// supervisor with the full isolation profile, against a fake hub and a temp
// git repo, and checks exit (j) + Gap A on the real CLI:
//   - system/init: tools ⊆ the profile's tools + mcp__board__*, mcp_servers = [board]
//   - the Bash tool shows no user aliases/functions (`alias`, `type rm`)
//   - hooks reached the runner (SessionStart, Pre/PostToolUse facts)
//   - the run ends via board_complete, cost < $0.10
// BOARD_MCP_SERVER overrides the board MCP server path (default: board/mcp/server.js,
// else the sibling ctl-board-mcp worktree, else a minimal test stub).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supervisor, findOnPath } from '../supervisor.js';
import { makeLogger } from '../util.js';
import { MCP_SERVER, TOOLS } from '../launch.js';
import { startFakeHub, makeRepo, tmpDir, rm, offerFor, waitFor, REPO_ID, OWNER } from '../test/helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUDGET = 0.05;

function mcpServerPath() {
  if (process.env.BOARD_MCP_SERVER) return process.env.BOARD_MCP_SERVER;
  if (fs.existsSync(MCP_SERVER)) return MCP_SERVER;
  const sibling = path.resolve(HERE, '../../../../ctl-board-mcp/board/mcp/server.js');
  if (fs.existsSync(sibling)) return sibling;
  return path.join(HERE, '..', 'test', 'fixtures', 'stub-mcp.js');
}

// zsh's own defaults (present with no rc files at all) are not user aliases.
const ZSH_DEFAULT_ALIASES = new Set(['run-help', 'which-command']);
function aliasLines(out) {
  return out.split('\n').filter((l) => /^(alias )?[\w.-]+=/.test(l) && !/^FNCOUNT=/.test(l) && !ZSH_DEFAULT_ALIASES.has(l.replace(/^alias /, '').split('=')[0]));
}

const PROBE = 'alias; echo "FNCOUNT=$(typeset +f 2>/dev/null | wc -l | tr -d " ")"; type rm';

async function main() {
  const claude = findOnPath('claude');
  if (!claude) throw new Error('no `claude` on PATH');
  const root = tmpDir('brs-');
  const hub = await startFakeHub();
  const repo = makeRepo(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(path.join(home, 'device.json'), JSON.stringify({ hub: 'http://127.0.0.1', device_id: 'dev-smoke', device_token: 'bdt_smoke' }), { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'policy.json'), JSON.stringify({
    repos: { [REPO_ID]: { opt_in: true, local_path: repo.checkout, model: 'haiku', budget_per_run: BUDGET } },
    accept_from: {}, backends: { claude }, never_auto_labels: [],
  }), { mode: 0o600 });
  const body = [
    'This is an automated isolation probe. Do exactly these steps and nothing else:',
    `1. Run this exact Bash command once: ${PROBE}`,
    '2. Call board_update_status with summary "probe done".',
    '3. Call board_complete with summary "probe done" and evidence_ids [].',
    'Then stop.',
  ].join('\n');
  hub.rpcReply = (f) => {
    if (f.method === 'board_get_card') return { ok: true, result: { card: { key: 'SMK-1', title: 'Isolation probe', body }, acceptance: 'The probe ran.', handover_md: '', open_asks: [], comments: [] } };
    if (f.method === 'board_complete') return { ok: true, result: { state: 'in_review' } };
    if (f.method === 'board_declare_plan' || f.method === 'board_check_overlap') return { ok: true, result: { overlaps: [], locks: [] } };
    if (f.method === 'approval') {
      // Nothing in the probe should need a prompt; if one comes, record and allow it as the owner.
      const prid = `pr-${hub.of('rpc').length}`;
      setTimeout(() => hub.send({ type: 'answer', run_id: f.run_id, card_id: f.card_id, fence: f.fence, permission_request_id: prid, decision: 'allow', answered_by: { member_id: OWNER, name: 'Owner' } }), 50);
      return { ok: true, result: { permission_request_id: prid } };
    }
    return { ok: true, result: {} };
  };
  const mcp = mcpServerPath();
  const sup = new Supervisor({ home, hubUrl: hub.url, claudeBin: claude, mcpServer: mcp, env: process.env, log: makeLogger(process.stderr, { quiet: !process.env.BOARD_SMOKE_LOG }), gitleaks: null });
  await sup.start();
  await waitFor(() => sup.connected, { what: 'connected' });

  const report = { claude, mcp_server: mcp, ok: false };
  const raws = [];
  const t0 = Date.now();
  try {
    const offer = offerFor({ key: 'SMK-1', title: 'Isolation probe', seed: {} });
    offer.budget_usd = BUDGET;
    offer.max_turns = 6;
    hub.send(offer);
    const run = await waitFor(() => [...sup.runs.values()][0], { what: 'run', timeout: 20000 });
    await waitFor(() => run.backend, { what: 'spawned', timeout: 20000 });
    run.backend.on('raw', (m) => raws.push(m));
    report.argv = run.backend.argv();
    const ended = await waitFor(() => run.ended || raws.some((m) => m.type === 'result'), { what: 'result', timeout: 240000, interval: 250 });
    if (!run.ended) await waitFor(() => run.ended, { what: 'ended', timeout: 30000, interval: 250 }).catch(() => null);
    report.ended = ended && run.ended;
    report.end_reason = run.endReason;
    const init = raws.find((m) => m.type === 'system' && m.subtype === 'init');
    const results = raws.filter((m) => m.type === 'result');
    report.init = init ? { tools: init.tools, mcp_servers: init.mcp_servers, permissionMode: init.permissionMode, model: init.model } : null;
    report.cost_usd = results.reduce((a, r) => Math.max(a, r.total_cost_usd ?? 0), 0);
    report.result = results.map((r) => ({ subtype: r.subtype, num_turns: r.num_turns, terminal_reason: r.terminal_reason }));
    const toolUses = raws.filter((m) => m.type === 'assistant').flatMap((m) => m.message.content.filter((c) => c.type === 'tool_use'));
    const probeUse = toolUses.find((c) => c.name === 'Bash' && /type rm/.test(c.input?.command ?? ''));
    const probeResult = probeUse && raws.filter((m) => m.type === 'user').flatMap((m) => (Array.isArray(m.message.content) ? m.message.content : [])).find((c) => c.tool_use_id === probeUse.id);
    const probeOut = probeResult ? (typeof probeResult.content === 'string' ? probeResult.content : JSON.stringify(probeResult.content)) : null;
    report.probe_output = probeOut;
    report.user_alias_lines = probeOut ? aliasLines(probeOut) : null;
    report.approval_prompts = hub.of('rpc').filter((f) => f.method === 'approval').map((f) => f.params.input_summary);
    report.tool_calls = toolUses.map((c) => c.name);
    await waitFor(() => sup.outbox.acked === sup.outbox.head, { what: 'drained', timeout: 5000 }).catch(() => null);
    report.hub = {
      activity: hub.outs('activity').length,
      facts: [...new Set(hub.facts().map((f) => f.kind))],
      status: hub.outs('status.update').map((m) => m.summary),
      rpcs: hub.of('rpc').map((f) => f.method),
      snapshots: hub.outs('snapshot').map((s) => `${s.status} ${s.ref}`),
      failed: hub.outs('run.failed'),
    };
    const allowed = new Set(TOOLS.split(','));
    const checks = {
      init_seen: !!init,
      tools_are_ours: !!init && init.tools.every((t) => allowed.has(t) || t.startsWith('mcp__board__')),
      mcp_only_board: !!init && init.mcp_servers.every((s) => s.name === 'board'),
      board_connected: !!init && init.mcp_servers.some((s) => s.name === 'board' && s.status === 'connected'),
      probe_ran: probeOut != null,
      no_user_aliases: probeOut != null && aliasLines(probeOut).length === 0,
      no_user_functions: probeOut != null && /FNCOUNT=0\b/.test(probeOut),
      rm_is_binary: probeOut != null && /rm is \/bin\/rm/.test(probeOut),
      hooks_reached_runner: report.hub.facts.includes('tool_start') && report.hub.facts.includes('session'),
      cost_under_10c: report.cost_usd < 0.10,
    };
    report.checks = checks;
    report.ok = Object.values(checks).every(Boolean);
    report.elapsed_s = Math.round((Date.now() - t0) / 1000);
  } finally {
    await sup.shutdown();
    await hub.close();
    if (!process.env.BOARD_SMOKE_KEEP) rm(root); else report.kept = root;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(2); });
