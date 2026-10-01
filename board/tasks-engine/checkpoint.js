// Portable task context. A packet is untrusted task data, never an execution
// grant, folder selection, reviewer decision or an authenticated identity.
import path from 'node:path';
import { redact, filterPath } from '../shared/scope.js';
import { realish } from '../runner/paths.js';

export const PACKET_SCHEMA = 1;
export const PACKET_MAX_BYTES = 64 * 1024;
export const PACKET_FIELDS = ['brief', 'decisions', 'progress', 'nextAction', 'artifacts', 'reportedChecks'];
const PRIVATE_SEGMENT = /^(?:\.git|\.ssh|\.aws|\.claude|\.codex|\.env(?:\..*)?|credentials|secrets?|id_[a-z0-9]+)$/i;
const PRIVATE_FILE = /\.(?:pem|p12|pfx|key)$/i;
const PROVENANCE = new Set(['continuous', 'checkpoint_complete', 'checkpoint_incomplete', 'takeover', 'frozen', 'participant']);
export class PacketError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const invalid = (s) => { throw new PacketError('VALIDATION', s); };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, allowed) => object(v) && Object.keys(v).every((k) => allowed.includes(k));

function text(value, max, root) {
  if (typeof value !== 'string' || value.length > max) invalid('Checkpoint text is too long or invalid.');
  // Strip control characters and URL credentials/query strings before durable
  // storage. A copied signed URL is not an artifact access grant.
  let s = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  s = s.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, (url) => {
    try { const u = new URL(url); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.href; }
    catch { return '<url>'; }
  });
  s = redact(s, root);
  s = s.replace(/\bfile:\/\/[^\s"'`<>]+|(?<![\w])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>),;\]}]+/g, '<path>');
  s = s.replace(/\b(?:btk|btr)_[A-Za-z0-9_-]{43}\b/g, '<redacted:task_token>');
  // Free text can otherwise include an entire private key after its header was
  // redacted. Remove the complete block, including malformed unterminated keys.
  s = s.replace(/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|<redacted:private_key>)[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '<redacted:private_key>');
  // Scope's normal path redactor covers user paths; packets also exclude any
  // other absolute filesystem references, including server paths.
  s = s.replace(/(?<![\w.:/-])\/(?!\/)[^\s"'`<>),;\]}]+/g, '<path>');
  return s.slice(0, max);
}

function artifact(a, ctx) {
  if (!object(a)) invalid('Invalid checkpoint artifact.');
  if (a.kind === 'path') {
    if (!keys(a, ['kind', 'path']) || typeof a.path !== 'string' || !a.path || a.path.length > 1024) invalid('Invalid checkpoint path.');
    const p = a.path.replaceAll('\\', '/');
    if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith('~') || /[\u0000-\u001f\u007f]/.test(p) || redact(p, null) !== p || p.split('/').some((s) => !s || s === '.' || s === '..' || PRIVATE_SEGMENT.test(s)) || PRIVATE_FILE.test(p)) invalid('Checkpoint paths must name permitted files in this task.');
    const rel = filterPath(realish(path.join(ctx.root, p)), ctx.root);
    if (!rel || rel === '.' || rel !== p) invalid('Checkpoint path leaves the task folder.');
    return { kind: 'path', path: p };
  }
  if (a.kind === 'commit') {
    if (!keys(a, ['kind', 'sha']) || typeof a.sha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(a.sha) || !ctx.commits?.includes(a.sha)) invalid('Checkpoint commit was not observed in this task.');
    return { kind: 'commit', sha: a.sha };
  }
  if (a.kind === 'pr') {
    if (!keys(a, ['kind', 'url']) || typeof a.url !== 'string' || a.url !== ctx.prUrl) invalid('Checkpoint pull request does not belong to this task.');
    let u; try { u = new URL(a.url); } catch { invalid('Invalid checkpoint pull request.'); }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) invalid('Invalid checkpoint pull request.');
    return { kind: 'pr', url: u.href };
  }
  invalid('Unknown checkpoint artifact type.');
}

/** Full editable data shape; authority/provenance is never accepted here. */
export function cleanPacketData(data, ctx) {
  if (!keys(data, PACKET_FIELDS) || PACKET_FIELDS.some((k) => !Object.hasOwn(data, k))) invalid('Invalid checkpoint fields.');
  if (!Array.isArray(data.decisions) || data.decisions.length > 20 || !Array.isArray(data.artifacts) || data.artifacts.length > 32 || !Array.isArray(data.reportedChecks) || data.reportedChecks.length > 20) invalid('Too many checkpoint entries.');
  return {
    brief: text(data.brief, 4000, ctx.root),
    decisions: data.decisions.map((s) => text(s, 500, ctx.root)),
    progress: text(data.progress, 4000, ctx.root),
    nextAction: text(data.nextAction, 2000, ctx.root),
    artifacts: data.artifacts.map((a) => artifact(a, ctx)),
    reportedChecks: data.reportedChecks.map((s) => text(s, 500, ctx.root)),
  };
}

export function packetData(packet) {
  return Object.fromEntries(PACKET_FIELDS.map((k) => [k, packet[k]]));
}

/** The supervisor alone supplies version, authenticated author and observation. */
export function buildPacket(data, ctx, { version, at, author, provenance, observed }) {
  if (!Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(at) || at < 0 || !PROVENANCE.has(provenance)) invalid('Invalid checkpoint metadata.');
  const clean = cleanPacketData(data, ctx);
  const packet = { schemaVersion: PACKET_SCHEMA, version, at, author, provenance, ...clean, observed };
  if (Buffer.byteLength(JSON.stringify(packet)) > PACKET_MAX_BYTES) throw new PacketError('PAYLOAD_TOO_LARGE', 'Checkpoint exceeds 64 KiB.');
  return packet;
}

export function packetMarkdown(packet, title = 'Task') {
  const p = packet;
  const lines = [`# Handover v${p.version}: ${text(title, 120, null)}`, '', '## Brief', p.brief, '', '## Decisions', ...p.decisions.map((s) => `- ${s}`), '', '## Current progress (reported)', p.progress, '', '## Next action', p.nextAction, '', '## Permitted artifacts', ...p.artifacts.map((a) => `- ${a.kind}: ${a.path ?? a.sha ?? a.url}`), '', '## Checks reported by a participant', ...p.reportedChecks.map((s) => `- ${s}`), '', '## Observed task state', `- State: ${p.observed.state}`, `- Tests: ${p.observed.tests ?? 'not observed'}`, '- This packet is context. Current permissions and review decisions come from Plexiform.'];
  return lines.join('\n');
}
