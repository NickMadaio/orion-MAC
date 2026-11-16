// The mail watcher diagnoses and reports its own failures (2026-11-16, A7). On 11-16 mail-state.json read failures: 301, problem: "error",
// while the live sign-in was expired, and nothing recorded WHAT failed. Three behaviours: an expired/revoked sign-in is classed expired;
// a small capped history of recent failures stays in state (never a token); a signed-out account is not hammered hourly.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailTick, pollWaitMs, EXPIRED_WAIT_MS } from "../scripts/lib/mail/tick.mjs";
import { failureKind, redactError, HISTORY_MAX } from "../scripts/lib/mail/failures.mjs";
import { gog, withToolPath } from "../scripts/lib/gmail-client.mjs";
import { GMAIL_EXPIRED } from "../scripts/lib/gmail-status.mjs";

const NOW = new Date(2026, 10, 16, 14, 0);
const later = (min) => new Date(NOW.getTime() + min * 60_000);
const stateOf = (dir) => JSON.parse(readFileSync(join(dir, "mail-state.json"), "utf8"));
const GMAIL = { id: "gmail", kind: "gmail", label: "Gmail" };

function world(fetchInbox) {
  const dir = mkdtempSync(join(tmpdir(), "orion-mailfail-"));
  writeFileSync(join(dir, "mail-seen.jsonl"), "");
  const said = [];
  const deps = { dir, keyringDir: mkdtempSync(join(tmpdir(), "orion-nokeys-")), now: NOW, ctx: {}, askModel: null, accounts: [{ ...GMAIL, fetchInbox }],
    reach: async (text, opts) => { said.push({ text, ...opts }); return { ok: true, id: `r${said.length}` }; } };
  return { dir, said, deps };
}
const boom = (text) => async () => { throw new Error(text); };

// ---- 1. an expired or revoked sign-in is classed expired

test("gog's other ways of saying 'sign in again' are expired, not generic error", () => {
  for (const text of ["no token for owner@example.com", "account is not authenticated", "401 Unauthorized", "unauthorized_client", "invalid_token: refresh token revoked", "Request had invalid authentication credentials. Unauthenticated"])
    assert.equal(failureKind(GMAIL, text), "expired", text);
});

test("a missing gog binary is 'setup', a timeout stays error, a network failure stays unreachable", () => {
  assert.equal(failureKind(GMAIL, "Could not run gog: spawn gog ENOENT"), "setup");
  assert.equal(failureKind(GMAIL, "gog didn't answer within 20 s, so it was stopped"), "error");
  assert.equal(failureKind(GMAIL, "dial tcp: no such host"), "unreachable");
  assert.equal(failureKind(GMAIL, "gog exited 2"), "error");
});

test("mailTick records such a failure as expired and tells him", async () => {
  const { dir, said, deps } = world(boom("gog: no token for owner@example.com"));
  const r = await mailTick(deps);
  assert.equal(stateOf(dir).problem, "expired");
  assert.equal(said.length, 1);
  assert.match(r.said, /needs reconnecting/);
});

test("gog() turns a 'not authenticated' stderr into the plain expired sentence", async () => {
  const root = mkdtempSync(join(tmpdir(), "orion-gogfail-")); const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(root, ".env"), "GOG_KEYRING_PASSWORD=test-only\n");
  writeFileSync(join(bin, "gog"), `#!/bin/sh\necho "no token for owner@example.com (not authenticated)" >&2\nexit 1\n`); chmodSync(join(bin, "gog"), 0o755);
  await assert.rejects(gog(root, ["gmail", "search", "x"], { env: { PATH: `${bin}:/usr/bin:/bin` } }), (e) => e.message === GMAIL_EXPIRED);
});

test("gog is found even when the app's PATH is the bare system one (the launchd/GUI trap)", () => {
  const p = withToolPath("/usr/bin:/bin").split(":");
  assert.ok(p.includes("/opt/homebrew/bin"));
  assert.deepEqual(p.slice(0, 2), ["/usr/bin", "/bin"], "his own PATH entries still win");
  assert.equal(withToolPath(undefined).split(":").includes("/opt/homebrew/bin"), true);
});

// ---- 2. a small capped history of recent failures

test("each failure is kept with time, class and short text; the list is capped; no token survives", async () => {
  const token = "ya29." + "a0AfH6SMB".repeat(6);
  const { dir, deps } = world(boom(`gog exited 2: Bearer ${token} refresh_token=1//0gAbCdEf${"x".repeat(30)} failed\nsecond line`));
  for (let i = 0; i < HISTORY_MAX + 5; i += 1) await mailTick({ ...deps, now: later(i * 90), force: true });
  const s = stateOf(dir);
  assert.equal(s.failures, HISTORY_MAX + 5, "the counter still counts");
  assert.equal(s.history.length, HISTORY_MAX);
  const last = s.history.at(-1);
  assert.deepEqual(Object.keys(last).sort(), ["at", "kind", "text"]);
  assert.equal(last.kind, "error");
  assert.equal(last.at, later((HISTORY_MAX + 4) * 90).toISOString());
  assert.ok(last.text.length <= 160);
  assert.match(last.text, /gog exited 2/);
  const raw = readFileSync(join(dir, "mail-state.json"), "utf8");
  assert.doesNotMatch(raw, /ya29|a0AfH6SMB|1\/\/0gAbCdEf/);
});

test("redactError flattens to one short line and strips token shapes", () => {
  assert.doesNotMatch(redactError(`access_token="abcdef0123456789abcdef0123456789"`), /abcdef0123456789abcdef0123456789/);
  assert.equal(redactError("a\nb"), "a b");
  assert.ok(redactError("x".repeat(500)).length <= 160);
});

test("history is per account and survives a good poll", async () => {
  let fail = true;
  const { dir, deps } = world(async () => { if (fail) throw new Error("gog exited 2"); return []; });
  await mailTick(deps);
  fail = false;
  await mailTick({ ...deps, now: later(11) });
  const s = stateOf(dir);
  assert.equal(s.failures, 0);
  assert.equal(s.history.length, 1, "the record of what went wrong stays after it recovers");
});

// ---- 3. signed out: stop hammering, tell him once

test("signed out waits hours, not the hourly cap; other problems keep the old backoff", () => {
  assert.equal(pollWaitMs(300, "expired"), EXPIRED_WAIT_MS);
  assert.ok(EXPIRED_WAIT_MS >= 6 * 60 * 60_000);
  assert.equal(pollWaitMs(300, "error"), 60 * 60_000);
  assert.equal(pollWaitMs(300), 60 * 60_000);
});

test("while signed out gog is not asked again for hours, and he is told once", async () => {
  let calls = 0;
  const { dir, said, deps } = world(async () => { calls += 1; throw new Error("oauth2: invalid_grant: Token has been expired or revoked."); });
  await mailTick(deps);
  for (const m of [11, 40, 90, 200, 300]) assert.equal((await mailTick({ ...deps, now: later(m) })).polled, false, `${m} min`);
  assert.equal(calls, 1);
  assert.equal(said.length, 1);
  assert.match(said[0].text, /gog auth add/);
  assert.equal(stateOf(dir).failures, 1);
  assert.equal((await mailTick({ ...deps, now: later(EXPIRED_WAIT_MS / 60_000 + 1) })).polled, true, "still checked, just rarely");
});

// ---- review fixes (2026-11-16)

test("redaction keeps 'exit code: N' but still hides auth codes", () => {
  assert.match(redactError("gog failed: exit code: 1"), /exit code: 1/);
  assert.doesNotMatch(redactError("callback code=4/0AbCdEf"), /4\/0AbCdEf/);
  assert.doesNotMatch(redactError("bad code: 123456"), /123456/);
});

test("signed out: a new gog token since the last poll makes the next tick poll at once", async () => {
  const { utimesSync, writeFileSync: write } = await import("node:fs");
  let calls = 0;
  const { deps } = world(async () => { calls += 1; throw new Error("oauth2: invalid_grant: Token has been expired or revoked."); });
  const keyringDir = mkdtempSync(join(tmpdir(), "orion-keyring-"));
  write(join(keyringDir, "token-old"), "x");
  const longAgo = new Date(NOW.getTime() - 86_400_000);
  utimesSync(join(keyringDir, "token-old"), longAgo, longAgo);
  await mailTick({ ...deps, keyringDir });
  assert.equal((await mailTick({ ...deps, keyringDir, now: later(30) })).polled, false, "nothing changed: still waiting");
  const signedIn = new Date(later(40).getTime());
  write(join(keyringDir, "token-new"), "y");
  utimesSync(join(keyringDir, "token-new"), signedIn, signedIn);
  assert.equal((await mailTick({ ...deps, keyringDir, now: later(45) })).polled, true, "token written after the failed poll: asked again");
  assert.equal(calls, 2);
});
