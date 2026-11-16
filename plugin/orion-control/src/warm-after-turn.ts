/*
 Re-warm the local models shortly after a turn ends (2026-11-16 latency work).

 The gateway indexes each finished turn into memory with an embedding model (nomic-embed-text). Ollama runs
 with two model slots and the 4B front desk and 9B worker fill them, so the embedding load evicts the idle
 4B (server.log: embed at 19:48:29, 4B reloaded at 19:49:32 by the next message, 3.7 s desk call against
 1.9 s). keepWarm already puts it back, but only every 5 minutes. This calls it a little after each turn
 instead, off the turn's critical path, debounced across a burst and never more often than minGapMs.
*/
export type WarmAfterTurn = { turnEnded: () => void };

export type WarmAfterTurnOptions = {
  /** Wait after the last turn ended (lands after the gateway's embedding call, about 1 s after a turn). */
  delayMs?: number;
  /** Never warm twice inside this gap. */
  minGapMs?: number;
  /** True while a turn is running. Ollama serves one request at a time, so a warm then would queue in front of his
   *  next message: it is skipped, and that turn's own end re-arms it. A throwing check counts as busy. */
  isBusy?: () => boolean;
};

const busyNow = (isBusy: () => boolean): boolean => { try { return isBusy(); } catch { return true; } };

export function createWarmAfterTurn(warm: () => unknown, { delayMs = 20_000, minGapMs = 60_000, isBusy = () => false }: WarmAfterTurnOptions = {}): WarmAfterTurn {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRun = Number.NEGATIVE_INFINITY;
  const fire = () => {
    timer = undefined;
    if (Date.now() - lastRun < minGapMs || busyNow(isBusy)) return;
    lastRun = Date.now();
    try { Promise.resolve(warm()).catch(() => undefined); } catch { /* warming never touches a turn */ }
  };
  return {
    turnEnded() {
      try {
        if (timer) clearTimeout(timer);
        timer = setTimeout(fire, delayMs);
        timer.unref?.();
      } catch { /* never throws into the hook that called it */ }
    },
  };
}
