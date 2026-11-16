// Every correction-to-rule attempt and every questions-queue add attempt leaves one JSONL row (A6, 2026-11-16).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "orion-questions");
const { logAttempt, learningLogPath, readAttempts, LEARNING_LOG_MAX_BYTES } = await import("../scripts/lib/brain/learning-log.mjs");
const NOW = new Date(2026, 10, 16, 15);

function env() {
  const root = mkdtempSync(join(tmpdir(), "learning-log-"));
  const ctl = join(root, "ctl"); mkdirSync(ctl);
  return { root, ctl, vars: { ORION_CONTROLLED_DIR: ctl, ORION_NOW: NOW.toISOString(), ORION_BRIDGE_BIN: "/nonexistent" } };
}
const run = (e, ...args) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, ...e.vars }, encoding: "utf8" });
const log = (e) => readAttempts(learningLogPath(e.ctl));

test("logAttempt appends one timestamped row per call and keeps earlier rows", () => {
  const e = env(); const file = learningLogPath(e.ctl);
  assert.equal(logAttempt(file, { kind: "correction", trigger: { message: "its called macro not econ" }, decision: "qualified", write: { result: "ok" } }, NOW).ok, true);
  assert.equal(logAttempt(file, { kind: "correction", trigger: { message: "no" }, decision: "not-qualified", reason: "no pattern matched" }, NOW).ok, true);
  const rows = readAttempts(file);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].at, NOW.toISOString());
  assert.equal(rows[0].write.result, "ok");
  assert.equal(rows[1].reason, "no pattern matched");
});

test("a log that cannot be written is reported, not swallowed", () => {
  const e = env(); const dirAsFile = join(e.ctl, "learning-attempts.jsonl"); mkdirSync(dirAsFile);
  const r = logAttempt(dirAsFile, { kind: "correction", decision: "qualified" }, NOW);
  assert.equal(r.ok, false);
  assert.match(r.error, /EISDIR|illegal operation/i);
});

test("orion-questions add logs an added attempt", () => {
  const e = env();
  const a = run(e, "add", "Who is Sam?", "--why", "lifts with Sam", "--topic", "person");
  assert.equal(a.status, 0, a.stderr);
  const rows = log(e);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "question-add");
  assert.equal(rows[0].decision, "qualified");
  assert.equal(rows[0].write.result, "ok");
  assert.equal(rows[0].trigger.q, "Who is Sam?");
  assert.equal(rows[0].trigger.why, "lifts with Sam");
});

test("orion-questions add logs a duplicate, a refusal and bad arguments", () => {
  const e = env();
  run(e, "add", "Who is Sam?");
  run(e, "add", "whos sam");
  const secret = run(e, "add", "my key is sk" + "-abcdefghijklmnopqrstuvwx");
  const empty = run(e, "add", "   ");
  const rows = log(e);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.decision), ["qualified", "not-qualified", "not-qualified", "not-qualified"]);
  assert.match(rows[1].reason, /duplicate/i);
  assert.equal(rows[1].write.result, "skipped");
  assert.equal(rows[2].write.result, "refused");
  assert.equal(rows[2].write.exit, secret.status);
  assert.ok(rows[2].write.error.length > 0);
  assert.equal(rows[3].write.result, "error");
  assert.equal(empty.status, 2);
});

test("a questions store that cannot be written logs the error text", () => {
  const e = env(); mkdirSync(join(e.ctl, "questions.jsonl"));
  const r = run(e, "add", "Who is Sam?");
  assert.notEqual(r.status, 0);
  const rows = log(e);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].write.result, "error");
  assert.ok(rows[0].write.error.length > 0);
});

test("an evaluation (sandboxed) writes its own log file, not the live one", () => {
  const e = env();
  assert.match(learningLogPath(e.ctl, { sandboxed: true }), /eval-learning-attempts\.jsonl$/);
  assert.equal(existsSync(learningLogPath(e.ctl)), false);
});

test("a refused secret never reaches the attempt log, in the question or the why", () => {
  const e = env();
  const key = "sk" + "-abcdefghijklmnopqrstuvwx";
  const r1 = run(e, "add", `my key is ${key}`);
  const r2 = run(e, "add", "What is the wifi?", "--why", `the key is ${key}`);
  assert.equal(r1.status, 3); assert.equal(r2.status, 3);
  const raw = readFileSync(learningLogPath(e.ctl), "utf8");
  assert.ok(!raw.includes(key), "the secret is not in learning-attempts.jsonl");
  assert.ok(!raw.includes("abcdefghijklmnopqrstuvwx"));
  const rows = log(e);
  assert.equal(rows.length, 2);
  assert.match(rows[0].reason, /secret-like/);
  assert.equal(rows[0].write.result, "refused");
});

test("other logged question text is truncated", () => {
  const e = env();
  const long = "Who is Sam? " + "x ".repeat(400);
  run(e, "add", long, "--why", "y ".repeat(400));
  const row = log(e)[0];
  assert.ok(row.trigger.q.length <= 200, `q is ${row.trigger.q.length}`);
  assert.ok(row.trigger.why.length <= 200);
});

test("the log file is created owner-only (0600)", () => {
  const e = env(); const file = learningLogPath(e.ctl);
  logAttempt(file, { kind: "question-add", decision: "qualified" }, NOW);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("the log is capped: past the limit it is cut to its newest rows", () => {
  const e = env(); const file = learningLogPath(e.ctl);
  const old = `${JSON.stringify({ kind: "question-add", pad: "p".repeat(900) })}\n`;
  writeFileSync(file, old.repeat(Math.ceil(LEARNING_LOG_MAX_BYTES / old.length) + 5));
  logAttempt(file, { kind: "question-add", decision: "qualified", reason: "newest" }, NOW);
  assert.ok(statSync(file).size <= LEARNING_LOG_MAX_BYTES);
  const rows = readAttempts(file);
  assert.equal(rows.at(-1).reason, "newest");
});

test("an existing log with wide permissions is tightened to owner-only", () => {
  const e = env(); const file = learningLogPath(e.ctl);
  writeFileSync(file, ""); chmodSync(file, 0o644);
  logAttempt(file, { kind: "correction", decision: "qualified" }, NOW);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
