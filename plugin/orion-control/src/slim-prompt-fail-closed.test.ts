// A host hook timeout drops ORION's slim prompt and the 9B gets the 17-19k-token workspace prompt (3 min on one call, 2026-10-20).
// before_agent_run runs AFTER the prompt build and is fail-closed: if the build is still running then, the turn is refused with a short line.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerLocalRouting, PROMPT_NOT_READY_LINE } from "./local-routing.js";
import { SLOW_FLOW_LINE } from "./turn-budget.js";
import type { Decision } from "./front-desk.js";

type H = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
function rig(scheduleFlow: () => Promise<unknown>) {
  const handlers = new Map<string, H[]>();
  const api = { on: (n: string, fn: H) => handlers.set(n, [...(handlers.get(n) ?? []), fn]) };
  registerLocalRouting(api as never, { warm: false, mode: "on", logPath: join(mkdtempSync(join(tmpdir(), "sp-")), "r.jsonl"), clock: () => "Tue 12:30",
    now: () => new Date(2026, 10, 5, 12, 30), decideImpl: async () => ({ move: "escalate", tier: "standard", ms: 1 }) as Decision, brainSearch: async () => "", scheduleFlow } as never);
  const fire = async (name: string, e: Record<string, unknown>, ctx: Record<string, unknown>) => { const out = []; for (const fn of handlers.get(name) ?? []) out.push(await fn(e, ctx)); return out; };
  return fire;
}

describe("the slim prompt falls through to the workspace prompt only when the hook did not finish", () => {
  it("a normal turn: the build finished, the gate passes", async () => {
    const fire = rig(async () => ({ outcome: "fallback", reason: "t" }));
    const ctx = { runId: "n1", sessionKey: "agent:main:orion-chat-sp" };
    await fire("before_model_resolve", { prompt: "how are you" }, ctx);
    const [built] = (await fire("before_prompt_build", { prompt: "how are you", messages: [] }, ctx)) as Array<{ systemPrompt?: string }>;
    expect(built?.systemPrompt).toBeTruthy();
    const gates = (await fire("before_agent_run", { prompt: "how are you" }, ctx)) as Array<{ outcome: string } | undefined>;
    expect(gates.every((g) => g === undefined || g.outcome === "pass")).toBe(true);
  });
  it("a normal turn whose build returns nothing (code owns it) is not refused either", async () => {
    const fire = rig(async () => ({ outcome: "fallback", reason: "t" }));
    const ctx = { runId: "n2", sessionKey: "agent:main:orion-chat-sp" };   // no before_model_resolve: no settled run, the hook returns undefined
    await fire("before_prompt_build", { prompt: "hi", messages: [] }, ctx);
    const gates = (await fire("before_agent_run", { prompt: "hi" }, ctx)) as Array<{ outcome: string } | undefined>;
    expect(gates.every((g) => g === undefined || g.outcome === "pass")).toBe(true);
  });
  it("the build still running when the model is about to be called: refused with a short plain line, no workspace prompt", async () => {
    const fire = rig(() => new Promise(() => undefined));   // the scheduling flow never answers: the host's hook cut-off would drop the slim prompt
    const ctx = { runId: "h1", sessionKey: "agent:main:orion-chat-sp" };
    const msg = "move my gym to 7pm tomorrow";
    await fire("before_model_resolve", { prompt: msg }, ctx);
    void fire("before_prompt_build", { prompt: msg, messages: [] }, ctx);
    await new Promise((r) => setTimeout(r, 20));
    const gates = (await fire("before_agent_run", { prompt: msg }, ctx)) as Array<{ outcome: string; message?: string } | undefined>;
    const block = gates.find((g) => g?.outcome === "block");
    expect(block?.message).toBe(PROMPT_NOT_READY_LINE);
    expect(PROMPT_NOT_READY_LINE).toMatch(/couldn't prepare/);
    expect(PROMPT_NOT_READY_LINE).toMatch(/try again/i);
  });
});

describe("a turn the plugin itself cut at 50 s is already handled, so the gate passes it (review 2026-11-16)", () => {
  afterEach(() => vi.useRealTimers());
  it("the slow-flow line is the reply and before_agent_run does not refuse", async () => {
    vi.useFakeTimers();
    const fire = rig(() => new Promise(() => undefined));
    const ctx = { runId: "c1", sessionKey: "agent:main:orion-chat-sp" };
    const msg = "move my gym to 7pm tomorrow";
    await fire("before_model_resolve", { prompt: msg }, ctx);
    const building = fire("before_prompt_build", { prompt: msg, messages: [] }, ctx);
    await vi.advanceTimersByTimeAsync(50_000);
    const [built] = (await building) as Array<{ systemPrompt?: string; appendContext?: string }>;
    expect(`${built?.systemPrompt}${built?.appendContext}`).toContain(SLOW_FLOW_LINE);
    const gates = (await fire("before_agent_run", { prompt: msg }, ctx)) as Array<{ outcome: string } | undefined>;
    expect(gates.every((g) => g === undefined || g.outcome === "pass")).toBe(true);
  });
});
