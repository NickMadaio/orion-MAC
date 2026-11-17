import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// orion-mode (relaxations) and orion-automation (install) carry the same owner
// check as orion-approve. Read-only and tightening subcommands do not.
const MODE = new URL("../scripts/orion-mode", import.meta.url).pathname;
const AUTOMATION = new URL("../scripts/orion-automation", import.meta.url).pathname;
const INSTALLED = join(homedir(), ".openclaw/extensions/orion-control");
const skip = existsSync(join(INSTALLED, "dist/strictness.js")) ? false : "needs the installed plugin";

function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), "owner-only-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".openclaw/extensions"), { recursive: true });
  mkdirSync(join(home, ".openclaw/orion-gate"), { recursive: true });
  symlinkSync(INSTALLED, join(home, ".openclaw/extensions/orion-control"));
  const reached = join(home, "REAUTH_REACHED");
  const standIn = join(home, "confirm");
  writeFileSync(standIn, `#!/bin/sh\ntouch "${reached}"\nexit 0\n`); chmodSync(standIn, 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OPENCLAW_")));
  const run = (script, args, extra = {}) => spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...env, HOME: home, ORION_REAUTH_BIN: standIn, ...extra } });
  return { home, reached, run };
}

test("orion-mode: a relaxation from an agent-shaped caller exits 3 before the owner prompt or any write", { skip }, (t) => {
  const { home, reached, run } = sandbox(t);
  for (const extra of [{ ORION_OWNER_CHECK: "enforce" }, { ORION_OWNER_CHECK: "enforce", OPENCLAW_SHELL: "exec" }]) {
    const r = run(MODE, ["open", "--yes", "--for", "1h"], extra);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /cannot be run by ORION/);
  }
  assert.equal(existsSync(reached), false, "the owner prompt was reached");
  assert.equal(existsSync(join(home, ".openclaw/orion-gate/strictness.json")), false);
});
test("orion-mode: reading and tightening are not gated (the panic direction stays one step)", { skip }, (t) => {
  const { home, run } = sandbox(t);
  assert.equal(run(MODE, ["--json"], { ORION_OWNER_CHECK: "enforce" }).status, 0);
  assert.equal(run(MODE, ["--explain", "sovereign"], { ORION_OWNER_CHECK: "enforce" }).status, 0);
  const r = run(MODE, ["contained"], { ORION_OWNER_CHECK: "enforce" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(home, ".openclaw/orion-gate/strictness.json")));
});
test("orion-automation: install is owner-only; list is not", { skip }, (t) => {
  const { run } = sandbox(t);
  const install = run(AUTOMATION, ["install", "anything"]);
  assert.equal(install.status, 3, install.stderr);
  assert.match(install.stderr, /cannot be run by ORION/);
  assert.equal(run(AUTOMATION, ["list"]).status, 0);
});
