// The day's real conversations, summarised by CODE (counts, topics by tool/route, verbatim only for explicit "remember" facts).
// No model call: a journal that needs a model stops the night the model is down. Real sessions only, defined positively by
// the owner session keys (../memory/real-session.mjs); every other key is skipped. Transcripts listed in sessions.json are
// read, and so are transcripts modified that day that have dropped out of it (the key is then read from the sibling
// `<id>.trajectory.jsonl` header, or the transcript's own first line); a transcript whose key cannot be found is skipped.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { isRealSession } from "../memory/real-session.mjs";

const localDay = (ms) => new Date(ms).toLocaleDateString("en-CA");
const clock = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const REMEMBER = /^\s*(?:please\s+|hey\s+|orion[,:]?\s+)*(?:remember|don'?t forget|keep in mind)\b[\s,:-]*(?:that\s+)?(.{3,400})$/is;

/** Nick's words only: the transports prepend context blocks before a marker line. */
export function ownerText(content) {
  const raw = Array.isArray(content) ? content.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : String(content ?? "");
  const marks = ["User message:\n", "--- Nick's message follows ---\n"];
  const cut = marks.map((m) => raw.lastIndexOf(m) < 0 ? -1 : raw.lastIndexOf(m) + m.length).reduce((a, b) => Math.max(a, b), -1);
  return (cut >= 0 ? raw.slice(cut) : raw).trim();
}

const assistantText = (content) => (Array.isArray(content) ? content.filter((p) => p?.type === "text").map((p) => p.text).join(" ") : String(content ?? "")).trim();
const topicOf = (call) => {
  const script = String(call?.arguments?.command ?? "").match(/\b(orion-[a-z][a-z-]*)/)?.[1];
  return script ?? call?.name ?? "tool";
};

/** The first line of a file, read without loading the whole thing (transcripts can be large). */
function firstLine(file, max = 64 * 1024) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString("utf8").split("\n")[0];
  } catch { return ""; } finally { if (fd !== undefined) closeSync(fd); }
}

const keyIn = (line) => { try { const k = JSON.parse(line)?.sessionKey; return typeof k === "string" ? k : null; } catch { return null; } };

/** The session key of a transcript that is not in sessions.json, or null. */
export function transcriptKey(sessionsDir, name) {
  const id = name.slice(0, -".jsonl".length);
  return keyIn(firstLine(join(sessionsDir, `${id}.trajectory.jsonl`))) ?? keyIn(firstLine(join(sessionsDir, name)));
}

const modifiedOn = (file, day) => { try { return localDay(statSync(file).mtimeMs) === day; } catch { return false; } };

/** Real session files touched on `day`: [{ key, file }]. Indexed ones first, then dropped-out transcripts from that day. */
export function realSessions(sessionsDir, day, { isReal = isRealSession } = {}) {
  let index = {};
  try { index = JSON.parse(readFileSync(join(sessionsDir, "sessions.json"), "utf8")) ?? {}; } catch { /* no index: scan only */ }
  const indexed = Object.entries(index).flatMap(([key, v]) => {
    if (!isReal(key) || !v) return [];
    const file = join(sessionsDir, basename(String(v.sessionFile ?? `${v.sessionId}.jsonl`)));
    return existsSync(file) ? [{ key, file }] : [];
  });
  const seen = new Set(indexed.map((s) => s.file));
  let names = [];
  try { names = readdirSync(sessionsDir); } catch { return indexed; }
  const dropped = names
    .filter((n) => n.endsWith(".jsonl") && !n.endsWith(".trajectory.jsonl") && !seen.has(join(sessionsDir, n)))
    .filter((n) => modifiedOn(join(sessionsDir, n), day))
    .flatMap((n) => { const key = transcriptKey(sessionsDir, n); return key && isReal(key) ? [{ key, file: join(sessionsDir, n) }] : []; });
  return [...indexed, ...dropped];
}

/** @returns { turns, replies, sessions, first, last, topics: [name, count][], untooled, remembered: string[], lines: string[] } */
export function summariseConversations({ sessionsDir, day }) {
  const topics = new Map();
  const remembered = [];
  let turns = 0, replies = 0, untooled = 0, first = null, last = null, sessions = 0;
  for (const { file } of realSessions(sessionsDir, day)) {
    try { if (localDay(statSync(file).mtimeMs) < day) continue; } catch { continue; }
    let touched = false, pendingTools = 0, open = false;
    const closeTurn = () => { if (open && pendingTools === 0) untooled += 1; open = false; pendingTools = 0; };
    for (const line of readFileSync(file, "utf8").split("\n")) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const at = Date.parse(o?.timestamp);
      if (o?.type !== "message" || Number.isNaN(at) || localDay(at) !== day) continue;
      const m = o.message ?? {};
      if (m.role === "user") {
        closeTurn();
        const said = ownerText(m.content);
        if (!said) continue;
        touched = true; turns += 1; open = true;
        first = first === null ? at : Math.min(first, at); last = last === null ? at : Math.max(last, at);
        const fact = said.match(REMEMBER)?.[1]?.replace(/\s+/g, " ").trim();
        if (fact && !remembered.includes(fact)) remembered.push(fact);
      } else if (m.role === "assistant") {
        if (assistantText(m.content)) { replies += 1; touched = true; }
        for (const p of Array.isArray(m.content) ? m.content : []) if (p?.type === "toolCall") { pendingTools += 1; const t = topicOf(p); topics.set(t, (topics.get(t) ?? 0) + 1); }
      }
    }
    closeTurn();
    if (touched) sessions += 1;
  }
  const ranked = [...topics].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const lines = turns === 0 ? [] : [
    "## Conversations",
    "",
    `- ${turns} message${turns === 1 ? "" : "s"} from Nick, ${replies} repl${replies === 1 ? "y" : "ies"} from ORION, across ${sessions} session${sessions === 1 ? "" : "s"} (${clock(first)}–${clock(last)}).`,
    ranked.length ? `- Tools and routes used: ${ranked.slice(0, 10).map(([n, c]) => `${n} ×${c}`).join(", ")}.` : "- No tools used.",
    ...(untooled > 0 && ranked.length ? [`- ${untooled} turn${untooled === 1 ? "" : "s"} answered in conversation with no tool.`] : []),
    ...(remembered.length ? ["- Asked to remember (his words):", ...remembered.slice(0, 10).map((f) => `  - ${f}`)] : []),
    "",
  ];
  return { turns, replies, sessions, first, last, topics: ranked, untooled, remembered, lines };
}
