export declare const EMPTY_MARK = "I came back with nothing";
/** What a blank reply with no known failure honestly was: the model sent back nothing (2026-11-16: it came back in 1-5 s, it was not a timeout). */
export declare const MODEL_RETURNED_NOTHING = "the model returned nothing";
/** The honest line. `reason` is one short clause (a failed tool, "that took too long"); with none, the model simply returned nothing. */
export declare function emptyReplyLine(reason?: string): string;
/**
 * Blank = no letter, digit or emoji. An emoji ("👍", "❤️") is a real reply and is never retried or replaced (review 2026-11-16).
 * Punctuation-only ("?", "…") stays blank, as it was before today's change (HEAD already swapped it for the empty line); it now gets
 * the one retry first, which costs one model call and can only help, and a deliberate ignore is exempt through run.quiet (local-routing.ts).
 */
export declare const isBlank: (reply: string | undefined) => boolean;
export declare const isEmptyLine: (reply: string) => boolean;
/** A why-question about the reply that was blank: it is that reply he means. */
export declare function whyEmptyLine(reason?: string): string;
