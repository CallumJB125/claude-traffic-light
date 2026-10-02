'use strict';
// Tiny JSON Schema (draft 2020-12 subset) validator so tests and the snapshot
// step need no dependency: type, enum, const, required, properties,
// additionalProperties, items, $ref (#/$defs/...), minimum, maximum, pattern.

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function validate(schema, value, root = schema, at = '$', errors = []) {
  if (schema.$ref) {
    const name = schema.$ref.replace('#/$defs/', '');
    return validate(root.$defs[name], value, root, at, errors);
  }
  if (schema.type) {
    const types = [].concat(schema.type);
    const t = typeOf(value);
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${t}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if ('const' in schema && schema.const !== value) errors.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${at}: < ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${at}: > ${schema.maximum}`);
  }
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => validate(schema.items, v, root, `${at}[${i}]`, errors));
  if (typeOf(value) === 'object') {
    // Own properties only: a key named "constructor" or "toString" must not match Object.prototype.
    for (const k of schema.required || []) if (!Object.hasOwn(value, k)) errors.push(`${at}: missing ${k}`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, k)) validate(schema.properties[k], v, root, `${at}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected ${k}`);
      else if (typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, v, root, `${at}.${k}`, errors);
    }
  }
  return errors;
}

module.exports = { validate };
