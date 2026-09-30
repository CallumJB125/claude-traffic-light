// Durable outbox (CONTRACT §6.5): append-only NDJSON per device + acked.json.
// Entries hold ONLY bytes produced by scope.serializeOutbound — append() takes
// the serialized string, never an object, so nothing else can reach the file.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic } from './util.js';

export class Outbox {
  constructor(dir, deviceId) {
    ensureDir(dir);
    this.file = path.join(dir, `${deviceId}.ndjson`);
    this.ackedFile = path.join(dir, 'acked.json');
    this.headFile = path.join(dir, 'head.json');
    this.entries = [];   // [{seq, offline, bytes}] not yet acked
    this.acked = readJson(this.ackedFile, { seq: 0 }).seq ?? 0;
    this.head = Math.max(readJson(this.headFile, { seq: 0 }).seq ?? 0, this.acked);
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { /* first run */ }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const e = parseLine(line);
      if (!e) continue;   // torn tail from a crash mid-append
      this.head = Math.max(this.head, e.seq);
      if (e.seq > this.acked) this.entries.push(e);
    }
    this.entries.sort((a, b) => a.seq - b.seq);
  }

  // bytes: output of serializeOutbound(msg, scope, {requireRepoId:true}).
  append(bytes, { offline = false } = {}) {
    if (typeof bytes !== 'string') throw new TypeError('outbox.append takes serialized bytes');
    const seq = this.head + 1;
    this.head = seq;
    writeJsonAtomic(this.headFile, { seq });   // persist the head before anything is sent
    const line = `{"seq":${seq},"offline":${offline ? 'true' : 'false'},"msg":${bytes}}\n`;
    fs.appendFileSync(this.file, line, { mode: 0o600 });
    const e = { seq, offline, bytes };
    this.entries.push(e);
    return e;
  }

  ack(seq) {
    if (!Number.isSafeInteger(seq) || seq <= this.acked) return;
    this.acked = Math.min(seq, this.head);
    writeJsonAtomic(this.ackedFile, { seq: this.acked });
    this.entries = this.entries.filter((e) => e.seq > this.acked);
    if (this.entries.length === 0) {
      fs.writeFileSync(this.file, '', { mode: 0o600 });
    } else if (this.entries.length < 64) {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, this.entries.map(lineOf).join(''), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    }
  }

  pendingAfter(seq) {
    return this.entries.filter((e) => e.seq > seq);
  }

  // The `out` frame, assembled around the stored bytes so they are sent verbatim.
  static frame(e, delayed) {
    return `{"type":"out","seq":${e.seq},"delayed":${delayed ? 'true' : 'false'},"msg":${e.bytes}}`;
  }
}

function lineOf(e) {
  return `{"seq":${e.seq},"offline":${e.offline ? 'true' : 'false'},"msg":${e.bytes}}\n`;
}

function parseLine(line) {
  const m = /^\{"seq":(\d+),"offline":(true|false),"msg":(.*)\}$/.exec(line);
  if (!m) return null;
  try { JSON.parse(m[3]); } catch { return null; }
  return { seq: Number(m[1]), offline: m[2] === 'true', bytes: m[3] };
}
