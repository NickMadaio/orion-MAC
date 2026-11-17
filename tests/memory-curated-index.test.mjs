import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { collectCurated } from "../scripts/lib/memory/curated-sources.mjs";
import { isRealSession } from "../scripts/lib/memory/real-session.mjs";
import { buildIndex, writeIndex, readIndex } from "../scripts/lib/memory/curated-index.mjs";
import { stubEmbedder } from "../scripts/lib/memory/embed.mjs";
import { fuse, recall, renderRecall } from "../scripts/lib/memory/recall.mjs";

const root = new URL("..", import.meta.url).pathname;

function world() {
  const dir = mkdtempSync(join(tmpdir(), "orion-curated-"));
  const vaultDir = join(dir, "vault"), workspaceDir = join(dir, "ws"), controlledDir = join(dir, "ctl");
  for (const d of ["20 Areas/Health", "40 Daily", "90 System", "00 Inbox", "20 Areas/Test Fixtures"]) mkdirSync(join(vaultDir, d), { recursive: true });
  mkdirSync(workspaceDir, { recursive: true }); mkdirSync(controlledDir, { recursive: true });
  writeFileSync(join(vaultDir, "20 Areas/Health/Pool.md"), "---\ntitle: Pool\n---\n# Pool\n\n## Observations\n- [days] Swims at the Harbourside pool on Tuesday mornings before class.\n");
  writeFileSync(join(vaultDir, "40 Daily/2026-11-01.md"), "# Day\n\nDAILY-EPISODE should never be indexed because it is a daily log entry.\n");
  writeFileSync(join(vaultDir, "90 System/Policy.md"), "# Policy\n\nSYSTEM-NOTE should never be indexed because it is tooling text.\n");
  writeFileSync(join(vaultDir, "20 Areas/Test Fixtures/Fake.md"), "# Fake\n\nFIXTURE-NOTE should never be indexed because it is a fixture.\n");
  writeFileSync(join(workspaceDir, "USER.md"), "# Nick\n\n- Name: Test Person\n- 2026-10-01 — Times are 12-hour, never 24-hour.\n  Say them once.\n\nStore only durable facts.\n");
  writeFileSync(join(controlledDir, "declared-facts.json"), JSON.stringify({ facts: [{ id: "fact-1", date: "2026-11-02", text: "The cat is called Biscuit." }] }));
  writeFileSync(join(controlledDir, "learned-routines.json"), JSON.stringify({ routines: [{ id: "r1", label: "out Fri evening", status: "confident", occurrences: 3, lastHit: "2026-11-13" }, { id: "r2", label: "gone", status: "dropped" }] }));
  writeFileSync(join(controlledDir, "known-places.json"), JSON.stringify({ places: [{ id: "chapter", name: "Chapter Spitalfields", aliases: ["spit"] }] }));
  const attempts = [
    { at: "2026-11-10T10:00:00Z", kind: "correction", decision: "qualified", rule: "Never schedule study right after a late shift.", trigger: { sessionKey: "agent:main:orion-app-v2", channel: "orion-app" } },
    { at: "2026-11-10T10:01:00Z", kind: "correction", decision: "not-qualified", rule: "NOT-QUALIFIED-ROW", trigger: { sessionKey: "agent:main:orion-app-v2" } },
    { at: "2026-11-10T10:02:00Z", kind: "correction", decision: "qualified", rule: "SWEEP-ROW should be skipped.", trigger: { sessionKey: "agent:main:orion-chat-sweep-1116c" } },
  ];
  writeFileSync(join(controlledDir, "learning-attempts.jsonl"), attempts.map((a) => JSON.stringify(a)).join("\n"));
  return { dir, vaultDir, workspaceDir, controlledDir };
}

test("curated sources: only curated material, each chunk carries source, date and kind", () => {
  const w = world();
  try {
    const chunks = collectCurated(w);
    const all = chunks.map((c) => c.text).join("\n");
    for (const banned of ["DAILY-EPISODE", "SYSTEM-NOTE", "FIXTURE-NOTE", "NOT-QUALIFIED-ROW", "SWEEP-ROW", "gone"]) assert.ok(!all.includes(banned), banned);
    assert.deepEqual([...new Set(chunks.map((c) => c.kind))].sort(), ["correction", "note", "place", "profile", "remembered", "routine", "rule"]);
    for (const c of chunks) { assert.ok(c.source, "source"); assert.ok(c.kind, "kind"); assert.ok(c.id, "id"); assert.ok(c.date === "" || /^\d{4}-\d{2}-\d{2}$/.test(c.date), "date"); }
    assert.match(chunks.find((c) => c.kind === "rule").text, /Say them once/, "continuation lines are kept");
    assert.match(chunks.find((c) => c.kind === "place").text, /spit/);
    assert.equal(chunks.find((c) => c.kind === "remembered").date, "2026-11-02");
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("curated sources: a missing source is skipped, not fatal", () => {
  assert.deepEqual(collectCurated({ vaultDir: "/nonexistent-a", workspaceDir: "/nonexistent-b", controlledDir: "/nonexistent-c" }), []);
});

test("session keys: the index builder and the journal share one positive real-session test", () => {
  for (const k of ["agent:main:orion-chat-gate-1102-5", "agent:main:orion-probe-plugin", "agent:main:cron:x", "agent:main:orion-chat-sweep-1116c", "agent:main:subagent:1", "agent:main:orion-eval-3", "agent:main:orion-chat-z12", "agent:main:orion-chat-j", "agent:main:orion-chat-test", "agent:main:orion-chat-longc"]) assert.ok(!isRealSession(k), k);
  for (const k of ["agent:main:orion-app-v2", "agent:main:orion-chat-phone-history", "agent:main:orion-chat-5d2b1c3e-1111-2222-3333-444455556666"]) assert.ok(isRealSession(k), k);
});

test("index: build, write atomically, read back; refuses sqlite; corrupt file reads as null", async () => {
  const w = world();
  try {
    const index = await buildIndex(collectCurated(w), stubEmbedder(32), { now: new Date("2026-11-16T00:00:00Z") });
    assert.equal(index.dim, 32);
    const path = join(w.dir, "idx", "orion-curated-index.json");
    const res = writeIndex(path, index);
    assert.equal(res.chunks, index.chunks.length);
    assert.equal(readIndex(path).chunks.length, index.chunks.length);
    assert.throws(() => writeIndex(join(w.dir, "openclaw-agent.sqlite"), index), /refusing/);
    writeFileSync(path, "{not json");
    assert.equal(readIndex(path), null);
    assert.equal(readIndex(join(w.dir, "missing.json")), null);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("fuse: reciprocal rank rewards agreement between lists", () => {
  const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
  const out = fuse([{ name: "keyword", items: [a, b] }, { name: "embedding", items: [c, b] }]);
  assert.equal(out[0].item.id, "b");
  assert.deepEqual(out[0].via, ["keyword", "embedding"]);
});

test("recall: hybrid when everything works; keyword-only with a note when the embedder fails or the index is missing; never throws", async () => {
  const w = world();
  try {
    const embedder = stubEmbedder(64);
    const index = await buildIndex(collectCurated(w), embedder);
    const ok = await recall("which mornings do I swim at the pool", { index, embedder, n: 3 });
    assert.equal(ok.mode, "hybrid");
    assert.match(ok.results[0].text, /Harbourside/);
    assert.ok(ok.results[0].source && ok.results[0].kind);
    const broken = { name: "x", embed: async () => { throw new Error("connection refused"); } };
    const down = await recall("pool", { index, embedder: broken });
    assert.equal(down.mode, "keyword-only");
    assert.match(down.notes.join(" "), /embedding unavailable/);
    assert.match(down.results[0].text, /Harbourside/);
    const wrongSize = await recall("pool", { index, embedder: stubEmbedder(8) });
    assert.match(wrongSize.notes.join(" "), /does not match/);
    const none = await recall("pool", { indexPath: join(w.dir, "nope.json"), embedder, extraKeyword: () => [{ id: "v", text: "pool note", source: "vault/x.md", date: "", kind: "note" }] });
    assert.equal(none.mode, "keyword-only");
    assert.match(none.notes.join(" "), /index unavailable/);
    assert.equal(none.results[0].source, "vault/x.md");
    const boom = await recall("pool", { index, embedder, extraKeyword: () => { throw new Error("x"); } });
    assert.ok(boom.results.length > 0);
    assert.equal((await recall("", { index, embedder })).mode, "none");
    assert.match(renderRecall(down), /unavailable/);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("orion-brain recall: --json, keyword-only fallback when the index is missing, never fails", () => {
  const w = world();
  try {
    const env = { ...process.env, ORION_BRAIN_VAULT: w.vaultDir, ORION_CONTROLLED_DIR: w.controlledDir, ORION_WORKSPACE_DIR: w.workspaceDir, ORION_CURATED_INDEX: join(w.dir, "absent.json"), ORION_OLLAMA_URL: "http://127.0.0.1:9" };
    const out = JSON.parse(execFileSync(process.execPath, [join(root, "scripts/orion-brain"), "recall", "Harbourside pool", "--json"], { env, encoding: "utf8" }));
    assert.equal(out.mode, "keyword-only");
    assert.match(out.notes.join(" "), /unavailable/);
    assert.match(out.results[0].text, /Harbourside/);
    const text = execFileSync(process.execPath, [join(root, "scripts/orion-brain"), "recall", "zzzqqq nothing"], { env, encoding: "utf8" });
    assert.match(text, /Nothing in curated memory/);
    const usage = spawnSync(process.execPath, [join(root, "scripts/orion-brain"), "recall"], { env, encoding: "utf8" });
    assert.equal(usage.status, 2);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("orion-brain recall with an index but Ollama unreachable degrades to keyword-only with a note", async () => {
  const w = world();
  try {
    const index = await buildIndex(collectCurated(w), stubEmbedder(16));
    const path = join(w.dir, "idx.json");
    writeIndex(path, index);
    const env = { ...process.env, ORION_BRAIN_VAULT: w.vaultDir, ORION_CONTROLLED_DIR: w.controlledDir, ORION_CURATED_INDEX: path, ORION_OLLAMA_URL: "http://127.0.0.1:9" };
    const out = JSON.parse(execFileSync(process.execPath, [join(root, "scripts/orion-brain"), "recall", "Biscuit the cat", "--json"], { env, encoding: "utf8" }));
    assert.equal(out.mode, "keyword-only");
    assert.match(out.notes.join(" "), /embedding unavailable/);
    assert.match(out.results[0].text, /Biscuit/);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("orion-memory-index: --dry counts by kind and writes nothing; stub build writes only the named file", () => {
  const w = world();
  try {
    const env = { ...process.env, ORION_BRAIN_VAULT: w.vaultDir, ORION_CONTROLLED_DIR: w.controlledDir, ORION_WORKSPACE_DIR: w.workspaceDir };
    const dry = JSON.parse(execFileSync(process.execPath, [join(root, "scripts/orion-memory-index"), "build", "--dry"], { env, encoding: "utf8" }));
    assert.ok(dry.chunks >= 7 && dry.byKind.rule === 1);
    const out = join(w.dir, "new-index.json");
    const built = JSON.parse(execFileSync(process.execPath, [join(root, "scripts/orion-memory-index"), "build", "--embedder", "stub", "--out", out], { env, encoding: "utf8" }));
    assert.equal(built.chunks, dry.chunks);
    assert.ok(existsSync(out) && readFileSync(out, "utf8").includes("orion.curated-index.v1"));
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});
