// Latency statistics over the plugin's routing log rows (their `lat` object). Numbers only; no message text is read.
/** Exactly the plugin's own "internal session" test (plugin/orion-control/src/local-routing.ts INTERNAL). */
export const INTERNAL_KEY = /\b(?:cron|heartbeat|doctor|test|subagent|eval)\b/i;
/** Optional extra filter (--exclude-sweeps): live sweep and probe sessions, matched on the key prefix only. */
export const SWEEP_KEY = /orion-(?:chat-sweep-|probe)/i;
export const MAX_SEGMENT_MS = 10 * 60_000;
export const SEGMENTS = ["resolveMs", "chainMs", "deskMs", "buildMs", "brainWaitMs", "buildToFinalMs", "finalizeMs", "turnMs"];
export const LABELS = { buildToFinalMs: "buildToFinalMs (last pass)" };

/** Percentile by nearest rank over a sorted copy; undefined for an empty list. */
export function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** Parses routing-log text; a bad line is skipped. */
export function parseRows(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return rows;
}

const segmentValues = (t) => [...Object.entries(t.lat ?? {}).filter(([k, v]) => k.endsWith("Ms") && typeof v === "number"), ["turnMs", t.turnMs]].filter(([, v]) => typeof v === "number");
const isSane = (t) => segmentValues(t).every(([, v]) => v >= 0 && v <= MAX_SEGMENT_MS);

/**
 * Real turns: closing rows with `lat` (not stage rows), not an internal session. A turn is keyed by its runId (fallback sessionKey + at);
 * a turn with several finalize rows is counted once, by its LAST row, so buildToFinalMs and passes describe the last pass.
 * Rows with a negative or > 10 min segment are dropped and counted in `dropped`. Returns { turns, dropped }.
 */
export function realTurns(rows, { last = 100, excludeSweeps = false } = {}) {
  const byTurn = new Map();
  for (const r of rows) {
    if (!r || typeof r !== "object" || !r.lat || typeof r.lat !== "object" || r.stage) continue;
    const key = String(r.sessionKey ?? "");
    if (INTERNAL_KEY.test(key) || (excludeSweeps && SWEEP_KEY.test(key))) continue;
    const id = r.runId ?? `${key}@${r.at ?? ""}`;
    byTurn.delete(id); byTurn.set(id, r);   // last row wins, ordered by its position
  }
  const all = [...byTurn.values()];
  const turns = all.filter(isSane);
  return { turns: turns.slice(-Math.max(1, last)), dropped: all.length - turns.length };
}

export function summarize(turns, dropped = 0) {
  const segments = {};
  for (const name of SEGMENTS) {
    const values = turns.map((t) => (name === "turnMs" ? t.turnMs : t.lat?.[name])).filter((v) => typeof v === "number");
    segments[name] = { n: values.length, median: percentile(values, 0.5), p90: percentile(values, 0.9) };
  }
  const asked = turns.filter((t) => t.lat?.desk && t.lat.desk !== "skipped");
  const share = (count, total) => (total ? count / total : 0);
  return {
    turns: turns.length,
    dropped,
    segments,
    deskAsked: asked.length,
    deskTimeoutShare: share(asked.filter((t) => t.lat.desk === "timeout").length, asked.length),
    deskSkippedShare: share(turns.filter((t) => t.lat?.desk === "skipped").length, turns.length),
    rewriteShare: share(turns.filter((t) => (t.lat?.passes ?? t.passes ?? 0) > 0).length, turns.length),
  };
}

const ms = (v) => (v === undefined ? "-" : String(Math.round(v)));
export function format(summary) {
  const lines = [`real turns: ${summary.turns} (dropped ${summary.dropped ?? 0} with a negative or >10 min segment)`, "segment                      n   median_ms   p90_ms"];
  for (const [name, s] of Object.entries(summary.segments)) lines.push(`${(LABELS[name] ?? name).padEnd(26)} ${String(s.n).padStart(4)} ${ms(s.median).padStart(10)} ${ms(s.p90).padStart(9)}`);
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  lines.push(`front desk asked: ${summary.deskAsked} of ${summary.turns} (skipped ${pct(summary.deskSkippedShare)})`);
  lines.push(`front desk timeout share (of asked): ${pct(summary.deskTimeoutShare)}`);
  lines.push(`turns needing rewrites: ${pct(summary.rewriteShare)}`);
  return lines.join("\n");
}
