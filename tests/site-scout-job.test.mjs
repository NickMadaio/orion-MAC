// The site-scout job end to end on fixtures, through the real runner, allowlist and approval gate.
import './site-nonet.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runJob } from '../scripts/lib/jobs/runner.mjs';
import { loadJob, validateInputs } from '../scripts/lib/jobs/registry.mjs';
import { countingExec, makeEnv, newRun, stubModel } from './jobs-harness.mjs';

async function setup(t, input = {}) {
  const env = await makeEnv();
  t.after(env.cleanup);
  const job = await loadJob('site-scout');
  const exec = countingExec();
  const model = stubModel([]);
  const { runDir } = await newRun(env, job, validateInputs(job, { year: '2026', ...input }));
  const deps = () => ({ exec, model, approvals: env.approvals });
  return { env, job, exec, model, runDir, deps };
}

test('runs on fixtures, produces cards, and stops at the approval', async t => {
  const s = await setup(t);
  const state = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  assert.equal(state.status, 'waiting_approval');
  for (const id of ['discover', 'score', 'classify', 'cards']) assert.equal(state.steps[id].status, 'done', id);
  const cards = JSON.parse(state.steps.cards.output.stdout);
  assert.ok(cards.length >= 3, `only ${cards.length} cards`);
  assert.ok(cards.every(card => card.json && typeof card.text === 'string'));
  assert.equal(state.steps.approve.status, 'waiting');
  assert.match(state.steps.approve.content, /1\. /);
  assert.deepEqual([...new Set(s.exec.calls.map(call => call.name))], ['echo'], 'only the allowlisted echo ran');
  assert.equal(s.model.calls.length, 0, 'no model call');
});

test('resuming without a grant does not proceed past the approval', async t => {
  const s = await setup(t);
  const first = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  const calls = s.exec.calls.length;
  const again = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  assert.equal(again.status, 'waiting_approval');
  assert.equal(again.steps.approve.ticketId, first.steps.approve.ticketId);
  assert.equal(s.exec.calls.length, calls, 'no step re-ran');
});

test('live=on is refused and nothing is fetched', async t => {
  const s = await setup(t, { live: 'on' });
  const state = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  assert.equal(state.status, 'failed');
  assert.match(state.error, /live mode is not available/);
  assert.equal(s.exec.calls.length, 0);
});

test('a fixtures input outside tests/fixtures/site is refused', async t => {
  for (const fixtures of ['/etc', '../../..', 'job/../../..']) {
    const s = await setup(t, { fixtures });
    const state = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
    assert.equal(state.status, 'failed', fixtures);
    assert.match(state.error, /absolute|outside/, fixtures);
  }
});
