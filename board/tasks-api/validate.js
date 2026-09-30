// A small JSON Schema (draft 2020-12) validator covering exactly the keywords
// schema.json uses, so the mock, the tests and (later) the supervisor can
// check frames without a dependency (board/CONTRACT.md §1 allows none).
// test/schema.test.js fails if schema.json starts using a keyword not listed
// in KEYWORDS.
//
// validate(schema, defName, value) → null | {path, message}

export const KEYWORDS = Object.freeze([
  '$schema', '$id', '$defs', '$ref', 'title', 'description', 'type', 'enum', 'const', 'properties',
  'required', 'additionalProperties', 'items', 'oneOf', 'anyOf', 'minimum', 'maximum', 'minLength',
  'maxLength', 'minItems', 'uniqueItems',
]);

function typeOk(t, v) {
  switch (t) {
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return false;
  }
}

function check(root, s, v, p) {
  if (s === true || s == null) return null;
  if (s === false) return { path: p, message: 'not allowed' };
  if (s.$ref) {
    const name = s.$ref.replace('#/$defs/', '');
    const target = root.$defs?.[name];
    if (!target) return { path: p, message: `unknown $ref ${s.$ref}` };
    const e = check(root, target, v, p);
    if (e) return e;
  }
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeOk(t, v))) return { path: p, message: `expected ${types.join('|')}, got ${v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v}` };
  }
  if ('const' in s && v !== s.const) return { path: p, message: `expected ${JSON.stringify(s.const)}` };
  if (s.enum && !s.enum.includes(v)) return { path: p, message: `${JSON.stringify(v)} not in [${s.enum.join(', ')}]` };
  if (typeof v === 'number') {
    if (s.minimum != null && v < s.minimum) return { path: p, message: `< minimum ${s.minimum}` };
    if (s.maximum != null && v > s.maximum) return { path: p, message: `> maximum ${s.maximum}` };
  }
  if (typeof v === 'string') {
    if (s.minLength != null && v.length < s.minLength) return { path: p, message: `shorter than ${s.minLength}` };
    if (s.maxLength != null && v.length > s.maxLength) return { path: p, message: `longer than ${s.maxLength}` };
  }
  if (Array.isArray(v)) {
    if (s.minItems != null && v.length < s.minItems) return { path: p, message: `fewer than ${s.minItems} items` };
    if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) return { path: p, message: 'items not unique' };
    if (s.items) for (let i = 0; i < v.length; i++) { const e = check(root, s.items, v[i], `${p}[${i}]`); if (e) return e; }
  }
  if (typeOk('object', v)) {
    for (const k of s.required ?? []) if (!(k in v)) return { path: p, message: `missing required ${k}` };
    for (const [k, val] of Object.entries(v)) {
      if (s.properties && k in s.properties) {
        const e = check(root, s.properties[k], val, `${p}.${k}`);
        if (e) return e;
      } else if (s.additionalProperties === false) {
        return { path: `${p}.${k}`, message: 'unexpected property' };
      } else if (typeof s.additionalProperties === 'object') {
        const e = check(root, s.additionalProperties, val, `${p}.${k}`);
        if (e) return e;
      }
    }
  }
  if (s.anyOf) {
    const errs = s.anyOf.map((x) => check(root, x, v, p));
    if (errs.every(Boolean)) return errs.find((e) => e.path !== p) ?? errs[0];
  }
  if (s.oneOf) {
    const errs = s.oneOf.map((x) => check(root, x, v, p));
    const n = errs.filter((e) => !e).length;
    if (n === 0) {
      // Report the branch that got furthest (deepest path) for a readable error.
      return errs.reduce((a, b) => (b.path.length > a.path.length ? b : a));
    }
    if (n > 1) return { path: p, message: `matches ${n} oneOf branches` };
  }
  return null;
}

export function validate(schema, defName, value) {
  const s = schema.$defs?.[defName];
  if (!s) return { path: '$', message: `unknown definition ${defName}` };
  return check(schema, s, value, '$');
}

/** Every keyword used anywhere in the schema (for the KEYWORDS guard test). */
export function keywordsUsed(schema) {
  const out = new Set();
  const walk = (s, inProps) => {
    if (!s || typeof s !== 'object') return;
    if (Array.isArray(s)) { s.forEach((x) => walk(x, false)); return; }
    for (const [k, v] of Object.entries(s)) {
      if (inProps) { walk(v, false); continue; }
      out.add(k);
      if (k === 'enum' || k === 'const' || k === 'required') continue;
      walk(v, k === 'properties' || k === '$defs');
    }
  };
  walk(schema, false);
  return out;
}
