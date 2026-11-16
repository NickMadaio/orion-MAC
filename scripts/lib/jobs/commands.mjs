/*
 The CLI's verbs as functions, so tests can call them with injected deps.
 There is deliberately no `approve` here: a yes comes only from
 `orion-approve`, and `resume` proceeds only if that grant verifies.
*/
import { newRunId, runDirFor, stateRoot } from './paths.mjs';
import { initialState, listRuns, readState, writeState } from './state.mjs';
import { listJobs, loadJob, validateInputs, DEFAULT_JOBS_DIR } from './registry.mjs';
import { runJob, stopRun } from './runner.mjs';
import { execAllowed } from './allowlist.mjs';
import { createOllamaAdapter } from './model.mjs';
import { createGateApprovals } from './approval.mjs';

/** Real dependencies; the model adapter and approval gate are built lazily. */
export function defaultDeps() {
  let model;
  let approvals;
  return {
    exec: execAllowed,
    model: (request) => { model ??= createOllamaAdapter(); return model(request); },
    approvals: {
      status: (...a) => (approvals ??= createGateApprovals()).status(...a),
      grantedBy: (...a) => (approvals ??= createGateApprovals()).grantedBy(...a),
      mint: (...a) => (approvals ??= createGateApprovals()).mint(...a),
      spend: (...a) => (approvals ??= createGateApprovals()).spend(...a),
    },
  };
}

export function parseInputs(pairs) {
  const out = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at < 1) throw new Error(`--input wants key=value, got "${pair.slice(0, 40)}"`);
    out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}

export async function cmdList({ jobsDir = DEFAULT_JOBS_DIR } = {}) {
  return (await listJobs(jobsDir)).map(job => ({ name: job.name, description: job.description ?? '',
    steps: job.steps.map(step => `${step.id}:${step.kind}`), inputs: Object.keys(job.inputs ?? {}) }));
}

export async function cmdStart({ jobName, input = {}, root = stateRoot(), jobsDir = DEFAULT_JOBS_DIR, deps, now = new Date() }) {
  const job = await loadJob(jobName, jobsDir);
  const runId = newRunId(job.name, now);
  const state = initialState({ runId, job: job.name, input: validateInputs(job, input), now });
  const runDir = runDirFor(runId, root);
  await writeState(runDir, state, now);
  return runJob({ job, runDir, deps });
}

export async function cmdResume({ runId, root = stateRoot(), jobsDir = DEFAULT_JOBS_DIR, deps }) {
  const runDir = runDirFor(runId, root);
  const state = await readState(runDir);
  const job = await loadJob(state.job, jobsDir);
  return runJob({ job, runDir, deps });
}

export async function cmdStop({ runId, root = stateRoot() }) {
  return stopRun(runDirFor(runId, root));
}

export async function cmdStatus({ runId, root = stateRoot() } = {}) {
  if (runId) return readState(runDirFor(runId, root));
  return listRuns(root);
}

export function describeRun(state) {
  const lines = [`${state.runId}  ${state.status}${state.error ? `  (${state.error})` : ''}`];
  for (const [id, record] of Object.entries(state.steps)) {
    const extra = record.status === 'waiting' ? `  waiting for owner: orion-approve ${record.ticketId}` : '';
    lines.push(`  ${id.padEnd(10)} ${record.status}${extra}`);
  }
  if (state.status === 'waiting_approval') {
    const waiting = Object.values(state.steps).find(record => record.status === 'waiting');
    if (waiting) lines.push('', 'Content to approve:', ...String(waiting.content).split('\n').map(l => `  | ${l}`),
      '', `Approve as the owner (orion-approve ${waiting.ticketId}), then: orion-jobs resume ${state.runId}`);
  }
  return lines.join('\n');
}

