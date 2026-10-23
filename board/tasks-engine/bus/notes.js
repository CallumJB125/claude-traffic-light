// Session-to-session notes (plan-agent-awareness §3.6), inside the tasks utilityProcess with the rest of the bus.
// Main is the only caller: it verified the sender from the calling process, looked the recipient up by handle,
// and scrubbed the text, so every identity here is main's, never an agent's own word. A note never starts a
// turn or a run and carries no hop: the recipient's hook shows only a Plexiform notice (count and sender), and
// the text reaches it only as the result of its own bus_notes call, framed as data from another AI.
// Ops: note, notes, notes_pending (main's notices after a restart), notified (main saw the notice written).
import crypto from 'node:crypto';
import { NoteArgs, NotesArgs, NotifiedArgs, NOTE_LIMITS, issue } from '../../shared/bus-schema.js';
import untrustedFrame from '../../shared/untrusted-frame.cjs';

const { frame, fold } = untrustedFrame;
const HOUR_MS = 60 * 60 * 1000;
const NAMES = Object.freeze({ claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// Main folded and scrubbed the text (src/signal-server.js busScrub); the same fold again is a no-op for it and keeps any
// other caller's text to what a model reads: compatibility forms folded, invisible and control characters dropped.
const clean = (s) => fold(s).slice(0, NOTE_LIMITS.text);
const HALTED = Object.freeze({ reason: 'HALTED', message: 'The agent bus is stopped on this Mac, so notes are held. Your person can resume it from the tray or Sessions.' });

/** log: openBusLog(); halted(): whether the bus is stopped; record(kind, data): a note.* event without the text. */
export function createNotes({ log, now = Date.now, halted = () => false, record = () => {} }) {
  const parse = (S, a) => { const r = S.safeParse(a ?? {}); return r.success ? { args: r.data } : { refusal: { reason: 'VALIDATION', message: issue(r) } }; };
  const mark = (kind, rows) => { for (const r of rows) record(kind, { note_id: r.note_id, from: r.from_handle, to: r.to_handle }); };

  function expire() { mark('note.expired', log.expireNotes(now())); }

  function note(raw) {
    const { args: a, refusal } = parse(NoteArgs, raw);
    if (refusal) return refusal;
    if (halted()) return HALTED;
    if (a.from.key === a.to.key) return { reason: 'VALIDATION', message: 'That handle is you.' };
    const t = now();
    expire();
    const requestKey = `${a.from.key}|${a.request_id}`;
    const prior = log.noteByRequest(requestKey);
    if (prior) return { note_id: prior.note_id, state: prior.state, duplicate: true };
    const text = clean(a.text);
    if (!text.trim()) return { reason: 'VALIDATION', message: 'text: the note is empty.' };
    const hash = sha(text);
    const dup = log.noteDuplicate(a.from.key, a.to.key, hash, t - NOTE_LIMITS.dedupeMs);
    if (dup) return { note_id: dup.note_id, state: dup.state, duplicate: true };
    if (log.countNotes({ fromKey: a.from.key, since: t - HOUR_MS }) >= NOTE_LIMITS.perSenderHour) return { reason: 'RATE', message: `At most ${NOTE_LIMITS.perSenderHour} notes an hour from one session.` };
    if (log.countNotes({ fromKey: a.from.key, toKey: a.to.key, since: t - HOUR_MS }) >= NOTE_LIMITS.perPairHour) return { reason: 'RATE', message: `At most ${NOTE_LIMITS.perPairHour} notes an hour to one session.` };
    if (log.unreadCount(a.to.key, t) >= NOTE_LIMITS.queued) return { reason: 'RATE', message: `That session already has ${NOTE_LIMITS.queued} unread notes.` };
    const row = { note_id: `note_${crypto.randomBytes(10).toString('hex')}`, request_key: requestKey, from_key: a.from.key, from_handle: a.from.handle, from_provider: a.from.provider,
      from_folder: a.from.folder, to_key: a.to.key, to_handle: a.to.handle, text, text_hash: hash, created_at: t, expires_at: t + (a.ttl_s ?? NOTE_LIMITS.ttlS) * 1000 };
    log.addNote(row);
    mark('note.queued', [row]);
    return { note_id: row.note_id, state: 'queued', expires_at: row.expires_at };
  }

  const view = (r) => ({
    note_id: r.note_id, from: { handle: r.from_handle, provider: r.from_provider, folder: r.from_folder }, at: r.created_at,
    text: frame({ kind: 'note', source: { kind: 'session', provider: NAMES[r.from_provider] ?? 'AI', name: r.from_folder, handle: r.from_handle }, body: r.text }),
  });

  // The caller's own notes only (me is the session main verified): unread ones oldest first, at most NOTE_LIMITS.read,
  // or one by id. Reading never deletes: the person can still see them until they are swept. status: what I sent.
  function notes(raw) {
    const { args: a, refusal } = parse(NotesArgs, raw);
    if (refusal) return refusal;
    const t = now();
    expire();
    if (a.status) {
      return { sent: log.sentBy(a.me.key, a.note_id ?? null).map((r) => ({ note_id: r.note_id, to: r.to_handle, state: r.state, at: r.created_at,
        notified_at: r.notified_at ?? null, read_at: r.read_at ?? null, expires_at: r.expires_at })) };
    }
    if (halted()) return HALTED;
    const rows = a.note_id ? [log.noteFor(a.me.key, a.note_id, t)].filter(Boolean) : log.unreadFor(a.me.key, t, NOTE_LIMITS.read);
    const moved = new Set(log.setNotes(a.me.key, rows.map((r) => r.note_id), 'read', t));
    mark('note.read', rows.filter((r) => moved.has(r.note_id)));
    return { notes: rows.map(view), more: log.unreadCount(a.me.key, t) };
  }

  // Metadata only, for main's notices: who each unread note is for and from. Never the text.
  function pending() {
    expire();
    return { notes: log.unread(now()).map((r) => ({ note_id: r.note_id, to_key: r.to_key, from_handle: r.from_handle, from_provider: r.from_provider, from_folder: r.from_folder, expires_at: r.expires_at })) };
  }

  // Main saw the recipient's hook write the notice (a receipt, not proof anyone read it): queued → notified.
  function notified(raw) {
    const { args: a, refusal } = parse(NotifiedArgs, raw);
    if (refusal) return refusal;
    const ids = log.setNotes(a.to.key, a.note_ids, 'notified', now());
    const rows = ids.map((id) => log.noteFor(a.to.key, id, 0)).filter(Boolean);
    mark('note.notified', rows);
    return { notified: ids };
  }

  return {
    expire,
    op(name, args) {
      if (name === 'note') return note(args);
      if (name === 'notes') return notes(args);
      if (name === 'notes_pending') return pending();
      if (name === 'notified') return notified(args);
      return { reason: 'VALIDATION', message: 'unknown note op' };
    },
  };
}
