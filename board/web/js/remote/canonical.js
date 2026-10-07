// Canonical JSON (RFC 8785 / JCS for the JSON values JSON.parse can produce):
// keys sorted by UTF-16 code units, no whitespace, ECMAScript number and
// string serialisation. The phone and the desktop must hash byte-identical
// text for the same tool input, so anything JCS can't represent is an error,
// never silently dropped the way JSON.stringify drops `undefined`.
import { utf8, hex } from './encoding.js';

const MAX_DEPTH = 64;

export class CanonicalError extends Error {}

function ser(v, depth) {
  if (depth > MAX_DEPTH) throw new CanonicalError('too deeply nested');
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false';
    case 'string': return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new CanonicalError('non-finite number');
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) {
        let out = '[';
        for (let i = 0; i < v.length; i++) {
          if (!(i in v)) throw new CanonicalError('sparse array');
          out += (i ? ',' : '') + ser(v[i], depth + 1);
        }
        return out + ']';
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalError('not a plain object');
      const keys = Object.keys(v).sort();
      let out = '{';
      for (let i = 0; i < keys.length; i++) {
        out += (i ? ',' : '') + JSON.stringify(keys[i]) + ':' + ser(v[keys[i]], depth + 1);
      }
      return out + '}';
    }
    default:
      throw new CanonicalError(`unsupported ${typeof v}`);
  }
}

export function canonicalize(value) {
  return ser(value, 0);
}

export async function sha256Hex(textOrBytes) {
  const bytes = typeof textOrBytes === 'string' ? utf8(textOrBytes) : textOrBytes;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

// The hash a decision is bound to. An absent tool_input hashes as {} — the
// same default the PermissionRequest hook uses.
export function hashToolInput(toolInput) {
  return sha256Hex(canonicalize(toolInput ?? {}));
}
