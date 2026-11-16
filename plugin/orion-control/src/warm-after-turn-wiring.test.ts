import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerLocalRouting } from "./local-routing.js";

// 2026-11-16 latency: the gateway's embedding call after a turn evicts the idle 4B front desk. The plugin re-warms a little after
// each turn ends (warm-after-turn.ts), off the reply's path, never while another turn runs, and never throwing into a hook.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DELAY = 40;

function rig(afterTurnWarm: () => unknown) {
  const f = fakeApi();
  registerLocalRouting(f.api, { warm: false, mode: "on", logPath: join(mkdtempSync(join(tmpdir(), "lr-warm-")), "r.jsonl"), brainSearch: async () => "",
    decideImpl: async () => ({ move: "answer", answer: "Paris." }), clock: () => "Mon 20:10", afterTurnWarm, afterTurnDelayMs: DELAY, afterTurnMinGapMs: 0 });
  const start = (runId: string) => f.fire("before_model_resolve", { prompt: "what is the capital of france" }, { runId, sessionKey: `agent:main:orion-chat-${runId}` });
  const finish = async (runId: string) => {
    const ctx = { runId, sessionKey: `agent:main:orion-chat-${runId}` };
    await f.fire("before_agent_finalize", { sessionId: "s", lastAssistantMessage: "Paris.", model: "qwen3.5:9b" }, ctx);
    await f.fire("agent_end", { success: true }, ctx);
  };
  return { start, finish };
}

describe("after-turn warm, wired into the routing hooks", () => {
  it("is not called while the turn ends (never delays the reply), and is called once a little after", async () => {
    let calls = 0;
    const r = rig(() => { calls += 1; });
    await r.start("t1");
    await r.finish("t1");
    expect(calls).toBe(0);
    await sleep(DELAY * 3);
    expect(calls).toBe(1);
  });

  it("a warm is not started while a turn is running", async () => {
    let calls = 0;
    const r = rig(() => { calls += 1; });
    await r.start("t1"); await r.finish("t1");
    await r.start("t2");                       // his next message, still running when the delay ends
    await sleep(DELAY * 3);
    expect(calls).toBe(0);
    await r.finish("t2");
    await sleep(DELAY * 3);
    expect(calls).toBe(1);
  });

  it("a burst of turns causes one warm", async () => {
    let calls = 0;
    const r = rig(() => { calls += 1; });
    for (const id of ["a", "b", "c", "d"]) { await r.start(id); await r.finish(id); }
    await sleep(DELAY * 3);
    expect(calls).toBe(1);
  });

  it("a throwing or rejecting warm never reaches the hooks", async () => {
    const r = rig(() => { throw new Error("ollama down"); });
    await r.start("t1");
    await expect(r.finish("t1")).resolves.toBeUndefined();
    await sleep(DELAY * 3);
    const r2 = rig(() => Promise.reject(new Error("ollama down")));
    await r2.start("t1"); await r2.finish("t1");
    await sleep(DELAY * 3);
  });
});
