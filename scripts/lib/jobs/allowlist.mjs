/*
 The commands a job step may run. A job names an ENTRY here (never a path or a
 shell string); code builds the argument list; execFile runs it with no shell.
 Step outputs are data and never reach the command name.
*/
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOY_WRITE = fileURLToPath(new URL('../../jobs/toy/write-greeting.mjs', import.meta.url));

export const COMMANDS = Object.freeze({
  date: Object.freeze({ file: '/bin/date', prefix: [] }),
  echo: Object.freeze({ file: '/bin/echo', prefix: [] }),
  'toy-write': Object.freeze({ file: process.execPath, prefix: [TOY_WRITE] }),
});

const MAX_OUTPUT_BYTES = 64 * 1024;

export function isAllowedCommand(name) { return Object.hasOwn(COMMANDS, name); }

/** Real executor. Resolves { stdout, stderr, exitCode }; a non-zero exit rejects. */
export const IDEMPOTENCY_ENV = 'ORION_JOB_IDEMPOTENCY_KEY';
const KEY = /^[0-9a-f]{32}$/;

/*
 Idempotency convention: when the runner gives a step a key, the command gets it
 in ORION_JOB_IDEMPOTENCY_KEY (never in argv, so it cannot be mistaken for
 content). A command with outside effects records the key once its effect is
 done and, seeing the same key again, does nothing and says "already done".
*/
export function execAllowed(name, args, { cwd, timeoutMs = 60_000, idempotencyKey } = {}) {
  if (idempotencyKey !== undefined && !KEY.test(idempotencyKey)) {
    return Promise.reject(new Error('idempotency key must be 32 hex characters'));
  }
  if (!isAllowedCommand(name)) return Promise.reject(new Error(`command "${name}" is not on the jobs allowlist`));
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    return Promise.reject(new Error(`arguments for "${name}" must be an array of strings`));
  }
  const { file, prefix } = COMMANDS[name];
  return new Promise((resolve, reject) => {
    execFile(file, [...prefix, ...args], { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES,
      env: { PATH: '/usr/bin:/bin', ...(idempotencyKey ? { [IDEMPOTENCY_ENV]: idempotencyKey } : {}) }, shell: false }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).trim().slice(0, 300);
        reject(new Error(`command "${name}" failed (${error.code ?? error.signal ?? 'error'}): ${detail}`));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 });
    });
  });
}
