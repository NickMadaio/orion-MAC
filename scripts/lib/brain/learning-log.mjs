/*
 Append-only record of every "learning" attempt (A6, 2026-11-16): a correction that might become a rule in USER.md, and every add to
 the questions queue. Until now a failed write was silent, so "never fired" and "fired and failed" looked the same.

 One JSON object per line in orion-controlled/learning-attempts.jsonl (eval-learning-attempts.jsonl during a sandboxed evaluation):
   { at, kind: "correction" | "question-add", trigger: {...what started it}, decision: "qualified" | "not-qualified",
     reason?: why it was not, write?: { result: "ok" | "already" | "skipped" | "refused" | "error", error?, exit? } }
 Never throws: a log that cannot be written is reported on stderr and in the return value, and the caller carries on.
*/
import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const learningLogPath = (dir, { sandboxed = false } = {}) => join(dir, sandboxed ? "eval-learning-attempts.jsonl" : "learning-attempts.jsonl");

/** The file is cut to its newest rows once it passes this many bytes (same cap as the plugin's writer). */
export const LEARNING_LOG_MAX_BYTES = 256 * 1024;

function capLog(file) {
  try {
    if (statSync(file).size <= LEARNING_LOG_MAX_BYTES) return;
    const tail = readFileSync(file, "utf8").slice(-Math.floor(LEARNING_LOG_MAX_BYTES / 2));
    writeFileSync(file, tail.slice(tail.indexOf("\n") + 1), { mode: 0o600 });
  } catch { /* nothing to cap */ }
}

/** Appends one row. Returns { ok: true } or { ok: false, error }; the error is also written to stderr. */
export function logAttempt(file, entry, now = new Date()) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: now.toISOString(), ...entry })}\n`, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best effort: tightens a file that predates the mode */ }
    capLog(file);
    return { ok: true };
  } catch (e) {
    const error = String(e && e.message ? e.message : e);
    process.stderr.write(`learning-log: could not record the attempt (${error})\n`);
    return { ok: false, error };
  }
}

/** Every well-formed row, oldest first; a missing file is no rows. */
export function readAttempts(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  return text.split("\n").flatMap((l) => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
}
