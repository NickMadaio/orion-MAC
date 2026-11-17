// "Real session" is defined positively: the owner session keys the apps actually send. Everything else is not real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRealSession, OWNER_SESSION_KEYS } from "../scripts/lib/memory/real-session.mjs";

const UUID = "5d2b1c3e-1111-2222-3333-444455556666";

test("the keys the Mac app, phone link and Mac chat tabs send are real, with or without the agent prefix", () => {
  assert.ok(OWNER_SESSION_KEYS.includes("orion-app-v2"));
  for (const k of ["orion-app-v2", "agent:main:orion-app-v2", "agent:main:orion-chat-phone-history",
    `orion-chat-${UUID}`, `agent:main:orion-chat-${UUID.toUpperCase()}`]) assert.equal(isRealSession(k), true, k);
});

test("anything else is not real, including look-alikes the old exclusion list let through", () => {
  for (const k of ["agent:main:orion-chat-longc", "agent:main:orion-chat-voice", "agent:main:orion-chat-x", "orion-chat-",
    "agent:main:orion-chat-gate-1102-5", "agent:main:cron:nightly", "agent:main:subagent:1", "agent:main:main",
    "agent:main:orion-app-v2-test", "orion-app-v3", `orion-chat-${UUID}-sweep`, `orion-chat-${UUID.slice(0, 30)}`,
    "agent:main:echo hi && rm -rf /", "$(whoami)", "orion-app-v2; ls", "agent:main:orion-app-v2\nfoo", "",
    undefined, null, 42, "gateway-fallback-" + UUID]) assert.equal(isRealSession(k), false, String(k));
});
