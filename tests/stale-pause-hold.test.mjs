// 2026-11-16 audit: a focus session paused since 2026-11-10 held outreach for six days ("paused for under 3 min").
// The live socket reply has no pause start, so the probe stamped the pause with "now" and the gate saw a 0 s pause every
// time. A pause that is old, from another day, or of unknown age must never hold.
import test from "node:test";
import assert from "node:assert/strict";
import { gate, resolveAwareness, sessionFromStatus } from "../scripts/lib/reach/gate.mjs";
import { isSessionActive } from "../scripts/lib/reach/focus-hold.mjs";
import { harness, NOW } from "./delivery-helpers.mjs";

const at = (secondsAgo) => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
const SIX_DAYS = 6 * 86_400;
// what `orion-session status --json` answers for a pause: no pausedAt, a dayKey of the day it began
const socketPaused = (dayKey) => ({ status: "paused", sessionId: "s-1", task: "Focus", dayKey });

test("the live probe does not restart an old pause: the file's since survives", () => {
  const h = harness();
  h.setAwareness({ session: { state: "paused", sessionId: "s-1", since: at(SIX_DAYS), at: at(10), source: "socket" } });
  const probeFn = (_env, now) => sessionFromStatus(socketPaused("2026-10-10"), now);
  const aw = resolveAwareness({ dir: h.dir, now: NOW, env: {}, probeFn });
  assert.equal(gate(aw, { kind: "info", now: NOW }).action, "deliver");
});

test("a fresh pause still holds through the probe", () => {
  const h = harness();
  h.setAwareness({ session: { state: "paused", sessionId: "s-1", since: at(60), at: at(10), source: "socket" } });
  const probeFn = (_env, now) => sessionFromStatus(socketPaused("2026-10-16"), now);
  const aw = resolveAwareness({ dir: h.dir, now: NOW, env: {}, probeFn });
  assert.equal(gate(aw, { kind: "info", now: NOW }).action, "hold");
});

test("a socket pause from a previous day is no session at all", () => {
  assert.equal(sessionFromStatus(socketPaused("2026-10-10"), NOW).state, "none");
  assert.equal(sessionFromStatus(socketPaused("2026-10-16"), NOW).state, "paused");
  assert.equal(sessionFromStatus(socketPaused("2026-10-15"), new Date(2026, 9, 16, 2, 0)).state, "paused", "before 04:00 it is still yesterday's day");
});

test("with no file to carry the start, a stale-day socket pause still delivers", () => {
  const h = harness();
  h.setAwareness({ session: { state: "unknown", at: at(0) } });
  const probeFn = (_env, now) => sessionFromStatus(socketPaused("2026-10-10"), now);
  assert.equal(gate(resolveAwareness({ dir: h.dir, now: NOW, env: {}, probeFn }), { kind: "info", now: NOW }).action, "deliver");
});

test("focus-hold: a socket pause of unknown length from a previous day is not active", () => {
  assert.equal(isSessionActive({ status: "paused", dayKey: "2026-10-10" }, NOW), false);
  assert.equal(isSessionActive({ status: "paused", dayKey: "2026-10-16" }, NOW), true);
  assert.equal(isSessionActive({ status: "paused", pausedForMs: 6 * 86_400_000 }, NOW), false);
});

test("a same-day pause of unknown start holds for at most 3 minutes of repeated probes, then releases", () => {
  const h = harness();
  h.setAwareness({ session: { state: "unknown", at: at(0) } });
  const probeFn = (_env, now) => sessionFromStatus(socketPaused("2026-10-16"), now);
  const actionAt = (minutes) => { const now = new Date(NOW.getTime() + minutes * 60_000); return gate(resolveAwareness({ dir: h.dir, now, env: {}, probeFn }), { kind: "info", now }).action; };
  assert.equal(actionAt(0), "hold");
  assert.equal(actionAt(1), "hold");
  assert.equal(actionAt(2), "hold");
  assert.equal(actionAt(4), "deliver", "first seen 4 minutes ago: released");
  assert.equal(actionAt(30), "deliver");
});

test("focus-hold: the pinned clock reaches the stale-day check on the awareness path", async () => {
  const { activeSession } = await import("../scripts/lib/reach/focus-hold.mjs");
  const h = harness();
  const env = { ORION_CONTROLLED_DIR: h.dir, ORION_REACH_NOW: NOW.toISOString() };
  const paused = (dayKey) => h.setAwareness({ session: { state: "paused", sessionId: "s-1", since: at(30), at: at(5), source: "socket", dayKey } });
  paused("2026-10-16");
  assert.notEqual(activeSession(env), null, "a same-day pause on the pinned day is active (the real clock would call it stale)");
  paused("2026-10-10");
  assert.equal(activeSession(env), null, "a pause from before the pinned day is a leftover");
});

// ---- the first-seen record must not outlive its pause

test("a resume seen by the awareness refresh clears the record: a new pause in the same session holds again", async () => {
  const { writeAwareness } = await import("../scripts/lib/awareness/state.mjs");
  const { awareness } = await import("./delivery-helpers.mjs");
  const h = harness();
  const T = (m, s = 0) => new Date(NOW.getTime() + m * 60_000 + s * 1000);
  const probePaused = (_env, now) => sessionFromStatus(socketPaused("2026-10-16"), now);
  const verdict = (now) => gate(resolveAwareness({ dir: h.dir, now, env: {}, probeFn: probePaused }), { kind: "info", now }).action;
  h.setAwareness({ session: { state: "unknown", at: at(0) } });
  assert.equal(verdict(T(0)), "hold", "10:00 first pause recorded");
  writeAwareness(h.dir, awareness(T(2), { session: { state: "focus", sessionId: "s-1", at: T(2).toISOString(), source: "phase-hook" } }));   // 10:02 resumed, the refresh sees it
  assert.equal(verdict(T(40, 20)), "hold", "10:40 is a brand-new pause");
});

test("a pause continuously paused for 6 hours with gate calls 30 minutes apart releases", () => {
  const h = harness();
  h.setAwareness({ session: { state: "unknown", at: at(0) } });
  const probe = (_env, now) => sessionFromStatus(socketPaused("2026-10-16"), now);
  const actions = [0, 30, 60, 120, 240, 360].map((m) => { const now = new Date(NOW.getTime() + m * 60_000); return gate(resolveAwareness({ dir: h.dir, now, env: {}, probeFn: probe }), { kind: "info", now }).action; });
  assert.deepEqual(actions, ["hold", "deliver", "deliver", "deliver", "deliver", "deliver"]);
});

test("a real running session still holds", () => {
  const h = harness();
  h.setAwareness({ session: { state: "unknown", at: at(0) } });
  const probe = (_env, now) => sessionFromStatus({ status: "running", phase: "focus", sessionId: "s-1" }, now);
  assert.equal(gate(resolveAwareness({ dir: h.dir, now: NOW, env: {}, probeFn: probe }), { kind: "info", now: NOW }).action, "hold");
});
