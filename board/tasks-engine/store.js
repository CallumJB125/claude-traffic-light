// Durable store for the Tasks engine: two append-only JSONL files in a 0700
// dir, each 0600.
//   tasks.jsonl   {task}        a full snapshot per write; the last one per id wins
//   events.jsonl  {at, e}       one line per event, seq strictly increasing
// Only engine-built objects are ever written (never a client frame). A torn
// last line after a crash, or any line that doesn't parse or doesn't fit the
// shape, is skipped on load; the next append starts on a fresh line. Both
// files are compacted in place (tmp + rename) once they outgrow their caps, so
// the event log keeps at most `ringEvents` events after a compaction.
import fs from 'node:fs';
import path from 'node:path';
import { STATES } from '../shared/states.js';
import { EVENT_TYPES, RING_EVENTS } from '../tasks-api/protocol.js';

export const TASK_ID_RE = /^tsk_[0-9a-f]{12}$/;
export const MAX_EVENT_LOG_BYTES = 64 * 1024 * 1024;

export class TaskStore {
  constructor(dir, { ringEvents = RING_EVENTS, maxEventBytes = MAX_EVENT_LOG_BYTES } = {}) {
    this.dir = dir;
    this.ringEvents = ringEvents;
    this.maxEventBytes = maxEventBytes;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    this.tasksFile = path.join(dir, 'tasks.jsonl');
    this.eventsFile = path.join(dir, 'events.jsonl');
    this.taskLines = 0;
    this.eventLines = 0;
    this.eventBytes = 0;
    this.taskFd = null;
    this.eventFd = null;
  }

  /** → {tasks: Map(id → task), events: [{at, e}] (the newest ringEvents), lastSeq} */
  load() {
    const tasks = new Map();
    for (const rec of readLines(this.tasksFile)) {
      const t = rec?.task;
      if (!t || typeof t !== 'object' || !TASK_ID_RE.test(t.id) || !STATES.includes(t.state) || typeof t.spec !== 'object' || t.spec === null) continue;
      tasks.set(t.id, t);
      this.taskLines += 1;
    }
    let events = [];
    let lastSeq = 0;
    for (const rec of readLines(this.eventsFile)) {
      const e = rec?.e;
      if (!e || typeof e !== 'object' || !Number.isSafeInteger(e.seq) || e.seq <= lastSeq || typeof e.taskId !== 'string'
        || !EVENT_TYPES.includes(e.type) || !Number.isFinite(rec.at)) continue;
      lastSeq = e.seq;
      events.push({ at: rec.at, e });
      this.eventLines += 1;
    }
    if (events.length > this.ringEvents) events = events.slice(-this.ringEvents);
    try { this.eventBytes = fs.statSync(this.eventsFile).size; } catch { this.eventBytes = 0; }
    this.taskFd = openAppend(this.tasksFile);
    this.eventFd = openAppend(this.eventsFile);
    this.ring = events;
    return { tasks, events, lastSeq };
  }

  saveTask(task, liveTasks) {
    fs.writeSync(this.taskFd, `${JSON.stringify({ task })}\n`);
    fs.fsyncSync(this.taskFd);
    this.taskLines += 1;
    if (liveTasks && this.taskLines > 4 * liveTasks.size + 256) this.compactTasks(liveTasks);
  }

  appendEvent(e, at, ring) {
    const line = `${JSON.stringify({ at, e })}\n`;
    fs.writeSync(this.eventFd, line);
    this.eventLines += 1;
    this.eventBytes += Buffer.byteLength(line);
    if (ring && (this.eventLines > 2 * this.ringEvents || this.eventBytes > this.maxEventBytes)) this.compactEvents(ring);
  }

  compactTasks(liveTasks) {
    const body = [...liveTasks.values()].map((task) => `${JSON.stringify({ task })}\n`).join('');
    this.taskFd = rewrite(this.tasksFile, body, this.taskFd);
    this.taskLines = liveTasks.size;
  }

  /** ring: [{at, e}] newest last; keeps at most ringEvents of them (and under the byte cap). */
  compactEvents(ring) {
    let keep = ring.slice(-this.ringEvents);
    let body = keep.map(({ at, e }) => `${JSON.stringify({ at, e })}\n`).join('');
    while (Buffer.byteLength(body) > this.maxEventBytes / 2 && keep.length > 1) {
      keep = keep.slice(Math.ceil(keep.length / 2));
      body = keep.map(({ at, e }) => `${JSON.stringify({ at, e })}\n`).join('');
    }
    this.eventFd = rewrite(this.eventsFile, body, this.eventFd);
    this.eventLines = keep.length;
    this.eventBytes = Buffer.byteLength(body);
    return keep;
  }

  close() {
    for (const fd of [this.taskFd, this.eventFd]) { if (fd != null) { try { fs.closeSync(fd); } catch { /* closed */ } } }
    this.taskFd = null;
    this.eventFd = null;
  }
}

function readLines(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  const lines = text.split('\n');
  // The last element is '' after a final newline, or a torn partial line: skip it either way.
  for (const line of lines.slice(0, -1)) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* corrupt line */ }
  }
  return out;
}

// O_APPEND fd, 0600; a torn tail gets a newline first so the next record parses.
function openAppend(file) {
  const fd = fs.openSync(file, 'a+', 0o600);
  fs.fchmodSync(fd, 0o600);
  const { size } = fs.fstatSync(fd);
  if (size > 0) {
    const b = Buffer.alloc(1);
    if (fs.readSync(fd, b, 0, 1, size - 1) === 1 && b[0] !== 0x0a) fs.writeSync(fd, '\n');
  }
  return fd;
}

function rewrite(file, body, oldFd) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  const fd = fs.openSync(tmp, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  try { fs.closeSync(oldFd); } catch { /* closed */ }
  return openAppend(file);
}
