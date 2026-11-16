/*
 Where the jobs lane keeps its state, and what a run id looks like.

 The state root is a constant taken from the account database (userInfo), not
 from $HOME. There is no environment override: a caller that
 could redirect state (or the gate) by environment could point the lane at a
 directory it controls. Tests pass `root` explicitly.

 State is NOT trusted for approval decisions (ORION can write this directory):
 the gate dir is the only authority, see approval.mjs and steps.mjs.
*/
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_STATE_ROOT = join(userInfo().homedir, '.openclaw/orion-controlled/jobs');

const RUN_ID = /^[a-z][a-z0-9-]{0,40}-\d{14}-[0-9a-f]{4}$/;
const JOB_NAME = /^[a-z][a-z0-9-]{0,40}$/;

export function stateRoot() { return DEFAULT_STATE_ROOT; }

export function isJobName(name) { return typeof name === 'string' && JOB_NAME.test(name); }
export function isRunId(id) { return typeof id === 'string' && RUN_ID.test(id); }

export function newRunId(job, now = new Date(), entropy = randomBytes(2).toString('hex')) {
  if (!isJobName(job)) throw new Error(`"${job}" is not a valid job name`);
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
  return `${job}-${stamp}-${entropy}`;
}

export function runDirFor(runId, root = stateRoot()) {
  if (!isRunId(runId)) throw new Error(`"${String(runId).slice(0, 60)}" is not a run id`);
  return join(root, 'runs', runId);
}

export function runsDir(root = stateRoot()) { return join(root, 'runs'); }
