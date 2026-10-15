import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CrashReports, RETENTION_MS, MAX_REPORTS } from '../crash-reports.js';
import wire from '../../shared/crash-report.cjs';
import { startAccounts } from './accounts-helpers.js';
const report = () => wire.wireReport({ id: randomUUID(), at: new Date().toISOString(), kind: 'renderer-gone', app: { version: '1.0.2', os: 'darwin', arch: 'arm64' }, renderer: { reason: 'oom', exitCode: 1 } });
test('crash store rejects extra fields, deduplicates, caps count and expires by server receipt time', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-hub-')); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = Date.now(); const store = new CrashReports({ dataDir, now: () => now }); const r = report();
  assert.throws(() => store.accept({ ...r, prompt: 'private' }), /invalid crash report/);
  store.accept(r); store.accept(r); assert.equal(store.read().length, 1);
  store.write(Array.from({ length: MAX_REPORTS }, () => ({ receivedAt: now, report: report() })));
  store.accept(report()); assert.equal(store.read().length, MAX_REPORTS);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  now += RETENTION_MS + 1; store.sweep(); assert.equal(store.read().length, 0);
});
test('HTTP intake is opt-in, anonymous, JSON-only, bounded and rate limited', async () => {
  const h = await startAccounts({ config: { crashReports: true } });
  try {
    const send = (body) => h.call('POST', '/api/crash-reports/v1', { body });
    assert.equal((await send(report())).status, 200);
    assert.equal((await send({ ...report(), extra: 'no' })).status, 400);
    assert.equal((await send({ ...report(), extra: 'x'.repeat(3000) })).status, 413);
    let status; for (let i = 0; i < 26; i++) status = (await send(report())).status;
    assert.equal(status, 429);
    assert.equal((await h.call('GET', '/api/crash-reports/v1')).status, 404);
  } finally { await h.close(); }
  const off = await startAccounts();
  try { assert.equal((await off.call('POST', '/api/crash-reports/v1', { body: report() })).status, 404); } finally { await off.close(); }
});
