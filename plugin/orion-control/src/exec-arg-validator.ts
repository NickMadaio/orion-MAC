/*
 Exec argument validator (2026-11-16, F3 follow-up).

 The host matches an allowlisted exec by executable NAME only; it never reads the arguments. Several allowlisted
 read-only tools launch other programs through their own flags (`fd -x`, `rg --pre`, `sort --compress-program`, and
 `find -exec` if find ever returns), which lets the local model run `scripts/orion-approve <ticket>` and grant its own
 approval. This refuses those forms before the host sees them, with a sentence the model can act on.

 It validates ARGUMENT STRUCTURE (a quote-aware tokenizer, a table of executable -> forbidden flags). It does not look
 at what Nick said and does no routing. A flag after `--` is a file name and is never refused. Where the host's parse
 and this one can disagree (shell globs, variables, `cd` then a relative name, files that run themselves), see the
 "Residual risk" notes in .builds/fix-2026-11-16/F3-env-find.md.
*/

interface LongFlag { readonly name: string; /** shortest prefix (after `--`) the tool accepts, for getopt_long tools; omitted = exact only */ readonly minAbbrev?: number }
interface FlagRule {
  readonly forbidShort?: string;
  readonly forbidLong?: readonly LongFlag[];
  /** Single-dash words that are forbidden as whole words (find-style options). */
  readonly forbidWords?: readonly string[];
  /** Short flags / long flags that take a value, so the next word is that value, not a flag. */
  readonly valueShort?: string;
  readonly valueLong?: readonly string[];
  readonly message: string;
}

const exact = (...names: string[]): LongFlag[] => names.map((name) => ({ name }));
const ACTION = "Use it to list or search, then act on a path with an ORION action.";

const RULES: Readonly<Record<string, FlagRule>> = {
  fd: {
    forbidShort: "xX",
    forbidLong: exact("exec", "exec-batch"),
    valueShort: "eEdtScoj",
    valueLong: ["extension", "exclude", "max-depth", "min-depth", "exact-depth", "type", "size", "color", "owner", "threads", "changed-within", "changed-before", "ignore-file", "base-directory", "path-separator", "search-path", "max-results", "batch-size", "strip-cwd-prefix"],
    message: `fd cannot run other programs here (-x/--exec, -X/--exec-batch). ${ACTION}`,
  },
  rg: {
    forbidLong: exact("pre", "pre-glob", "hostname-bin"),
    valueShort: "efgtTmABCjMrEdp",
    valueLong: ["regexp", "file", "glob", "iglob", "type", "type-not", "max-count", "after-context", "before-context", "context", "threads", "max-columns", "replace", "encoding", "max-depth", "max-filesize", "sort", "sortr", "type-add", "type-clear", "colors", "color", "ignore-file", "path-separator", "dfa-size-limit", "regex-size-limit", "engine"],
    message: `rg cannot run other programs here (--pre, --pre-glob, --hostname-bin). Use plain rg to search file contents.`,
  },
  sort: {
    forbidLong: [{ name: "compress-program", minAbbrev: 2 }],
    valueShort: "ktTSo",
    valueLong: ["key", "field-separator", "temporary-directory", "buffer-size", "output", "files0-from", "parallel", "batch-size", "random-source"],
    message: `sort cannot run other programs here (--compress-program). Use plain sort to order lines.`,
  },
  find: {
    forbidWords: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"],
    message: `find cannot run programs, delete or write files here (-exec, -execdir, -ok, -okdir, -delete, -fprint*, -fls). Use fd or mdfind to list files, then act on a path with an ORION action.`,
  },
};

const GIT_MESSAGE = "git cannot run other programs here (-c, --config-env, --exec-path=, --upload-pack, subcommands like difftool, submodule foreach, bisect run, rebase -x). Use read-only git such as log, status or diff.";
const GIT_GLOBAL_VALUE = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source"]);
const GIT_BAD_ANYWHERE = ["--upload-pack", "--receive-pack", "--exec", "--ext-diff"];
const GIT_BAD_SUBCOMMANDS = new Set(["difftool", "mergetool", "filter-branch", "daemon", "instaweb", "web--browse", "help"]);
const GIT_CONFIG_READ = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin", "--show-scope"]);

const APPROVE_REASON = "That would let you approve your own request, so it is not yours to run: only Nick approves, in his own words or in the app. Tell him what is waiting and let him approve it.";

/*
 Environment that changes what a tool executes or loads (F3 review 6b, 2026-11-16). The rules above only see argv;
 `RIPGREP_CONFIG_PATH=/tmp/c rg x` gives rg a --pre from a file, `GIT_EXTERNAL_DIFF=/tmp/x git diff` runs a program,
 and the loader/startup variables do the same for anything. Assigning one of these anywhere is refused; any NAME=value
 in front of a ruled tool is refused too, since the rule cannot see what the variable changes.
*/
const DENY_ENV = /^(?:RIPGREP_CONFIG_PATH|GIT_[A-Z0-9_]*|LESSOPEN|LESSCLOSE|PAGER|EDITOR|VISUAL|PATH|NODE_OPTIONS|PYTHONSTARTUP|DYLD_[A-Z0-9_]*|LD_[A-Z0-9_]*|BASH_ENV|ENV|ZDOTDIR)$/;
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const EXPORTERS = new Set(["export", "declare", "typeset", "readonly", "local", "setenv"]);
const envReason = (name: string): string =>
  `That command sets the environment variable ${name}, which changes what the program runs or loads, and this tool cannot check it. Run the program plainly, with no NAME=value in front of it, and pass what you need as ordinary flags.`;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const WRAPPERS = new Set(["env", "xargs", "nice", "nohup", "time", "command", "exec", "sudo", "timeout", "builtin", "stdbuf", "caffeinate", "eval"]);
const MAX_DEPTH = 4;

const baseName = (word: string): string => word.replace(/\/+$/, "").split("/").pop() ?? word;

/** Quote-aware split into commands (at | ; & ( ) newline, backtick) of dequoted words. A word that hides a substitution
    inside double quotes is returned in `nested` so it can be validated as a command of its own. */
function tokenize(command: string): { segments: string[][]; nested: string[] } {
  const segments: string[][] = [];
  const nested: string[] = [];
  let words: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: "" | "'" | '"' = "";
  let hidden = false;
  const endWord = () => {
    if (inWord) { words.push(cur); if (hidden) nested.push(cur); }
    cur = ""; inWord = false; hidden = false;
  };
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote === "'") { if (ch === "'") quote = ""; else cur += ch; continue; }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < command.length) { cur += command[++i]; continue; }
      if (ch === '"') { quote = ""; continue; }
      if (ch === "`" || (ch === "$" && command[i + 1] === "(")) hidden = true;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inWord = true; continue; }
    if (ch === "\\" && i + 1 < command.length) { cur += command[++i]; inWord = true; continue; }
    if ("|;&()`\n\r".includes(ch)) { endSegment(); continue; }
    if (ch === "<" || ch === ">" || ch === " " || ch === "\t") { endWord(); continue; }
    cur += ch; inWord = true;
  }
  endSegment();
  return { segments, nested };
}

function longMatches(flag: LongFlag, name: string): boolean {
  const typed = name.slice(2);
  if (typed === flag.name) return true;
  if (flag.minAbbrev === undefined) return false;
  return typed.length >= flag.minAbbrev && flag.name.startsWith(typed);
}

function checkFlags(rule: FlagRule, args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    if (word === "--") return false;
    if (rule.forbidWords?.includes(word)) return true;
    if (rule.forbidWords) continue;
    if (word.startsWith("--")) {
      const name = word.split("=", 1)[0] as string;
      if (rule.forbidLong?.some((f) => longMatches(f, name))) return true;
      if (!word.includes("=") && rule.valueLong?.includes(name.slice(2))) i++;
      continue;
    }
    if (word.length > 1 && word.startsWith("-")) {
      for (let c = 1; c < word.length; c++) {
        const ch = word[c] as string;
        if (rule.forbidShort?.includes(ch)) return true;
        if (rule.valueShort?.includes(ch)) { if (c === word.length - 1) i++; break; }
      }
    }
  }
  return false;
}

function gitRefused(args: readonly string[]): boolean {
  let i = 0;
  for (; i < args.length; i++) {
    const w = args[i] as string;
    if (w === "--") return false;
    if (w === "-c" || /^-c./.test(w) || w === "--config-env" || w.startsWith("--config-env=") || w.startsWith("--exec-path=")) return true;
    if (GIT_BAD_ANYWHERE.some((f) => w === f || w.startsWith(`${f}=`))) return true;
    if (GIT_GLOBAL_VALUE.has(w)) { i++; continue; }
    if (w.startsWith("-")) continue;
    break;
  }
  const sub = args[i];
  if (sub === undefined) return false;
  if (GIT_BAD_SUBCOMMANDS.has(sub)) return true;
  const rest = args.slice(i + 1);
  const dashDash = rest.indexOf("--");
  const flags = dashDash < 0 ? rest : rest.slice(0, dashDash);
  if (flags.some((w) => GIT_BAD_ANYWHERE.some((f) => w === f || w.startsWith(`${f}=`)) || w === "--config-env" || w.startsWith("--config-env="))) return true;
  if (sub === "config") return !flags.some((w) => GIT_CONFIG_READ.has(w));
  if (sub === "submodule") return flags.includes("foreach");
  if (sub === "bisect") return flags[0] === "run";
  if (sub === "rebase") return flags.some((w) => w === "-x" || w === "--exec" || w.startsWith("--exec=") || /^-[a-zA-Z]*x/.test(w) && !w.startsWith("--"));
  return false;
}

const isRuled = (name: string): boolean => name === "git" || name in RULES;

/** The reason when this segment's environment assignments are not safe, otherwise undefined. */
function envReasonForSegment(words: readonly string[], at: number, exe: string, args: readonly string[]): string | undefined {
  const prefix = words.slice(0, at).map((w) => (ASSIGN.exec(w) as RegExpExecArray)[1] as string);
  const denied = prefix.find((name) => DENY_ENV.test(name));
  if (denied) return envReason(denied);
  if (prefix.length > 0 && isRuled(exe)) return envReason(prefix[0] as string);
  if (EXPORTERS.has(exe)) {
    const named = args.map((w) => w.split("=", 1)[0] as string).find((name) => DENY_ENV.test(name));
    if (named) return envReason(named);
  }
  if (exe === "env") {
    const assigned = args.filter((w) => ASSIGN.test(w)).map((w) => (ASSIGN.exec(w) as RegExpExecArray)[1] as string);
    const bad = assigned.find((name) => DENY_ENV.test(name));
    if (bad) return envReason(bad);
    const tool = args.findIndex((w) => !w.startsWith("-") && !ASSIGN.test(w));
    if (assigned.length > 0 && tool >= 0 && isRuled(baseName(args[tool] as string))) return envReason(assigned[0] as string);
  }
  return undefined;
}

function reasonForSegment(words: readonly string[], depth: number): string | undefined {
  let at = 0;
  while (at < words.length && ASSIGN.test(words[at] as string)) at++;
  const exe = baseName(words[at] ?? "");
  const args = words.slice(at + 1);
  const envRefusal = envReasonForSegment(words, at, exe, args);
  if (envRefusal) return envRefusal;
  if (exe === "") return undefined;
  if (exe === "git") return gitRefused(args) ? GIT_MESSAGE : undefined;
  const rule = RULES[exe];
  if (rule) return checkFlags(rule, args) ? rule.message : undefined;
  if (depth >= MAX_DEPTH) return undefined;
  if (SHELLS.has(exe)) {
    const c = args.findIndex((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
    return c >= 0 && args[c + 1] !== undefined ? reasonForCommand(args[c + 1] as string, depth + 1) : undefined;
  }
  if (WRAPPERS.has(exe)) {
    for (const w of args) if (/\s/.test(w)) { const r = reasonForCommand(w, depth + 1); if (r) return r; }
    for (let j = 0; j < args.length; j++) {
      const name = baseName(args[j] as string);
      if (name === "git" || RULES[name] || SHELLS.has(name) || WRAPPERS.has(name)) return reasonForSegment(args.slice(j), depth + 1);
    }
  }
  return undefined;
}

function reasonForCommand(command: string, depth: number): string | undefined {
  const { segments, nested } = tokenize(command);
  for (const seg of segments) { const r = reasonForSegment(seg, depth); if (r) return r; }
  if (depth < MAX_DEPTH) for (const n of nested) { const r = reasonForCommand(n, depth + 1); if (r) return r; }
  return undefined;
}

/** The command with quotes and backslashes removed and `/./` and `//` collapsed, so `orion-appro"ve` still reads as orion-approve. */
function squash(command: string): string {
  return command.replace(/["'\\]/g, "").replace(/(?:\/\.)+(?=\/|$)/g, "").replace(/\/{2,}/g, "/");
}

/** Mac filesystems ignore case; fold compatibility forms (fullwidth letters and hyphens), other dashes and %xx escapes. */
function fold(command: string): string {
  return squash(command)
    .replace(/%([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .normalize("NFKC")
    .replace(/[\u2010-\u2015\u2212\uFE63]/g, "-")
    .toLowerCase();
}

function namesApproval(command: string): boolean {
  const flat = fold(command);
  return /orion-approve/.test(flat) || /\.openclaw\/orion-gate(?![\w-])/.test(flat) || /(?:^|[\s/=])orion-gate(?:\/|$|\s)/.test(flat);
}

/*
 The other owner-only programs (F3 review 6b). orion-connect-admin is entirely Nick's switch, so naming it is refused
 like orion-approve. orion-mode and orion-automation are not: ORION may read them and may tighten, so only the
 owner-only uses are refused (scripts/orion-mode: naming a mode other than "contained" without --explain, since only
 those can relax or widen; scripts/orion-automation: install). The words after each mention, up to the end of that
 command, are what is checked, so `node .../orion-mode open --yes` and `sh -c 'orion-mode open'` are caught too.
*/
const CONNECT_ADMIN_REASON = "orion-connect-admin is Nick's own switch for connectors (which hosts and keys a connector may use), so it is not yours to run. Tell him the exact orion-connect-admin line to run himself.";
const MODE_REASON = "Relaxing ORION's mode or widening its scope is Nick's act, so it is not yours to run. You may check it (orion-mode, orion-mode --json, orion-mode --explain <mode>) or tighten to orion-mode contained; tell Nick what you would change and let him run it.";
const AUTOMATION_REASON = "Installing an automation is Nick's act, so it is not yours to run. Propose it (automation_propose), show him orion-automation simulate, and tell him to run orion-automation install himself.";
const RELAXING_MODES = new Set(["guarded", "open", "sovereign"]);
const MODE_VALUE_FLAGS = new Set(["--for", "--never", "--within", "--reason"]);

/** The words after each mention of `name` (a whole program name), up to the end of that command. */
function wordsAfter(flat: string, name: string): string[][] {
  const out: string[][] = [];
  const re = new RegExp(`${name}(?![\\w-])`, "g");
  for (let m = re.exec(flat); m; m = re.exec(flat)) {
    const rest = flat.slice(m.index + m[0].length).split(/[|;&()`\n\r]/, 1)[0] as string;
    out.push(rest.split(/\s+/).filter((w) => w.length > 0 && !/^\d*[<>]/.test(w)));
  }
  return out;
}

const computed = (w: string): boolean => /[$`*?[\]{}]/.test(w);

function modeRelaxes(words: readonly string[]): boolean {
  if (words.includes("--explain")) return false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (MODE_VALUE_FLAGS.has(w)) { i++; continue; }
    if (w.startsWith("-")) continue;
    if (computed(w) || RELAXING_MODES.has(w)) return true;
  }
  return false;
}

function ownerOnlyReason(command: string): string | undefined {
  const flat = fold(command);
  if (/orion-connect-admin(?![\w-])/.test(flat)) return CONNECT_ADMIN_REASON;
  if (wordsAfter(flat, "orion-mode").some(modeRelaxes)) return MODE_REASON;
  if (wordsAfter(flat, "orion-automation").some((ws) => ws.some((w) => w === "install" || computed(w)))) return AUTOMATION_REASON;
  return undefined;
}

const PLAIN_REASON = "That command uses shell quoting ($'...' or $\"...\") or character escapes that this tool cannot check safely. Write each argument plainly, in ordinary quotes, with no \\x or \\0 escapes.";

/** True when `$'` or `$"` appears outside single quotes and outside double quotes (bash ANSI-C / locale quoting). Not decoded: refused. */
function hasDollarQuote(command: string): boolean {
  let quote: "" | "'" | '"' = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote === "'") { if (ch === "'") quote = ""; continue; }
    if (quote === '"') { if (ch === "\\") i++; else if (ch === '"') quote = ""; continue; }
    if (ch === "\\") { i++; continue; }
    if (ch === "$" && (command[i + 1] === "'" || command[i + 1] === '"')) return true;
    if (ch === "'" || ch === '"') quote = ch;
  }
  return false;
}

function mentionsRuledTool(command: string): boolean {
  return tokenize(command).segments.some((seg) => seg.some((w) => { const b = baseName(w); return b === "git" || b in RULES; }));
}

/** A sentence for the model when this exec command must not run, otherwise undefined. */
export function validateExecArgs(command: string): string | undefined {
  if (hasDollarQuote(command)) return PLAIN_REASON;
  if (namesApproval(command)) return APPROVE_REASON;
  const ownerOnly = ownerOnlyReason(command);
  if (ownerOnly) return ownerOnly;
  // ripgrep reads options (including --pre) from the file RIPGREP_CONFIG_PATH names; naming it anywhere is refused.
  if (/ripgrep_config_path/.test(fold(command))) return envReason("RIPGREP_CONFIG_PATH");
  if (/\\[xuU0-7]/.test(command) && (/approv|orion/i.test(command) || mentionsRuledTool(command))) return PLAIN_REASON;
  return reasonForCommand(command, 0);
}
