import { describe, expect, it } from "vitest";
import { validateExecArgs } from "./exec-arg-validator.js";
import { guardToolCall, type GuardDeps } from "./tool-guards.js";

const deps: GuardDeps = { scriptNames: () => ["orion-agenda"] };
const refused = (c: string) => validateExecArgs(c) !== undefined;

describe("forbidden program-launching flags are refused", () => {
  const bad = [
    "fd -x echo hi", "fd --exec echo hi", "fd --exec=echo pattern", "fd -X echo", "fd --exec-batch echo",
    "fd pattern dir -x ls", "fd -0x echo", "fd -Hx echo", "fd -xecho", "fd -e md -x echo",
    "rg --pre cat foo", "rg --pre=cat foo", "rg -n --pre-glob '*.pdf' foo", "rg --hostname-bin=ls foo",
    "sort --compress-program=sh file", "sort --compress-program sh file", "sort --compress-p=sh file", "sort --co=sh file",
    "find . -exec ls {} ;", "find . -execdir ls {} +", "find . -ok ls {} ;", "find . -okdir ls {} ;", "find . -delete",
    "find . -fprint out", "find . -fprint0 out", "find . -fprintf out %p", "find . -fls out",
    "git -c core.pager=sh log", "git -ccore.pager=sh log", "git --exec-path=/x log", "git --config-env=a=B log",
    "git fetch --upload-pack=sh origin", "git submodule foreach ls", "git bisect run ls", "git rebase -x ls",
    "git config alias.x !sh", "git difftool",
  ];
  for (const c of bad) it(`refuses: ${c}`, () => expect(refused(c), c).toBe(true));

  it("refuses inside a quoted command string run by a shell", () => {
    expect(refused(`sh -c "fd -x echo hi"`)).toBe(true);
    expect(refused(`bash -lc 'rg --pre cat foo'`)).toBe(true);
    expect(refused(`env FOO=1 fd --exec echo`)).toBe(true);
    expect(refused(`xargs -0 fd -X echo`)).toBe(true);
  });
  it("refuses when the second or later command of a chain is the forbidden one", () => {
    for (const c of ["ls | fd -x echo", "ls && rg --pre cat x", "ls; sort --compress-program=sh f", "echo $(fd -x ls)", "echo `fd -x ls`", `echo "$(fd -x ls)"`, "(fd -x ls)", "ls\nfd -x ls"]) {
      expect(refused(c), c).toBe(true);
    }
  });
  it("sees through a path and quoted flag text", () => {
    expect(refused("/opt/homebrew/bin/fd -x echo")).toBe(true);
    expect(refused(`fd "--exec" echo`)).toBe(true);
    expect(refused(`'fd' -x echo`)).toBe(true);
  });
  it("tells the model why and what to do", () => {
    const r = validateExecArgs("fd -x echo")!;
    expect(r).toMatch(/fd cannot run other programs here/);
    expect(r).toMatch(/ORION action/);
    expect(r).not.toMatch(/allowlist miss/);
    expect(validateExecArgs("rg --pre cat x")).toMatch(/rg/);
  });
});

describe("plain legitimate forms still pass", () => {
  const ok = [
    "fd pattern dir", "fd -e md", "fd -e md notes", "fd -H -t f readme", "fd -ex", "fd -E -x dir", "fd -d 2 foo",
    "rg -n foo", "rg -n foo dir", "rg -e -x file", "rg -l --files", "rg --glob '*.md' foo", "rg -g '!x' -t md foo",
    "sort -u file", "sort -k 2 -t , file", "sort -o out file", "sort -r -n file",
    "git log --oneline", "git status", "git diff --stat", "git config --get user.name", "git -C dir log",
    "ls -la", "grep -rn foo dir", "cat file", `rg "fd -x is a search phrase" notes`,
    "find . -name x", "find . -type f -iname '*.md'",
  ];
  for (const c of ok) it(`allows: ${c}`, () => expect(validateExecArgs(c), c).toBeUndefined());

  it("does not refuse a FILE named like a flag after --", () => {
    expect(validateExecArgs("fd -- -x")).toBeUndefined();
    expect(validateExecArgs("fd -e md -- --exec")).toBeUndefined();
    expect(validateExecArgs("rg -n foo -- --pre")).toBeUndefined();
    expect(validateExecArgs("sort -- --compress-program=x")).toBeUndefined();
    expect(validateExecArgs("git log -- -c")).toBeUndefined();
  });
});

describe("orion-approve and the gate directory are refused from any executable", () => {
  const bad = [
    "orion-approve T1", "scripts/orion-approve T1", "/x/scripts/orion-approve T1", "~/Desktop/ORION/scripts/orion-approve-resume T1",
    "cat scripts/orion-approve", "node scripts/orion-approve T1", "ls ~/.openclaw/orion-gate", "cat ~/.openclaw/orion-gate/tickets/T1.json",
    "cat $HOME/.openclaw/orion-gate/x", "head ~/.openclaw//./orion-gate/x", "sh -c 'orion-approve T1'", `cat "scripts/orion-appro"ve`,
    "ls | xargs orion-approve", "tail ~/.openclaw/orion-gate",
  ];
  for (const c of bad) it(`refuses: ${c}`, () => expect(validateExecArgs(c), c).toMatch(/approv|gate/i));
  it("explains what to do", () => {
    expect(validateExecArgs("cat scripts/orion-approve")).toMatch(/Nick/);
  });
  it("leaves unrelated gate-like names alone", () => {
    expect(validateExecArgs("ls scripts/orion-verify-gate")).toBeUndefined();
    expect(validateExecArgs("ls ~/.openclaw/workspace")).toBeUndefined();
  });
});

describe("guardToolCall wires the validator into exec", () => {
  it("blocks with the reason for exec, shell and bash", () => {
    for (const tool of ["exec", "shell", "bash"]) {
      const r = guardToolCall(tool, { command: "fd -x echo hi" }, deps);
      expect(r && "block" in r && r.blockReason).toMatch(/fd cannot run other programs here/);
    }
    const r2 = guardToolCall("exec", { cmd: "cat scripts/orion-approve" }, deps);
    expect(r2 && "block" in r2).toBe(true);
  });
  it("leaves a plain fd call alone", () => {
    expect(guardToolCall("exec", { command: "fd -e md notes" }, deps)).toBeUndefined();
  });
});

describe("exec dispatched through tool_call is validated too (defence in depth)", () => {
  const viaWrapper = (params: Record<string, unknown>) => guardToolCall("tool_call", params, deps);
  const blockedReason = (r: ReturnType<typeof viaWrapper>) => (r && "block" in r ? r.blockReason : undefined);
  it("refuses a forbidden command in args.command, flat command, or a JSON-string args", () => {
    expect(blockedReason(viaWrapper({ id: "exec", args: { command: "fd -x echo" } }))).toMatch(/fd cannot run/);
    expect(blockedReason(viaWrapper({ id: "exec", command: "fd -x echo" }))).toMatch(/fd cannot run/);
    expect(blockedReason(viaWrapper({ id: "openclaw:core:exec", args: JSON.stringify({ command: "cat scripts/orion-approve" }) }))).toMatch(/approve/);
  });
  it("fails closed when the inner exec arguments cannot be parsed", () => {
    expect(blockedReason(viaWrapper({ id: "exec", args: "{not json" }))).toMatch(/JSON object/);
  });
  it("leaves a plain inner exec to the host", () => {
    expect(viaWrapper({ id: "exec", args: { command: "fd -e md notes" } })).toBeUndefined();
  });
});

describe("quoting and spelling tricks fail closed", () => {
  const probe = String.raw`sort $'--compress-program=./orion-appro\x76e' -S 1K big.txt`;
  it("refuses the ANSI-C quoted sort probe, $\"...\" and rg $'--pre'", () => {
    expect(validateExecArgs(probe)).toMatch(/plainly/);
    expect(validateExecArgs(String.raw`sort $"--compress-program=sh" f`)).toMatch(/plainly/);
    expect(validateExecArgs(String.raw`rg $'--pre' cat foo`)).toMatch(/plainly/);
    expect(validateExecArgs(String.raw`ls $'a'`)).toMatch(/plainly/);
    expect(validateExecArgs(`echo x | cat $'f'`)).toMatch(/plainly/);
  });
  it("refuses backslash escapes for ruled tools or approval talk, but not elsewhere", () => {
    expect(validateExecArgs(String.raw`fd \x2dx echo`)).toMatch(/plainly/);
    expect(validateExecArgs(String.raw`cat ORION-\x41pprove`)).toBeDefined();
    expect(validateExecArgs(String.raw`ls dir\0name`)).toBeUndefined();
  });
  it("matches orion-approve case-insensitively, NFKC-normalised and percent-decoded", () => {
    for (const c of ["scripts/ORION-APPROVE 1", "cat Scripts/Orion-Approve", "cat ~/.OpenClaw/Orion-Gate/x", "cat scripts/orion%2Dapprove",
      "cat scripts/orion－approve", "cat scripts/orion‐approve", "cat scripts/ｏｒion-approve"]) {
      expect(validateExecArgs(c), c).toMatch(/approve/i);
    }
  });
  it("leaves a literal $ followed by a letter, and $ inside quotes, alone", () => {
    expect(validateExecArgs(`echo "$HOME"`)).toBeUndefined();
    expect(validateExecArgs(`echo $HOME`)).toBeUndefined();
    expect(validateExecArgs(`echo "costs $'5'"`)).toBeUndefined();
    expect(validateExecArgs(`rg '$"' file`)).toBeUndefined();
    expect(validateExecArgs(`rg -n 'a$' file`)).toBeUndefined();
  });
});

describe("the other owner-only programs are refused, but only their owner-only uses (F3 review 6b)", () => {
  const bad = [
    "orion-connect-admin allow-host a b.c", "scripts/orion-connect-admin allow-writes foo", "cat scripts/orion-connect-admin",
    "orion-approve-resume A-1 summary",
    "orion-mode sovereign --yes", "orion-mode open --yes --for 8h", "/x/scripts/orion-mode guarded --yes", "node scripts/orion-mode --yes OPEN",
    "orion-mode op''en --yes", "orion-mode $MODE --yes", "sh -c 'orion-mode sovereign --yes'", "orion-mode contained; orion-mode open --yes",
    "/x/scripts/orion-automation install a", "orion-automation install nightly", "node scripts/orion-automation install a",
  ];
  for (const c of bad) it(`refuses: ${c}`, () => expect(validateExecArgs(c), c).toMatch(/Nick/));
  it("says why and what to do instead", () => {
    expect(validateExecArgs("orion-mode sovereign --yes")).toMatch(/--explain|contained/);
    expect(validateExecArgs("orion-automation install a")).toMatch(/propos/i);
    expect(validateExecArgs("orion-connect-admin allow-host a b.c")).toMatch(/connector/i);
  });
  const ok = [
    "orion-mode", "orion-mode --json", "orion-mode --explain sovereign", "orion-mode open --explain", "orion-mode contained",
    "orion-mode contained --reason open", "orion-mode contained --never messages_read",
    "orion-automation list", "orion-automation show nightly", "orion-automation simulate nightly",
    "orion-automation schedule-plan nightly --timezone Europe/London", "orion-automation remove nightly",
    "orion-model-status", "ls scripts/orion-modes", "cat scripts/orion-mode-check", "grep -n relax scripts/orion-mode scripts/orion-lock",
  ];
  for (const c of ok) it(`leaves alone: ${c}`, () => expect(validateExecArgs(c), c).toBeUndefined());
});

describe("environment that changes what a tool runs is refused (F3 review 6b)", () => {
  const bad = [
    "RIPGREP_CONFIG_PATH=/tmp/c rg x", "env RIPGREP_CONFIG_PATH=/tmp/c rg x", "export RIPGREP_CONFIG_PATH=/tmp/c; rg x",
    "GIT_EXTERNAL_DIFF=/tmp/x git diff", "env GIT_EXTERNAL_DIFF=/tmp/x git diff", "GIT_PAGER=x git log",
    "FOO=1 rg -n foo", "LC_ALL=C sort big.txt", "X=1 fd -e md", "env FOO=1 git log", "env -S 'X=y rg foo'",
    "PAGER=/tmp/x cat f", "PATH=/tmp:/usr/bin ls", "NODE_OPTIONS=--require=/tmp/x node a.js", "DYLD_INSERT_LIBRARIES=/tmp/x.dylib ls",
    "LD_PRELOAD=/tmp/x.so ls", "BASH_ENV=/tmp/x bash -c ls", "ENV=/tmp/x sh -c ls", "ZDOTDIR=/tmp zsh -c ls",
    "PYTHONSTARTUP=/tmp/x python3", "LESSOPEN='|/tmp/x %s' less f", "EDITOR=/tmp/x crontab -e", "VISUAL=/tmp/x foo",
    "export GIT_EXTERNAL_DIFF=/tmp/x; git diff", "GIT_EXTERNAL_DIFF=/tmp/x; export GIT_EXTERNAL_DIFF; git diff",
    "declare -x PAGER=/tmp/x", "export PATH", "env PATH=/tmp ls",
  ];
  for (const c of bad) it(`refuses: ${c}`, () => expect(validateExecArgs(c), c).toMatch(/environment variable/));
  it("names the variable and says to run the tool plainly", () => {
    expect(validateExecArgs("GIT_EXTERNAL_DIFF=/tmp/x git diff")).toMatch(/GIT_EXTERNAL_DIFF.*plainly/s);
  });
  const ok = ["rg -n foo", "git log", "git diff", "LC_ALL=C ls -la", "TZ=Europe/London date", "env", "date", "echo $PATH", "rg -n PATH src"];
  for (const c of ok) it(`leaves alone: ${c}`, () => expect(validateExecArgs(c), c).toBeUndefined());
});
