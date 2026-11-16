#!/usr/bin/env node
// CI runner for the node script tests under tests/.
//
//   node scripts/ci-node-tests.mjs check   every tests/*.test.mjs is in exactly one of
//                                          tests/ci-node-tests.txt (runs in CI) or
//                                          tests/ci-node-tests.skip.txt (class + reason)
//   node scripts/ci-node-tests.mjs run     check, then run the allowlist with node --test
//
// Why: CI used to run a hand-picked handful of these files, so ~300 test files never ran
// anywhere but Nick's Mac. A new test file now has to be put on one list or the other.
// Skip lines: "<path> <class> <few words>", class a=Mac-only, b=~/.openclaw or /Users path,
// c=time-of-day/timezone, d=failing everywhere.
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lines = (file) =>
  readFileSync(join(root, file), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

export function checkLists() {
  const onDisk = readdirSync(join(root, "tests")).filter((f) => f.endsWith(".test.mjs")).map((f) => `tests/${f}`).sort();
  const allow = lines("tests/ci-node-tests.txt");
  const skipRows = lines("tests/ci-node-tests.skip.txt");
  const skipPaths = skipRows.map((l) => l.split(/\s+/)[0]);
  const problems = [];
  const seen = new Set();
  for (const p of [...allow, ...skipPaths]) {
    if (seen.has(p)) problems.push(`listed more than once: ${p}`);
    seen.add(p);
  }
  for (const f of onDisk) if (!seen.has(f)) problems.push(`not in the allowlist or the skip list: ${f}`);
  // A listed file that is not on disk is a stale line, not a reason to turn CI red.
  const stale = [...seen].filter((p) => !onDisk.includes(p));
  for (const row of skipRows) {
    const [, cls, ...why] = row.split(/\s+/);
    if (!/^[abcd]$/.test(cls ?? "") || why.length === 0) problems.push(`skip line needs "<path> <a|b|c|d> <reason>": ${row}`);
  }
  if (JSON.stringify(allow) !== JSON.stringify([...allow].sort())) problems.push("tests/ci-node-tests.txt is not sorted");
  return { allow: allow.filter((p) => onDisk.includes(p)), skipCount: skipRows.length, problems, stale };
}

const mode = process.argv[2];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (mode !== "check" && mode !== "run") {
    console.error("usage: ci-node-tests.mjs check|run");
    process.exit(2);
  }
  const { allow, skipCount, problems, stale } = checkLists();
  for (const p of stale) console.warn(`warning: listed but not on disk (remove the line): ${p}`);
  if (problems.length) {
    console.error(problems.map((p) => `  ${p}`).join("\n"));
    console.error("fix: add the file to tests/ci-node-tests.txt, or to tests/ci-node-tests.skip.txt with a class and reason");
    process.exit(1);
  }
  console.log(`test lists ok: ${allow.length} run in CI, ${skipCount} skipped`);
  if (mode === "check") process.exit(0);
  const r = spawnSync(process.execPath, ["--test", "--test-concurrency=2", "--test-timeout=120000", ...allow], { cwd: root, stdio: "inherit" });
  process.exit(r.status ?? 1);
}
