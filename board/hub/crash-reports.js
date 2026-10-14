// Anonymous, structural crash counts only. No user/device identity or raw error text.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import wire from '../shared/crash-report.cjs';
import { HubError } from './db.js';
export const RETENTION_MS = 30 * 86400000;
export const MAX_REPORTS = 1000;
export class CrashReports {
  constructor({ dataDir, now = Date.now }) {
    this.dir = path.join(dataDir, 'crash-reports'); this.file = path.join(this.dir, 'reports.jsonl'); this.now = now;
    this.sweep();
  }
  read() {
    try {
      if (fs.statSync(this.file).size > MAX_REPORTS * wire.MAX_BYTES) return [];
      return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
        try { const entry = JSON.parse(line); const report = wire.wireReport(entry.report);
          return report && Number.isFinite(entry.receivedAt) && entry.receivedAt > this.now() - RETENTION_MS && entry.receivedAt <= this.now()
            ? [{ receivedAt: entry.receivedAt, report }] : [];
        } catch { return []; }
      }).slice(-MAX_REPORTS);
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  write(rows) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, this.file);
  }
  sweep() { this.write(this.read()); }
  accept(body) {
    const report = wire.wireReport(body);
    if (!report || !isDeepStrictEqual(body, report)) throw new HubError('VALIDATION', 'invalid crash report');
    const rows = this.read();
    if (!rows.some((r) => r.report.id === report.id)) rows.push({ receivedAt: this.now(), report });
    this.write(rows.slice(-MAX_REPORTS));
    return { accepted: true };
  }
}
