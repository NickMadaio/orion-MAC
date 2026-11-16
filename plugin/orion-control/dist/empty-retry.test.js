import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerLocalRouting } from "./local-routing.js";
/** One turn through finalize with a fixed worker reply; returns each verdict and what is finally in place. */
async function finalizeTurn(said, worker, opts = {}) {
    const handlers = new Map();
    const api = { on: (n, fn) => handlers.set(n, [...(handlers.get(n) ?? []), fn]) };
    registerLocalRouting(api, { warm: false, mode: "on", logPath: join(mkdtempSync(join(tmpdir(), "er-")), "r.jsonl"), clock: () => "Tue 12:30",
        now: () => new Date(2026, 10, 5, 12, 30), decideImpl: async () => (opts.move ? { move: opts.move, tier: "standard", ms: 1 } : { move: "escalate", fallback: "timeout", ms: 1 }), brainSearch: async () => "",
        scheduleFlow: async () => ({ outcome: "fallback", reason: "test" }) });
    const fire = async (name, e, ctx) => { const out = []; for (const fn of handlers.get(name) ?? [])
        out.push(await fn(e, ctx)); return out; };
    const ctx = { runId: "er-1", sessionKey: "agent:main:orion-chat-er" };
    await fire("before_model_resolve", { prompt: said }, ctx);
    await fire("before_agent_reply", { cleanedBody: said }, ctx);
    await fire("before_prompt_build", { prompt: said, messages: [] }, ctx);
    const messages = [{ role: "user", content: said }, { role: "assistant", content: [{ type: "text", text: worker }] }];
    const verdicts = [];
    for (let pass = 0; pass < 6; pass += 1) {
        const [v] = (await fire("before_agent_finalize", { lastAssistantMessage: worker, messages, hadDeterministicSideEffect: opts.hadSideEffect ?? false }, ctx));
        verdicts.push(v);
        if (v?.action !== "revise")
            break;
    }
    const final = messages[1].content.map((b) => b.text).join("");
    return { verdicts, final, revises: verdicts.filter((v) => v?.action === "revise").length };
}
describe("a blank worker reply", () => {
    it("is retried exactly once, then says the model returned nothing, never that it timed out", async () => {
        const r = await finalizeTurn("hows my week looking", "");
        expect(r.revises).toBe(1);
        expect(r.final).toMatch(/model (returned|gave) nothing/i);
        expect(r.final).not.toMatch(/in time|timed out|took too long/i);
    });
    it.each([["an ellipsis", "…"], ["whitespace", "   \n "]])("%s is retried exactly once, then the honest 'returned nothing' line", async (_n, blank) => {
        const r = await finalizeTurn("hows my week looking", blank);
        expect(r.revises).toBe(1);
        expect(r.final).toMatch(/the model returned nothing/);
        expect(r.final).not.toMatch(/in time|timed out/i);
    });
    it("with a tool already run (host ignores revise) the honest line goes in place at once, no retry", async () => {
        const r = await finalizeTurn("hows my week looking", "", { hadSideEffect: true });
        expect(r.revises).toBe(0);
        expect(r.final).not.toMatch(/in time/);
    });
    it("a normal non-blank reply is untouched", async () => {
        const r = await finalizeTurn("how are you", "Doing well, thanks.");
        expect(r.revises).toBe(0);
        expect(r.final).toBe("Doing well, thanks.");
    });
});
describe("an emoji reply is content, not a blank", () => {
    it.each(["👍", "❤️", "😂😂"])("%s is untouched: no retry, no 'returned nothing'", async (emoji) => {
        const r = await finalizeTurn("hows my week looking", emoji);
        expect(r.revises).toBe(0);
        expect(r.final).toBe(emoji);
    });
});
describe("a deliberate ignore is not a blank model reply (audit G1, 2026-11-16)", () => {
    const SAID = "[Nick SAID this out loud] there";
    it("a spoken turn the desk ignored ends with zero revises and the silent marker, never an error line", async () => {
        const r = await finalizeTurn(SAID, "…", { move: "ignore" });
        expect(r.revises).toBe(0);
        expect(r.final).toBe("…");
        expect(r.final).not.toMatch(/came back with nothing|returned nothing|in time/i);
    });
    it("the same turn when the model blanks on an answer turn still gets exactly one retry", async () => {
        const r = await finalizeTurn("hows my week looking", "…", { move: "answer" });
        expect(r.revises).toBe(1);
        expect(r.final).toMatch(/the model returned nothing/);
    });
});
