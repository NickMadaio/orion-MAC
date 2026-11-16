// orion-latency on fixture rows (no real log is read).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { format, parseRows, percentile, realTurns, summarize } from "../scripts/lib/latency-stats.mjs";

let seq = 0;
const row = (key, desk, deskMs, passes, turnMs, extra = {}) => ({ runId: `run-${seq += 1}`, at: "2026-11-16T10:00:00Z", sessionKey: key, passes, turnMs, lat: { resolveMs: deskMs + 1000, chainMs: 900, desk, deskMs, buildMs: 50, finalizeMs: 20, passes, ...extra } });
const fixture = [
  row("agent:main:orion-chat-a", "answered", 1000, 0, 5000),
  row("agent:main:orion-chat-a", "answered", 2000, 1, 6000),
  row("agent:main:orion-chat-b", "timeout", 8000, 0, 15000),
  row("agent:main:orion-chat-b", "skipped", 0, 0, 3000),
  row("agent:main:orion-chat-sweep-1", "answered", 9999, 3, 99999),
  row("agent:main:cron:daily", "answered", 9999, 3, 99999),
  row("agent:main:orion-probe-plugin", "answered", 9999, 3, 99999),
  { sessionKey: "agent:main:orion-chat-a", stage: "decision", lat: { deskMs: 1 } },
  { sessionKey: "agent:main:orion-chat-a", turnMs: 5 },
];

test("percentile uses nearest rank and ignores non-numbers", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
  assert.equal(percentile([], 0.5), undefined);
  assert.equal(percentile([NaN, 4], 0.5), 4);
});

test("internal sessions (the plugin's whole-word test), stage rows and rows without lat are left out", () => {
  // sweep and probe keys are not internal by default
  assert.equal(realTurns(fixture).turns.length, 6);
  assert.equal(realTurns(fixture, { excludeSweeps: true }).turns.length, 4);
});

test("latest/contest keys are real turns; whole-word test/eval/cron are not", () => {
  const rows = [row("agent:main:orion-chat-latest", "answered", 1, 0, 1), row("agent:main:orion-chat-contest", "answered", 1, 0, 1), row("agent:main:orion-test-x", "answered", 1, 0, 1), row("agent:main:eval-1", "answered", 1, 0, 1)];
  assert.equal(realTurns(rows).turns.length, 2);
});

test("a turn with several finalize rows is counted once, by its last row", () => {
  const a = { ...row("agent:main:orion-chat-a", "answered", 1000, 1, 5000), runId: "r1" };
  const b = { ...row("agent:main:orion-chat-a", "answered", 1000, 2, 7000, { buildToFinalMs: 300 }), runId: "r1" };
  const { turns } = realTurns([a, b]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].lat.passes, 2);
});

test("rows with a negative or absurd segment are dropped and counted", () => {
  const bad = [row("agent:main:orion-chat-a", "answered", -5, 0, 1000), row("agent:main:orion-chat-a", "answered", 100, 0, 700_000), row("agent:main:orion-chat-a", "answered", 100, 0, 1000)];
  const r = realTurns(bad);
  assert.equal(r.turns.length, 1);
  assert.equal(r.dropped, 2);
  assert.match(format(summarize(r.turns, r.dropped)), /dropped 2/);
});

test("--last keeps only the most recent turns", () => {
  assert.equal(realTurns(fixture, { last: 2 }).turns.length, 2);
});

test("summary: median, p90, timeout share of asked turns, rewrite share", () => {
  const s = summarize(realTurns(fixture, { excludeSweeps: true }).turns);
  assert.equal(s.turns, 4);
  assert.equal(s.segments.turnMs.median, 5000);
  assert.equal(s.segments.deskMs.n, 4);
  assert.equal(s.deskAsked, 3);
  assert.ok(Math.abs(s.deskTimeoutShare - 1 / 3) < 1e-9);
  assert.equal(s.deskSkippedShare, 0.25);
  assert.equal(s.rewriteShare, 0.25);
  assert.match(format(s), /buildToFinalMs \(last pass\)/);
});

test("empty input does not throw and reads zero", () => {
  const s = summarize([]);
  assert.equal(s.turns, 0);
  assert.equal(s.deskTimeoutShare, 0);
  assert.match(format(s), /real turns: 0/);
});

test("parseRows skips bad lines", () => {
  assert.equal(parseRows('{"a":1}\nnot json\n\n{"b":2}').length, 2);
});

test("the CLI prints the table for a fixture log", () => {
  const dir = mkdtempSync(join(tmpdir(), "latency-"));
  const log = join(dir, "shadow.jsonl");
  writeFileSync(log, fixture.map((r) => JSON.stringify(r)).join("\n"));
  const bin = fileURLToPath(new URL("../scripts/orion-latency", import.meta.url));
  const out = execFileSync("node", [bin, "--log", log, "--last", "50", "--exclude-sweeps"], { encoding: "utf8" });
  assert.match(out, /real turns: 4/);
  assert.match(out, /timeout share/);
  const json = JSON.parse(execFileSync("node", [bin, "--log", log, "--json", "--exclude-sweeps"], { encoding: "utf8" }));
  assert.equal(json.turns, 4);
});
