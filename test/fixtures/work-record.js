'use strict';
// A WorkRecord v1 in the contract's shape (docs/TEAM-CONTEXT-CONTRACT.md), for
// tests of code that consumes src/work-record.js output.
const INSTALL = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
function workRecord({ install = INSTALL, adapter = 'claude', session = 'sess-1', repo = 'repo-a', rev = 1, status = 'working', edited = [], read = [], ...extra } = {}) {
  const at = '2026-10-07T10:00:00.000Z';
  return { v: 1, record_id: `${install}:${adapter}:${session}`, adapter, session_id: session, install_id: install, repo_id: repo, folder: 'app',
    title: 'Fix the export', goal: 'Stream CSV export', summary: 'Rewrote the writer', status, files: { edited, read }, branch: 'feat/export',
    started_at: at, updated_at: at, rev, cost_usd: null, route: null, handover: null, ...extra };
}
module.exports = { workRecord, INSTALL };
