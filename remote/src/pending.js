// The desktop's view of permission requests still waiting on a hook.
//
// PendingRequest {
//   requestId, sessionId, cardId|null, toolName, toolInput, cwd,
//   ownerId,              // member who owns the session (runner: whose machine)
//   assigneeIds?: [],     // card assignees (runner sessions)
//   runner?: boolean,     // started by the board runner
//   repoLabels?: [],      // desktop-assigned labels, e.g. ['prod']
//   createdAt
// }
//
// A store has get(requestId) and settle(requestId, decision, meta) → boolean.
// settle is first-wins: exactly one caller (desk click, phone, teammate) gets
// true; the rest get false. node/file-store.js implements the same contract
// over the widget's requests directory.
export class MemoryPendingStore {
  constructor({ onSettle = () => {} } = {}) {
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
    if (!r || r.settled) return false;
    r.settled = { decision, ...meta };
    await this.onSettle(r, decision, meta);
    return true;
  }

  settledOf(requestId) {
    return this.items.get(requestId)?.settled ?? null;
  }
}
