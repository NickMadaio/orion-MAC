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
const exact = (...names) => names.map((name) => ({ name }));
const ACTION = "Use it to list or search, then act on a path with an ORION action.";
const RULES = {
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
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const WRAPPERS = new Set(["env", "xargs", "nice", "nohup", "time", "command", "exec", "sudo", "timeout", "builtin", "stdbuf", "caffeinate", "eval"]);
const MAX_DEPTH = 4;
const baseName = (word) => word.replace(/\/+$/, "").split("/").pop() ?? word;
/** Quote-aware split into commands (at | ; & ( ) newline, backtick) of dequoted words. A word that hides a substitution
    inside double quotes is returned in `nested` so it can be validated as a command of its own. */
function tokenize(command) {
    const segments = [];
    const nested = [];
    let words = [];
    let cur = "";
    let inWord = false;
    let quote = "";
    let hidden = false;
    const endWord = () => {
        if (inWord) {
            words.push(cur);
            if (hidden)
                nested.push(cur);
        }
        cur = "";
        inWord = false;
        hidden = false;
    };
    const endSegment = () => { endWord(); if (words.length)
        segments.push(words); words = []; };
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote === "'") {
            if (ch === "'")
                quote = "";
            else
                cur += ch;
            continue;
        }
        if (quote === '"') {
            if (ch === "\\" && i + 1 < command.length) {
                cur += command[++i];
                continue;
            }
            if (ch === '"') {
                quote = "";
                continue;
            }
            if (ch === "`" || (ch === "$" && command[i + 1] === "("))
                hidden = true;
            cur += ch;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            inWord = true;
            continue;
        }
        if (ch === "\\" && i + 1 < command.length) {
            cur += command[++i];
            inWord = true;
            continue;
        }
        if ("|;&()`\n\r".includes(ch)) {
            endSegment();
            continue;
        }
        if (ch === "<" || ch === ">" || ch === " " || ch === "\t") {
            endWord();
            continue;
        }
        cur += ch;
        inWord = true;
    }
    endSegment();
    return { segments, nested };
}
function longMatches(flag, name) {
    const typed = name.slice(2);
    if (typed === flag.name)
        return true;
    if (flag.minAbbrev === undefined)
        return false;
    return typed.length >= flag.minAbbrev && flag.name.startsWith(typed);
}
function checkFlags(rule, args) {
    for (let i = 0; i < args.length; i++) {
        const word = args[i];
        if (word === "--")
            return false;
        if (rule.forbidWords?.includes(word))
            return true;
        if (rule.forbidWords)
            continue;
        if (word.startsWith("--")) {
            const name = word.split("=", 1)[0];
            if (rule.forbidLong?.some((f) => longMatches(f, name)))
                return true;
            if (!word.includes("=") && rule.valueLong?.includes(name.slice(2)))
                i++;
            continue;
        }
        if (word.length > 1 && word.startsWith("-")) {
            for (let c = 1; c < word.length; c++) {
                const ch = word[c];
                if (rule.forbidShort?.includes(ch))
                    return true;
                if (rule.valueShort?.includes(ch)) {
                    if (c === word.length - 1)
                        i++;
                    break;
                }
            }
        }
    }
    return false;
}
function gitRefused(args) {
    let i = 0;
    for (; i < args.length; i++) {
        const w = args[i];
        if (w === "--")
            return false;
        if (w === "-c" || /^-c./.test(w) || w === "--config-env" || w.startsWith("--config-env=") || w.startsWith("--exec-path="))
            return true;
        if (GIT_BAD_ANYWHERE.some((f) => w === f || w.startsWith(`${f}=`)))
            return true;
        if (GIT_GLOBAL_VALUE.has(w)) {
            i++;
            continue;
        }
        if (w.startsWith("-"))
            continue;
        break;
    }
    const sub = args[i];
    if (sub === undefined)
        return false;
    if (GIT_BAD_SUBCOMMANDS.has(sub))
        return true;
    const rest = args.slice(i + 1);
    const dashDash = rest.indexOf("--");
    const flags = dashDash < 0 ? rest : rest.slice(0, dashDash);
    if (flags.some((w) => GIT_BAD_ANYWHERE.some((f) => w === f || w.startsWith(`${f}=`)) || w === "--config-env" || w.startsWith("--config-env=")))
        return true;
    if (sub === "config")
        return !flags.some((w) => GIT_CONFIG_READ.has(w));
    if (sub === "submodule")
        return flags.includes("foreach");
    if (sub === "bisect")
        return flags[0] === "run";
    if (sub === "rebase")
        return flags.some((w) => w === "-x" || w === "--exec" || w.startsWith("--exec=") || /^-[a-zA-Z]*x/.test(w) && !w.startsWith("--"));
    return false;
}
function reasonForSegment(words, depth) {
    let at = 0;
    while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]))
        at++;
    const exe = baseName(words[at] ?? "");
    if (exe === "")
        return undefined;
    const args = words.slice(at + 1);
    if (exe === "git")
        return gitRefused(args) ? GIT_MESSAGE : undefined;
    const rule = RULES[exe];
    if (rule)
        return checkFlags(rule, args) ? rule.message : undefined;
    if (depth >= MAX_DEPTH)
        return undefined;
    if (SHELLS.has(exe)) {
        const c = args.findIndex((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
        return c >= 0 && args[c + 1] !== undefined ? reasonForCommand(args[c + 1], depth + 1) : undefined;
    }
    if (WRAPPERS.has(exe)) {
        for (const w of args)
            if (/\s/.test(w)) {
                const r = reasonForCommand(w, depth + 1);
                if (r)
                    return r;
            }
        for (let j = 0; j < args.length; j++) {
            const name = baseName(args[j]);
            if (name === "git" || RULES[name] || SHELLS.has(name) || WRAPPERS.has(name))
                return reasonForSegment(args.slice(j), depth + 1);
        }
    }
    return undefined;
}
function reasonForCommand(command, depth) {
    const { segments, nested } = tokenize(command);
    for (const seg of segments) {
        const r = reasonForSegment(seg, depth);
        if (r)
            return r;
    }
    if (depth < MAX_DEPTH)
        for (const n of nested) {
            const r = reasonForCommand(n, depth + 1);
            if (r)
                return r;
        }
    return undefined;
}
/** The command with quotes and backslashes removed and `/./` and `//` collapsed, so `orion-appro"ve` still reads as orion-approve. */
function squash(command) {
    return command.replace(/["'\\]/g, "").replace(/(?:\/\.)+(?=\/|$)/g, "").replace(/\/{2,}/g, "/");
}
function namesApproval(command) {
    // Mac filesystems ignore case; fold compatibility forms (fullwidth letters and hyphens), other dashes and %xx escapes first.
    const flat = squash(command)
        .replace(/%([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
        .normalize("NFKC")
        .replace(/[\u2010-\u2015\u2212\uFE63]/g, "-")
        .toLowerCase();
    return /orion-approve/.test(flat) || /\.openclaw\/orion-gate(?![\w-])/.test(flat) || /(?:^|[\s/=])orion-gate(?:\/|$|\s)/.test(flat);
}
const PLAIN_REASON = "That command uses shell quoting ($'...' or $\"...\") or character escapes that this tool cannot check safely. Write each argument plainly, in ordinary quotes, with no \\x or \\0 escapes.";
/** True when `$'` or `$"` appears outside single quotes and outside double quotes (bash ANSI-C / locale quoting). Not decoded: refused. */
function hasDollarQuote(command) {
    let quote = "";
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote === "'") {
            if (ch === "'")
                quote = "";
            continue;
        }
        if (quote === '"') {
            if (ch === "\\")
                i++;
            else if (ch === '"')
                quote = "";
            continue;
        }
        if (ch === "\\") {
            i++;
            continue;
        }
        if (ch === "$" && (command[i + 1] === "'" || command[i + 1] === '"'))
            return true;
        if (ch === "'" || ch === '"')
            quote = ch;
    }
    return false;
}
function mentionsRuledTool(command) {
    return tokenize(command).segments.some((seg) => seg.some((w) => { const b = baseName(w); return b === "git" || b in RULES; }));
}
/** A sentence for the model when this exec command must not run, otherwise undefined. */
export function validateExecArgs(command) {
    if (hasDollarQuote(command))
        return PLAIN_REASON;
    if (namesApproval(command))
        return APPROVE_REASON;
    if (/\\[xuU0-7]/.test(command) && (/approv|orion/i.test(command) || mentionsRuledTool(command)))
        return PLAIN_REASON;
    return reasonForCommand(command, 0);
}
