import test from "node:test";
import assert from "node:assert/strict";
import { makeRow, appendRow, parseRows, delta, check, corpusChanged, lastRows, formatTable } from "../scripts/lib/eval-trend.mjs";

const rep = (o = {}) => makeRow("replay", { cases: 100, pass: 90, fail: 0, xfail: 10, xpass: 0, skip: 0, durationMs: 1200, failing: [], ...o }, { commit: "abc1234", date: "2026-11-16" });

test("append is immutable", () => { const a = []; const b = appendRow(a, rep()); assert.equal(a.length, 0); assert.equal(b.length, 1); });
test("makeRow validates and strips paths", () => {
  assert.throws(() => makeRow("nope", {}));
  assert.throws(() => makeRow("live", { pass: 5, total: 3 }));
  assert.throws(() => makeRow("replay", { pass: 1 }));
  assert.throws(() => makeRow("live", { pass: 3, total: 4 }, { note: "see /Users/x/secret.txt" }), /home directory/);
  assert.throws(() => makeRow("live", { pass: 3, total: 4 }, { note: "a@b.com" }), /email/);
  assert.throws(() => makeRow("live", { pass: 3, total: 4 }, { note: 'he said "one two three four five six" ok' }), /quotes/);
  assert.equal(makeRow("live", { pass: 3, total: 4 }, { note: 'said "ok then" fine' }).note, 'said "ok then" fine');
  assert.equal(makeRow("live", { pass: 3, total: 4 }, { note: "x".repeat(300) }).note.length, 120);
  assert.equal(makeRow("live", { pass: 3, total: 4 }, { dirty: true }).dirty, true);
  assert.equal(makeRow("live", { pass: 3, total: 4 }).dirty, undefined);
});
test("delta verdicts for replay", () => {
  assert.equal(delta(undefined, rep()).verdict, "FIRST");
  assert.equal(delta(rep(), rep()).verdict, "SAME");
  assert.equal(delta(rep(), rep({ fail: 1, pass: 89, failing: ["a"] })).verdict, "WORSE");
  assert.equal(delta(rep({ fail: 1, pass: 89 }), rep()).verdict, "BETTER");
  assert.equal(delta(rep(), rep({ pass: 89, xfail: 11 })).verdict, "WORSE");
});
test("corpus change flagged and does not call fewer passes worse", () => {
  const a = rep(), b = rep({ cases: 110, pass: 90, xfail: 20 });
  assert.ok(corpusChanged(a, b));
  assert.equal(delta(a, b).corpusChanged, true);
  assert.equal(delta(a, rep({ cases: 110, pass: 85, xfail: 25 })).verdict, "SAME");
  assert.match(formatTable([a, b], "replay"), /CORPUS CHANGED/);
});
test("parser delta", () => {
  const p = (e, w) => makeRow("parser", { exact: e, writeWrong: w, clarify: 10, p50Ms: 1500 });
  assert.equal(delta(p(80, 8), p(83, 8)).verdict, "BETTER");
  assert.equal(delta(p(80, 8), p(80, 12)).verdict, "WORSE");
  assert.equal(delta(p(80, 8), p(80, 8)).verdict, "SAME");
});
test("check exit codes", () => {
  assert.equal(check([]).code, 0);
  assert.equal(check([rep()]).code, 0);
  assert.equal(check([rep(), rep()]).code, 0);
  assert.equal(check([rep(), rep({ fail: 1, pass: 89, failing: ["x"] })]).code, 1);
  assert.equal(check([rep(), rep({ pass: 89, xfail: 11 })]).code, 1);
  assert.equal(check([rep({ fail: 1, pass: 89, failing: ["x"] }), rep()]).code, 0);
  assert.equal(check([makeRow("parser", { exact: 1, writeWrong: 1, clarify: 1 }), rep()]).code, 0);
});
test("malformed rows tolerated", () => {
  const txt = ["", "{bad", JSON.stringify(rep()), "[1]", "null", '{"kind":"zzz"}', JSON.stringify(rep())].join("\n");
  const { rows, skipped } = parseRows(txt);
  assert.equal(rows.length, 2); assert.equal(skipped, 4);
  assert.equal(parseRows(undefined).rows.length, 0);
});
test("lastRows keeps newest 10 per kind", () => {
  const rows = Array.from({ length: 15 }, (_, i) => rep({ pass: i }));
  assert.equal(lastRows(rows, "replay").length, 10);
  assert.equal(lastRows(rows, "replay")[9].pass, 14);
  assert.equal(lastRows(rows, "parser").length, 0);
});

test("check fails on any current failure, naming ids", () => {
  const bad = rep({ fail: 2, pass: 88, failing: ["a", "b"] });
  assert.equal(check([bad]).code, 1);
  const r = check([bad, bad]);
  assert.equal(r.code, 1); assert.match(r.reason, /a b/);
  assert.equal(check([rep({ xfail: 20, pass: 80 })]).code, 0);
});
test("rows missing numbers are skipped and counted, not WORSE", () => {
  const { rows, skipped } = parseRows([JSON.stringify(rep()), '{"kind":"replay","date":"x"}', JSON.stringify(rep())].join("\n"));
  assert.equal(rows.length, 2); assert.equal(skipped, 1);
  assert.match(check(rows, skipped).reason, /1 unreadable/);
  assert.equal(check(rows, skipped).code, 0);
});
test("show marks dirty commits", () => {
  assert.match(formatTable([makeRow("live", { pass: 1, total: 2 }, { commit: "abc", dirty: true })], "live"), /abc\*/);
});
