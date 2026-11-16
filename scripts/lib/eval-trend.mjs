// Pure helpers for orion-eval-trend. Rows hold counts, rates, timings, a short commit hash, a date, a kind and a short note.
// Never message text, names or paths.
export const KINDS = ["replay", "parser", "live"];
const NUM = { replay: ["cases", "pass", "fail", "xfail", "xpass", "skip", "durationMs"], parser: ["exact", "writeWrong", "clarify", "p50Ms"], live: ["pass", "total"] };
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clean = (s, n = 160) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const NOTE_MAX = 120;

/** Reject notes that would leak into the public file. Returns the trimmed, capped note or throws. */
export function cleanNote(note) {
  const t = clean(note, NOTE_MAX);
  const full = String(note ?? "");
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(full)) throw new Error("note contains an email address");
  if (/(\/Users\/|\/home\/|~\/)/.test(full)) throw new Error("note contains a path under a home directory");
  for (const m of full.matchAll(/["\u201c]([^"\u201d]+)["\u201d]|(?:^|\s)'([^']+)'(?=\s|$|[.,;])/g)) {
    if ((m[1] ?? m[2]).trim().split(/\s+/).length > 5) throw new Error("note quotes more than 5 words (message text must not be recorded)");
  }
  return t;
}

/** Build a validated row, or throw. Drops anything not in the schema. */
export function makeRow(kind, fields, { commit = "", date = new Date().toISOString().slice(0, 10), note = "", dirty = false } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown kind "${kind}" (use ${KINDS.join(", ")})`);
  const row = { date, kind, commit: clean(commit, 12) };
  if (dirty === true) row.dirty = true;
  for (const k of NUM[kind]) {
    if (fields[k] === undefined) continue;
    if (!isNum(fields[k])) throw new Error(`${kind}: ${k} must be a number`);
    row[k] = fields[k];
  }
  if (kind === "replay") {
    if (!isNum(row.cases)) throw new Error("replay: cases is required");
    row.failing = (fields.failing ?? []).map((x) => clean(x, 80)).filter(Boolean);
  }
  if (kind === "parser") for (const k of ["exact", "writeWrong", "clarify"]) if (!isNum(row[k])) throw new Error(`parser: ${k} is required`);
  if (kind === "live") {
    if (!isNum(row.pass) || !isNum(row.total) || row.total <= 0 || row.pass > row.total) throw new Error("live: need --pass N --total M with 0 <= N <= M, M > 0");
    row.cases = row.total;
  }
  row.note = cleanNote(note);
  return row;
}

export const appendRow = (rows, row) => [...rows, row];
export const serialize = (row) => JSON.stringify(row);

const REQUIRED = { replay: ["cases", "pass", "fail"], parser: ["exact", "writeWrong", "clarify"], live: ["pass", "total"] };
const usable = (r) => KINDS.includes(r.kind) && REQUIRED[r.kind].every((k) => isNum(r[k]));

/** Parse JSONL, skipping blank, malformed or kind-less lines. Returns { rows, skipped }. */
export function parseRows(text) {
  const rows = []; let skipped = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r === "object" && usable(r)) rows.push(r); else skipped++; } catch { skipped++; }
  }
  return { rows, skipped };
}

export const lastRows = (rows, kind, n = 10) => rows.filter((r) => r.kind === kind).slice(-n);

const corpus = (r) => (r.kind === "replay" ? r.cases : r.kind === "live" ? r.total : undefined);
export const corpusChanged = (prev, cur) => Boolean(prev) && corpus(prev) !== undefined && corpus(cur) !== undefined && corpus(prev) !== corpus(cur);

/** Higher-is-better headline per kind. */
export function score(r) {
  if (r.kind === "replay") return isNum(r.cases) && r.cases > 0 ? ((r.pass ?? 0) / r.cases) * 100 : undefined;
  if (r.kind === "live") return isNum(r.total) && r.total > 0 ? (r.pass / r.total) * 100 : undefined;
  return r.exact;
}

/** Compare a row with the previous one of its kind. verdict: BETTER | WORSE | SAME | FIRST. */
export function delta(prev, cur) {
  if (!prev) return { verdict: "FIRST", corpusChanged: false, change: {} };
  const change = {};
  for (const k of NUM[cur.kind]) if (isNum(cur[k]) && isNum(prev[k])) change[k] = Math.round((cur[k] - prev[k]) * 100) / 100;
  let verdict = "SAME";
  if (cur.kind === "replay") {
    const same = !corpusChanged(prev, cur);
    const failD = (cur.fail ?? 0) - (prev.fail ?? 0);
    const passD = (cur.pass ?? 0) - (prev.pass ?? 0);
    if (failD > 0 || (same && passD < 0)) verdict = "WORSE";
    else if (failD < 0 || (same && passD > 0)) verdict = "BETTER";
  } else if (cur.kind === "parser") {
    const s = (cur.exact - prev.exact) - (cur.writeWrong - prev.writeWrong);
    verdict = Math.abs(s) < 0.05 ? "SAME" : s > 0 ? "BETTER" : "WORSE";
  } else {
    const a = score(cur), b = score(prev);
    verdict = a === undefined || b === undefined || Math.abs(a - b) < 0.05 ? "SAME" : a > b ? "BETTER" : "WORSE";
  }
  return { verdict, corpusChanged: corpusChanged(prev, cur), change };
}

/** check: exit code 1 if the latest replay row has more failures, fewer passes, or a new failing id vs the previous one. */
export function check(rows, skipped = 0) {
  const sk = skipped ? ` (${skipped} unreadable line(s) skipped)` : "";
  const rs = rows.filter((r) => r.kind === "replay");
  const latest = rs[rs.length - 1];
  if (latest && latest.fail > 0) return { code: 1, reason: `latest replay has ${latest.fail} failing case(s): ${(latest.failing ?? []).join(" ") || "ids not recorded"}${sk}` };
  if (rs.length < 2) return { code: 0, reason: `fewer than two replay rows: nothing to compare${sk}` };
  const prev = rs[rs.length - 2], cur = rs[rs.length - 1];
  const newFails = (cur.failing ?? []).filter((id) => !(prev.failing ?? []).includes(id));
  const d = delta(prev, cur);
  if (d.verdict === "WORSE" || newFails.length) {
    return { code: 1, reason: `${sk}replay got worse: fail ${prev.fail} -> ${cur.fail}, pass ${prev.pass} -> ${cur.pass}${newFails.length ? `, new failing: ${newFails.join(" ")}` : ""}` };
  }
  return { code: 0, reason: `replay ${d.verdict}${d.corpusChanged ? " (corpus size changed)" : ""}${sk}` };
}

const f = (v, w) => String(v ?? "-").padStart(w);
const sg = (v) => (v === undefined ? "" : ` (${v > 0 ? "+" : ""}${v})`);

export function formatTable(rows, kind, n = 10) {
  const sel = rows.filter((r) => r.kind === kind);
  const shown = sel.slice(-n);
  if (!shown.length) return `${kind}: no rows yet`;
  const out = [`== ${kind} (last ${shown.length} of ${sel.length}) ==`];
  shown.forEach((r, i) => {
    const prev = sel[sel.length - shown.length + i - 1];
    const d = delta(prev, r);
    let body;
    if (kind === "replay") body = `cases ${f(r.cases, 3)}  pass ${f(r.pass, 3)}${sg(d.change.pass)}  fail ${f(r.fail, 2)}${sg(d.change.fail)}  xfail ${f(r.xfail, 2)}  ${f(Math.round((r.durationMs ?? 0) / 100) / 10, 5)}s`;
    else if (kind === "parser") body = `exact ${f(r.exact, 5)}%${sg(d.change.exact)}  wrong ${f(r.writeWrong, 5)}%${sg(d.change.writeWrong)}  clarify ${f(r.clarify, 5)}%  p50 ${f(r.p50Ms, 5)}ms`;
    else body = `pass ${f(r.pass, 3)}/${f(r.total, 3)}${sg(d.change.pass)}`;
    out.push(`${r.date} ${f((r.commit || "-") + (r.dirty ? "*" : ""), 8)}  ${body}  ${d.verdict.padEnd(6)}${d.corpusChanged ? "  [CORPUS CHANGED]" : ""}${r.note ? `  ${r.note}` : ""}`);
  });
  const last = delta(sel[sel.length - 2], sel[sel.length - 1]);
  out.push(`latest: ${last.verdict}${last.corpusChanged ? " (corpus size changed: do not read as quality)" : ""}`);
  return out.join("\n");
}
