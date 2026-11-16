/*
 The 9B's system prompt, assembled so the text that repeats between turns comes first and the text that
 changes comes last (2026-11-16 latency work). qwen3.5 is a hybrid (recurrent) model: Ollama reuses the
 prompt only up to the last saved checkpoint inside the shared prefix, so every byte that differs early
 forces a re-read of everything after it. Measured on localhost with 5 runs: a ~300-token retrieved note
 placed BEFORE the ~600-token state card cost 2.2 s of prompt reading on the next turn; the card first
 cost 1.0 s. Wording of each part is unchanged; only the place is.
*/
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

export function workerSystemPrompt({ stable, card, perTurn, now }: WorkerPromptParts): string {
  const cardPart = card.trim() ? `\n\n${card.trimEnd()}` : "";
  return `${stable}${cardPart}${perTurn.join("")}\n\n${now}`;
}
