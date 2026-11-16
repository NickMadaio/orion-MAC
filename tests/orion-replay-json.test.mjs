// orion-replay --json: one parseable line of counts and ids only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const root = new URL("..", import.meta.url).pathname;
const built = existsSync(`${root}plugin/orion-control/dist/replay/suite.js`);
test("orion-replay --json prints one JSON line with counts", { skip: !built && "plugin not built" }, () => {
  const r = spawnSync("node", [`${root}scripts/orion-replay`, "--json"], { encoding: "utf8" });
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const j = JSON.parse(lines[0]);
  for (const k of ["total", "pass", "fail", "xfail", "xpass", "skip"]) assert.equal(typeof j[k], "number");
  assert.ok(Array.isArray(j.failing));
});
