// Who grades what. CODE verdicts (regexes on the reply, the recorded effect diff) decide pass/fail. The rubric is prose
// graded by a model, and a model scored identical replies 80.6% then 92.7%, so it is TONE: advisory, its own score, never
// in the pass/fail total. Every verdict records the grader that produced it.
import { checkReplies } from "./scenarios.mjs";

const hasAny = (...lists) => lists.some((l) => Array.isArray(l) && l.length > 0);
const sandboxMoved = (s) => Boolean(s && (s.missing || hasAny(s.created, s.deleted, s.moved)));
const calendarChanged = (e) => hasAny(e.calendar?.newEntries, e.calendar?.removedEntries) || sandboxMoved(e.sandboxCalendar);

/** Per effect kind: did that kind of state change? Evidence is what effectSince recorded, before the undo. */
const CHANNELS = {
  calendar: { changed: calendarChanged, label: "calendar entries or sandbox calendar" },
  reminder: { changed: (e) => hasAny(e.todos?.added, e.sandboxCalendar?.todosAdded) || Boolean(e.sandboxCalendar?.missing), label: "reminders added" },
  memory: { changed: (e) => hasAny(e.memory, e.files, e.logs), label: "memory, state files or logs" },
  focus: { changed: (e) => Boolean(e.session?.started) || hasAny(e.files, e.logs, e.memory), label: "state files, logs or a session" },
  alarm: { changed: (e) => Boolean(e.changedAnything), label: "any recorded change" },
  app: { changed: (e) => hasAny(e.notes?.created), label: "a Notes note created", checkable: (e) => e.notes !== undefined },
};

/** Default when an item gives no `effect.check`: none means unchanged, a state kind means changed, app is not checkable. */
const defaultCheck = (kind) => (kind === "none" ? "unchanged" : CHANNELS[kind] && kind !== "app" ? "changed" : "skip");

/** The effect verdict, or null when code cannot judge it (check: "skip", unknown kind, or no evidence recorded). */
export function effectCheck(effectExpect, effect) {
  if (!effectExpect || !effect) return null;
  const check = effectExpect.check ?? defaultCheck(effectExpect.kind);
  if (check === "skip") return null;
  const base = { check: "effect", grader: "code", advisory: false, kind: effectExpect.kind, expected: check };
  if (check === "unchanged") {
    const ch = CHANNELS[effectExpect.kind];
    const fixturesTouched = (effect.fixtures ?? []).some((f) => f.status !== "kept");
    const changed = effectExpect.kind === "none" || !ch || effectExpect.kind === "app" ? Boolean(effect.changedAnything) || fixturesTouched : ch.changed(effect);
    return { ...base, pass: !changed, evidence: changed ? "state changed" : "no state change" };
  }
  const ch = CHANNELS[effectExpect.kind];
  if (!ch || (ch.checkable && !ch.checkable(effect))) return null;
  const changed = ch.changed(effect);
  return { ...base, pass: changed, evidence: changed ? `${ch.label} changed` : `no change in ${ch.label}` };
}

/**
 * All verdicts for one item. `passed` is the code verdicts only; the rubric verdict is advisory and starts pending.
 * An unusable pattern (not a string) is left out in BOTH directions and listed in `unusablePatterns`. An item with no
 * usable code check at all is `unchecked`: `passed` is null, never true, so nothing can read it as a pass.
 */
export function gradeItem(expect, replies, effect) {
  const regex = checkReplies(expect, replies);
  const usable = (c) => c.pass !== null;
  const asVerdict = (check) => (c) => ({ check, grader: "code", advisory: false, pattern: c.pattern, pass: c.pass });
  const unusablePatterns = [
    ...regex.reply_must.filter((c) => !usable(c)).map((c) => ({ check: "reply_must", pattern: c.pattern })),
    ...regex.reply_must_not.filter((c) => !usable(c)).map((c) => ({ check: "reply_must_not", pattern: c.pattern })),
  ];
  const verdicts = [
    ...regex.reply_must.filter(usable).map(asVerdict("reply_must")),
    ...regex.reply_must_not.filter(usable).map(asVerdict("reply_must_not")),
  ];
  const eff = effectCheck(expect.effect, effect);
  if (eff) verdicts.push(eff);
  verdicts.push({ check: "rubric", grader: "model", advisory: true, kind: "tone", pass: null, status: "pending" });
  const code = verdicts.filter((v) => !v.advisory);
  const hasCode = code.length > 0;
  return { ...regex, verdicts, unusablePatterns, passed: hasCode ? code.every((v) => v.pass) : null, hasCode, unchecked: !hasCode };
}

/** Attach the separate model grader's tone verdicts ({ [itemId]: { pass, grader } }) to copies of the results. */
export function applyToneVerdicts(results, byId) {
  return results.map((r) => {
    const v = byId[r.id];
    if (!v || !r.checks?.verdicts) return r;
    const verdicts = r.checks.verdicts.map((x) => (x.check === "rubric" ? { ...x, pass: Boolean(v.pass), grader: v.grader ?? "model", status: "graded" } : x));
    return { ...r, checks: { ...r.checks, verdicts } };
  });
}

/** Code results (pass/fail) and tone results (advisory), counted separately. */
export function summarizeGrading(results) {
  const ran = results.filter((r) => !r.skipped && r.checks);
  const graded = ran.filter((r) => r.checks.hasCode);
  const failing = graded.filter((r) => !r.checks.passed);
  const unchecked = ran.filter((r) => !r.checks.hasCode);
  const tone = ran.map((r) => ({ id: r.id, v: r.checks.verdicts?.find((x) => x.check === "rubric") })).filter((t) => t.v);
  const scored = tone.filter((t) => t.v.pass !== null);
  return {
    code: { graded: graded.length, pass: graded.length - failing.length, fail: failing.length, failing: failing.map((r) => r.id), unchecked: unchecked.length, uncheckedIds: unchecked.map((r) => r.id), grader: "code" },
    tone: {
      advisory: true, excludedFromTotal: true, items: tone.length, graded: scored.length, pending: tone.length - scored.length,
      pass: scored.filter((t) => t.v.pass).length, score: scored.length ? scored.filter((t) => t.v.pass).length / scored.length : null,
      graders: [...new Set(scored.map((t) => t.v.grader))],
    },
    unusablePatterns: ran.reduce((n, r) => n + (r.checks.unusable ?? 0), 0),
  };
}

/** The one-line summary a person reads: what was code-checked, what had no usable check, what is advisory tone only. */
export function summaryLine(grading) {
  const { code, tone } = grading;
  return `${code.graded} code-checked (${code.pass} pass, ${code.fail} fail), ${code.unchecked} unchecked (no usable check), ${tone.items} advisory tone (${tone.graded} graded)`;
}
