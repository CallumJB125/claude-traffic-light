// A reviewed provider handover reuses the task's isolated worktree and existing
// checkpoint. No conversation/session ID, model or plan approval crosses AIs.
import crypto from 'node:crypto';
const TTL = 5 * 60_000;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = () => Object.assign(new Error('The provider handover needs a fresh review.'), { code: 'CONFLICT' });
export const workspaceBinding = capture => ({ source: capture.source, tree: capture.tree });
export function createProviderSwitch({ inspectSource, readPending = () => [], now = Date.now }) {
  const reviews = new Map();
  const pending = task => {
    const rows = readPending(task).map(m => ({ id: m.id, body: m.body, from: m.from }));
    if (rows.length > 64 || Buffer.byteLength(JSON.stringify(rows)) > 64 * 1024) throw Object.assign(new Error('Too many queued messages for a provider handover.'), { code: 'POLICY_DENIED' });
    return structuredClone(rows);
  };
  async function preview(task, target, current) {
    const messages = pending(task), c = await inspectSource(task, current);
    if (!current() || hash(messages) !== hash(pending(task))) throw conflict();
    const id = crypto.randomUUID(), expiresAt = now() + TTL;
    const review = { status: 'review', from: task.ai.id, to: target.id, permissionLevel: task.permissionLevel,
      planFirst: task.planFirst, budgetUsd: task.cost.budgetUsd, spentUsd: task.cost.usd,
      contextVersion: task.checkpoint?.version ?? 0, handover: task.handover?.markdown ?? '',
      messagesText: messages.map(m => `${m.from.kind === 'human' ? 'User' : 'Participant'}: ${m.body}`).join('\n\n'),
      branch: task.branch, files: c.files, patch: c.patch, expiresAt };
    const digest = hash({ c, target, review });
    for (const [key, value] of reviews) if (value.expiresAt <= now()) reviews.delete(key);
    while (reviews.size >= 100) reviews.delete(reviews.keys().next().value);
    reviews.set(id, { task, c, messages, target: structuredClone(target), digest, expiresAt, review });
    return { ...review, id, hash: digest };
  }
  async function apply(task, id, digest, getTarget, current) {
    const r = reviews.get(id); reviews.delete(id);
    if (!r || r.task !== task || r.digest !== digest || r.expiresAt <= now()) throw conflict();
    const fresh = () => current() && now() < r.expiresAt && hash(getTarget(r.target.id)) === hash(r.target) && hash(pending(task)) === hash(r.messages);
    if (!fresh()) throw conflict();
    const c = await inspectSource(task, fresh);
    if (!fresh() || hash(c) !== hash(r.c)) throw conflict();
    return { to: r.target.id, from: r.review.from, contextVersion: r.review.contextVersion, messages: structuredClone(r.messages),
      workspaceReview: { ...workspaceBinding(c), expiresAt: r.expiresAt } };
  }
  return { preview, apply };
}
