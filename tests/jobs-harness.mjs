// Shared helpers for the jobs tests: temp state dir, stub model, counting exec, real gate in a temp dir.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realApprovals from '../plugin/orion-control/dist/approvals.js';
import { createGateApprovals } from '../scripts/lib/jobs/approval.mjs';
import { execAllowed } from '../scripts/lib/jobs/allowlist.mjs';
import { initialState, readState, writeState } from '../scripts/lib/jobs/state.mjs';
import { loadJob } from '../scripts/lib/jobs/registry.mjs';
import { runDirFor, newRunId } from '../scripts/lib/jobs/paths.mjs';

export class CrashError extends Error { constructor(m) { super(m); this.name = 'CrashError'; } }

export async function makeEnv() {
  const dir = await mkdtemp(join(tmpdir(), 'orion-jobs-test-'));
  const root = join(dir, 'state');
  const gate = join(dir, 'gate');
  // Test-only: the repo build stands in for the installed, integrity-checked copy.
  const plugin = { approvals: realApprovals };
  const approvals = createGateApprovals({ root: gate, loadApprovals: async () => realApprovals });
  const paths = plugin.approvals.approvalPaths(gate);
  return { dir, root, gate, approvals, cleanup: () => rm(dir, { recursive: true, force: true }),
    /** What orion-approve does: the only writer of a grant. */
    ownerApproves: id => plugin.approvals.grant(paths, id, 'tester@terminal'),
    tickets: () => plugin.approvals.readTickets(paths),
    ownerDenies: id => plugin.approvals.deny(paths, id),
    mintForeign: hash => plugin.approvals.mintTicket(paths, { canonicalHash: hash, action: 'job_approval', summary: 'other', context: 'other' }) };
}

export function stubModel(replies) {
  const queue = [...replies];
  const calls = [];
  const fn = async request => {
    calls.push(request);
    if (queue.length === 0) throw new Error('stub model has no more replies');
    const next = queue.shift();
    return typeof next === 'string' ? next : JSON.stringify(next);
  };
  fn.calls = calls;
  return fn;
}

export function countingExec(real = execAllowed) {
  const calls = [];
  const fn = async (name, args, options) => { calls.push({ name, args }); return real(name, args, options); };
  fn.calls = calls;
  return fn;
}

export async function newRun(env, job, input = {}) {
  const runId = newRunId(job.name);
  const runDir = runDirFor(runId, env.root);
  await writeState(runDir, initialState({ runId, job: job.name, input }));
  return { runId, runDir };
}

export const toyJob = () => loadJob('toy');
export const load = runDir => readState(runDir);
export const readArtifact = (runDir, name) => readFile(join(runDir, 'artifacts', name), 'utf8');
