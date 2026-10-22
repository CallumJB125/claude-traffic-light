// Agent bus test harness: the real engine, transport, dispatcher and Codex
// adapter on temp dirs; only the Codex CLI is the subscription-free fixture.
import { IpcClient } from '../../mcp/ipc.js';
import { startCodexFixture } from './codex-helpers.js';
import { writePolicy, waitFor } from './helpers.js';

let n = 0;
export const rid = (p = 'req') => `${p}-${process.pid}-${++n}-${Date.now().toString(36)}`;

export async function startBus(scenario = { text: 'Done' }, { policy, engineOpts = {} } = {}) {
  const h = await startCodexFixture(scenario, { tickMs: 50, ...engineOpts });
  writePolicy(h.dataDir, policy ? policy(h.repo.checkout) : { repos: { [h.repo.checkout]: { bus_auto: true } } });
  const caller = { provider: 'claude', cwd: h.repo.checkout };
  const clients = [];
  // What main does on every helper connection: until it has, the dispatcher starts nothing.
  const ready = () => h.client.bus('busSetContext', {}, null);
  await ready();
  return {
    ready,
    h, caller,
    get engine() { return h.eng.engine; },
    bus: (op, args = {}, c = caller) => h.client.bus(op, args, c, { timeoutMs: 150_000 }),
    handoff: (args = {}, c = caller) => h.client.bus('handoff', { request_id: rid('hof'), to: { provider: 'codex' }, title: 'Fix the parser', brief: 'Grammar done, tests not.', provider: 'claude', ...args }, c),
    taskOf: (handoffId) => [...h.eng.engine.tasks.values()].find((t) => t.sourceMeta?.handoffId === handoffId),
    /** The run's own per-run MCP channel, as Codex's board server uses it. */
    async ipc(taskId) {
      const run = await waitFor(() => h.eng.engine.runs.get(taskId)?.ipc && h.eng.engine.runs.get(taskId), { label: 'run ipc' });
      const c = new IpcClient({ socketPath: run.socketPath, token: run.token });
      clients.push(c);
      return c;
    },
    async cleanup() { for (const c of clients) c.close(); await h.cleanup(); },
  };
}
