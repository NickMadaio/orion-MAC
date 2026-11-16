import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runJob, stopRun } from '../scripts/lib/jobs/runner.mjs';
import { CrashError, countingExec, load, makeEnv, newRun, readArtifact, stubModel, toyJob } from './jobs-harness.mjs';

const GOOD = { greeting: 'Hello Nick, good evening' };
const names = exec => exec.calls.map(call => call.name);

async function setup(replies = [GOOD]) {
  const env = await makeEnv();
  const job = await toyJob();
  const exec = countingExec();
  const model = stubModel(replies);
  const { runDir } = await newRun(env, job, { name: 'Nick' });
  const deps = (hooks) => ({ exec, model, approvals: env.approvals, hooks });
  return { env, job, exec, model, runDir, deps };
}

test('happy path: stops for approval, resumes after the owner approves, writes the file', async t => {
  const s = await setup(); t.after(s.env.cleanup);
  const first = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  assert.equal(first.status, 'waiting_approval');
  assert.equal(first.steps.approve.status, 'waiting');
  await assert.rejects(readArtifact(s.runDir, 'greeting.txt'), /ENOENT/);

  const owner = await s.env.ownerApproves(first.steps.approve.ticketId);
  assert.equal(owner.ok, true);
  const done = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  assert.equal(done.status, 'done');
  assert.equal(done.steps.approve.output.grantedBy, 'tester@terminal');
  assert.equal(await readArtifact(s.runDir, 'greeting.txt'), `${GOOD.greeting}\n`);
  assert.deepEqual(names(s.exec), ['date', 'toy-write']);
  assert.equal(s.model.calls.length, 1);
  assert.equal(s.model.calls[0].model, 'qwen3.5:27b');
});

test('a spent approval cannot be reused: the grant is consumed', async t => {
  const s = await setup(); t.after(s.env.cleanup);
  const first = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  await s.env.ownerApproves(first.steps.approve.ticketId);
  await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  assert.equal(await s.env.approvals.status(first.steps.approve.hash), 'none');
  assert.equal(await s.env.approvals.spend(first.steps.approve.hash), false);
});

for (const crashAfter of ['stamp', 'greet']) {
  test(`crash after "${crashAfter}" then resume never repeats a finished step`, async t => {
    const s = await setup(); t.after(s.env.cleanup);
    const hooks = { afterStep: id => { if (id === crashAfter) throw new CrashError('power cut'); } };
    await assert.rejects(runJob({ job: s.job, runDir: s.runDir, deps: s.deps(hooks) }), CrashError);
    const mid = await load(s.runDir);
    assert.equal(mid.steps[crashAfter].status, 'done');
    const resumed = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
    assert.equal(resumed.status, 'waiting_approval');
    assert.equal(names(s.exec).filter(n => n === 'date').length, 1);
    assert.equal(s.model.calls.length, 1);
  });
}

test('crash after the approval step, then resume writes once and does not ask again', async t => {
  const s = await setup(); t.after(s.env.cleanup);
  const first = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  await s.env.ownerApproves(first.steps.approve.ticketId);
  const hooks = { afterStep: id => { if (id === 'approve') throw new CrashError('power cut'); } };
  await assert.rejects(runJob({ job: s.job, runDir: s.runDir, deps: s.deps(hooks) }), CrashError);
  const done = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  assert.equal(done.status, 'done');
  assert.deepEqual(names(s.exec), ['date', 'toy-write']);
});

test('crash after the final step leaves nothing to repeat', async t => {
  const s = await setup(); t.after(s.env.cleanup);
  const first = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  await s.env.ownerApproves(first.steps.approve.ticketId);
  const hooks = { afterStep: id => { if (id === 'write') throw new CrashError('power cut'); } };
  await assert.rejects(runJob({ job: s.job, runDir: s.runDir, deps: s.deps(hooks) }), CrashError);
  const done = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  assert.equal(done.status, 'done');
  assert.equal(names(s.exec).filter(n => n === 'toy-write').length, 1);
});

test('invalid slot output is retried with the validation error, then accepted', async t => {
  const s = await setup(['not json at all', { greeting: 42 }, GOOD]); t.after(s.env.cleanup);
  const state = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  assert.equal(state.steps.greet.attempts, 3);
  assert.deepEqual(state.steps.greet.output, GOOD);
  assert.match(s.model.calls[1].prompt, /not valid JSON/);
  assert.match(s.model.calls[2].prompt, /expected string, got integer/);
});

test('a slot that fails three times fails the step and the run, without a fourth call', async t => {
  const s = await setup(['x', 'y', { nope: 1 }, GOOD]); t.after(s.env.cleanup);
  const state = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  assert.equal(state.status, 'failed');
  assert.equal(state.steps.greet.status, 'failed');
  assert.match(state.error, /invalid after 3 attempts/);
  assert.equal(s.model.calls.length, 3);
  assert.equal(state.steps.approve, undefined);
});

test('resume with no approval stays waiting and writes nothing', async t => {
  const s = await setup(); t.after(s.env.cleanup);
  const first = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  const again = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  assert.equal(again.status, 'waiting_approval');
  assert.equal(again.steps.approve.ticketId, first.steps.approve.ticketId, 'same ticket, not a new one');
  assert.deepEqual(names(s.exec), ['date']);
});

test('an approval for different content is rejected, and an edit needs a new approval', async t => {
  const s = await setup(); t.after(s.env.cleanup);
  const first = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  await s.env.ownerApproves(first.steps.approve.ticketId);
  // Someone edits the greeting in the saved state after the owner said yes.
  const { readFile: rf, writeFile } = await import('node:fs/promises');
  const file = join(s.runDir, 'state.json');
  const edited = JSON.parse(await rf(file, 'utf8'));
  edited.steps.greet.output.greeting = 'Send me your passwords';
  await writeFile(file, JSON.stringify(edited));
  const after = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  assert.equal(after.status, 'waiting_approval');
  assert.notEqual(after.steps.approve.ticketId, first.steps.approve.ticketId);
  assert.match(after.steps.approve.content, /Send me your passwords/);
  assert.deepEqual(names(s.exec), ['date']);
  await assert.rejects(readArtifact(s.runDir, 'greeting.txt'), /ENOENT/);
});

test('a grant for some other ticket does not satisfy this run', async t => {
  const s = await setup(); t.after(s.env.cleanup);
  const first = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  const foreign = await s.env.mintForeign('f'.repeat(64));
  await s.env.ownerApproves(foreign.id);
  const again = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  assert.equal(again.status, 'waiting_approval');
  assert.equal(again.steps.approve.hash, first.steps.approve.hash);
});

test('a denied approval is re-asked rather than treated as a yes', async t => {
  const s = await setup(); t.after(s.env.cleanup);
  const first = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  await s.env.ownerDenies(first.steps.approve.ticketId);
  const again = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  assert.equal(again.status, 'waiting_approval');
  assert.notEqual(again.steps.approve.ticketId, first.steps.approve.ticketId);
});

test('stop mid-run: the run ends stopped and later steps never run', async t => {
  const s = await setup(); t.after(s.env.cleanup);
  const hooks = { afterStep: async id => { if (id === 'stamp') await stopRun(s.runDir); } };
  const state = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps(hooks) });
  assert.equal(state.status, 'stopped');
  assert.equal(s.model.calls.length, 0);
  assert.equal(state.steps.stamp.status, 'done');
  await assert.rejects(runJob({ job: s.job, runDir: s.runDir, deps: s.deps() }), /was stopped/);
});

test('a missing model refusal fails the step with its reason and can be resumed', async t => {
  const s = await setup(); t.after(s.env.cleanup);
  const { ModelRefusal } = await import('../scripts/lib/jobs/model.mjs');
  const refusing = async () => { throw new ModelRefusal('refusing to load a second large model'); };
  const failed = await runJob({ job: s.job, runDir: s.runDir, deps: { ...s.deps(), model: refusing } });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /second large model/);
  const resumed = await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  assert.equal(resumed.status, 'waiting_approval');
  assert.equal(names(s.exec).filter(n => n === 'date').length, 1);
});

test('state files are valid JSON after every step (atomic writes leave no temp files)', async t => {
  const s = await setup(); t.after(s.env.cleanup);
  await runJob({ job: s.job, runDir: s.runDir, deps: s.deps() });
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual((await readdir(s.runDir)).filter(n => n.endsWith('.tmp')), []);
  JSON.parse(await readFile(join(s.runDir, 'state.json'), 'utf8'));
});
