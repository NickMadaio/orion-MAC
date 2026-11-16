import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, assertSupportedSchema } from '../scripts/lib/jobs/schema.mjs';
import { residencyVerdict, createOllamaAdapter, ModelRefusal } from '../scripts/lib/jobs/model.mjs';
import { execAllowed } from '../scripts/lib/jobs/allowlist.mjs';
import { isRunId, newRunId, runDirFor } from '../scripts/lib/jobs/paths.mjs';
import { cmdList, cmdStatus, parseInputs } from '../scripts/lib/jobs/commands.mjs';
import { validateInputs, loadJob } from '../scripts/lib/jobs/registry.mjs';
import { approvalHash } from '../scripts/lib/jobs/approval.mjs';

const GIB = 1024 ** 3;

test('schema: required, type, extra property, length', () => {
  const schema = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'string', maxLength: 3 } } };
  assert.deepEqual(validate({ a: 'abc' }, schema), []);
  assert.equal(validate({}, schema).length, 1);
  assert.equal(validate({ a: 'abcd' }, schema).length, 1);
  assert.equal(validate({ a: 'x', b: 1 }, schema).length, 1);
  assert.throws(() => assertSupportedSchema({ type: 'object', oneOf: [] }), /not supported/);
});

test('residency: refuses a second large model, allows a small one or the resident one', () => {
  const installed = [{ name: 'big:27b', sizeBytes: 17 * GIB }, { name: 'small:9b', sizeBytes: 6 * GIB }, { name: 'huge:70b', sizeBytes: 40 * GIB }];
  assert.equal(residencyVerdict({ model: 'big:27b', resident: [], installed }).ok, true);
  assert.equal(residencyVerdict({ model: 'big:27b', resident: [{ model: 'huge:70b', sizeBytes: 40 * GIB }], installed }).ok, false);
  assert.equal(residencyVerdict({ model: 'big:27b', resident: [{ model: 'small:9b', sizeBytes: 6 * GIB }], installed }).ok, true);
  assert.equal(residencyVerdict({ model: 'huge:70b', resident: [{ model: 'huge:70b', sizeBytes: 40 * GIB }], installed }).ok, true);
  assert.match(residencyVerdict({ model: 'nope', resident: [], installed }).reason, /not installed/);
});

test('adapter: stub fetch, sends format schema, refuses before chatting when memory is held', async () => {
  const schema = { type: 'object' };
  const requests = [];
  const reply = (resident) => async (url, init) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    const json = url.endsWith('/api/ps') ? { models: resident } : url.endsWith('/api/tags')
      ? { models: [{ name: 'qwen3.5:27b', size: 17 * GIB }] } : { message: { content: '{"ok":true}' } };
    const text = JSON.stringify(json);
    return { ok: true, json: async () => json, text: async () => text };
  };
  const ok = createOllamaAdapter({ fetchImpl: reply([]) });
  assert.equal(await ok({ model: 'qwen3.5:27b', prompt: 'hi', schema }), '{"ok":true}');
  assert.deepEqual(requests.at(-1).body.format, schema);
  const held = createOllamaAdapter({ fetchImpl: reply([{ name: 'big', size: 30 * GIB }]) });
  const before = requests.length;
  await assert.rejects(held({ model: 'qwen3.5:27b', prompt: 'hi', schema }), ModelRefusal);
  assert.ok(requests.slice(before).every(r => !r.url.endsWith('/api/chat')));
  assert.throws(() => createOllamaAdapter({ endpoint: 'http://example.com' }), /local Ollama/);
});

test('allowlist: unknown commands and non-string args are refused; shell text is just an argument', async () => {
  await assert.rejects(execAllowed('sh', ['-c', 'true']), /not on the jobs allowlist/);
  await assert.rejects(execAllowed('echo', [1]), /array of strings/);
  assert.equal((await execAllowed('echo', ['$(whoami); rm -rf x'])).stdout, '$(whoami); rm -rf x');
});

test('paths: run ids are validated and cannot escape the state root', () => {
  assert.ok(isRunId(newRunId('toy')));
  assert.throws(() => runDirFor('../../etc', '/x'), /not a run id/);
});

test('inputs: undeclared and oversized inputs are refused, defaults fill in', async () => {
  const toy = await loadJob('toy');
  assert.deepEqual(validateInputs(toy, {}), { name: 'Nick' });
  assert.throws(() => validateInputs(toy, { evil: 'x' }), /takes no input/);
  assert.throws(() => validateInputs(toy, { name: 'x'.repeat(41) }), /at most 40/);
  assert.deepEqual(parseInputs(['a=b=c']), { a: 'b=c' });
  assert.throws(() => parseInputs(['nokey']), /key=value/);
});

test('approval hash changes with any of job, run, step or content', () => {
  const base = { job: 'toy', runId: 'r', stepId: 's', fields: { a: 'c' } };
  const seen = new Set([approvalHash(base)]);
  for (const key of ['job', 'runId', 'stepId']) seen.add(approvalHash({ ...base, [key]: `${base[key]}x` }));
  seen.add(approvalHash({ ...base, fields: { a: 'cx' } }));
  assert.equal(seen.size, 5);
});

test('list shows the toy job; status of an empty state dir is empty', async () => {
  const jobs = await cmdList();
  assert.ok(jobs.some(job => job.name === 'toy' && job.steps.length === 4));
  assert.deepEqual(await cmdStatus({ root: '/nonexistent-orion-jobs-test-root' }), []);
});
