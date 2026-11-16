import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostDecision, hostSettings, shadowedSettings, PIN_STARTED, keychainOf, migrateAllowances, allowancesAfterCreate } from "../scripts/lib/connect/host-pin.mjs";

const CLI = new URL("../scripts/orion-connect", import.meta.url).pathname;
const ADMIN = new URL("../scripts/orion-connect-admin", import.meta.url).pathname;
const spec = (over = {}) => ({ name: "jokes", title: "Jokes", baseUrl: "https://api.example.test", auth: { type: "none" },
  operations: { random: { description: "x", path: "/r?q={{q}}", keep: ["a"] } }, createdAt: "2026-11-17T00:00:00Z", ...over });

test("a built-in host is fine; a new model-built host is not", () => {
  assert.equal(hostDecision({ spec: { name: "tfl", builtin: true }, host: "api.tfl.gov.uk" }).ok, true);
  const d = hostDecision({ spec: spec(), host: "api.example.test" });
  assert.equal(d.ok, false);
  assert.match(d.reason, /allow-host jokes api\.example\.test/);
});
test("an allowance is the pair (host, keychain item): any other host or item does not pass", () => {
  const allowed = { jokes: [{ host: "API.example.test", keychain: "none" }] };
  assert.equal(hostDecision({ spec: spec(), host: "api.example.test", allowed }).ok, true);
  assert.equal(hostDecision({ spec: spec(), host: "evil.example.test", allowed }).ok, false);
  const keyed = spec({ auth: { type: "bearer", keychain: "ORION Jokes" } });
  const pair = { jokes: [{ host: "api.example.test", keychain: "ORION Jokes" }] };
  assert.equal(hostDecision({ spec: keyed, host: "api.example.test", allowed: pair }).ok, true);
  const rebound = spec({ auth: { type: "bearer", keychain: "ORION Canvas" } });
  const d = hostDecision({ spec: rebound, host: "api.example.test", allowed: pair });
  assert.equal(d.ok, false, "another connector's keychain item must not ride on this host's allowance");
  assert.match(d.reason, /ORION Canvas/);
  assert.equal(hostDecision({ spec: keyed, host: "api.example.test", allowed: { jokes: ["api.example.test"] } }).ok, false, "an unmigrated bare host is not a pair");
});
test("keychainOf names the item or none", () => {
  assert.equal(keychainOf(spec()), "none");
  assert.equal(keychainOf(spec({ auth: undefined })), "none");
  assert.equal(keychainOf(spec({ auth: { type: "query", keychain: "ORION K", param: "k" } })), "ORION K");
});
test("legacy bare-host allowances migrate to pairs bound to the spec as it is now, once", () => {
  const specs = new Map([["jokes", spec({ auth: { type: "bearer", keychain: "ORION Jokes" } })]]);
  const { next, changed } = migrateAllowances({ jokes: ["api.example.test"], gone: ["x.example.test"] }, specs);
  assert.equal(changed, true);
  assert.deepEqual(next.jokes.map(({ host, keychain }) => [host, keychain]), [["api.example.test", "ORION Jokes"]]);
  assert.deepEqual(next.gone, [], "a bare host with no spec left is dropped, not guessed");
  assert.equal(migrateAllowances(next, specs).changed, false);
});
test("re-creating a spec with another host or keychain item drops its allowance", () => {
  const entries = [{ host: "api.example.test", keychain: "ORION Jokes" }];
  assert.deepEqual(allowancesAfterCreate(entries, spec({ auth: { type: "bearer", keychain: "ORION Jokes" } })), entries);
  assert.deepEqual(allowancesAfterCreate(entries, spec({ auth: { type: "bearer", keychain: "ORION Canvas" } })), []);
  assert.deepEqual(allowancesAfterCreate(entries, spec({ baseUrl: "https://other.example.test", auth: { type: "bearer", keychain: "ORION Jokes" } })), []);
  assert.deepEqual(allowancesAfterCreate(entries, spec({ baseUrl: "https://{{domain}}/api", auth: { type: "bearer", keychain: "ORION Jokes" } })), entries);
});
test("a credentialed spec is never grandfathered; an old unauthenticated one is", () => {
  const old = { createdAt: "2026-09-30T00:00:00Z" };
  assert.equal(hostDecision({ spec: spec(old), host: "api.example.test" }).ok, true);
  assert.equal(hostDecision({ spec: spec({ ...old, auth: { type: "bearer", keychain: "ORION X" } }), host: "api.example.test" }).ok, false);
  assert.equal(hostDecision({ spec: spec({ createdAt: undefined }), host: "api.example.test" }).ok, false);
  assert.ok(Date.parse(PIN_STARTED) > 0);
});
test("host-bearing settings and shadowing params are found", () => {
  const s = { baseUrl: "https://{{domain}}/api", settings: { domain: {}, term: {} } };
  assert.deepEqual(hostSettings(s), ["domain"]);
  assert.deepEqual(shadowedSettings(s, { domain: "evil.test", id: "1" }), ["domain"]);
  assert.deepEqual(shadowedSettings(s, { id: "1" }), []);
});

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "connect-pin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sec = join(dir, "fake-security"); writeFileSync(sec, "#!/bin/sh\nexit 0\n"); chmodSync(sec, 0o755);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ canvas: { domain: "school.example.test" } }));
  const env = { ...process.env, ORION_CONNECTORS_DIR: dir, ORION_SECURITY_BIN: sec };
  return { dir, run: (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: "utf8", env, stdin: "ignore" }) };
}

test("run refuses a request parameter that overrides the Canvas host setting", (t) => {
  const { run } = sandbox(t);
  const r = run("run", "canvas", "courses", "domain=evil.example.test");
  assert.match(r.stdout, /domain is a setting/);
});
test("a freshly created connector cannot run until Nick allows its host", (t) => {
  const { run } = sandbox(t);
  assert.match(run("create", "jokes", "--json", JSON.stringify(spec())).stdout, /Created jokes/);
  assert.match(run("run", "jokes", "random", "q=secret").stdout, /has not been cleared to contact api\.example\.test/);
});
test("an agent exec cannot set the host setting or allow a host", (t) => {
  const { run, dir } = sandbox(t);
  const set = run("set", "canvas", "domain=evil.example.test");
  assert.equal(set.status, 3);
  assert.match(set.stdout, /only Nick sets it/);
  assert.match(readFileSync(join(dir, "settings.json"), "utf8"), /school\.example\.test/);
  const admin = spawnSync(process.execPath, [ADMIN, "allow-host", "jokes", "api.example.test"], { encoding: "utf8", env: { ...process.env, ORION_CONNECTORS_DIR: dir }, stdin: "ignore" });
  assert.equal(admin.status, 3);
  assert.equal(existsSync(join(dir, "hosts-allowed.json")), false);
});

test("REBINDING: re-creating an allowed connector with another connector's keychain item cannot run, and the allowance is gone", (t) => {
  const { run, dir } = sandbox(t);
  const keyed = spec({ auth: { type: "bearer", keychain: "ORION Jokes" } });
  assert.match(run("create", "jokes", "--json", JSON.stringify(keyed)).stdout, /Created jokes/);
  // What the owner's `orion-connect-admin allow-host jokes api.example.test` writes.
  writeFileSync(join(dir, "hosts-allowed.json"), JSON.stringify({ jokes: [{ host: "api.example.test", keychain: "ORION Jokes" }] }));
  const out = run("create", "jokes", "--json", JSON.stringify(spec({ auth: { type: "bearer", keychain: "ORION Canvas" } }))).stdout;
  assert.match(out, /Created jokes/);
  assert.match(out, /allow-host jokes api\.example\.test/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "hosts-allowed.json"), "utf8")).jokes, []);
  assert.match(run("run", "jokes", "random", "q=x").stdout, /has not been cleared/);
});
test("a legacy bare-host allowance file is migrated on first read and keeps an existing connector running", (t) => {
  const { run, dir } = sandbox(t);
  writeFileSync(join(dir, "jokes.json"), JSON.stringify({ ...spec({ auth: { type: "bearer", keychain: "ORION Jokes" } }), createdAt: "2026-11-16T10:00:00Z" }));
  writeFileSync(join(dir, "hosts-allowed.json"), JSON.stringify({ jokes: ["api.example.test"] }));
  run("show", "jokes");
  run("run", "jokes", "nope");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "hosts-allowed.json"), "utf8")).jokes.map((e) => [e.host, e.keychain]), [["api.example.test", "ORION Jokes"]]);
});
test("the agent marker refuses `set` of the host setting even with a real pty present", { skip: process.platform === "darwin" ? false : "BSD script(1) syntax" }, (t) => {
  const { dir } = sandbox(t);
  // script(1) gives the child a TTY; the marker layer must refuse before any TTY is considered.
  const env = { ...process.env, ORION_CONNECTORS_DIR: dir, OPENCLAW_SHELL: "exec" };
  const r = spawnSync("/usr/bin/script", ["-q", "/dev/null", process.execPath, CLI, "set", "canvas", "domain=evil.example.test"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /agent marker OPENCLAW_SHELL/);
  assert.match(readFileSync(join(dir, "settings.json"), "utf8"), /school\.example\.test/);
});
