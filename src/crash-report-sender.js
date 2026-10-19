'use strict';
const { wireReport, MAX_BYTES } = require('../board/shared/crash-report.cjs');
const ENDPOINT = 'https://app.plexiform.dev/api/crash-reports/v1';
// No account token, cookies, retries, persistent queue, or configurable destination.
function create({ fetch }) {
  return async (report) => {
    const safe = wireReport(report);
    if (!safe) return { sent: false };
    const body = JSON.stringify(safe);
    if (Buffer.byteLength(body) > MAX_BYTES) return { sent: false };
    try {
      const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, // privacy-flow: crash-send
        credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000) }); // privacy-flow: crash-send
      await response.body?.cancel();
      return { sent: response.ok };
    } catch { return { sent: false }; }
  };
}
module.exports = { create, ENDPOINT };
