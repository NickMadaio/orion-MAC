// Recall ranking: embedding rank dominant, keyword a weighted tie-breaker, rare exact terms, keyword skip, relevance floor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { exactRank, exactTerms, fuse, recall, sharesVocabulary } from "../scripts/lib/memory/recall.mjs";

// A fake embedder with hand-set vectors: the query vector is looked up by exact text.
const chunk = (id, text, vec) => ({ id, text, source: `t#${id}`, date: "", kind: "remembered", vec });
const index = (chunks) => ({ dim: 2, model: "fake", chunks });
const fake = (byQuery, minSimilarity = 0.6) => ({ name: "fake", minSimilarity, embed: async ([q]) => [byQuery[q] ?? [0, 1]] });
const unit = (deg) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];

test("weighted fusion: a lighter list cannot outvote the heavier one at equal rank", () => {
  const [a, b] = [{ id: "a" }, { id: "b" }];
  const out = fuse([{ name: "keyword", items: [a, b], weight: 0.2 }, { name: "embedding", items: [b, a], weight: 1 }]);
  assert.equal(out[0].item.id, "b");
  assert.equal(fuse([{ name: "x", items: [a] }])[0].score, 1 / 61, "weight defaults to 1");
});

test("the embedding rank dominates a keyword-heavy distractor", async () => {
  const idx = index([
    chunk("kw", "gym gym gym timetable gym schedule", unit(60)),
    chunk("sem", "Swimming on Tuesday and Thursday mornings at the leisure centre", unit(5)),
  ]);
  const out = await recall("when is my gym schedule", { index: idx, embedder: fake({ "when is my gym schedule": unit(0) }) });
  assert.equal(out.mode, "hybrid");
  assert.equal(out.results[0].id, "sem");
});

test("keyword is the tie-breaker when the embedding is close", async () => {
  const idx = index([chunk("a", "locker at the library", unit(10)), chunk("b", "my locker number is 41", unit(11))]);
  const out = await recall("locker number", { index: idx, embedder: fake({ "locker number": unit(10.5) }) });
  assert.equal(out.results[0].id, "b");
});

test("exact terms: quoted strings, ids and Capitalised names; a term in many chunks does not vote", () => {
  assert.deepEqual(exactTerms('what did "blue folder" say about MKTG2201 and Priya'), ["blue folder", "mktg2201", "priya"]);
  assert.deepEqual(exactTerms("What time is it"), []);
  const chunks = ["Priya a", "Priya b", "Priya c", "Priya d", "MKTG2201 brief"].map((t, i) => ({ id: String(i), text: t }));
  assert.deepEqual(exactRank(["priya"], chunks), [], "common name dropped");
  assert.deepEqual(exactRank(["mktg2201"], chunks).map((c) => c.id), ["4"]);
});

test("the keyword half is skipped, with a note, when no query word is in the index", async () => {
  const idx = index([chunk("a", "swimming on tuesday", unit(0))]);
  assert.equal(sharesVocabulary("swimming", idx.chunks), true);
  assert.equal(sharesVocabulary("zebra xylophone", idx.chunks), false);
  const out = await recall("zebra xylophone", { index: idx, embedder: fake({ "zebra xylophone": unit(2) }) });
  assert.ok(out.notes.some((n) => /keyword half skipped/.test(n)));
  assert.equal(out.results[0].id, "a", "the embedding half still answers");
});

test("relevance floor: an off-topic query returns nothing rather than weak matches", async () => {
  const idx = index([chunk("a", "swimming on tuesday", unit(0)), chunk("b", "dentist on friday", unit(10))]);
  const out = await recall("recipe for banana bread", { index: idx, embedder: fake({ "recipe for banana bread": unit(70) }) });
  assert.deepEqual(out.results, []);
  assert.ok(out.notes.some((n) => /close enough/.test(n)));
  const near = await recall("swimming", { index: idx, embedder: fake({ swimming: unit(5) }) });
  assert.ok(near.results.every((r) => r.id === "a" || r.id === "b"));
  assert.equal(near.results[0].id, "a");
});

test("the floor keeps a weak-similarity chunk that matched a rare exact term", async () => {
  const idx = index([chunk("a", "the MKTG2201 brief bans AI ideation", unit(80)), chunk("b", "swimming", unit(0))]);
  const out = await recall("what does MKTG2201 say", { index: idx, embedder: fake({ "what does MKTG2201 say": unit(0) }) });
  assert.ok(out.results.some((r) => r.id === "a"));
});

test("no embedder: keyword-only with no floor, as before", async () => {
  const idx = index([chunk("a", "swimming on tuesday", unit(0))]);
  const out = await recall("swimming", { index: idx });
  assert.equal(out.mode, "keyword-only");
  assert.equal(out.results[0].id, "a");
});
