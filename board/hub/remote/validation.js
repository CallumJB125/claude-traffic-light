import { HubError } from '../db.js';
import { cleanPacketText } from '../../shared/packet-text.js';
import { redact } from '../../shared/scope.js';
export const invalid = () => new HubError('VALIDATION', 'invalid integration request');
export const unauthorized = () => new HubError('UNAUTHENTICATED', 'integration authorization required');
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function closed(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))
    || required.some(k => !Object.hasOwn(value,k))) throw invalid();
}
export function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  return cleanPacketText(value.trim(), 100);
}
export function origin(value) {
  let u; try { u = new URL(value); } catch { throw invalid(); }
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !(u.protocol === 'https:' || u.protocol === 'http:' && u.hostname === '127.0.0.1')) throw invalid();
  return u.origin;
}
export function redirect(value) {
  let u; try { u = new URL(value); } catch { throw invalid(); }
  if (typeof value !== 'string' || value.length > 1000 || /[\x00-\x20\x7f]/.test(value) || redact(value, null) !== value || u.username || u.password || u.hash || !(u.protocol === 'https:' || u.protocol === 'http:' && u.hostname === '127.0.0.1')) throw invalid();
  return u.href;
}
export function registeredRedirect(redirects, value) {
  const u = new URL(redirect(value));
  return redirects.some(r => { const registered = new URL(r); return registered.href === u.href || registered.protocol === 'http:' && registered.hostname === '127.0.0.1'
    && u.protocol === registered.protocol && u.hostname === registered.hostname && u.pathname === registered.pathname && u.search === registered.search; });
}
// Reject duplicate keys at every nesting level before JSON.parse erases them.
// The lexer consumes only bounded text and lets JSON.parse validate grammar.
export function strictJson(source) {
  const stack = []; let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '{') { stack.push(new Set()); if (stack.length > 16) throw invalid(); i++; }
    else if (c === '[') { stack.push(null); if (stack.length > 16) throw invalid(); i++; }
    else if (c === '}' || c === ']') { stack.pop(); i++; }
    else if (c === '"') {
      const start = i++;
      while (i < source.length) { if (source[i] === '\\') i += 2; else if (source[i++] === '"') break; }
      const end = i; while (/\s/.test(source[i] ?? '') && i < source.length) i++;
      if (source[i] === ':' && stack.at(-1) instanceof Set) {
        let key; try { key = JSON.parse(source.slice(start,end)); } catch { throw invalid(); }
        if (stack.at(-1).has(key)) throw invalid(); stack.at(-1).add(key);
      }
    } else i++;
  }
  try { return JSON.parse(source); } catch { throw invalid(); }
}
export function uniqueParams(params, allowed, required = []) {
  const out = Object.create(null);
  for (const [k,v] of params) { if (!allowed.includes(k) || Object.hasOwn(out,k) || v.length > 2000) throw invalid(); out[k] = v; }
  if (required.some(k => !Object.hasOwn(out,k))) throw invalid();
  return out;
}
