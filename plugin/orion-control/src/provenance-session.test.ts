/*
 Trust anchors are scoped to the session that issued the tool call (F3 review fix 6a, 2026-11-16).

 Before this, the `recent` tier accepted ANY owner turn from the last ten minutes, whatever conversation it was
 said in, so words from one session could authorise a target in another (a cron or mail-triage run naming a
 recipient Nick gave elsewhere). The Mac app, the phone and Discord all share the session key `orion-app-v2`,
 so "say it on the phone, confirm on the Mac" is ONE session and must keep working.
*/
import { describe, expect, it } from "vitest";
import { HarnessProvenance, transcriptSessionStamp } from "./provenance.js";

const MIN = 60 * 1000;
const APP = "orion-app-v2";

function clockedStore() {
  const clock = { now: 0 };
  const store = new HarnessProvenance(64, 64, () => clock.now);
  return { store, clock };
}

describe("the recent tier only takes turns from the tool call's own session", () => {
  it("a turn said in another session no longer anchors this one", () => {
    const { store, clock } = clockedStore();
    store.recordTranscriptTurn({ content: "text gia@example.com the notes", sessionId: "sess-discord", sessionKey: "discord:dm", receivedAt: 0 });
    clock.now = 5 * MIN;
    store.bindToolCall({ toolCallId: "c1", runId: "run-cron", sessionKey: "cron:mail-triage", sessionId: "sess-cron" });
    const anchor = store.resolve("c1");
    expect(anchor.binding).toBe("none");
    expect(anchor.turns).toEqual([]);
  });

  it("a transcript turn with no session stamp does not anchor a binding that names a session", () => {
    // e.g. read from the newest transcript file, which is not this session's.
    const { store, clock } = clockedStore();
    store.recordTranscriptTurn({ content: "text gia@example.com", sessionId: "sess-other", receivedAt: 0 });
    clock.now = MIN;
    store.bindToolCall({ toolCallId: "c1", sessionKey: APP, sessionId: "sess-app" });
    expect(store.resolve("c1").binding).toBe("none");
  });

  it("the same session still resolves through recent", () => {
    const { store, clock } = clockedStore();
    store.recordTranscriptTurn({ content: "text gia@example.com the notes", sessionId: "sess-app", receivedAt: 0 });
    clock.now = 2 * MIN;
    store.bindToolCall({ toolCallId: "c1", runId: "run-2", sessionKey: APP, sessionId: "sess-app" });
    const anchor = store.resolve("c1");
    expect(anchor.binding).toBe("recent");
    expect(anchor.turns.map((t) => t.content)).toEqual(["text gia@example.com the notes"]);
  });

  it("said on the phone, confirmed on the Mac: one shared session key, so it still anchors", () => {
    const { store, clock } = clockedStore();
    // Phone turn, hydrated from the app session's own transcript and stamped with its key.
    store.recordTranscriptTurn({ content: "text gia@example.com I'm running late", sessionId: "sess-app", sessionKey: APP, receivedAt: 0 });
    clock.now = 3 * MIN;
    store.recordTranscriptTurn({ content: "yes send it", sessionId: "sess-app", sessionKey: APP, receivedAt: clock.now });
    // The Mac's tool call: a different run, the same session key.
    store.bindToolCall({ toolCallId: "mac-1", runId: "run-mac", sessionKey: APP, sessionId: "sess-app" });
    const anchor = store.resolve("mac-1");
    expect(anchor.binding).toBe("recent");
    expect(anchor.turns.map((t) => t.content)).toContain("text gia@example.com I'm running late");
  });

  it("a session key match wins even after the session's transcript id rolled over", () => {
    const { store, clock } = clockedStore();
    store.recordTranscriptTurn({ content: "text gia@example.com", sessionId: "sess-app-old", sessionKey: APP, receivedAt: 0 });
    clock.now = MIN;
    store.bindToolCall({ toolCallId: "c1", sessionKey: APP, sessionId: "sess-app-new" });
    expect(store.resolve("c1").binding).toBe("recent");
  });

  it("a binding with no session keeps today's behaviour: any fresh turn, still bounded in time", () => {
    const { store, clock } = clockedStore();
    store.recordTranscriptTurn({ content: "text gia@example.com", sessionId: "sess-a", sessionKey: "discord:dm", receivedAt: 0 });
    clock.now = 5 * MIN;
    store.bindToolCall({ toolCallId: "c1", runId: "run-x" });
    expect(store.resolve("c1").binding).toBe("recent");
    // Unbound call (no tool call id): unchanged too.
    expect(store.resolve(undefined).binding).toBe("recent");
    clock.now = 11 * MIN;
    expect(store.resolve(undefined).binding).toBe("none");
  });

  it("a channel turn from another session cannot reach this call through recent", () => {
    const { store, clock } = clockedStore();
    store.recordChannelMessage({ content: "text gia@example.com", runId: "run-a", sessionKey: "discord:dm" });
    clock.now = MIN;
    store.bindToolCall({ toolCallId: "c1", runId: "run-b", sessionKey: "cron:mail-triage" });
    expect(store.resolve("c1").binding).toBe("none");
  });
});

describe("hydration knows which session it is topping up", () => {
  it("peekBinding returns the binding without consuming it", () => {
    const { store } = clockedStore();
    store.bindToolCall({ toolCallId: "c1", runId: "r", sessionKey: APP, sessionId: "sess-app" });
    expect(store.peekBinding("c1")).toMatchObject({ sessionKey: APP, sessionId: "sess-app" });
    expect(store.peekBinding("c1")).toBeDefined();
    expect(store.peekBinding(undefined)).toBeUndefined();
  });

  it("hasUsableTurn ignores a fresh hook turn from another session", () => {
    const { store } = clockedStore();
    store.recordChannelMessage({ content: "hi", sessionKey: "discord:dm" });
    expect(store.hasUsableTurn()).toBe(true);
    expect(store.hasUsableTurn(undefined, { sessionKey: "cron:x", sessionId: "s" })).toBe(false);
    expect(store.hasUsableTurn(undefined, { sessionKey: "discord:dm" })).toBe(true);
  });

  it("stamps the session key only when the transcript read was the bound session's own file", () => {
    const binding = { sessionKey: APP, sessionId: "sess-app" };
    expect(transcriptSessionStamp({ sessionId: "sess-app" }, binding)).toEqual({ sessionKey: APP });
    expect(transcriptSessionStamp({ sessionId: "sess-newest-other" }, binding)).toEqual({});
    expect(transcriptSessionStamp({ sessionId: "sess-app" }, { sessionKey: APP })).toEqual({});
    expect(transcriptSessionStamp({ sessionId: "sess-app" }, undefined)).toEqual({});
  });
});

describe("stamping does not widen the window", () => {
  it("a stamped transcript turn stays in the recent tier and ages out at ten minutes", () => {
    const { store, clock } = clockedStore();
    store.recordTranscriptTurn({ content: "text gia@example.com", sessionId: "sess-app", sessionKey: APP, receivedAt: 0 });
    clock.now = 12 * MIN;
    store.bindToolCall({ toolCallId: "c1", sessionKey: APP, sessionId: "sess-app" });
    expect(store.resolve("c1").binding).toBe("none");
  });
});
