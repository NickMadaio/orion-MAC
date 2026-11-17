// Recall check: facts + questions with the expected fact -> hit@1 / hit@5, for the hybrid search and for each half alone.
// Folder format: facts.json [{id, text, kind?, date?}], questions.json [{q, expect}]  (expect = fact id; or expectText = a text snippet).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildIndex } from "./curated-index.mjs";
import { keywordRank, recall } from "./recall.mjs";
import { cosine } from "./embed.mjs";

export const loadFolder = (dir) => ({
  facts: JSON.parse(readFileSync(join(dir, "facts.json"), "utf8")),
  questions: JSON.parse(readFileSync(join(dir, "questions.json"), "utf8")),
});

export const factsToChunks = (facts) => facts.map((f) => ({ id: f.id, text: f.text, source: `facts.json#${f.id}`, date: f.date ?? "", kind: f.kind ?? "remembered" }));

const isHit = (q, c) => (q.expect ? c.id === q.expect : q.expectText ? c.text.toLowerCase().includes(q.expectText.toLowerCase()) : false);
const rankOf = (q, list) => { const i = list.findIndex((c) => isHit(q, c)); return i < 0 ? Infinity : i + 1; };
const rate = (ranks, k) => (ranks.length ? Math.round((ranks.filter((r) => r <= k).length / ranks.length) * 1000) / 1000 : 0);

/** Runs every question. `index` may be passed (live check); otherwise it is built from `facts` with `embedder`. */
export async function runRecallCheck({ facts = [], questions, embedder, index = null, n = 5 }) {
  const idx = index ?? (await buildIndex(factsToChunks(facts), embedder));
  const hybrid = [], kw = [], emb = [], misses = [];
  for (const q of questions) {
    const out = await recall(q.q, { index: idx, embedder, n });
    const h = out.results.findIndex((r) => isHit(q, r));
    hybrid.push(h < 0 ? Infinity : h + 1);
    kw.push(rankOf(q, keywordRank(q.q, idx.chunks)));
    const [qv] = await embedder.embed([q.q], { role: "query" });
    emb.push(rankOf(q, idx.chunks.map((c) => ({ c, s: cosine(qv, c.vec) })).sort((a, b) => b.s - a.s).map((x) => x.c)));
    if (hybrid.at(-1) > n) misses.push({ q: q.q, expect: q.expect ?? q.expectText, mode: out.mode });
  }
  return {
    questions: questions.length,
    chunks: idx.chunks.length,
    embedder: embedder.name,
    hybrid: { hit1: rate(hybrid, 1), hit5: rate(hybrid, 5) },
    keywordOnly: { hit1: rate(kw, 1), hit5: rate(kw, 5) },
    embeddingOnly: { hit1: rate(emb, 1), hit5: rate(emb, 5) },
    misses,
  };
}
