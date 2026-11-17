// The curated memory index: a JSON file of { id, text, source, date, kind, vec } chunks. It is written to its OWN file and never
// to OpenClaw's openclaw-agent.sqlite (that is the old, raw-transcript index and is left alone).
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const INDEX_SCHEMA = "orion.curated-index.v1";

/** Builds the index in memory. Returns { schema, model, dim, builtAt, chunks }. Throws if the embedder fails (a builder must say so). */
export async function buildIndex(chunks, embedder, { now = new Date(), batch = 64 } = {}) {
  const vectors = [];
  for (let i = 0; i < chunks.length; i += batch) vectors.push(...(await embedder.embed(chunks.slice(i, i + batch).map((c) => c.text), { role: "document" })));
  if (vectors.length !== chunks.length) throw new Error("embedder returned the wrong number of vectors");
  const round = (v) => v.map((x) => Math.round(x * 1e5) / 1e5);
  return {
    schema: INDEX_SCHEMA,
    model: embedder.name,
    dim: vectors[0]?.length ?? 0,
    builtAt: now.toISOString(),
    chunks: chunks.map((c, i) => ({ ...c, vec: round(vectors[i]) })),
  };
}

/** Atomic write; refuses a path that looks like the old sqlite index. */
export function writeIndex(path, index) {
  if (/\.sqlite3?$/i.test(path)) throw new Error(`refusing to write the curated index to ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
  renameSync(tmp, path);
  return { path, bytes: statSync(path).size, chunks: index.chunks.length };
}

/** The index, or null when missing/corrupt/wrong schema. Never throws. */
export function readIndex(path) {
  try {
    const idx = JSON.parse(readFileSync(path, "utf8"));
    return idx?.schema === INDEX_SCHEMA && Array.isArray(idx.chunks) ? idx : null;
  } catch { return null; }
}
