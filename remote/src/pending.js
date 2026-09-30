// The desktop's view of permission requests still waiting on a hook.
//
// PendingRequest {
//   requestId, sessionId, cardId|null, toolName, toolInput, cwd,
//   ownerId,              // member who owns the session (runner: whose machine)
//   assigneeIds?: [],     // card assignees (runner sessions; hub-supplied, untrusted)
//   runner?: boolean,     // started by the board runner
//   repoLabels?: [],      // desktop-assigned labels, e.g. ['prod']
//   createdAt
// }
//
// A store has get(requestId) and settle(requestId, decision, meta), which
// resolves to one of:
//   'applied'          this answer won and the hook confirmed it acted on it
//   'already-answered' someone else (desk, another device) answered first
//   'refused'          the hook rejected it (input hash mismatch)
//   'unconfirmed'      written, but the hook never confirmed — not applied
// node/file-store.js implements the same contract over the widget's files.
export class MemoryPendingStore {
  constructor({ onSettle = () => 'applied' } = {}) {
    this.items = new Map();
    this.onSettle = onSettle;
  }

  add(req) {
    this.items.set(req.requestId, { ...req, settled: null });
    return req;
  }

  async get(requestId) {
    const r = this.items.get(requestId);
    return r && !r.settled ? { ...r } : null;
  }

  // Synchronous check-and-set, so two concurrent settles can't both win.
  async settle(requestId, decision, meta = {}) {
    const r = this.items.get(requestId);
    if (!r || r.settled) return 'already-answered';
    r.settled = { decision, ...meta };
    return (await this.onSettle(r, decision, meta)) || 'applied';
  }

  settledOf(requestId) {
    return this.items.get(requestId)?.settled ?? null;
  }
}
