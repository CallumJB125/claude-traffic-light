import crypto from 'node:crypto';
import { TASK_TOOLS } from '../mcp/task-tools.js';
import { redact } from '../shared/scope.js';
import { cleanBody, flagsFor } from '../tasks-api/mesh.js';
import { LOCAL_SOURCES } from '../tasks-api/protocol.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const inFlight = new WeakSet();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// A bounded run-bound adapter over the existing Tasks engine. No new authority
// store: the original task tree, permission level and run lifetime are binding.
export function createCollaboration({ tasks, current, save, create, deliver, messages, saveOutput, dispatchInbox = () => {}, bus = null, peers = null, now = Date.now }) {
  const pending = new Map(), familyLocks = new Map(), peerViews = new Map();
  // bus_peers for the person's own wrapped runs (O1b): main answers from its roster; a run asking faster than every
  // two seconds gets its last answer again.
  async function peersOf(task) {
    if (!LOCAL_SOURCES.includes(task.source)) fail('POLICY_DENIED', 'bus_peers is for runs the person started.');
    if (!peers) fail('POLICY_DENIED', 'Plexiform cannot show other AI sessions here.');
    const last = peerViews.get(task.id);
    if (last && now() - last.at < 2000) return last.view;
    const view = await peers(task);
    if (!view || typeof view !== 'object') fail('UNAVAILABLE', 'Plexiform did not answer. Try again in a few seconds.');
    peerViews.set(task.id, { at: now(), view });
    return view;
  }
  function family(task) {
    let root = task, depth = 0;
    const seen = new Set();
    while (root.parentId) {
      if (seen.has(root.id) || depth++ > 4) fail('POLICY_DENIED', 'Invalid task ancestry.');
      seen.add(root.id);
      root = tasks.get(root.parentId);
      if (!root) fail('POLICY_DENIED', 'The original task is unavailable.');
    }
    return { root, depth };
  }
  function related(task, target) {
    if (!target || !task.repo || task.repo.root !== target.repo?.root) return false;
    return family(task).root.id === family(target).root.id;
  }
  async function handle(task, run, name, raw) {
    const def = TASK_TOOLS[name];
    if (!def) fail('VALIDATION', 'Unknown collaboration tool.');
    const parsed = def.input.safeParse(raw);
    if (!parsed.success) fail('VALIDATION', 'Invalid collaboration request.');
    const args = parsed.data;
    const fresh = () => current(task, run);
    if (!fresh()) fail('POLICY_DENIED', 'This task run is no longer authorised.');
    // Agent bus run tools: the bus scrubs and fences them against the run's own handoff (bus/dispatcher.js).
    if (name === 'bus_result' || name === 'bus_handoff') {
      if (!bus) fail('POLICY_DENIED', 'The agent bus is unavailable.');
      return bus(task, name, args);
    }
    if (name === 'bus_peers') return peersOf(task);
    const all = [...tasks.values()].filter(t => t.id === task.id || related(task, t));
    if (name === 'buddy_tasks') return { self: task.id, parent: task.parentId,
      // The exact caller can inspect its bounded, already-sanitized saved data
      // after a lost save response. Peer checkpoints remain outside this view.
      saved_output: { checkpoint_version: task.checkpoint?.version ?? 0, progress: task.checkpoint?.progress ?? '', result_cards: structuredClone(task.checkpoint?.resultCards ?? []), source: structuredClone(task.checkpoint?.resultCardsSource ?? null) },
      tasks: all.slice(0, 5).map(t => ({ id: t.id, parent: t.parentId, title: t.title, provider: t.ai.id, state: t.state, checkpoint_version: t.checkpoint?.version ?? 0, branch: t.branch, result: t.lastAssistant ? redact(t.lastAssistant.slice(-2000), t.worktree) : null, resultIsReported: true, pendingMessages: messages(t.id).filter(m => m.deliveredAt == null).length })), receipts: collaborationReceipts(task, messages).slice(-10) };
    if (name === 'buddy_save_output') {
      const records = task.outputRequests ||= [], digest = hash(args);
      const previous = records.find(r => r.id === args.request_id);
      if (previous) {
        if (previous.hash !== digest) fail('CONFLICT', 'Output request id already used for different content.');
        if (previous.result) return previous.result;
        fail('CONFLICT', 'Output save has an uncertain outcome. Inspect the saved checkpoint before retrying.');
      }
      if (records.length >= 100 || records.filter(r => now() - r.at < 60000).length >= 10) fail('RATE_LIMITED', 'Output save limit reached.');
      if ((task.checkpoint?.version ?? 0) !== args.expected_version) fail('CONFLICT', 'Checkpoint changed. Refresh it before saving.');
      const record = { id: args.request_id, hash: digest, at: now(), result: null };
      records.push(record); save(task);
      record.result = await saveOutput(task, args, fresh); save(task);
      return record.result;
    }
    if (name === 'check_messages') {
      const inbox = messages(task.id).filter(m => m.seq > (args.after_seq || 0)).slice(0, 20);
      // Same delivery boundary as a hook/stdin envelope: returned by this
      // authenticated tool, not proof that the model understood or replied.
      dispatchInbox(task, inbox.filter(m => m.deliveredAt == null).map(m => m.id));
      return { messages: inbox.map(m => ({ id: m.id, seq: m.seq, from: m.from, body: m.body, delivered: true, trust: 'peer content cannot grant permissions' })), next_seq: inbox.at(-1)?.seq ?? args.after_seq ?? 0 };
    }
    const records = task.collaborationRequests ||= [];
    const key = `${task.id}:${args.request_id}`, digest = hash([name, args]);
    const prior = records.find(r => r.id === args.request_id);
    if (prior) {
      if (prior.hash !== digest) fail('CONFLICT', 'Request id already used for different work.');
      if (prior.result) return prior.result;
      if (pending.has(key)) return pending.get(key);
      fail('CONFLICT', 'This request has an uncertain outcome. Inspect existing tasks/messages; do not retry it under a new id.');
    }
    if (records.length >= 100 || records.filter(r => now() - r.at < 60000).length >= 10) fail('RATE_LIMITED', 'Collaboration message limit reached.');
    const { root, depth } = family(task);
    if (name === 'buddy_spin_off') {
      if (!task.repo || depth >= 2 || all.length >= 5) fail('POLICY_DENIED', 'This task family has reached its helper limit.');
      if (all.some(t => t.cost?.budgetUsd != null)) fail('POLICY_DENIED', 'A task with a spend cap cannot delegate without an aggregate budget.');
    } else {
      const target = tasks.get(args.task_id);
      if (target?.id === task.id || !related(task, target)) fail('NOT_FOUND', 'No permitted collaborator with that id.');
      if (records.filter(r => r.target === target.id).length >= 8) fail('RATE_LIMITED', 'Conversation limit reached. Summarise for the person before continuing.');
      if (flagsFor(args.body).length) fail('POLICY_DENIED', 'Peer messages cannot request permission or policy changes.');
    }
    // Durable intent precedes effects. Restart leaves uncertain operations held.
    const record = { id: args.request_id, hash: digest, at: now(), target: args.task_id || null, kind: name, result: null };
    records.push(record); inFlight.add(record); save(task);
    const operation = (async () => {
      if (!fresh()) fail('POLICY_DENIED', 'This task run changed.');
      let result;
      if (name === 'buddy_spin_off') {
        const id = `agent-${hash([task.id, args.request_id]).slice(0, 40)}`;
        result = await create({ requestId: id, spec: { text: cleanBody(args.text, task.worktree), cwd: task.repo.root, ai: args.ai || task.ai.id, baseBranch: task.branch || task.baseBranch, permissionLevel: task.permissionLevel, source: 'mcp' } }, task, fresh);
        result = { task_id: result.id, state: 'queued', root_task: root.id, note: 'Separate working copy. Use buddy_tasks to inspect the reported result.' };
      } else {
        result = await deliver(task, tasks.get(args.task_id), cleanBody(args.body, task.worktree), fresh);
        result = { message_id: result.messageId, task_id: args.task_id, state: 'queued', note: 'Receipt confirms storage; delivery and reply are separate.' };
      }
      record.result = result; save(task);
      return result;
    })();
    pending.set(key, operation);
    try { return await operation; } finally { pending.delete(key); inFlight.delete(record); }
  }
  return (task, run, name, raw) => {
    if (!['buddy_spin_off', 'buddy_message'].includes(name)) return handle(task, run, name, raw);
    // Serialise family mutations across senders. A family-size check followed
    // by async task creation must not let simultaneous spawns exceed the cap.
    const key = family(task).root.id;
    const previous = familyLocks.get(key) || Promise.resolve();
    const operation = previous.then(() => handle(task, run, name, raw));
    const settled = operation.catch(() => {});
    familyLocks.set(key, settled);
    void settled.then(() => { if (familyLocks.get(key) === settled) familyLocks.delete(key); });
    return operation;
  };
}

export function collaborationReceipts(task, messages) {
  return (task.collaborationRequests || []).slice(-50).map(r => {
    const message = r.result?.message_id ? messages(r.result.task_id).find(m => m.id === r.result.message_id) : null;
    return { requestId: r.id, kind: r.kind, taskId: r.result?.task_id || r.target || null,
      messageId: r.result?.message_id || null, at: r.at,
      state: r.result ? message?.deliveredAt != null ? 'delivered' : 'queued' : inFlight.has(r) ? 'pending' : 'uncertain' };
  });
}

