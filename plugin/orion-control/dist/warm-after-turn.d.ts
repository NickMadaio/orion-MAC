export type WarmAfterTurn = {
    turnEnded: () => void;
};
export type WarmAfterTurnOptions = {
    /** Wait after the last turn ended (lands after the gateway's embedding call, about 1 s after a turn). */
    delayMs?: number;
    /** Never warm twice inside this gap. */
    minGapMs?: number;
    /** True while a turn is running. Ollama serves one request at a time, so a warm then would queue in front of his
     *  next message: it is skipped, and that turn's own end re-arms it. A throwing check counts as busy. */
    isBusy?: () => boolean;
};
export declare function createWarmAfterTurn(warm: () => unknown, { delayMs, minGapMs, isBusy }?: WarmAfterTurnOptions): WarmAfterTurn;
