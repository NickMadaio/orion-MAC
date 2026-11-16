import { afterEach, describe, expect, it, vi } from "vitest";
import { createWarmAfterTurn } from "./warm-after-turn.js";

describe("warm after a turn (2026-11-16): put back a model the gateway's embedding call evicted", () => {
  afterEach(() => vi.useRealTimers());

  it("runs the warm once, a while after the last turn ended, not at the turn's end", () => {
    vi.useFakeTimers();
    const warm = vi.fn();
    const after = createWarmAfterTurn(warm, { delayMs: 20_000, minGapMs: 60_000 });
    after.turnEnded();
    vi.advanceTimersByTime(19_999);
    expect(warm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("a second turn inside the delay restarts the wait (one warm per burst of turns)", () => {
    vi.useFakeTimers();
    const warm = vi.fn();
    const after = createWarmAfterTurn(warm, { delayMs: 20_000, minGapMs: 60_000 });
    after.turnEnded();
    vi.advanceTimersByTime(15_000);
    after.turnEnded();
    vi.advanceTimersByTime(15_000);
    expect(warm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_001);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("never warms twice inside the minimum gap, and warms again after it", () => {
    vi.useFakeTimers();
    const warm = vi.fn();
    const after = createWarmAfterTurn(warm, { delayMs: 1_000, minGapMs: 60_000 });
    after.turnEnded(); vi.advanceTimersByTime(1_001);
    after.turnEnded(); vi.advanceTimersByTime(1_001);
    expect(warm).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    after.turnEnded(); vi.advanceTimersByTime(1_001);
    expect(warm).toHaveBeenCalledTimes(2);
  });

  it("a throwing or rejecting warm never escapes, and the timer does not keep the process alive", async () => {
    vi.useFakeTimers();
    const after = createWarmAfterTurn(() => { throw new Error("x"); }, { delayMs: 10, minGapMs: 0 });
    after.turnEnded();
    expect(() => vi.advanceTimersByTime(11)).not.toThrow();
    const rejecting = createWarmAfterTurn(() => Promise.reject(new Error("y")), { delayMs: 10, minGapMs: 0 });
    rejecting.turnEnded();
    vi.advanceTimersByTime(11);
    await Promise.resolve();
  });
});

describe("warm after a turn: never in front of a live turn (2026-11-16 wiring)", () => {
  afterEach(() => vi.useRealTimers());

  it("a warm is not started while a turn is running; the turn's own end re-arms it", () => {
    vi.useFakeTimers();
    const warm = vi.fn();
    let busy = false;
    const after = createWarmAfterTurn(warm, { delayMs: 1_000, minGapMs: 0, isBusy: () => busy });
    after.turnEnded();
    busy = true;                        // his next message arrived inside the delay
    vi.advanceTimersByTime(1_001);
    expect(warm).not.toHaveBeenCalled();
    busy = false;                       // that turn ends
    after.turnEnded();
    vi.advanceTimersByTime(1_001);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("a burst of turns causes one warm", () => {
    vi.useFakeTimers();
    const warm = vi.fn();
    const after = createWarmAfterTurn(warm, { delayMs: 20_000, minGapMs: 60_000, isBusy: () => false });
    for (let i = 0; i < 6; i++) { after.turnEnded(); vi.advanceTimersByTime(5_000); }
    vi.advanceTimersByTime(20_001);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("a throwing busy check skips the warm and never escapes", () => {
    vi.useFakeTimers();
    const warm = vi.fn();
    const after = createWarmAfterTurn(warm, { delayMs: 10, minGapMs: 0, isBusy: () => { throw new Error("z"); } });
    expect(() => { after.turnEnded(); vi.advanceTimersByTime(11); }).not.toThrow();
    expect(warm).not.toHaveBeenCalled();
  });
});
