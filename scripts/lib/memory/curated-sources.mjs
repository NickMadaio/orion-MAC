// What may go into the curated memory index, and nothing else (E2, 2026-11-16).
// Remembered facts, USER.md lines, learned routines, qualified corrections, place aliases and the vault's curated notes.
// NEVER raw session transcripts, any session that is not a real owner session (real-session.mjs), the task ledger, daily Episodes, or the vault's Daily/System/Inbox areas.
// Every chunk: { id, text, source, date, kind }. Reads only; a missing or broken source is skipped, never fatal.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isRealSession } from "./real-session.mjs";


/** Vault folders that hold curated notes. Daily, System, Inbox and Sources are logs, tooling and raw capture. */
export const VAULT_CURATED_DIRS = ["10 Projects", "20 Areas", "30 Resources", "50 Concepts"];
const SKIP_NOTE = /(^|\/)(README|Test Fixtures|Evidence|Templates)(\/|\.md$|$)/i;
const MAX_CHUNK = 900;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const day = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10); };
const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const chunk = (id, text, source, date, kind) => ({ id, text: squash(text), source, date: date || "", kind });

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".md")) yield p;
  }
}

/** Splits long text at sentence/line ends so no chunk passes MAX_CHUNK. */
export function splitLong(text, max = MAX_CHUNK) {
  const parts = [];
  let cur = "";
  for (const piece of String(text).split(/(?<=[.!?\n])\s+/)) {
    if (cur && cur.length + piece.length + 1 > max) { parts.push(cur); cur = piece; } else cur = cur ? `${cur} ${piece}` : piece;
  }
  if (cur) parts.push(cur);
  return parts.flatMap((p) => (p.length > max * 1.5 ? p.match(new RegExp(`.{1,${max}}`, "gs")) : [p]));
}

export function fromDeclaredFacts(controlledDir) {
  const facts = readJson(join(controlledDir, "declared-facts.json"))?.facts;
  return (Array.isArray(facts) ? facts : []).filter((f) => f?.text).map((f) => chunk(`fact:${f.id}`, f.text, `orion-controlled/declared-facts.json#${f.id}`, f.date || day(f.at), "remembered"));
}

/** Dated and plain top-level bullets of USER.md (with their indented continuation lines). */
export function fromUserMd(workspaceDir) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  readText(join(workspaceDir, "USER.md")).split("\n").forEach((line, i) => {
    const m = line.match(/^- (?:(\d{4}-\d{2}-\d{2}) — )?(.+)$/);
    if (m) { flush(); cur = { n: i + 1, date: m[1] ?? "", text: m[2], dated: !!m[1] }; }
    else if (cur && /^\s{2,}\S/.test(line)) cur.text += ` ${line.trim()}`;
    else flush();
  });
  flush();
  return out.map((r) => chunk(`user:${r.n}`, r.text, `workspace/USER.md#L${r.n}`, r.date, r.dated ? "rule" : "profile"));
}

export function fromRoutines(controlledDir) {
  const routines = readJson(join(controlledDir, "learned-routines.json"))?.routines;
  return (Array.isArray(routines) ? routines : [])
    .filter((r) => r?.label && !/^(dropped|retired|rejected)$/i.test(r.status ?? ""))
    .map((r) => chunk(`routine:${r.id}`, `Learned routine (${r.status ?? "unknown"}, seen ${r.occurrences ?? "?"} times): ${r.label}`, `orion-controlled/learned-routines.json#${r.id}`, r.lastHit, "routine"));
}

/** Only rows the learning log says qualified, from a real session, with the rule or correction text itself. */
export function fromLearningAttempts(controlledDir) {
  let text = "";
  try { text = readFileSync(join(controlledDir, "learning-attempts.jsonl"), "utf8"); } catch { return []; }
  const out = [];
  text.split("\n").forEach((line, i) => {
    let row;
    try { row = JSON.parse(line); } catch { return; }
    if (row?.decision !== "qualified" || !isRealSession(row.trigger?.sessionKey)) return;
    const said = row.rule ?? row.write?.rule ?? row.trigger?.text ?? row.trigger?.correction ?? row.text;
    if (typeof said === "string" && said.trim()) out.push(chunk(`correction:${i + 1}`, said, `orion-controlled/learning-attempts.jsonl#L${i + 1}`, day(row.at), "correction"));
  });
  return out;
}

export function fromPlaces(controlledDir) {
  const doc = readJson(join(controlledDir, "known-places.json"));
  return (Array.isArray(doc?.places) ? doc.places : []).filter((p) => p?.name).map((p) => {
    const aliases = Array.isArray(p.aliases) && p.aliases.length ? `, also called ${p.aliases.join(", ")}` : "";
    return chunk(`place:${p.id ?? p.name}`, `Place: ${p.name}${aliases}${p.kind ? ` (${p.kind})` : ""}`, `orion-controlled/known-places.json#${p.id ?? p.name}`, "", "place");
  });
}

export function fromVault(vaultDir) {
  const out = [];
  const files = [...VAULT_CURATED_DIRS.flatMap((d) => [...walk(join(vaultDir, d))]), ...(["Home.md"].map((f) => join(vaultDir, f)))];
  for (const abs of files) {
    const rel = relative(vaultDir, abs);
    if (SKIP_NOTE.test(rel)) continue;
    const raw = readText(abs);
    if (!raw.trim()) continue;
    let date = "";
    try { date = day(statSync(abs).mtimeMs); } catch { /* no date */ }
    const front = raw.match(/^---\n([\s\S]*?)\n---\n/);
    const title = front?.[1].match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? rel.replace(/\.md$/, "").split("/").pop();
    const body = front ? raw.slice(front[0].length) : raw;
    body.split(/^(?=#{1,3} )/m).forEach((section, si) => {
      const heading = section.match(/^#{1,3} (.+)$/m)?.[1]?.trim() ?? "";
      const text = squash(section.replace(/^#{1,3} .+$/m, ""));
      if (text.length < 20) return;
      splitLong(`${title}${heading && heading !== title ? ` / ${heading}` : ""}: ${text}`).forEach((part, pi) => out.push(chunk(`note:${rel}:${si}:${pi}`, part, `vault/${rel}${heading ? `#${heading}` : ""}`, date, "note")));
    });
  }
  return out;
}

/** All curated chunks, de-duplicated by text. */
export function collectCurated({ vaultDir, workspaceDir, controlledDir }) {
  const all = [...fromDeclaredFacts(controlledDir), ...fromUserMd(workspaceDir), ...fromRoutines(controlledDir), ...fromLearningAttempts(controlledDir), ...fromPlaces(controlledDir), ...fromVault(vaultDir)];
  const seen = new Set();
  return all.filter((c) => c.text && !seen.has(c.text) && seen.add(c.text));
}
