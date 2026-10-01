// Portable participant text; never an authority or an artifact access grant.
import { redact } from './scope.js';

export function cleanPacketText(value, max, root = null) {
  if (typeof value !== 'string' || value.length > max) throw new TypeError('Checkpoint text is too long or invalid.');
  let s = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  s = s.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, (url) => {
    try { const u = new URL(url); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.href; }
    catch { return '<url>'; }
  });
  s = redact(s, root);
  s = s.replace(/\bfile:\/\/[^\s"'`<>]+|(?<![\w])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>),;\]}]+/g, '<path>');
  s = s.replace(/\b(?:btk|btr|bdt|brt|inv|clinv)_[A-Za-z0-9_-]{43}\b/g, '<redacted:task_token>');
  s = s.replace(/\bbrt1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted:run_token>');
  s = s.replace(/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|<redacted:private_key>)[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '<redacted:private_key>');
  s = s.replace(/(?<![\w.:/-])\/(?!\/)[^\s"'`<>),;\]}]+/g, '<path>');
  return s.slice(0, max);
}

const PRIVATE_SEGMENT = /^(?:\.git|\.ssh|\.aws|\.claude|\.codex|\.env(?:\..*)?|credentials|secrets?|id_[a-z0-9]+)$/i;
const PRIVATE_FILE = /\.(?:pem|p12|pfx|key)$/i;
// A shared packet can only report a relative name; the hub never opens it.
export function packetRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024) return null;
  const p = value.replaceAll('\\', '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith('~') || /[\u0000-\u001f\u007f]/.test(p)
    || redact(p, null) !== p || p.split('/').some((s) => !s || s === '.' || s === '..' || PRIVATE_SEGMENT.test(s)) || PRIVATE_FILE.test(p)) return null;
  return p;
}
