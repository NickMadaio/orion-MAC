/*
 A deliberately small JSON-schema checker for slot output: type, required,
 properties, additionalProperties:false, enum, string length, numeric bounds,
 items. Returns a list of readable errors so a retry can show the model exactly
 what was wrong. Anything outside this subset in a schema is rejected up front.
*/
const SUPPORTED = new Set(['type', 'required', 'properties', 'additionalProperties', 'enum',
  'maxLength', 'minLength', 'minimum', 'maximum', 'items', 'description', 'maxItems', 'minItems']);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(want, value) {
  const got = typeOf(value);
  return got === want || (want === 'number' && got === 'integer');
}

/** Throws if the schema itself uses something this checker would silently ignore. */
export function assertSupportedSchema(schema, at = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`schema at ${at} must be an object`);
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) throw new Error(`schema keyword "${key}" at ${at} is not supported`);
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) assertSupportedSchema(child, `${at}.${name}`);
  if (schema.items) assertSupportedSchema(schema.items, `${at}[]`);
}

export function validate(value, schema, at = '$') {
  const errors = [];
  if (schema.type && !typeMatches(schema.type, value)) {
    return [`${at}: expected ${schema.type}, got ${typeOf(value)}`];
  }
  if (schema.enum && !schema.enum.some(option => option === value)) {
    errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'string') {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength} characters`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength} characters`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((item, index) => errors.push(...validate(item, schema.items, `${at}[${index}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${at}.${key}: is required`);
    const known = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(known, key)) errors.push(...validate(child, known[key], `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: is not an allowed property`);
    }
  }
  return errors;
}
