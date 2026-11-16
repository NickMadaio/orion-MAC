import { describe, expect, it } from "vitest";
import { workerSystemPrompt } from "./worker-prompt-order.js";
import { LOOK_IT_UP, PRODUCTION_NOTES } from "./local-routing.js";
import { TONE_NOTE } from "./state-card.js";
import { LATE_TONE_LINE } from "./night-hush.js";
import { GENERAL_INSTRUCTIONS, SCHEDULING_INSTRUCTIONS } from "./job-instructions.js";

const parts = {
  stable: "STABLE-INSTRUCTIONS\n\nPRODUCTION\n\nLOOK-IT-UP",
  card: "CARD-LINE-1\nCARD-LINE-2\n\nTONE\n\n",
  perTurn: ["\n\nLIVE-NOTE", "\n\nIGNORE-NOTE", "\n\nPUSH-NOTE", "\n\nBRAIN-FETCHED", "\n\nASK-NOTE"],
  now: "Now: Mon 20:10 (Europe/London). Monday 16 November",
};

describe("worker system prompt order (2026-11-16 latency): stable first, the clock last", () => {
  it("puts the state card before every per-turn note, and the clock last", () => {
    const text = workerSystemPrompt(parts);
    const at = (s: string) => text.indexOf(s);
    expect(at("STABLE-INSTRUCTIONS")).toBe(0);
    expect(at("CARD-LINE-1")).toBeGreaterThan(at("LOOK-IT-UP"));
    for (const n of ["LIVE-NOTE", "IGNORE-NOTE", "PUSH-NOTE", "BRAIN-FETCHED", "ASK-NOTE"]) expect(at(n)).toBeGreaterThan(at("TONE"));
    expect(text.endsWith(parts.now)).toBe(true);
  });

  it("keeps every part's wording: the same text, only the place changes", () => {
    const text = workerSystemPrompt(parts);
    for (const piece of [parts.stable, "CARD-LINE-1\nCARD-LINE-2\n\nTONE", ...parts.perTurn.map((p) => p.trim()), parts.now]) expect(text).toContain(piece);
  });

  it("two turns with different notes and clocks share everything up to the notes (the cacheable prefix)", () => {
    const a = workerSystemPrompt({ ...parts, perTurn: ["\n\nBRAIN-A"], now: "Now: 20:10" });
    const b = workerSystemPrompt({ ...parts, perTurn: ["\n\nBRAIN-B", "\n\nASK-B"], now: "Now: 20:11" });
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    expect(a.slice(0, i)).toContain("CARD-LINE-2\n\nTONE");
  });

  it("works with no card and no notes", () => {
    expect(workerSystemPrompt({ stable: "S", card: "", perTurn: [], now: "Now: 1" })).toBe("S\n\nNow: 1");
  });
});

// 2026-11-16: the reorder must not change WHAT the 9B is told. The line it replaced in local-routing.ts (before_prompt_build), kept here
// verbatim as the reference, and the new builder must give the same paragraphs (split on blank lines) for representative turns.

type Turn = { instructions: string; lookup: string; ignoreNote: string; pushNote: string; brainFetched: string; askNote: string; card: string; now: string };
const legacy = (t: Turn) => `${t.instructions}\n\n${PRODUCTION_NOTES}\n\n${LOOK_IT_UP}${t.lookup}${t.ignoreNote}${t.pushNote}${t.brainFetched}${t.askNote}\n\n${t.card}${t.now}`;
const current = (t: Turn) => workerSystemPrompt({ stable: `${t.instructions}\n\n${PRODUCTION_NOTES}\n\n${LOOK_IT_UP}`, card: t.card, perTurn: [t.lookup, t.ignoreNote, t.pushNote, t.brainFetched, t.askNote], now: t.now });
const paragraphs = (text: string) => text.split(/\n\n/).sort();

const cardText = (tone: string) => `Nick now: should be MKTG2201 (until 15:00); next ECON1115 at 15:30.\nThis week: gym skipped 3 times.\n\n${tone}\n\n`;
const LIVE = "\n\nThis needs live data (weather, sun times, his messages, his day). Answer only from what a tool returns just now; if none of your tools can get it, say \"I can't check that right now.\" Never guess it.";
const turns: Record<string, Turn> = {
  "plain chat with the card": { instructions: GENERAL_INSTRUCTIONS, lookup: "", ignoreNote: "", pushNote: "", brainFetched: "", askNote: "", card: cardText(TONE_NOTE), now: "Now: Mon 20:10 (Europe/London). Monday 16 November" },
  "live lookup + brain notes, late tone": { instructions: GENERAL_INSTRUCTIONS, lookup: LIVE, ignoreNote: "", pushNote: "", brainFetched: "\n\nFrom his brain, matched to this message (may help):\n## Gym\n- push day Mon\n\n## Sleep\n- in bed by 00:30", askNote: "",
    card: cardText(`${TONE_NOTE.split("\n").slice(0, 2).join("\n")}\n${LATE_TONE_LINE}`), now: "Now: Mon 23:40 (Europe/London). Monday 16 November" },
  "scheduling, ask + push note, no card": { instructions: SCHEDULING_INSTRUCTIONS, lookup: "", ignoreNote: "", pushNote: "\n\nHe is most likely answering what you sent him at 19:30: \"gym now?\". Act on that.", brainFetched: "", askNote: "\n\nAsk him: which day?", card: "", now: "Now: Mon 19:32 (Europe/London). Monday 16 November" },
  "ignore note + code-did-part clock": { instructions: GENERAL_INSTRUCTIONS, lookup: "", ignoreNote: "\n\nThis may not be meant for you.", pushNote: "", brainFetched: "", askNote: "", card: cardText(TONE_NOTE),
    now: "Now: Mon 20:10 (Europe/London). Monday 16 November\nCode already did this part of his message: Timer set. Do not do that part again." },
};

describe("worker prompt reorder keeps every section (2026-11-16)", () => {
  for (const [name, t] of Object.entries(turns)) {
    it(`${name}: the same paragraphs as the old line, only the order differs`, () => {
      expect(paragraphs(current(t))).toEqual(paragraphs(legacy(t)));
      expect(current(t).length).toBe(legacy(t).length);
    });
  }
  it("with no per-turn notes the text is byte-identical to the old line", () => {
    expect(current(turns["plain chat with the card"])).toBe(legacy(turns["plain chat with the card"]));
  });
});
