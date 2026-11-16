/*
 Never send nothing (w20 round 3, live gate turn 43: "whats on my todo list" came back blank after 68 s, model null).
 A blank, or a reply that was only an old outreach line, becomes a short honest line with the reason, and offers the retry that
 retry-slot.ts keeps ("Say go and I'll retry it.").
*/
import { RETRY_OFFER } from "./retry-slot.js";
export const EMPTY_MARK = "I came back with nothing";
/** What a blank reply with no known failure honestly was: the model sent back nothing (2026-11-16: it came back in 1-5 s, it was not a timeout). */
export const MODEL_RETURNED_NOTHING = "the model returned nothing";
/** The honest line. `reason` is one short clause (a failed tool, "that took too long"); with none, the model simply returned nothing. */
export function emptyReplyLine(reason) {
    const why = reason?.trim() ? reason.trim().replace(/[.!\s]+$/, "") : MODEL_RETURNED_NOTHING;
    return `${EMPTY_MARK} just now: ${why}. Say go and I'll retry it.`;
}
/**
 * Blank = no letter, digit or emoji. An emoji ("👍", "❤️") is a real reply and is never retried or replaced (review 2026-11-16).
 * Punctuation-only ("?", "…") stays blank, as it was before today's change (HEAD already swapped it for the empty line); it now gets
 * the one retry first, which costs one model call and can only help, and a deliberate ignore is exempt through run.quiet (local-routing.ts).
 */
export const isBlank = (reply) => !reply || !/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(reply);
export const isEmptyLine = (reply) => reply.startsWith(EMPTY_MARK) && RETRY_OFFER.test(reply);
/** A why-question about the reply that was blank: it is that reply he means. */
export function whyEmptyLine(reason) {
    const why = reason?.trim() ? reason.trim().replace(/[.!\s]+$/, "") : MODEL_RETURNED_NOTHING;
    return `My last reply came back blank, that was my failure, not yours: ${why}. Say go and I'll retry it.`;
}
