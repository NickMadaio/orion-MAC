// Embedders for the curated memory index. An embedder is { name, embed(texts, { role }) -> Promise<number[][]> }.
// "ollama" talks to localhost only (nomic-embed-text, already installed; ORION uses local models only).
// "stub" is a deterministic hashed bag-of-words, so tests and CI need no Ollama.
const DEFAULT_URL = "http://127.0.0.1:11434";
export const EMBED_MODEL = "nomic-embed-text";
export const NOMIC_MIN_SIMILARITY = 0.62;

const normalise = (v) => {
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / len);
};

const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
};
const stem = (w) => w.replace(/(ing|ed|es|s)$/, "");

/** Deterministic fake vectors: feature-hashed words (stemmed), so shared vocabulary means similar vectors. */
export function stubEmbedder(dim = 128) {
  return {
    name: `stub-${dim}`,
    dim,
    lexical: true, // word overlap, not meaning: recall fuses it with the keyword half at equal weight
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array(dim).fill(0);
        for (const w of String(t).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
          if (w.length < 3) continue;
          const h = hash(stem(w));
          v[h % dim] += h & 0x10000 ? 1 : -1;
        }
        return normalise(v);
      });
    },
  };
}

/** Ollama's /api/embed. nomic-embed-text wants a task prefix on documents and on queries. */
export function ollamaEmbedder({ url = process.env.ORION_OLLAMA_URL || DEFAULT_URL, model = EMBED_MODEL, timeoutMs = 60000, batch = 16, fetchFn = fetch } = {}) {
  const prefix = { document: "search_document: ", query: "search_query: " };
  return {
    name: model,
    // Relevance floor for recall (cosine). Measured 2026-11-16 on the curated index: off-topic queries topped out at
    // 0.585, the best match for a real question was never below 0.652. Only meaningful for nomic-embed-text.
    minSimilarity: model === EMBED_MODEL ? NOMIC_MIN_SIMILARITY : 0,
    async embed(texts, { role = "document" } = {}) {
      const out = [];
      for (let i = 0; i < texts.length; i += batch) {
        const input = texts.slice(i, i + batch).map((t) => prefix[role] + t);
        const res = await fetchFn(`${url}/api/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, input, truncate: true }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`ollama embed ${res.status}`);
        const body = await res.json();
        if (!Array.isArray(body.embeddings) || body.embeddings.length !== input.length) throw new Error("ollama embed: bad response");
        out.push(...body.embeddings.map(normalise));
      }
      return out;
    },
  };
}

export const cosine = (a, b) => {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
};
