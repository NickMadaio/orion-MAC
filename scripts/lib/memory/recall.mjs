// Hybrid recall over the curated index. The embedding rank dominates; the keyword rank is a lighter, weighted tie-breaker;
// exact names, ids and quoted strings in the query get their own list at full weight. The keyword half is skipped when no
// query word is in the index vocabulary, and in hybrid mode a relevance floor (cosine) drops weak matches, so an
// off-topic query returns nothing rather than the least-bad chunks (2026-11-16: live hybrid hit@1 53% vs 73% embedding-only).
// recall() never throws. With no index, or an embedder that fails or times out, it answers keyword-only and says why in `notes`.
import { cosine } from "./embed.mjs";
import { readIndex } from "./curated-index.mjs";

const STOP = new Set(["the", "a", "an", "of", "and", "or", "to", "is", "in", "on", "my", "what", "who", "do", "did", "i", "me", "about", "for", "with", "his", "her", "was", "are", "when", "where", "how", "which", "does", "it", "at", "be", "am", "should", "can"]);
export const words = (s) => [...new Set((String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.replace(/(ing|ed|es|s)$/, "")).filter((w) => w.length > 1 && !STOP.has(w)))];

/** idf-weighted word overlap over the chunks. Returns chunks best first (only those that share a word). */
export function keywordRank(query, chunks) {
  const q = words(query);
  if (!q.length) return [];
  const docs = chunks.map((c) => new Set(words(`${c.text} ${c.source}`)));
  const idf = new Map(q.map((w) => [w, Math.log(1 + chunks.length / (1 + docs.filter((d) => d.has(w)).length))]));
  return chunks
    .map((c, i) => ({ c, s: q.reduce((sum, w) => sum + (docs[i].has(w) ? idf.get(w) : 0), 0) / Math.sqrt(1 + c.text.length / 200) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}

/** Weighted reciprocal-rank fusion of ranked lists ({ name, items, weight = 1 }). Returns [{ item, score, via: [...] }] best first. */
export function fuse(lists, k = 60) {
  const acc = new Map();
  for (const { name, items, weight = 1 } of lists) {
    items.forEach((item, rank) => {
      const cur = acc.get(item.id) ?? { item, score: 0, via: [] };
      cur.score += weight / (k + rank + 1);
      cur.via.push(name);
      acc.set(item.id, cur);
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

/** Tuning, measured on the live private questions (E2-memory.md). Exported so the check can report what it ran with. */
export const FUSION = Object.freeze({ k: 60, embeddingWeight: 1, keywordWeight: 0.2, exactWeight: 1, embeddingDepth: 50 });
/** For a lexical embedder (the hashed bag-of-words stub used in tests and CI), whose "embedding" is itself word overlap: equal weights. */
export const LEXICAL_FUSION = Object.freeze({ ...FUSION, keywordWeight: 1 });

/** Exact things in a query worth matching literally: "quoted strings", tokens with a digit (ids, codes) and Capitalised names (not the first word). */
export function exactTerms(query) {
  const q = String(query);
  const quoted = [...q.matchAll(/["“]([^"”]{2,80})["”]/g)].map((m) => m[1].trim());
  const tokens = q.replace(/["“”]/g, " ").split(/\s+/).filter(Boolean);
  const ids = tokens.map((t) => t.replace(/[^\p{L}\p{N}-]/gu, "")).filter((t) => t.length > 1 && /\p{N}/u.test(t) && /\p{L}/u.test(t));
  const names = tokens.slice(1).map((t) => t.replace(/[^\p{L}\p{N}-]/gu, "")).filter((t) => t.length > 2 && /^\p{Lu}/u.test(t));
  return [...new Set([...quoted, ...ids, ...names].map((t) => t.toLowerCase()))];
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Chunks containing the exact terms as whole words, most terms first. A term found in more than `maxHits` chunks does not
 * pick anything out (a common name such as the owner's own, or a course code on every timetable line) and is dropped:
 * measured live, letting those vote cost 2 to 4 hit@1 on 25 questions.
 */
export function exactRank(terms, chunks, { maxHits = 3 } = {}) {
  if (!terms.length) return [];
  const res = terms
    .map((t) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}($|[^\\p{L}\\p{N}])`, "iu"))
    .filter((r) => { const n = chunks.filter((c) => r.test(c.text)).length; return n > 0 && n <= maxHits; });
  if (!res.length) return [];
  return chunks
    .map((c) => ({ c, n: res.filter((r) => r.test(c.text)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.c);
}

/** True when at least one query word appears somewhere in the chunks (else the keyword half has nothing to say). */
export function sharesVocabulary(query, chunks) {
  const q = words(query);
  if (!q.length) return false;
  return chunks.some((c) => { const d = new Set(words(`${c.text} ${c.source}`)); return q.some((w) => d.has(w)); });
}

const view = ({ item, score, via }, rank) => ({ id: item.id, rank, score: Math.round(score * 1e4) / 1e4, via, kind: item.kind, date: item.date, source: item.source, text: item.text });

/**
 * @param query string
 * @param opts { indexPath | index, embedder, n, queryTimeoutMs, extraKeyword: (q, hasIndex) => [{id,text,source,date,kind}] }
 * @returns { mode: "hybrid" | "keyword-only" | "none", notes: string[], results: [{rank,score,via,kind,date,source,text}] }
 */
export async function recall(query, { indexPath, index, embedder, n = 5, queryTimeoutMs = 4000, extraKeyword = null, fusion: tuning, minSimilarity } = {}) {
  const fusion = tuning ?? (embedder?.lexical ? LEXICAL_FUSION : FUSION);
  const notes = [];
  try {
    const q = String(query ?? "").trim();
    if (!q) return { mode: "none", notes: ["empty query"], results: [] };
    const idx = index ?? (indexPath ? readIndex(indexPath) : null);
    let extra = [];
    try { extra = extraKeyword ? extraKeyword(q, Boolean(idx)) ?? [] : []; } catch { notes.push("the vault keyword search failed"); }
    if (!idx) notes.push("curated index unavailable (missing or unreadable): keyword-only");
    const chunks = idx?.chunks ?? [];
    const useKeyword = !idx || sharesVocabulary(q, chunks);
    if (idx && !useKeyword) notes.push("no query word is in the index: keyword half skipped");
    const keyword = [...(useKeyword ? keywordRank(q, chunks) : []), ...extra.filter((e) => !chunks.some((c) => c.id === e.id))];
    const exact = exactRank(exactTerms(q), chunks);
    let mode = "keyword-only";
    let sims = null;
    if (idx && embedder) {
      try {
        const [qv] = await Promise.race([
          embedder.embed([q], { role: "query" }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("embedding timed out")), queryTimeoutMs).unref()),
        ]);
        if (!Array.isArray(qv) || qv.length !== idx.dim) throw new Error(`query vector size ${qv?.length} does not match the index (${idx.dim}; index model ${idx.model})`);
        sims = new Map(chunks.map((c) => [c.id, cosine(qv, c.vec)]));
        mode = "hybrid";
      } catch (e) { notes.push(`embedding unavailable (${String(e?.message ?? e).slice(0, 120)}): keyword-only`); }
    } else if (idx) notes.push("no embedder: keyword-only");
    const lists = [{ name: "keyword", items: keyword, weight: sims ? fusion.keywordWeight : 1 }];
    if (exact.length) lists.push({ name: "exact", items: exact, weight: fusion.exactWeight });
    if (sims) {
      const ranked = [...chunks].sort((a, b) => sims.get(b.id) - sims.get(a.id)).slice(0, fusion.embeddingDepth);
      lists.push({ name: "embedding", items: ranked, weight: fusion.embeddingWeight });
    }
    let fused = fuse(lists, fusion.k);
    // The relevance floor: in hybrid mode a chunk must be similar enough, unless it matched an exact name, id or quote.
    const floor = minSimilarity ?? embedder?.minSimilarity ?? 0;
    if (sims && floor > 0) {
      const before = fused.length;
      fused = fused.filter((r) => r.via.includes("exact") || (sims.get(r.item.id) ?? 0) >= floor);
      if (before && !fused.length) notes.push(`nothing in curated memory is close enough (similarity floor ${floor})`);
    }
    const results = fused.slice(0, n).map((r, i) => view(r, i + 1));
    return { mode, notes, results };
  } catch (e) {
    return { mode: "none", notes: [`recall failed safely: ${String(e?.message ?? e).slice(0, 120)}`], results: [] };
  }
}

/** Plain text for the prompt or the terminal. */
export function renderRecall(out, { max = 600 } = {}) {
  const head = out.notes.length ? `(${out.notes.join("; ")})\n` : "";
  if (!out.results.length) return `${head}Nothing in curated memory matches.`;
  return head + out.results.map((r) => `${r.rank}. [${r.kind}${r.date ? ` ${r.date}` : ""}] ${r.text.slice(0, max)}  (${r.source})`).join("\n");
}
