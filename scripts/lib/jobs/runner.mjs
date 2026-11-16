/*
 The loop. Walks the job's own ordered steps, skips any already done, runs the
 first unfinished one, and writes state atomically after each. A step stops the
 run by returning `halt` (approval) or throwing StepError (failure). A `stop`
 written to the state file by another process is honoured before the next step.

 Crash safety for steps with outside effects: "running" and an idempotency key
 are persisted BEFORE the step executes. A gated step's grant is spent before
 it executes too, so an `outward` step found running or failed on resume is
 never re-run: its approval record is dropped and the owner must approve again.
*/
import { acquireLock, readState, writeState, withStep, withStatus } from './state.mjs';
import { ApprovalError, EXECUTORS, StepError, idempotencyKey, makeContext } from './steps.mjs';

const clock = deps => (deps.now ?? (() => new Date()))();
const without = (steps, ids) => Object.fromEntries(Object.entries(steps).filter(([id]) => !ids.includes(id)));

/* Commit onto the freshest state so a concurrent `stop` is never overwritten. */
async function commit(runDir, stepId, record, deps, status, job) {
  const latest = await readState(runDir);
  const gate = record.status === 'done' ? job?.steps.find(s => s.id === stepId)?.requireApproved : null;
  const withoutWarning = gate && latest.interrupted?.[gate]
    ? { ...latest, interrupted: Object.fromEntries(Object.entries(latest.interrupted).filter(([id]) => id !== gate)) } : latest;
  const base = withStep(withoutWarning, stepId, record);
  const next = latest.status === 'stopped' ? base : withStatus(base, status ?? 'running');
  return writeState(runDir, next, clock(deps));
}

async function failRun(runDir, job, stepId, error, deps) {
  const latest = await readState(runDir);
  const record = { ...(latest.steps[stepId] ?? { id: stepId }), id: stepId, status: 'failed',
    finishedAt: clock(deps).toISOString(), error: error.message, ...(error.details ?? {}) };
  const dropped = error instanceof ApprovalError ? [job.steps.find(s => s.id === stepId).requireApproved] : [];
  const steps = without({ ...latest.steps, [stepId]: record }, dropped);
  const next = latest.status === 'stopped' ? { ...latest, steps }
    : withStatus({ ...latest, steps }, 'failed', `step "${stepId}": ${error.message}`);
  return writeState(runDir, next, clock(deps));
}

/*
 On resume, an outward step that was running or failed may or may not have had
 its effect. Forget it and the approval that covered it: the approval step
 then asks the owner again, and only a fresh yes lets it run.
*/
async function requireReapprovalForInterruptedOutwardSteps(job, runDir, deps) {
  const state = await readState(runDir);
  const hit = job.steps.filter(step => step.outward && ['running', 'failed'].includes(state.steps[step.id]?.status));
  if (hit.length === 0) return state;
  const warnings = Object.fromEntries(hit.map(step => [step.requireApproved,
    { step: step.id, was: state.steps[step.id].status, startedAt: state.steps[step.id].startedAt ?? 'an unknown time' }]));
  return writeState(runDir, { ...state, interrupted: { ...(state.interrupted ?? {}), ...warnings },
    steps: without(state.steps, hit.flatMap(step => [step.id, step.requireApproved])) }, clock(deps));
}

/**
 * Run or resume. deps: { exec, model, approvals, now?, hooks?: { afterStep } }.
 * Returns the final state. Unexpected errors (including a hook's simulated
 * crash) propagate without being recorded as a step failure.
 */
export async function runJob({ job, runDir, deps }) {
  const release = await acquireLock(runDir);
  try {
    let state = await readState(runDir);
    if (state.status === 'done') return state;
    if (state.status === 'stopped') throw new Error('this run was stopped; start a new one');
    await requireReapprovalForInterruptedOutwardSteps(job, runDir, deps);
    state = await writeState(runDir, withStatus(await readState(runDir), 'running'), clock(deps));

    for (const step of job.steps) {
      state = await readState(runDir);
      if (state.status === 'stopped') return state;
      const existing = state.steps[step.id];
      if (existing?.status === 'done') continue;

      const ctx = makeContext(job, state, runDir);
      const started = { ...(existing ?? {}), id: step.id, kind: step.kind, status: 'running',
        startedAt: clock(deps).toISOString(), error: null, idempotencyKey: idempotencyKey(state.runId, step.id) };
      let result;
      try {
        await commit(runDir, step.id, started, deps); // persisted before anything executes
        result = await EXECUTORS[step.kind](step, ctx, started, deps, job);
      } catch (error) {
        if (error instanceof StepError || error?.name === 'Error') return failRun(runDir, job, step.id, error, deps);
        throw error;
      }
      state = await commit(runDir, step.id, result.record, deps, result.halt, job);
      if (result.halt) return state;
      await deps.hooks?.afterStep?.(step.id, state);
    }
    const latest = await readState(runDir);
    return latest.status === 'stopped' ? latest : writeState(runDir, withStatus(latest, 'done'), clock(deps));
  } finally {
    await release();
  }
}

/** Mark a run stopped. Safe to call from another process while the runner is mid-step. */
export async function stopRun(runDir, now = new Date()) {
  const state = await readState(runDir);
  if (['done', 'failed', 'stopped'].includes(state.status)) return state;
  return writeState(runDir, withStatus(state, 'stopped', 'stopped by owner'), now);
}
