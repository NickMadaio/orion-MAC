// Code-checked results vs advisory tone results: which grader produced each verdict, and what the summary counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { effectCheck, gradeItem, applyToneVerdicts, summarizeGrading, summaryLine } from "../lib/grading.mjs";
import { checkReplies, summarize, validateScenarios } from "../lib/scenarios.mjs";

const none = { calendar: { newEntries: [], removedEntries: [] }, sandboxCalendar: null, memory: [], files: [], logs: [], todos: { added: [], completed: [] }, fixtures: [], changedAnything: false };
const withCal = { ...none, calendar: { newEntries: [{ a: 1 }], removedEntries: [] }, changedAnything: true };
const withSandboxMove = { ...none, sandboxCalendar: { created: [], deleted: [], moved: [{ title: "gym" }], todosAdded: [], todosCompleted: [] }, changedAnything: true };

test("effect check: calendar needs calendar evidence, not just any change", () => {
  const e = { kind: "calendar", detail: "gym moved", check: "changed" };
  assert.equal(effectCheck(e, withCal).pass, true);
  assert.equal(effectCheck(e, withSandboxMove).pass, true);
  assert.equal(effectCheck(e, none).pass, false);
  assert.equal(effectCheck(e, { ...none, memory: [{ path: "memory/x" }], changedAnything: true }).pass, false);
  assert.equal(effectCheck(e, none).grader, "code");
});

test("effect check: unchanged and none fail when something moved", () => {
  assert.equal(effectCheck({ kind: "none", detail: "no change", check: "unchanged" }, none).pass, true);
  assert.equal(effectCheck({ kind: "none", detail: "no change", check: "unchanged" }, withCal).pass, false);
  assert.equal(effectCheck({ kind: "calendar", detail: "no events deleted yet", check: "unchanged" }, withCal).pass, false);
  assert.equal(effectCheck({ kind: "app", detail: "canary unchanged", check: "unchanged" }, { ...none, fixtures: [{ status: "removed" }], changedAnything: true }).pass, false);
});

test("effect check: other kinds, notes, skip, and the default from kind", () => {
  assert.equal(effectCheck({ kind: "memory", detail: "m", check: "changed" }, { ...none, memory: [{}], changedAnything: true }).pass, true);
  assert.equal(effectCheck({ kind: "reminder", detail: "r", check: "changed" }, { ...none, todos: { added: [{}], completed: [] }, changedAnything: true }).pass, true);
  assert.equal(effectCheck({ kind: "app", detail: "note", check: "changed" }, { ...none, notes: { created: [{ id: 1 }] }, changedAnything: true }).pass, true);
  assert.equal(effectCheck({ kind: "app", detail: "note", check: "changed" }, { ...none, notes: { created: [] } }).pass, false);
  assert.equal(effectCheck({ kind: "calendar", detail: "either", check: "skip" }, none), null);
  assert.equal(effectCheck({ kind: "none", detail: "x" }, withCal).pass, false, "no check field: none means unchanged");
  assert.equal(effectCheck({ kind: "calendar", detail: "x" }, withCal).pass, true, "no check field: a kind means changed");
  assert.equal(effectCheck({ kind: "app", detail: "x" }, none), null, "no check field and an app kind is not checkable");
  assert.equal(effectCheck(undefined, none), null);
});

test("unusable regexes ({} from a JSON.stringify'd RegExp) are counted, never silently passed", () => {
  const c = checkReplies({ rubric: "r", reply_must: [{}, "ok"], reply_must_not: ["bad"] }, ["all ok"]);
  assert.equal(c.reply_must[0].pass, null);
  assert.equal(c.reply_must[0].unusable, true);
  assert.equal(c.reply_must[1].pass, true);
  assert.equal(c.passed, true);
  assert.equal(c.unusable, 1);
  const none2 = checkReplies({ rubric: "r", reply_must: [{}] }, ["x"]);
  assert.equal(none2.hasRegex, false, "an item with only unusable patterns has no regex grading");
});

test("an unusable reply_must_not pattern is filtered and reported, never failing the item", () => {
  const g = gradeItem({ rubric: "r", reply_must_not: [{}], effect: { kind: "calendar", detail: "d", check: "changed" } }, ["fine"], withCal);
  assert.equal(g.passed, true, "{} in reply_must_not must not fail the item");
  assert.equal(g.verdicts.filter((v) => v.check === "reply_must_not").length, 0);
  assert.equal(g.unusable, 1);
  assert.deepEqual(g.unusablePatterns, [{ check: "reply_must_not", pattern: {} }]);
  const both = gradeItem({ rubric: "r", reply_must: [{}], reply_must_not: [{}, "bad"] }, ["fine"], none);
  assert.deepEqual(both.unusablePatterns.map((u) => u.check), ["reply_must", "reply_must_not"]);
  assert.equal(both.passed, true);
  assert.equal(both.hasCode, true);
});

test("an item with no usable code check is unchecked (passed: null), not a pass", () => {
  const g = gradeItem({ rubric: "r", reply_must: [{}], effect: { kind: "calendar", detail: "d", check: "skip" } }, ["x"], none);
  assert.equal(g.hasCode, false);
  assert.equal(g.passed, null);
  assert.equal(g.unchecked, true);
  const ok = gradeItem({ rubric: "r", reply_must: ["x"] }, ["x"], none);
  assert.equal(ok.unchecked, false);
});

test("summary counts unchecked items and prints code-checked / unchecked / advisory tone plainly", () => {
  const item = (id, expect, replies, effect) => ({ id, area: "a", wording: "clear", turns: [{ latencyMs: 1, reply: replies[0] }], cleanup: { verified: { ok: true } }, checks: gradeItem(expect, replies, effect) });
  const results = [
    item("p", { rubric: "r", reply_must: ["x"] }, ["x"], none),
    item("f", { rubric: "r", reply_must: ["y"] }, ["x"], none),
    item("u", { rubric: "r", reply_must: [{}], effect: { kind: "calendar", detail: "d", check: "skip" } }, ["x"], none),
    { id: "s", skipped: "not here", turns: [] },
  ];
  const s = summarizeGrading(results);
  assert.deepEqual([s.code.graded, s.code.pass, s.code.fail, s.code.unchecked, s.code.uncheckedIds], [2, 1, 1, 1, ["u"]]);
  assert.equal(s.unusablePatterns, 1);
  assert.equal(summaryLine(s), "2 code-checked (1 pass, 1 fail), 1 unchecked (no usable check), 3 advisory tone (0 graded)");
  const record = summarize(results);
  assert.equal(record.unchecked, 1, "the run record (summary.json) carries the unchecked count");
  assert.equal(record.line, summaryLine(s));
  assert.equal(record.regex.graded, 2, "unchecked items stay out of the pass/fail totals");
});

test("gradeItem: code verdicts, a tone verdict that is pending and advisory, and who graded each", () => {
  const g = gradeItem({ rubric: "polite", rubric_kind: "tone", reply_must: ["done"], effect: { kind: "calendar", detail: "d", check: "changed" } }, ["done"], withCal);
  assert.equal(g.passed, true);
  assert.equal(g.hasCode, true);
  assert.deepEqual(g.verdicts.map((v) => [v.check, v.grader, v.advisory]), [["reply_must", "code", false], ["effect", "code", false], ["rubric", "model", true]]);
  assert.equal(g.verdicts.at(-1).pass, null);
  assert.equal(g.verdicts.at(-1).status, "pending");
  const fail = gradeItem({ rubric: "r", effect: { kind: "calendar", detail: "d", check: "changed" } }, ["hi"], none);
  assert.equal(fail.passed, false);
});

test("a rubric that is not marked tone still never counts toward pass/fail", () => {
  const g = gradeItem({ rubric: "r", reply_must_not: ["bad"] }, ["fine"], none);
  const rub = g.verdicts.find((v) => v.check === "rubric");
  assert.equal(rub.advisory, true);
  assert.equal(rub.grader, "model");
});

test("summary prints code results and tone results separately; tone is excluded from the total", () => {
  const mk = (id, codePass, tonePass) => ({ id, area: "a", wording: "clear", turns: [{ latencyMs: 10, reply: "x" }], cleanup: { verified: { ok: true } },
    checks: { passed: codePass, hasRegex: true, hasCode: true, verdicts: [{ check: "reply_must", grader: "code", advisory: false, pass: codePass }, { check: "rubric", grader: "model", advisory: true, pass: tonePass, status: tonePass === null ? "pending" : "graded" }] } });
  const results = [mk("a", true, null), mk("b", false, null), mk("c", true, null)];
  let s = summarizeGrading(results);
  assert.deepEqual([s.code.graded, s.code.pass, s.code.fail, s.code.failing], [3, 2, 1, ["b"]]);
  assert.deepEqual([s.tone.items, s.tone.graded, s.tone.pending, s.tone.score], [3, 0, 3, null]);
  assert.equal(s.tone.advisory, true);
  const verdicts = { a: { pass: true, grader: "model:grader-x" }, b: { pass: false, grader: "model:grader-x" } };
  const after = applyToneVerdicts(results, verdicts);
  assert.equal(results[0].checks.verdicts[1].pass, null, "input not mutated");
  s = summarizeGrading(after);
  assert.deepEqual([s.tone.graded, s.tone.pass, s.tone.pending, s.tone.score], [2, 1, 1, 0.5]);
  assert.equal(s.code.pass, 2, "tone verdicts do not move the code total");
  assert.equal(after[0].checks.verdicts[1].grader, "model:grader-x");
});

test("every shipped scenario: valid, rubric marked tone, effect check explicit, no dead patterns left unreported", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../scenarios");
  const items = readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  assert.equal(items.length, 144);
  assert.deepEqual(validateScenarios(items), []);
  for (const it of items) {
    assert.equal(it.expect.rubric_kind, "tone", it.id);
    assert.ok(["changed", "unchanged", "skip"].includes(it.expect.effect.check), `${it.id} effect.check`);
  }
  const checked = items.filter((i) => i.expect.effect.check !== "skip").length;
  assert.ok(checked >= 120, `only ${checked} items have a code-checked effect`);
});
