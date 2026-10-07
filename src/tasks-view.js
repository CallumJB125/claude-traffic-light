// Pure view helpers for the Tasks page: error words, ages, list rows, the
// capped transcript buffer, message status and composer limits. Loaded by the
// page as a plain script (window.TasksView) and by node:test.
// All strings go to the DOM through textContent only.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TasksView = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Same numbers as board/tasks-api/protocol.js and TASKS-CONTRACT.md §5.1/§8.6 (a unit test pins them).
  const LIMITS = Object.freeze({ taskText: 20000, message: 8192, answer: 20000, note: 4000 });

  // Every contract error code in plain words. The server's own message is never shown.
  const ERROR_TEXT = Object.freeze({
    VALIDATION: 'That did not look right. Check what you entered and try again.',
    UNAUTHENTICATED: "The background helper did not accept this app's key. Restart the helper and try again.",
    FORBIDDEN: 'The helper’s key file is readable by other users on this Mac, so it was not used. Fix its permissions (owner only) and try again.',
    POLICY_DENIED: 'That is not allowed by this project’s rules.',
    NOT_FOUND: 'That task, request or recipient no longer exists.',
    ILLEGAL_TRANSITION: 'The task is not in a state where that can be done any more. It has been refreshed.',
    CONFLICT: 'That request was already sent with different details.',
    ALREADY_ANSWERED: 'Someone else answered this first.',
    PAYLOAD_TOO_LARGE: 'That is too long to send.',
    BUDGET_EXCEEDED: 'This task has used up its budget (or its message allowance).',
    PROTOCOL_UNSUPPORTED: 'This app and the background helper are different versions. Update Plexiform and restart the helper.',
    CONFIRM_REQUIRED: 'That needs your confirmation first.',
    RATE_LIMITED: 'Too many messages too quickly. Wait a minute and try again.',
    INTERNAL: 'The background helper hit a problem. Try again in a moment.',
    PLAN_REQUIRED: 'Run tonight is part of Plus. Pick "Start now" or "When my limit resets" instead.',
    HUB_UNREACHABLE: 'The team board is not reachable right now, so this board card cannot be changed from here.',
    UNKNOWN_METHOD: 'The background helper does not understand that request. Update it and try again.',
    AI_UNAVAILABLE: 'That AI is not installed or not logged in on this Mac.',
    CAPABILITY_MISSING: 'That AI cannot do what this task needs in the background. Pick another AI or a different permission level.',
    NO_HANDOVER: 'There is no saved handover yet, so the AI cannot be switched.',
    IN_PLACE_BUSY: 'Another task is already working directly in that folder. Wait for it or use a different folder.',
    SESSION_BUSY: 'The terminal session is still open. Close it, then hand the task back.',
    MERGE_CONFLICT: 'The changes do not merge cleanly. Ask the AI to rebase, or open a pull request instead.',
    DISK_FULL: 'There is not enough disk space to start the task.',
    HUB_OWNED: 'Board cards are changed from the board, not here.',
    TIMEOUT: 'The background helper took too long to answer. It may be busy; try again.',
    NO_ROUTE: 'There is nowhere to send that from this Mac.',
    SUPERVISOR_UNREACHABLE: "The background helper isn't running, so nothing could be sent.",
  });
  const errorText = (code) => ERROR_TEXT[code] || ERROR_TEXT.INTERNAL;

  const TERMINAL = new Set(['done']);
  // Needs a person first, then live work, then waiting, then finished.
  const RANK = { blocked: 0, orphaned: 0, unresponsive: 1, failed: 1, in_review: 1, parked: 2, suspended: 2, handed_over: 3, running: 4, quiet: 4, claimed: 5, handing_over: 5, queued: 6, done: 9 };

  function ageText(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const s = Math.floor(ms / 1000);
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  }

  const AI_NAME = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };

  // A list row from a main-sanitised task. `unread` is a count kept by main.
  function rowView(task, now = Date.now()) {
    return {
      id: task.id,
      title: task.title || 'Untitled task',
      label: task.label,
      tone: task.tone || 'grey',
      green: task.green === true,
      reason: task.reason || '',
      ai: AI_NAME[task.ai?.id] || 'AI',
      where: task.repo?.name || task.where || '',
      age: ageText(now - (task.stateSinceMs ?? now)),
      unread: task.unread > 0 ? task.unread : 0,
      board: !!task.hub,
      stale: task.stale === true,
    };
  }

  function sortTasks(tasks) {
    return [...tasks].sort((a, b) => ((RANK[a.state] ?? 7) - (RANK[b.state] ?? 7)) || ((b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)));
  }

  // ── transcript: chunked events → a bounded list of items ──
  const CAPS = Object.freeze({ items: 1500, chars: 400000 });

  function newTranscript() { return { items: [], chars: 0, dropped: 0, lastSeq: 0 }; }

  function trim(t, caps) {
    while (t.items.length > caps.items || (t.chars > caps.chars && t.items.length > 1)) {
      const first = t.items.shift();
      t.chars -= first.text ? first.text.length : 0;
      t.dropped += 1;
    }
  }

  // Returns true when the event changed the transcript. Duplicates (seq already seen) are ignored.
  function addEvent(t, e, caps = CAPS) {
    if (!e || (e.seq && e.seq <= t.lastSeq)) return false;
    if (e.seq) t.lastSeq = e.seq;
    if (e.type === 'transcript') {
      const last = t.items[t.items.length - 1];
      if (last && last.kind === 'text' && last.open && last.role === e.role && last.turn === e.turn) {
        last.text += e.text;
        last.open = !!e.partial;
        t.chars += e.text.length;
      } else {
        t.items.push({ kind: 'text', role: e.role, turn: e.turn, text: e.text, open: !!e.partial });
        t.chars += e.text.length;
      }
    } else if (e.type === 'tool') {
      if (e.phase === 'end') {
        const start = [...t.items].reverse().find((i) => i.kind === 'tool' && i.toolUseId === e.toolUseId);
        if (start) { start.done = true; start.ok = e.ok; start.durationMs = e.durationMs; return true; }
      }
      t.items.push({ kind: 'tool', toolUseId: e.toolUseId, name: e.name, summary: e.summary, done: e.phase === 'end', ok: e.ok, durationMs: e.durationMs });
    } else if (e.type === 'error') {
      t.items.push({ kind: 'note', text: errorText(e.code) });
      t.chars += t.items[t.items.length - 1].text.length;
    } else return false;
    trim(t, caps);
    return true;
  }

  // ── messages ──
  // A message you typed sits in the task's thread as an inbound one from a human; "out" is what the task itself sent.
  const isMine = (m) => m.from?.kind === 'human';
  function messageStatus(m) {
    if (!isMine(m) && m.direction !== 'out') return m.quarantined ? 'Flagged as suspicious, not shown to the AI as an instruction' : '';
    if (m.readAt != null) return m.source === 'notes' ? 'Read (from its notes)' : 'Read';
    if (m.deliveredAt != null) return 'Delivered';
    return 'Waiting to be delivered';
  }
  function partyName(p) {
    if (!p) return '';
    if (p.kind === 'human') return 'You';
    return p.label || p.id || '';
  }

  // Applies a message / message-state event to a list, keeping one entry per id.
  function mergeMessage(list, e) {
    if (e.type === 'message-state') {
      const m = list.find((x) => x.id === e.id);
      if (m) { m.deliveredAt = e.deliveredAt; m.readAt = e.readAt; m.source = e.source; return true; }
      return false;
    }
    if (list.some((x) => x.id === e.id)) return false;
    list.push(e);
    if (list.length > 300) list.shift();
    return true;
  }

  // ── composer ──
  function validateDraft(d) {
    const text = String(d.text ?? '').trim();
    if (!text) return { ok: false, error: 'Say what you want done first.' };
    if (text.length > LIMITS.taskText) {
      const over = text.length - LIMITS.taskText;
      return { ok: false, error: `That is ${over} character${over === 1 ? '' : 's'} over the ${LIMITS.taskText.toLocaleString('en')} limit.` };
    }
    if (!d.hasFolder) return { ok: false, error: 'Choose the folder it should work in.' };
    return { ok: true };
  }
  function validateMessage(body) {
    const b = String(body ?? '').trim();
    if (!b) return { ok: false, error: '' };
    if (new TextEncoder().encode(b).length > LIMITS.message) return { ok: false, error: 'That message is too long (8 KB at most).' };
    return { ok: true };
  }

  const ACTION_LABEL = Object.freeze({
    pause: 'Pause', resume: 'Resume now', stop: 'Stop', takeover: 'Take over in terminal', handback: 'Hand back',
    message: 'Message', approve: 'Allow once', deny: 'Deny', answer: 'Answer', merge: 'Merge', openPr: 'Open pull request',
    discard: 'Discard', retry: 'Retry', switchAi: 'Switch AI',
  });
  // Clicks that need a second, deliberate click.
  const CONFIRM_ACTIONS = Object.freeze(['stop', 'merge']);
  // Confirmed by main in a native dialog; the page's own click never counts.
  const NATIVE_CONFIRM = Object.freeze(['discard', 'openPr', 'takeover']);
  const KIND_LABEL = Object.freeze({ task: 'another task', card: 'board card', member: 'teammate', repo: 'a repo broadcast', human: 'you' });
  // The kind always comes before the sender-chosen label, so a label cannot pose as something else.
  const partyText = (p) => (p ? (p.kind === 'human' ? 'You' : `${KIND_LABEL[p.kind] || 'someone'}: ${p.label || p.id || ''}`) : '');
  const CONFIRM_TEXT = Object.freeze({
    stop: 'Stop this task? The AI stops now. Its work so far is kept.',
    merge: 'Merge this task’s branch into your checkout? Nothing is pushed.',
  });

  return { LIMITS, ERROR_TEXT, errorText, TERMINAL, ageText, rowView, sortTasks, CAPS, newTranscript, addEvent, messageStatus, isMine, partyName, mergeMessage, validateDraft, validateMessage, ACTION_LABEL, CONFIRM_ACTIONS, NATIVE_CONFIRM, KIND_LABEL, partyText, CONFIRM_TEXT, AI_NAME };
}));
