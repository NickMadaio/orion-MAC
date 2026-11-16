/*
 Run state: one JSON file per run, replaced atomically (temp file + rename) so a
 crash leaves either the old state or the new one, never half of one. Every
 update builds a new object; nothing is mutated in place.

 Durability: the temp file is fsynced before the rename and the directory after
 it, so a committed step survives a process crash and, as far as fsync
 guarantees on macOS (it does not force the drive cache; that needs
 F_FULLFSYNC), a power cut. The lock file keeps two runners off one run; a lock
 whose process is gone is taken over by renaming it aside, and a lock is only
 released by the holder that wrote it.
*/
import { mkdir, open, readFile, rename, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runsDir } from './paths.mjs';

export const STATE_VERSION = 1;
const STATE_FILE = 'state.json';
const LOCK_FILE = 'lock';

export const TERMINAL_STATUSES = Object.freeze(['done', 'failed', 'stopped']);

export function initialState({ runId, job, input, now = new Date() }) {
  const stamp = now.toISOString();
  return Object.freeze({ version: STATE_VERSION, runId, job, input: Object.freeze({ ...input }),
    status: 'running', createdAt: stamp, updatedAt: stamp, error: null, steps: Object.freeze({}) });
}

export async function writeState(runDir, state, now = new Date()) {
  await mkdir(runDir, { recursive: true });
  const next = { ...state, updatedAt: now.toISOString() };
  const temp = join(runDir, `.state-${randomBytes(4).toString('hex')}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, join(runDir, STATE_FILE));
  const dir = await open(runDir, 'r');
  try { await dir.sync(); } finally { await dir.close(); }
  return next;
}

export async function readState(runDir) {
  let text;
  try { text = await readFile(join(runDir, STATE_FILE), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`no such run (no state file in ${runDir})`);
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new Error(`run state is corrupt (${error.message}); refusing to guess`); }
  if (parsed?.version !== STATE_VERSION || typeof parsed.steps !== 'object') {
    throw new Error(`run state has an unknown shape (version ${parsed?.version})`);
  }
  return parsed;
}

/** New state with one step record replaced. */
export function withStep(state, stepId, record) {
  return { ...state, steps: { ...state.steps, [stepId]: record } };
}

export function withStatus(state, status, error = null) {
  return { ...state, status, error };
}

export async function listRuns(root) {
  let names;
  try { names = await readdir(runsDir(root)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const runs = [];
  for (const name of names.sort()) {
    try { runs.push(await readState(join(runsDir(root), name))); } catch { /* unreadable run: skipped, status <run> explains */ }
  }
  return runs;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const holderPid = text => Number.parseInt(String(text).split(':')[0], 10);

/** Returns a release function that removes the lock only if it is still ours. */
export async function acquireLock(runDir, pid = process.pid) {
  await mkdir(runDir, { recursive: true });
  const file = join(runDir, LOCK_FILE);
  const token = `${pid}:${randomBytes(6).toString('hex')}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(file, token, { flag: 'wx', mode: 0o600 });
      return async () => {
        const current = await readFile(file, 'utf8').catch(() => null);
        if (current === token) await rm(file, { force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const seen = await readFile(file, 'utf8').catch(() => null);
      if (seen === null) continue;
      const holder = holderPid(seen);
      if (Number.isInteger(holder) && alive(holder)) throw new Error(`run is already being worked on by process ${holder}`);
      // Take over by moving the stale lock aside (atomic), never by deleting it:
      // if it changed hands in between, it is put back and we back off.
      const aside = `${file}.stale-${randomBytes(4).toString('hex')}`;
      const moved = await rename(file, aside).then(() => true, () => false);
      if (!moved) continue;
      const movedText = await readFile(aside, 'utf8').catch(() => null);
      if (movedText !== seen) {
        await rename(aside, file).catch(() => {});
        throw new Error('run lock changed hands while being taken over; try again');
      }
      await rm(aside, { force: true });
    }
  }
  throw new Error('could not take the run lock');
}
