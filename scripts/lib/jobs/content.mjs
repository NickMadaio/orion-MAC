/*
 What the owner is shown IS what is hashed IS what a gated step may use.

 An approval step returns a flat object of short strings (its "fields"). Here
 each value is stripped of ANSI escapes, control and bidi characters, the
 object is rendered once for display, and the same sanitised object is hashed
 and handed to the gated step. Content too long to show in full is refused, so
 nothing past a display cut is ever approved unseen.
*/
import { createHash } from 'node:crypto';

export const MAX_DISPLAY_CHARS = 1500;
const FIELD_KEY = /^[a-z][a-zA-Z0-9]{0,30}$/;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b./g;
// Ranges as code points so no invisible character sits in this source file.
const BLOCKED = [[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x2029],
  [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]];
const isBlocked = code => BLOCKED.some(([low, high]) => code >= low && code <= high);

export class ContentError extends Error {
  constructor(message) { super(message); this.name = 'ContentError'; }
}

export function sanitizeText(value) {
  return [...String(value).replace(ANSI, '')].filter(char => !isBlocked(char.codePointAt(0))).join('');
}

/** Flat string fields -> frozen sanitised copy, or ContentError. */
export function normalizeFields(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ContentError('approval fields must be an object of strings');
  const out = {};
  for (const key of Object.keys(raw).sort()) {
    if (!FIELD_KEY.test(key)) throw new ContentError(`approval field name "${key.slice(0, 30)}" is not allowed`);
    if (typeof raw[key] !== 'string') throw new ContentError(`approval field "${key}" must be text`);
    out[key] = sanitizeText(raw[key]);
  }
  const rendered = renderFields(out);
  if (rendered.length > MAX_DISPLAY_CHARS) {
    throw new ContentError(`approval content is ${rendered.length} characters; the owner can be shown at most ${MAX_DISPLAY_CHARS}, so it was refused`);
  }
  return Object.freeze(out);
}

export function renderFields(fields) {
  return Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join('\n');
}

export function approvalHash({ job, runId, stepId, fields }) {
  const canonical = Object.keys(fields).sort().map(key => [key, fields[key]]);
  return createHash('sha256').update(JSON.stringify({ v: 2, job, runId, stepId, fields: canonical })).digest('hex');
}
