import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { ownerText, summariseConversations } from "../scripts/lib/journal/conversations.mjs";

const root = new URL("..", import.meta.url).pathname;
const DAY = "2026-11-10";
const at = (hhmm) => new Date(`${DAY}T${hhmm}:00`).toISOString();
const msg = (role, content, hhmm) => JSON.stringify({ type: "message", timestamp: at(hhmm), message: { role, content } });

function sessions({ withDropped = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orion-journal-"));
  const sdir = join(dir, ".openclaw/agents/main/sessions");
  mkdirSync(sdir, { recursive: true });
  const real = [
    msg("user", "[ctx]\nUser message:\nremember that my locker number is 41", "09:00"),
    msg("assistant", [{ type: "text", text: "Saved." }], "09:00"),
    msg("user", "[ctx]\n--- Nick's message follows ---\nmove gym to after dinner", "10:30"),
    msg("assistant", [{ type: "toolCall", name: "exec", arguments: { command: "/x/scripts/orion-reschedule move gym" } }], "10:30"),
    msg("assistant", [{ type: "text", text: "Done." }], "10:31"),
    msg("user", "thanks", "11:00"),
    msg("assistant", [{ type: "text", text: "Any time." }], "11:00"),
    msg("user", "an old message", "09:00").replace(DAY, "2026-11-09"),
  ].join("\n");
  const junk = [msg("user", "JUNK-PROBE-TEXT remember that junk", "12:00"), msg("assistant", [{ type: "text", text: "ok" }], "12:00")].join("\n");
  const files = { "real.jsonl": real, "gate.jsonl": junk, "sweep.jsonl": junk, "cron.jsonl": junk };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(sdir, name), body);
  const noon = new Date(`${DAY}T13:00:00`);
  for (const name of Object.keys(files)) utimesSync(join(sdir, name), noon, noon);
  // Transcripts that dropped out of sessions.json: the key is in the sibling trajectory file's first line.
  if (withDropped) {
  const header = (key) => `${JSON.stringify({ type: "session.started", sessionId: "x", sessionKey: key })}\n`;
  const dropped = [msg("user", "User message:\nwhat's on tomorrow", "15:00"), msg("assistant", [{ type: "text", text: "Two lectures." }], "15:00"),
    msg("user", "and friday", "15:05")].join("\n");
  writeFileSync(join(sdir, "dropped-real.jsonl"), dropped);
  writeFileSync(join(sdir, "dropped-real.trajectory.jsonl"), header("agent:main:orion-app-v2"));
  writeFileSync(join(sdir, "dropped-junk.jsonl"), junk);
  writeFileSync(join(sdir, "dropped-junk.trajectory.jsonl"), header("agent:main:orion-chat-longc"));
  writeFileSync(join(sdir, "dropped-nokey.jsonl"), junk);
  writeFileSync(join(sdir, "old-real.jsonl"), dropped);
  writeFileSync(join(sdir, "old-real.trajectory.jsonl"), header("agent:main:orion-app-v2"));
  for (const name of ["dropped-real.jsonl", "dropped-junk.jsonl", "dropped-nokey.jsonl"]) utimesSync(join(sdir, name), noon, noon);
  const before = new Date(`2026-11-08T13:00:00`);
  utimesSync(join(sdir, "old-real.jsonl"), before, before);
  }
  writeFileSync(join(sdir, "sessions.json"), JSON.stringify({
    "agent:main:orion-app-v2": { sessionId: "real", sessionFile: "/elsewhere/real.jsonl" },
    "agent:main:orion-chat-gate-1110-1": { sessionId: "gate" },
    "agent:main:orion-chat-sweep-1110c": { sessionId: "sweep" },
    "agent:main:cron:nightly": { sessionId: "cron" },
    "agent:main:orion-chat-longc": { sessionId: "gate" },
  }));
  return { dir, sdir };
}

test("ownerText strips the transport context and keeps only Nick's words", () => {
  assert.equal(ownerText("[ctx]\nUser message:\nhello"), "hello");
  assert.equal(ownerText("a\n--- Nick's message follows ---\nhi there"), "hi there");
  assert.equal(ownerText([{ type: "text", text: "plain" }]), "plain");
});

test("summary counts real sessions only, topics by tool, verbatim only for remember facts", () => {
  const w = sessions();
  try {
    const s = summariseConversations({ sessionsDir: w.sdir, day: DAY });
    assert.equal(s.turns, 3);
    assert.equal(s.replies, 3);
    assert.equal(s.sessions, 1);
    assert.deepEqual(s.topics, [["orion-reschedule", 1]]);
    assert.deepEqual(s.remembered, ["my locker number is 41"]);
    const text = s.lines.join("\n");
    assert.match(text, /3 messages from Nick, 3 replies from ORION, across 1 session/);
    assert.match(text, /orion-reschedule ×1/);
    assert.match(text, /my locker number is 41/);
    assert.ok(!text.includes("JUNK-PROBE-TEXT"), "junk sessions excluded");
    assert.ok(!text.includes("move gym"), "ordinary owner turns are not quoted");
    assert.ok(!text.includes("an old message"), "other days excluded");
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("a real transcript missing from sessions.json is still counted; junk, keyless and other-day ones are not", () => {
  const w = sessions({ withDropped: true });
  try {
    const s = summariseConversations({ sessionsDir: w.sdir, day: DAY });
    assert.equal(s.turns, 5, "3 from the indexed session + 2 from the dropped one");
    assert.equal(s.sessions, 2);
    assert.ok(!s.lines.join("\n").includes("JUNK-PROBE-TEXT"));
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test("a day whose only sessions are look-alike or shell-text keys writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "orion-journal-junk-"));
  try {
    const line = msg("user", "User message:\nhello", "09:00");
    for (const [key, id] of [["agent:main:orion-chat-longc", "a"], ["agent:main:sh -c 'echo hi'", "b"]]) writeFileSync(join(dir, `${id}.jsonl`), line);
    writeFileSync(join(dir, "sessions.json"), JSON.stringify({ "agent:main:orion-chat-longc": { sessionId: "a" }, "agent:main:sh -c 'echo hi'": { sessionId: "b" } }));
    const noon = new Date(`${DAY}T13:00:00`);
    for (const id of ["a", "b"]) utimesSync(join(dir, `${id}.jsonl`), noon, noon);
    const s = summariseConversations({ sessionsDir: dir, day: DAY });
    assert.equal(s.turns, 0);
    assert.deepEqual(s.lines, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no sessions file or no turns gives an empty section, never a throw", () => {
  assert.deepEqual(summariseConversations({ sessionsDir: "/nonexistent-sessions", day: DAY }).lines, []);
});

test("orion-daily writes a journal with a Conversations section even when the ledger is empty, and keeps existing notes", () => {
  const w = sessions();
  try {
    const mem = join(w.dir, ".openclaw/workspace/memory");
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, `${DAY}.md`), "# note\n\nORION wrote this himself.\n");
    const env = { ...process.env, HOME: w.dir, ORION_SESSIONS_DIR: w.sdir };
    const out = execFileSync(process.execPath, [join(root, "scripts/orion-daily"), DAY], { env, encoding: "utf8" });
    assert.match(out, /3 conversation turns/);
    const text = readFileSync(join(mem, `${DAY}.md`), "utf8");
    assert.match(text, /ORION wrote this himself/);
    assert.match(text, /No task-graph actions in the ledger today/);
    assert.match(text, /## Conversations/);
    assert.match(text, /my locker number is 41/);
    execFileSync(process.execPath, [join(root, "scripts/orion-daily"), DAY], { env, encoding: "utf8" });
    assert.equal(readFileSync(join(mem, `${DAY}.md`), "utf8").match(/## Conversations/g).length, 1, "rerun replaces the block");
    const quiet = execFileSync(process.execPath, [join(root, "scripts/orion-daily"), "2026-01-01"], { env, encoding: "utf8" });
    assert.match(quiet, /no summary written/);
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});
