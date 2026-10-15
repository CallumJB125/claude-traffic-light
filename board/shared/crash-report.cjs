'use strict';
// Wire format deliberately has no arbitrary strings: errors can contain user input.
const KINDS = ['uncaughtException', 'unhandledRejection', 'renderer-gone'];
const NAMES = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'NonError'];
const REASONS = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction', 'unknown'];
const CONSENT_VERSION = 2;
const MAX_BYTES = 2048;
function wireReport(r) {
  if (!r || !KINDS.includes(r.kind) || typeof r.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.id)) return null;
  if (typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) return null;
  const version = typeof r.app?.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-beta\.\d{1,10})?$/.test(r.app.version) ? r.app.version : 'unknown';
  const out = { schema: 1, id: r.id, at: new Date(r.at).toISOString(), kind: r.kind, app: {
    version, os: ['darwin', 'win32', 'linux'].includes(r.app?.os) ? r.app.os : 'unknown',
    arch: ['arm64', 'x64', 'ia32', 'arm'].includes(r.app?.arch) ? r.app.arch : 'unknown',
  } };
  if (r.kind === 'renderer-gone') out.renderer = { reason: REASONS.includes(r.renderer?.reason) ? r.renderer.reason : 'unknown', exitCode: Number.isSafeInteger(r.renderer?.exitCode) && Math.abs(r.renderer.exitCode) <= 2147483648 ? r.renderer.exitCode : null };
  else out.error = { name: NAMES.includes(r.error?.name) ? r.error.name : 'Error' };
  return out;
}
module.exports = { wireReport, CONSENT_VERSION, MAX_BYTES };
