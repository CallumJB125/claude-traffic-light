// Agent bus test harness: the real engine, transport, dispatcher and Codex
// adapter on temp dirs; only the Codex CLI is the subscription-free fixture.
import { IpcClient } from '../../mcp/ipc.js';
import { startCodexFixture } from './codex-helpers.js';
import { writePolicy, waitFor } from './helpers.js';
import { parentBus } from '../parent-bus.js';
import { MAIN_ONLY } from '../engine.js';

let n = 0;
let parentSeq = 0;
// One parentPort round trip through the same handler utility-entry.js uses: a reply, or an error with its code.
export async function viaParent(engine, op, args = {}) {
  const r = await parentBus(engine, structuredClone({ type: 'tasks.bus', id: `t${++parentSeq}`, op, args }));
  if (!r) throw Object.assign(new Error('ignored'), { code: 'IGNORED' });
  if (!r.ok) throw Object.assign(new Error(r.code), { code: r.code });
  return r.result;
}
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
    // Main's path for each op, as the app takes it: the note ops over parentPort (parent-bus.js, what
    // utility-entry.js runs), everything else over the socket. socketBus is the socket, for any op.
    bus: (op, args = {}, c = caller) => (MAIN_ONLY.has(op) ? viaParent(h.eng.engine, op, args) : h.client.bus(op, args, c, { timeoutMs: 150_000 })),
    socketBus: (op, args = {}, c = caller) => h.client.bus(op, args, c, { timeoutMs: 150_000 }),
    viaParent: (op, args = {}) => viaParent(h.eng.engine, op, args),
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
