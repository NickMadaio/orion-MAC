import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  decideApproveCaller, readCallerContext, parsePsTable, ORION_APP_PATH, TERMINAL_HOSTS,
} from "../scripts/lib/approve-caller.mjs";

const TERMINAL_PATH = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";
const CODE_HELPER = "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper";
const GATEWAY = "/opt/node/bin/node /opt/node/lib/node_modules/openclaw/dist/index.js gateway --port 1";

const proc = (pid, ppid, comm, { stat = "S", tty = "ttys001", command = comm } = {}) => ({ pid, ppid, stat, tty, comm, command });
// A genuine Terminal tab: Terminal -> login (session leader) -> -zsh -> node orion-approve.
const terminal = proc(19, 1, TERMINAL_PATH, { tty: "??" });
const login = proc(20, 19, "login", { stat: "Ss", command: "login -pfl nick /bin/bash -c exec -la zsh /bin/zsh" });
const zsh = proc(21, 20, "-zsh");
const self = proc(22, 21, "node", { stat: "S+", command: "node /x/scripts/orion-approve A-1" });
const ownerChain = [zsh, login, terminal];

/** Fake inspector: real executable path and signature answer per pid. */
function inspector(table, { realpath = (p) => p } = {}) {
  return {
    executablePath: (pid) => table[pid]?.path ?? null,
    satisfies: (pid, requirement) => (typeof table[pid]?.ok === "function" ? table[pid].ok(requirement) : Boolean(table[pid]?.ok)),
    realpath,
  };
}
const genuine = inspector({ 19: { path: TERMINAL_PATH, ok: true }, 20: { path: "/usr/bin/login", ok: true }, 21: { path: "/bin/zsh", ok: true } });
const tty = { stdinTTY: true, stdoutTTY: true };
const decide = (over = {}) => decideApproveCaller({ env: {}, self, chain: ownerChain, inspect: genuine, ...tty, ...over });

/* ------------------------------------------------------------ terminal route */

test("owner in a genuine Terminal tab is allowed", () => {
  assert.deepEqual([decide().allow, decide().via], [true, "tty"]);
});
test("a shell leader under a verified terminal host (VS Code helper) and an ssh login are allowed", () => {
  const helper = proc(40, 1, CODE_HELPER, { tty: "??" });
  const leader = proc(41, 40, "/bin/zsh", { stat: "Ss", command: "/bin/zsh -l" });
  const d = decide({ self: proc(42, 41, "node"), chain: [leader, helper],
    inspect: inspector({ 40: { path: CODE_HELPER, ok: true }, 41: { path: "/bin/zsh", ok: true } }) });
  assert.equal(d.allow, true, d.reason);
  const sshd = proc(50, 1, "/usr/libexec/sshd-session", { tty: "??" });
  const remote = proc(51, 50, "-zsh", { stat: "Ss" });
  assert.equal(decide({ self: proc(52, 51, "node"), chain: [remote, sshd],
    inspect: inspector({ 50: { path: "/usr/libexec/sshd-session", ok: true }, 51: { path: "/bin/zsh", ok: true } }) }).allow, true);
});
test("REVIEW EXPLOIT: orphaned to launchd with a pty from script(1) is refused", () => {
  // (sh -c 'unset OPENCLAW_SHELL; exec script -q /dev/null orion-approve X' &): node is its own session leader under script, under launchd.
  const script = proc(60, 1, "script", { tty: "??", command: "script -q /dev/null orion-approve X" });
  const orphan = proc(61, 60, "node", { stat: "Ss+", tty: "ttys009" });
  const d = decide({ self: orphan, chain: [script], inspect: inspector({ 60: { path: "/usr/bin/script", ok: true } }) });
  assert.equal(d.allow, false);
});
test("an orphan with a TTY and an empty chain is refused", () => {
  const d = decide({ self: proc(70, 1, "node", { stat: "Ss+", tty: "ttys009" }), chain: [] });
  assert.equal(d.allow, false);
  assert.match(d.reason, /terminal/);
});
test("script, expect, unbuffer, python pty, osascript anywhere in the chain refuse, even under a real Terminal", () => {
  for (const [comm, command] of [["script", "script -q /dev/null x"], ["expect", "expect -c spawn"], ["unbuffer", "unbuffer x"],
    ["/usr/bin/python3", "python3 -c import pty; pty.spawn(['x'])"], ["osascript", "osascript -e x"], ["Python", "Python -c x"]]) {
    const wrapper = proc(30, 21, comm, { command });
    const d = decide({ self: proc(31, 30, "node"), chain: [wrapper, ...ownerChain] });
    assert.equal(d.allow, false, comm);
    assert.match(d.reason, /pty|terminal driver/, comm);
  }
});
test("a terminal host named by argv but not at the real path, or failing its signature, is refused", () => {
  const forgedPath = inspector({ 19: { path: "/private/var/tmp/Terminal", ok: true }, 20: { path: "/usr/bin/login", ok: true } });
  assert.equal(decide({ inspect: forgedPath }).allow, false);
  const badSig = inspector({ 19: { path: TERMINAL_PATH, ok: false }, 20: { path: "/usr/bin/login", ok: true } });
  assert.equal(decide({ inspect: badSig }).allow, false);
  const fakeLogin = inspector({ 19: { path: TERMINAL_PATH, ok: true }, 20: { path: "/private/tmp/login", ok: true } });
  assert.equal(decide({ inspect: fakeLogin }).allow, false);
});
test("the session leader must be a login shell or login, started by the host, on the same tty", () => {
  const nodeLeader = proc(20, 19, "node", { stat: "Ss" });
  assert.equal(decide({ chain: [zsh, nodeLeader, terminal], inspect: inspector({ 19: { path: TERMINAL_PATH, ok: true }, 20: { path: "/usr/local/bin/node", ok: true } }) }).allow, false);
  const launchdLeader = proc(20, 1, "-zsh", { stat: "Ss" });
  assert.equal(decide({ chain: [launchdLeader], inspect: inspector({ 20: { path: "/bin/zsh", ok: true } }) }).allow, false);
  assert.equal(decide({ self: { ...self, tty: "ttys002" } }).allow, false);
  assert.equal(decide({ self: { ...self, tty: "??" } }).allow, false);
});
test("a detached tmux server is not a terminal host", () => {
  const tmux = proc(80, 1, "tmux", { tty: "??", command: "tmux new -s a" });
  const leader = proc(81, 80, "-zsh", { stat: "Ss" });
  assert.equal(decide({ self: proc(82, 81, "node"), chain: [leader, tmux], inspect: inspector({ 80: { path: "/opt/homebrew/bin/tmux", ok: true }, 81: { path: "/bin/zsh", ok: true } }) }).allow, false);
});
test("one tty end only is not enough; no inspector fails closed", () => {
  assert.equal(decide({ stdoutTTY: false }).allow, false);
  assert.equal(decide({ stdoutTTY: false, requireStdoutTTY: false }).allow, true);
  assert.equal(decide({ inspect: undefined }).allow, false);
});

/* ----------------------------------------------------------------- app route */

const appParent = proc(5, 1, ORION_APP_PATH, { tty: "??" });
const appSelf = proc(6, 5, "node", { tty: "??", command: "node /x/scripts/orion-approve A-1" });
const appOk = inspector({ 5: { path: ORION_APP_PATH, ok: true } });
const decideApp = (over = {}) => decideApproveCaller({ env: { ORION_APPROVE_VIA: "app" }, self: appSelf, chain: [appParent], inspect: appOk, ...over });

test("the installed Orion app (exact path, launchd parent, signature) is allowed", () => {
  const d = decideApp();
  assert.deepEqual([d.allow, d.via], [true, "app"]);
});
test("the app binary at any other path is refused, even if argv claims /Applications", () => {
  for (const path of ["/private/tmp/x/Orion.app/Contents/MacOS/Orion", "/Volumes/X/Orion.app/Contents/MacOS/Orion"]) {
    assert.equal(decideApp({ inspect: inspector({ 5: { path, ok: true } }) }).allow, false, path);
  }
  assert.equal(decideApp({ inspect: appOk, chain: [{ ...appParent, comm: "/private/tmp/Orion.app/Contents/MacOS/Orion" }] }).allow, true, "argv is not consulted, the real path is");
});
test("the app with a wrong signature, a non-launchd parent, or a symlinked path is refused", () => {
  assert.equal(decideApp({ inspect: inspector({ 5: { path: ORION_APP_PATH, ok: false } }) }).allow, false);
  assert.equal(decideApp({ chain: [{ ...appParent, ppid: 777 }] }).allow, false);
  assert.equal(decideApp({ inspect: inspector({ 5: { path: ORION_APP_PATH, ok: true } }, { realpath: () => "/private/tmp/elsewhere/Orion" }) }).allow, false);
});
test("a forged ORION_APPROVE_VIA=app without the app as direct parent is refused", () => {
  assert.equal(decideApp({ chain: [proc(9, 5, "node x"), appParent] }).allow, false);
  assert.equal(decideApproveCaller({ env: { ORION_APPROVE_VIA: "app" }, self, chain: ownerChain, inspect: genuine }).allow, false);
});

/* ------------------------------------------------------- refusal layers 1-2 */

test("agent markers refuse even with a genuine terminal or app context", () => {
  for (const env of [{ OPENCLAW_SHELL: "exec" }, { OPENCLAW_SERVICE_MARKER: "openclaw" }, { OPENCLAW_MCP_SESSION_KEY: "k" }]) {
    assert.equal(decide({ env }).allow, false);
    assert.equal(decideApp({ env: { ...env, ORION_APPROVE_VIA: "app" } }).allow, false);
  }
  assert.equal(decide({ env: { OPENCLAW_SHELL: "tui-local" } }).allow, true);
});
test("a gateway, remote bridge or agent CLI ancestor refuses even inside a genuine terminal", () => {
  for (const command of [GATEWAY, "node /x/orion-remote/scripts/orion-remote-bridge run", "/x/openclaw agent --session-key s"]) {
    const d = decide({ chain: [proc(30, 21, "node", { command }), ...ownerChain] });
    assert.equal(d.allow, false, command);
    assert.match(d.reason, /agent runtime/);
  }
});
test("unreadable ancestry and no arguments fail closed; refusal names the owner paths", () => {
  assert.match(decide({ chain: null }).reason, /could not be read/);
  assert.equal(decideApproveCaller().allow, false);
  const { reason } = decideApproveCaller({ env: { OPENCLAW_SHELL: "exec" } });
  assert.match(reason, /cannot be run by ORION/);
  assert.match(reason, /Allow button/);
});
test("TERMINAL_HOSTS are absolute paths with a signature requirement each", () => {
  for (const host of TERMINAL_HOSTS) {
    assert.ok(host.path.startsWith("/"), host.path);
    assert.match(host.requirement, /anchor apple/);
  }
});

/* ------------------------------------------------------- reading the table */

test("parsePsTable and readCallerContext walk injected rows, nearest first, stop on loops", () => {
  const rows = parsePsTable(
    "   10     9 S+   ttys001  node\n    9     8 Ss   ttys001  -zsh\n    8     1 S    ??       /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal\n",
    "   10 node /x/orion-approve\n    9 -zsh\n    8 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal\n");
  const context = readCallerContext(10, rows);
  assert.equal(context.self.tty, "ttys001");
  assert.deepEqual(context.chain.map((p) => p.pid), [9, 8]);
  assert.equal(context.chain[0].stat, "Ss");
  assert.equal(readCallerContext(10, null), null);
  assert.equal(readCallerContext(99, rows), null);
  const loop = parsePsTable("1000 1001 S ?? a\n1001 1000 S ?? b\n", "1000 a\n1001 b\n");
  assert.ok(readCallerContext(1000, loop).chain.length <= 2);
});

/* ------------------------------------- the real entry, under a fake gateway */

test("REAL ENTRY: orion-approve under a gateway-shaped ancestor exits 3 and never reaches the grant path", { skip: process.platform === "darwin" ? false : "reads macOS ps columns" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "approve-entry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sentinel = join(dir, "REACHED");
  // Any import of lib/orion-plugin.mjs (the only route to grant()) is redirected to a stub that leaves a sentinel.
  writeFileSync(join(dir, "stub.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "reached");\nexport const PATHS = {};\nexport async function loadPlugin() { process.exit(97); }\n`);
  writeFileSync(join(dir, "hooks.mjs"), `export async function resolve(specifier, context, next) {\n  if (specifier.endsWith("orion-plugin.mjs")) return { url: ${JSON.stringify(pathToFileURL(join(dir, "stub.mjs")).href)}, shortCircuit: true };\n  return next(specifier, context);\n}\n`);
  writeFileSync(join(dir, "register.mjs"), `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(join(dir, "hooks.mjs")).href)});\n`);
  // The parent's command line is what a gateway's looks like: node .../openclaw/dist/index.js gateway.
  mkdirSync(join(dir, "openclaw/dist"), { recursive: true });
  const approve = new URL("../scripts/orion-approve", import.meta.url).pathname;
  writeFileSync(join(dir, "openclaw/dist/index.js"), `const { spawnSync } = require("node:child_process");\nconst r = spawnSync(process.execPath, ["--import", ${JSON.stringify(join(dir, "register.mjs"))}, ${JSON.stringify(approve)}, "A-TEST"], { encoding: "utf8", env: { ...process.env, ORION_APPROVE_VIA: "app", HOME: ${JSON.stringify(dir)} } });\nprocess.stdout.write(JSON.stringify({ status: r.status, stderr: r.stderr }));\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OPENCLAW_")));
  const run = spawnSync(process.execPath, [join(dir, "openclaw/dist/index.js"), "gateway", "--port", "1"], { encoding: "utf8", env });
  const child = JSON.parse(run.stdout);
  assert.equal(child.status, 3, child.stderr);
  assert.match(child.stderr, /agent runtime/);
  assert.equal(existsSync(sentinel), false, "the grant path was reached");
  // Control: the same hook DOES catch an import of orion-plugin.mjs, so the absence above means something.
  writeFileSync(join(dir, "control.mjs"), `await import(${JSON.stringify(new URL("../scripts/lib/orion-plugin.mjs", import.meta.url).href)});\n`);
  spawnSync(process.execPath, ["--import", join(dir, "register.mjs"), join(dir, "control.mjs")], { encoding: "utf8" });
  assert.equal(existsSync(sentinel), true, "the sentinel hook is live");
});
