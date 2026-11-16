/*
 Who is calling an owner-only program? Decide it from what the kernel says,
 not from what the caller says.

 The grant is the one act ORION must not perform. orion-approve is absent from
 the exec allowlist and the plugin refuses argv naming it, but both are argv
 filters with documented bypasses. This is the check inside the program, used by
 orion-approve, orion-connect-admin, `orion-connect set` (host settings),
 orion-mode (relaxations) and orion-automation (install).

 Layers, in order. Any layer can refuse; only the last can allow.
   1. ENV MARKERS the gateway sets on every agent exec. Presence refuses.
      Absence proves nothing: `unset` removes them (review 2026-11-16).
   2. ANCESTRY. Any ancestor that is the gateway, its env wrapper, an exec/node
      host, the remote bridge or `openclaw agent` refuses. Absence proves
      nothing either: a backgrounded subshell is re-parented to launchd.
   3. POSITIVE PROOF. One of:
      TERMINAL: stdin (and stdout unless the caller opts out) is a TTY, the
        process has a controlling terminal, its session leader is `login` or a
        login shell ON THAT TERMINAL, and the leader's parent is a known
        terminal host (Terminal, iTerm2, Ghostty, kitty, WezTerm, Alacritty, the
        VS Code / Cursor terminal helper, sshd) whose REAL executable path (from
        the kernel, via codesign on the pid, never argv[0]) is that host's
        install path and whose signature satisfies the host's requirement. No
        pty driver (script, expect, unbuffer, python/perl/ruby, osascript,
        socat, tmux, screen) may appear anywhere in the chain. A pty made by
        anything else makes ITS child the session leader, so the leader's
        parent is the pty maker, not a host, and it is refused even if the
        maker is not on the deny list.
      APP: ORION_APPROVE_VIA=app, and the DIRECT parent's real executable is
        exactly /Applications/Orion.app/Contents/MacOS/Orion (not a symlink),
        that parent's parent is launchd (pid 1), and the running parent
        satisfies the app's designated requirement (codesign --verify -R on the
        pid). The installed app is signed by the local "Orion Local Signing"
        certificate with NO Team ID, so the requirement pinned is its own
        designated requirement (identifier + certificate leaf hash).
 Nothing is cached across runs. The function is pure: env, the process records
 and an inspector are passed in; readCallerContext/liveInspector are the only
 places that spawn, always by absolute path with an empty env.

 STILL FORGEABLE (see .builds/fix-2026-11-16/F3-approval-holes.md): anything
 that makes a REAL terminal host start the command -- `open -a Terminal x.command`,
 `osascript -e 'tell app "Terminal" to do script ...'` (osascript exits before
 the command runs, so it is not in the chain), iTerm's AppleScript, `code`
 tasks -- yields a genuine chain. Those need `open`/osascript, which are not on
 ORION's allowlist, but a script written in one call and run in the next can
 reach them. The real fix is an owner-presence prompt drawn by the app that the
 model cannot drive (Touch ID / LocalAuthentication), which needs Swift.
*/
import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

export const AGENT_ENV_KEYS = [
  "OPENCLAW_SHELL",               // "exec" on every host/sandbox exec (tui-local/acp-client are owner shells)
  "OPENCLAW_SERVICE_MARKER",      // set for the gateway service and inherited by its children
  "OPENCLAW_SERVICE_KIND",
  "OPENCLAW_MCP_SESSION_KEY",     // set for tools running inside an agent session
  "OPENCLAW_MCP_AGENT_ID",
  "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY",
];
const OWNER_SHELL_VALUES = new Set(["tui-local", "acp-client"]);

const AGENT_ANCESTOR = [
  /openclaw[^\s]*\/dist\/index\.js\s+gateway\b/,
  /ai\.openclaw\.gateway(-env-wrapper)?/,
  /openclaw[^\s]*\s+gateway\b/,
  /\bnode-host\b|\bexec-host\b|OPENCLAW_NODE_EXEC_HOST/,
  /orion-remote-bridge/,
  /openclaw[^\s]*\s+agent\b/,
];

// Programs that hand a child a pty or drive a terminal. Matched on the
// basename of comm and of argv[0]; a python running `pty` is caught by name.
const PTY_DRIVERS = /^(script|expect|unbuffer|osascript|socat|ptyexec|tmux|screen|perl[\d.]*|ruby[\d.]*|tclsh[\d.]*|python[\d.]*|Python)$/;

export const ORION_APP_PATH = "/Applications/Orion.app/Contents/MacOS/Orion";
// What `codesign -d -r- /Applications/Orion.app` reported on 2026-11-16. The app
// is signed by native/Orion/make_app_bundle.sh with the local "Orion Local
// Signing" identity: no Team ID exists to pin. A rebuild with the same identity
// keeps this hash; a NEW signing certificate changes it, and then the Allow
// button is refused (the terminal route still works) until this line is updated.
export const ORION_APP_REQUIREMENT =
  'identifier "com.nickmadaio.orion.app" and certificate leaf = H"171a72ab4922a629de353811e065ce2c5820ac09"';

const APPLE = "anchor apple";
const DEVELOPER_ID = "anchor apple generic";
export const TERMINAL_HOSTS = [
  { name: "Terminal", path: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", requirement: `${APPLE} and identifier "com.apple.Terminal"` },
  { name: "Terminal", path: "/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", requirement: `${APPLE} and identifier "com.apple.Terminal"` },
  { name: "iTerm2", path: "/Applications/iTerm.app/Contents/MacOS/iTerm2", requirement: DEVELOPER_ID },
  { name: "Ghostty", path: "/Applications/Ghostty.app/Contents/MacOS/ghostty", requirement: DEVELOPER_ID },
  { name: "kitty", path: "/Applications/kitty.app/Contents/MacOS/kitty", requirement: DEVELOPER_ID },
  { name: "Alacritty", path: "/Applications/Alacritty.app/Contents/MacOS/alacritty", requirement: DEVELOPER_ID },
  { name: "WezTerm", path: "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui", requirement: DEVELOPER_ID },
  { name: "VS Code", path: "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper", requirement: DEVELOPER_ID },
  { name: "Cursor", path: "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper", requirement: DEVELOPER_ID },
  { name: "sshd", path: "/usr/libexec/sshd-session", requirement: APPLE },
  { name: "sshd", path: "/usr/sbin/sshd", requirement: APPLE },
];
const LOGIN_PATH = "/usr/bin/login";
const SHELL_NAMES = new Set(["zsh", "bash", "sh", "dash", "ksh", "tcsh", "csh", "fish", "nu"]);
const SHELL_DIRS = new Set(["/bin", "/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"]);

const base = (text) => String(text ?? "").trim().split(/\s+/)[0].split("/").pop().replace(/^-/, "");
const baseOfPath = (path) => String(path ?? "").split("/").pop();
const dirOf = (path) => String(path ?? "").split("/").slice(0, -1).join("/");
const hasTty = (record) => Boolean(record?.tty) && record.tty !== "??" && record.tty !== "-";

export function decideApproveCaller({
  env = {}, self = null, chain = null, stdinTTY = false, stdoutTTY = false, requireStdoutTTY = true, inspect = null,
} = {}) {
  for (const key of AGENT_ENV_KEYS) {
    const value = String(env[key] ?? "").trim();
    if (!value) continue;
    if (key === "OPENCLAW_SHELL" && OWNER_SHELL_VALUES.has(value)) continue;
    return refuse(`this process carries the agent marker ${key}`);
  }
  if (!Array.isArray(chain)) return refuse("its parent processes could not be read");
  for (const proc of chain) {
    const command = String(proc?.command ?? "");
    if (AGENT_ANCESTOR.some((pattern) => pattern.test(command))) {
      return refuse(`it was started under the agent runtime (pid ${proc.pid})`);
    }
  }
  if (!inspect || !self) return refuse("its process identity could not be checked");
  if (env.ORION_APPROVE_VIA === "app") {
    const app = appProof(chain[0], inspect);
    return app.ok ? { allow: true, via: "app" } : refuse(app.why);
  }
  if (!stdinTTY || (requireStdoutTTY && !stdoutTTY)) return refuse("it has no terminal and was not started by the Orion app");
  const term = terminalProof(self, chain, inspect);
  return term.ok ? { allow: true, via: "tty", host: term.host } : refuse(term.why);
}

function appProof(parent, inspect) {
  if (!parent) return { ok: false, why: "ORION_APPROVE_VIA=app but it has no parent process" };
  if (parent.ppid !== 1) return { ok: false, why: "ORION_APPROVE_VIA=app but its parent was not started by launchd" };
  const path = safe(() => inspect.executablePath(parent.pid));
  if (path !== ORION_APP_PATH) return { ok: false, why: "ORION_APPROVE_VIA=app but its parent is not the installed Orion app" };
  if (safe(() => inspect.realpath(ORION_APP_PATH)) !== ORION_APP_PATH) return { ok: false, why: "the Orion app path is a link to somewhere else" };
  if (!safe(() => inspect.satisfies(parent.pid, ORION_APP_REQUIREMENT))) return { ok: false, why: "its parent does not carry the Orion app's signature" };
  return { ok: true };
}

function terminalProof(self, chain, inspect) {
  const driver = [self, ...chain].find((p) => PTY_DRIVERS.test(base(p?.comm)) || PTY_DRIVERS.test(base(p?.command)));
  if (driver) return { ok: false, why: `a pty or terminal driver (${base(driver.comm) || base(driver.command)}) is in its ancestry` };
  if (!hasTty(self)) return { ok: false, why: "it has no controlling terminal" };
  const records = [self, ...chain];
  const at = records.findIndex((p) => String(p?.stat ?? "").includes("s"));
  if (at < 0) return { ok: false, why: "its terminal session leader could not be found" };
  const leader = records[at];
  if (leader.tty !== self.tty) return { ok: false, why: "its session leader is not on its terminal" };
  const host = records[at + 1];
  if (!host || host.pid !== leader.ppid || leader.ppid <= 1) return { ok: false, why: "its terminal session was not started by a terminal app" };
  const leaderPath = safe(() => inspect.executablePath(leader.pid));
  const isLogin = leaderPath === LOGIN_PATH && safe(() => inspect.satisfies(leader.pid, APPLE));
  const isShell = SHELL_NAMES.has(baseOfPath(leaderPath)) && SHELL_DIRS.has(dirOf(leaderPath));
  if (!isLogin && !isShell) return { ok: false, why: "its terminal session leader is not a login shell" };
  const hostPath = safe(() => inspect.executablePath(host.pid));
  const known = TERMINAL_HOSTS.find((h) => h.path === hostPath);
  if (!known) return { ok: false, why: "its terminal session was not started by a known terminal app" };
  if (!safe(() => inspect.satisfies(host.pid, known.requirement))) return { ok: false, why: `${known.name} did not pass its signature check` };
  return { ok: true, host: known.name };
}

const safe = (fn) => { try { return fn(); } catch { return null; } };

function refuse(why) {
  return {
    allow: false,
    reason: `orion-approve is the owner's yes and cannot be run by ORION: ${why}. ` +
      "Approve from the Orion app's Allow button, or run orion-approve yourself in a terminal.",
  };
}

/* ------------------------------------------------------------- live reading */

const CLEAN = { env: {}, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] };

/** Map pid -> {pid, ppid, stat, tty, comm, command} from two ps listings. */
export function parsePsTable(fieldsText, commandText) {
  const commands = new Map();
  for (const line of String(commandText ?? "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m) commands.set(Number(m[1]), m[2]);
  }
  const table = new Map();
  for (const line of String(fieldsText ?? "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    table.set(pid, { pid, ppid: Number(m[2]), stat: m[3], tty: m[4], comm: m[5].trim(), command: commands.get(pid) ?? "" });
  }
  return table;
}

export function readProcessTable() {
  try {
    return parsePsTable(
      execFileSync("/bin/ps", ["-axww", "-o", "pid=,ppid=,stat=,tty=,comm="], CLEAN),
      execFileSync("/bin/ps", ["-axww", "-o", "pid=,command="], CLEAN),
    );
  } catch { return null; }
}

/** { self, chain } with chain nearest-first up to (not including) launchd, or null. */
export function readCallerContext(pid = process.pid, table = readProcessTable(), limit = 40) {
  if (!(table instanceof Map) || !table.has(pid)) return null;
  const self = table.get(pid);
  const chain = [];
  const seen = new Set([pid]);
  let next = self.ppid;
  while (next > 1 && !seen.has(next) && chain.length < limit) {
    const row = table.get(next);
    if (!row) return null;
    chain.push(row);
    seen.add(next);
    next = row.ppid;
  }
  return { self, chain };
}

/** The kernel's view of a pid: executable path and signature checks, via /usr/bin/codesign. */
export function liveInspector() {
  return {
    executablePath(pid) {
      // codesign -dv writes to stderr; Executable= is the kernel's path for the pid.
      const r = spawnSync("/usr/bin/codesign", ["-dv", String(pid)], CLEAN);
      const m = String(r.stderr ?? "").match(/^Executable=(.+)$/m);
      return m ? m[1] : null;
    },
    satisfies(pid, requirement) {
      try { execFileSync("/usr/bin/codesign", ["--verify", `-R=${requirement}`, String(pid)], CLEAN); return true; }
      catch { return false; }
    },
    realpath: (path) => realpathSync(path),
  };
}

/** The whole check against the live process. One call per run; nothing is cached. */
export function checkOwnerCaller({ requireStdoutTTY = true, pid = process.pid } = {}) {
  const context = readCallerContext(pid);
  return decideApproveCaller({
    env: process.env,
    self: context?.self ?? null,
    chain: context?.chain ?? null,
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    requireStdoutTTY,
    inspect: liveInspector(),
  });
}
