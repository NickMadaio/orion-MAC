/*
 Job definitions: scripts/jobs/<name>/job.mjs, default export
   { name, description, model?, inputs?: { key: { maxLength } }, steps: [...] }
 Steps are fixed, ordered and written in code. Validation here is what makes
 "outputs are data" structural: a step can only name an allowlisted command by
 key, and nothing a step returns is ever consulted for what runs next.
*/
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAllowedCommand } from './allowlist.mjs';
import { isJobName } from './paths.mjs';
import { assertSupportedSchema } from './schema.mjs';

export const DEFAULT_JOBS_DIR = fileURLToPath(new URL('../../jobs', import.meta.url));
const STEP_ID = /^[a-z][a-z0-9-]{0,30}$/;
const KINDS = ['script', 'slot', 'approval'];

export function validateJob(job) {
  const fail = message => { throw new Error(`job "${job?.name}": ${message}`); };
  if (!job || !isJobName(job.name)) throw new Error(`job has no valid name (${job?.name})`);
  if (!Array.isArray(job.steps) || job.steps.length === 0) fail('has no steps');
  const seen = new Map();
  for (const step of job.steps) {
    if (!STEP_ID.test(step?.id ?? '')) fail(`step id "${step?.id}" is not valid`);
    if (seen.has(step.id)) fail(`duplicate step id "${step.id}"`);
    if (!KINDS.includes(step.kind)) fail(`step "${step.id}" has unknown kind "${step.kind}"`);
    if (step.kind === 'script') {
      if (!isAllowedCommand(step.command)) fail(`step "${step.id}" names "${step.command}", which is not allowlisted`);
      if (typeof step.args !== 'function') fail(`step "${step.id}" needs an args function`);
    }
    if (step.kind === 'slot') {
      if (typeof step.prompt !== 'function') fail(`step "${step.id}" needs a prompt function`);
      try { assertSupportedSchema(step.schema); } catch (error) { fail(`step "${step.id}": ${error.message}`); }
    }
    if (step.kind === 'approval') {
      if (typeof step.fields !== 'function') fail(`step "${step.id}" needs a fields function returning the text to approve`);
      if (typeof step.summary !== 'string' || !step.summary) fail(`step "${step.id}" needs a summary`);
    }
    if (step.outward && (step.kind !== 'script' || !step.requireApproved)) {
      fail(`step "${step.id}" is outward, so it must be a script step gated by requireApproved`);
    }
    if (step.requireApproved && seen.get(step.requireApproved) !== 'approval') {
      fail(`step "${step.id}" requires approval "${step.requireApproved}", which is not an earlier approval step`);
    }
    seen.set(step.id, step.kind);
  }
  return job;
}

/*
 Job files run as code (their args/fields functions). They must live where
 ORION cannot write: a jobs directory outside every root in ORION's mutable
 set, owned by the owner. As a floor this refuses a job directory or job.mjs
 that is a symlink or writable by group/other.
*/
async function assertSafeJobFiles(dir, file, name) {
  for (const path of [dir, file]) {
    const stat = await lstat(path).catch(error => {
      if (error.code === 'ENOENT') throw new Error(`no job called "${name}"`);
      throw error;
    });
    if (stat.isSymbolicLink()) throw new Error(`job "${name}" refused: ${path} is a symlink`);
    if ((stat.mode & 0o022) !== 0) throw new Error(`job "${name}" refused: ${path} is writable by group or others`);
  }
}

export async function loadJob(name, jobsDir = DEFAULT_JOBS_DIR) {
  if (!isJobName(name)) throw new Error(`"${String(name).slice(0, 40)}" is not a valid job name`);
  await assertSafeJobFiles(join(jobsDir, name), join(jobsDir, name, 'job.mjs'), name);
  let module;
  try { module = await import(pathToFileURL(join(jobsDir, name, 'job.mjs')).href); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') throw new Error(`no job called "${name}"`);
    throw error;
  }
  const job = validateJob(module.default);
  if (job.name !== name) throw new Error(`job folder "${name}" defines a job named "${job.name}"`);
  return job;
}

export async function listJobs(jobsDir = DEFAULT_JOBS_DIR) {
  const entries = await readdir(jobsDir, { withFileTypes: true }).catch(() => []);
  const jobs = [];
  for (const entry of entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try { jobs.push(await loadJob(entry.name, jobsDir)); } catch { /* a broken job is not listed */ }
  }
  return jobs;
}

/** Inputs: only keys the job declares, each a bounded string. */
export function validateInputs(job, raw) {
  const spec = job.inputs ?? {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(spec, key)) throw new Error(`job "${job.name}" takes no input "${key}" (takes: ${Object.keys(spec).join(', ') || 'none'})`);
    const max = spec[key].maxLength ?? 200;
    if (typeof value !== 'string' || value.length > max) throw new Error(`input "${key}" must be text of at most ${max} characters`);
    out[key] = value;
  }
  for (const [key, def] of Object.entries(spec)) {
    if (out[key] === undefined) {
      if (def.default === undefined) throw new Error(`job "${job.name}" needs --input ${key}=...`);
      out[key] = def.default;
    }
  }
  return out;
}
