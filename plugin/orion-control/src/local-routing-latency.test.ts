import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerLocalRouting } from "./local-routing.js";
import type { Decision } from "./front-desk.js";

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
function fakeApi() {
  const handlers = new Map<string, Handler[]>();
  return {
    api: { on: (name: string, fn: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), fn]) },
    fire: async (name: string, event: Record<string, unknown>, ctx: Record<string, unknown> = {}) => {
      const out = [];
      for (const fn of handlers.get(name) ?? []) out.push(await fn(event, ctx));
      return out;
    },
  };
}
const rows = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));

async function oneTurn(decideImpl: () => Promise<Decision>, message = "what is the capital of france") {
  const logPath = join(mkdtempSync(join(tmpdir(), "lr-lat-")), "shadow.jsonl");
  const f = fakeApi();
  registerLocalRouting(f.api, { warm: false, mode: "on", logPath, decideImpl, clock: () => "Sat 18:00" });
  const ctx = { runId: "r1", sessionKey: "agent:main:orion-chat-lat" };
  await f.fire("before_model_resolve", { prompt: message }, ctx);
  await f.fire("before_prompt_build", { prompt: message, messages: [] }, ctx);
  await f.fire("before_agent_finalize", { sessionId: "s", lastAssistantMessage: "Paris.", model: "qwen3.5:9b" }, ctx);
  return rows(logPath).at(-1);
}

describe("routing row timing marks (lat)", () => {
  it("records hook, desk, build and finalize timings as numbers, with no message text", async () => {
    const row = await oneTurn(async () => ({ move: "answer", answer: "Paris.", ms: 5 }));
    expect(row.lat).toBeDefined();
    for (const key of ["resolveMs", "chainMs", "deskMs", "buildMs", "finalizeMs", "passes"]) expect(typeof row.lat[key]).toBe("number");
    expect(row.lat.desk).toBe("answered");
    expect(JSON.stringify(row.lat)).not.toContain("france");
    expect(row.sessionKey).toBe("agent:main:orion-chat-lat");
    expect(Object.keys(row.lat).some((k) => k.endsWith("At"))).toBe(false);
  });

  it("marks a front desk that timed out", async () => {
    const row = await oneTurn(async () => ({ move: "escalate", fallback: "timeout", ms: 8000 }));
    expect(row.lat.desk).toBe("timeout");
  });

  it("marks a front desk that threw as an error and the turn still completes", async () => {
    const row = await oneTurn(async () => { throw new Error("boom"); });
    expect(row.lat.desk).toBe("error");
    expect(row.flow ?? null).not.toBeUndefined();
  });

  it("marks a code-first turn as skipped (desk never asked)", async () => {
    let called = 0;
    const row = await oneTurn(async () => { called += 1; return { move: "answer", answer: "x" }; }, "set a timer for 5 minutes");
    if (called === 0) expect(row.lat.desk).toBe("skipped");
    else expect(["answered", "skipped"]).toContain(row.lat.desk);
  });

  it("durations come from a monotonic clock: a wall-clock step never makes a negative or fractional segment", async () => {
    let wall = 1_800_000_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => (wall -= 5_000)); // wall clock steps backward 5 s per read
    try {
      const row = await oneTurn(async () => ({ move: "answer", answer: "Paris.", ms: 5 }));
      for (const [key, value] of Object.entries(row.lat)) if (typeof value === "number") {
        expect(value, key).toBeGreaterThanOrEqual(0);
        expect(value, key).toBeLessThan(5_000);
        expect(Number.isInteger(value), key).toBe(true);
      }
    } finally { spy.mockRestore(); }
  });
});
