import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { loadFolder, runRecallCheck } from "../scripts/lib/memory/recall-check.mjs";
import { stubEmbedder } from "../scripts/lib/memory/embed.mjs";

const root = new URL("..", import.meta.url).pathname;
const folder = join(root, "tests/fixtures/recall");

test("fixtures are synthetic and shaped as expected: 25 facts, 25 questions, every expected id exists", () => {
  const { facts, questions } = loadFolder(folder);
  assert.equal(facts.length, 25);
  assert.equal(questions.length, 25);
  const ids = new Set(facts.map((f) => f.id));
  for (const q of questions) assert.ok(ids.has(q.expect), q.expect);
});

test("recall check with the stub embedder: hybrid hit@5 is at least 90% and hit@1 at least 80%", async () => {
  const result = await runRecallCheck({ ...loadFolder(folder), embedder: stubEmbedder() });
  assert.equal(result.questions, 25);
  assert.ok(result.hybrid.hit5 >= 0.9, JSON.stringify(result));
  assert.ok(result.hybrid.hit1 >= 0.8, JSON.stringify(result));
  assert.ok(result.hybrid.hit5 >= result.embeddingOnly.hit5, "fusion is no worse than the embedding half");
});

test("a wrong expectation is reported as a miss, not a pass", async () => {
  const { facts } = loadFolder(folder);
  const result = await runRecallCheck({ facts, questions: [{ q: "what is the cat called", expect: "f25" }], embedder: stubEmbedder() });
  assert.equal(result.hybrid.hit5, 0);
  assert.equal(result.misses.length, 1);
});

test("scripts/orion-recall-check prints the rates and --json parses", () => {
  const text = execFileSync(process.execPath, [join(root, "scripts/orion-recall-check"), folder], { encoding: "utf8" });
  assert.match(text, /25 questions over 25 chunks/);
  assert.match(text, /hybrid\s+hit@1 \d+%\s+hit@5 \d+%/);
  const json = JSON.parse(execFileSync(process.execPath, [join(root, "scripts/orion-recall-check"), folder, "--json"], { encoding: "utf8" }));
  assert.equal(json.questions, 25);
});
