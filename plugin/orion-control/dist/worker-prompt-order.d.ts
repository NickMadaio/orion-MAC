export type WorkerPromptParts = {
    /** Job instructions + production notes + look-it-up: identical every turn. */
    stable: string;
    /** State card + tone note, already ending in a blank line when present (changes about every 5 minutes), or "". */
    card: string;
    /** Per-turn notes, each already starting with its blank line: live-data, ignore, push, retrieved notes, ask. */
    perTurn: string[];
    /** The clock line (and what code already did): changes every turn, so it is last. */
    now: string;
};
export declare function workerSystemPrompt({ stable, card, perTurn, now }: WorkerPromptParts): string;
