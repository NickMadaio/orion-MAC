import { describe, expect, it } from "vitest";
import { decide, frontDeskRequest, keepWarm, FRONT_DESK_MAX_TOKENS } from "./front-desk.js";
import { FRONT_DESK_MODEL, FRONT_DESK_SYSTEM } from "./front-desk-prompt.js";

const reply = (content: string) => async () => new Response(JSON.stringify({ message: { content } }), { status: 200 });

describe("front desk", () => {
  it("sends the frozen prompt, stable text first and Nick's message last, as forced JSON at temperature 0", () => {
    const body = frontDeskRequest({ message: "lights off", clock: "Fri 21:40", history: [{ role: "assistant", content: "Gym is at 6 PM." }] });
    expect(body.model).toBe(FRONT_DESK_MODEL);
    expect(body.messages[0]).toEqual({ role: "system", content: FRONT_DESK_SYSTEM });
    expect(body.messages[1]?.content).toMatch(/^Now: Fri 21:40\.\n\nEarlier:\nORION: Gym is at 6 PM\.\n\nMessage:\nNick: lights off$/);
    expect(body.format.required).toEqual(["move", "tool", "args", "tier", "think", "say", "answer"]);
    expect(body.options.temperature).toBe(0);
    expect(body.think).toBe(false);
    expect(body.stream).toBe(false);
  });

  it("2026-11-16: output is capped (the one JSON decision needs about 70 tokens) and the load options are the warm-up's", () => {
    const body = frontDeskRequest({ message: "hi", clock: "Fri 21:40" });
    expect(FRONT_DESK_MAX_TOKENS).toBe(400);
    expect(body.options).toMatchObject({ num_predict: 400, num_ctx: 16384 });
    expect(body.keep_alive).toBe("24h");
  });

  it("2026-10-30: a one-line context (his state, heard by the microphone) goes after the clock, the frozen system prompt is unchanged", () => {
    const body = frontDeskRequest({ message: "no class today btw", clock: "Fri 13:20", context: "Nick now: should be MKTG2201; next ECON1115 at 3:30 PM." });
    expect(body.messages[0]).toEqual({ role: "system", content: FRONT_DESK_SYSTEM });
    expect(body.messages[1]?.content).toBe("Now: Fri 13:20.\n\nContext: Nick now: should be MKTG2201; next ECON1115 at 3:30 PM.\n\nMessage:\nNick: no class today btw");
  });

  it("returns the model's move when it is valid", async () => {
    const d = await decide({ message: "lights off", clock: "Fri 21:40" }, { fetchImpl: reply('{"move":"tool","tool":"lights","args":{"do":"off"},"tier":"quick","think":"off","say":"Turning them off.","answer":""}') });
    expect(d).toMatchObject({ move: "tool", tool: "lights", args: { do: "off" }, say: "Turning them off." });
    expect(d.fallback).toBeUndefined();
  });

  it("never blocks a turn: bad JSON, an unknown move or tool, an HTTP error and a timeout all hand the turn to the worker", async () => {
    const cases = [
      reply("not json"),
      reply('{"move":"dance"}'),
      reply('{"move":"tool","tool":"teleport","args":{}}'),
      async () => new Response("boom", { status: 500 }),
      (_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    ];
    for (const fetchImpl of cases) {
      const d = await decide({ message: "x", clock: "Fri 10:00" }, { fetchImpl: fetchImpl as typeof fetch, timeoutMs: 50 });
      expect(d.move).toBe("escalate");
      expect(d.fallback).toBeTruthy();
    }
  });

  it("an answer move must carry its answer text; otherwise the worker answers", async () => {
    const d = await decide({ message: "what time is it", clock: "Fri 10:00" }, { fetchImpl: reply('{"move":"answer","tool":"","args":{},"tier":"quick","think":"off","say":"","answer":""}') });
    expect(d.move).toBe("escalate");
    expect(d.fallback).toBe("empty answer");
  });
});

// 2026-10-14: the 9B was never warmed and anything else (a terminal `ollama run`, a different
// num_ctx) unloaded the models, so turns paid cold loads. keepWarm reloads only what is missing.
describe("keepWarm", () => {
  const fakeOllama = (loaded: Array<{ name: string; context_length: number }>) => {
    const loads: Array<{ model: string; num_ctx: number }> = [];
    const fetchImpl = (async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/api/ps")) return { ok: true, json: async () => ({ models: loaded }) };
      const body = JSON.parse(init?.body ?? "{}");
      loads.push({ model: body.model, num_ctx: body.options?.num_ctx });
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
    return { fetchImpl, loads };
  };
  const models = [{ model: "qwen3.5:4b-q4_K_M", numCtx: 16384 }, { model: "qwen3.5:9b", numCtx: 32768 }];

  it("loads the models that are not in memory, at the context the gateway uses", async () => {
    const { fetchImpl, loads } = fakeOllama([{ name: "qwen3.5:4b-q4_K_M", context_length: 16384 }]);
    expect(await keepWarm(models, { fetchImpl })).toEqual(["qwen3.5:9b"]);
    expect(loads).toEqual([{ model: "qwen3.5:9b", num_ctx: 32768 }]);
  });

  it("reloads a model loaded at another context size, and leaves warm ones alone", async () => {
    const { fetchImpl, loads } = fakeOllama([{ name: "qwen3.5:4b-q4_K_M", context_length: 16384 }, { name: "qwen3.5:9b", context_length: 8192 }]);
    expect(await keepWarm(models, { fetchImpl })).toEqual(["qwen3.5:9b"]);
    const warm = fakeOllama([{ name: "qwen3.5:4b-q4_K_M", context_length: 16384 }, { name: "qwen3.5:9b", context_length: 32768 }]);
    expect(await keepWarm(models, { fetchImpl: warm.fetchImpl })).toEqual([]);
    expect(warm.loads).toEqual([]);
  });

  it("never throws when Ollama is down", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await keepWarm(models, { fetchImpl })).toEqual([]);
  });
});

// 2026-11-16: the gateway's embedding model (memory search) is a third model; with two slots it evicts the idle 4B. The reloaded runner has an empty
// prompt cache, so the next front-desk call re-read all 2.5k tokens (2.5 s against 1.8 s). A reload by keepWarm now also reads the frozen prompt.
describe("keepWarm primes the front desk's prompt after reloading it", () => {
  const rig = (loaded: Array<{ name: string; context_length: number }>) => {
    const calls: Array<{ url: string; body: Record<string, any> }> = [];
    const fetchImpl = (async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/api/ps")) return { ok: true, json: async () => ({ models: loaded }) };
      calls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  };
  const models = [{ model: FRONT_DESK_MODEL, numCtx: 16384 }, { model: "qwen3.5:9b", numCtx: 32768 }];

  it("sends the frozen system prompt with one output token when the front desk was cold", async () => {
    const { fetchImpl, calls } = rig([{ name: "qwen3.5:9b", context_length: 32768 }]);
    await keepWarm(models, { fetchImpl, primeDesk: true });
    const prime = calls.find((c) => c.url.endsWith("/api/chat"));
    expect(prime?.body.model).toBe(FRONT_DESK_MODEL);
    expect(prime?.body.messages[0]).toEqual({ role: "system", content: FRONT_DESK_SYSTEM });
    expect(prime?.body.options).toMatchObject({ num_predict: 1, num_ctx: 16384 });
    expect(prime?.body.keep_alive).toBe("24h");
    expect(calls.filter((c) => c.url.endsWith("/api/generate")).map((c) => c.body.model)).toEqual([FRONT_DESK_MODEL]);
  });

  it("sends nothing when both models are warm, and nothing unless asked", async () => {
    const warm = rig([{ name: FRONT_DESK_MODEL, context_length: 16384 }, { name: "qwen3.5:9b", context_length: 32768 }]);
    expect(await keepWarm(models, { fetchImpl: warm.fetchImpl, primeDesk: true })).toEqual([]);
    expect(warm.calls).toEqual([]);
    const cold = rig([]);
    await keepWarm(models, { fetchImpl: cold.fetchImpl });
    expect(cold.calls.some((c) => c.url.endsWith("/api/chat"))).toBe(false);
  });

  it("a failed prime never throws and still reports what it loaded", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("/api/ps")) return { ok: true, json: async () => ({ models: [] }) };
      calls.push(String(url));
      if (String(url).endsWith("/api/chat")) throw new Error("boom");
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
    expect(await keepWarm(models, { fetchImpl, primeDesk: true })).toEqual([FRONT_DESK_MODEL, "qwen3.5:9b"]);
  });
});
