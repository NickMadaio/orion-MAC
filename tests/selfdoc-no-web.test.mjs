// TOOLS.md must not promise web search/fetch: config denies web tools to every Ollama model and ORION is local-only (review 2026-11-16).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

function generate(toolsConfig) {
  const home = mkdtempSync(join(tmpdir(), "selfdoc-"));
  mkdirSync(join(home, ".openclaw/workspace"), { recursive: true });
  mkdirSync(join(home, ".openclaw/orion-controlled"), { recursive: true });
  mkdirSync(join(home, "Desktop"), { recursive: true });
  symlinkSync(repo, join(home, "Desktop/ORION"));
  writeFileSync(join(home, ".openclaw/openclaw.json"), JSON.stringify({ tools: toolsConfig, plugins: { entries: { "orion-control": { config: {} } } } }));
  const r = spawnSync(process.execPath, [join(repo, "scripts/orion-selfdoc")], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  return { r, text: readFileSync(join(home, ".openclaw/workspace/TOOLS.md"), "utf8") };
}

test("TOOLS.md never promises web_search or web_fetch, even when the coding profile would allow web", () => {
  const { text } = generate({ profile: "coding" });
  assert.doesNotMatch(text, /`web_search` finds|`web_fetch` reads/);
  assert.match(text, /Web access is not available/i);
});

test("with web denied, the same plain statement", () => {
  const { text } = generate({ profile: "coding", deny: ["group:web"] });
  assert.doesNotMatch(text, /`web_search` finds/);
  assert.match(text, /Web access is not available/i);
});
