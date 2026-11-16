// What went wrong, in words (A7, 2026-11-16). The watcher once counted 301 failures and could not say what any of them were, and called a
// signed-out Gmail a generic "error". This file classifies a failure and keeps a short, token-free record of the recent ones.
import { classifyGmailError } from "../gmail-status.mjs";

export const HISTORY_MAX = 20;
const TEXT_MAX = 160;
/** More ways gog and Google say "sign in again" than gmail-status.mjs knows: no stored token, not authenticated, 401, a revoked refresh token. */
const SIGN_IN = /no (?:stored )?(?:oauth )?token|not (?:signed in|authenticated|logged in)|unauthenticated|unauthori[sz]ed|invalid_token|invalid authentication credentials|refresh token|reauth|login required/i;
/** gog could not be started, or its vault password is unreadable: fixed by setup, not by signing in. */
const SETUP = /could not run gog|spawn gog|ENOENT|vault password|could not read .*\.env/i;

/** True when gog's stderr means the owner has to sign in again. */
export const isSignInProblem = (text) => classifyGmailError(text) === "expired" || SIGN_IN.test(String(text ?? ""));

/** "expired" | "unreachable" | "setup" | "error". An app password counts as expired for IMAP. */
export function failureKind(account, text) {
  const t = String(text ?? "");
  const base = classifyGmailError(t);
  if (base === "unreachable") return "unreachable";
  if (account.kind === "imap") return /app password|sign-in refused|authentication failed|keychain/i.test(t) ? "expired" : base;
  if (isSignInProblem(t)) return "expired";
  if (SETUP.test(t)) return "setup";
  return base;
}

/** One short line, no token shapes: Bearer values, ya29./1// Google tokens, key=value secrets, and any long unbroken run. */
export function redactError(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ").trim()
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\b(access_token|refresh_token|id_token|token|password|secret|client_secret|(?<!exit\s)code)(["']?\s*[:=]\s*)["']?[^\s"',}]+["']?/gi, "$1$2<redacted>")
    .replace(/\bya29\.[\w.-]+|\b1\/\/[\w.-]+/g, "<redacted>")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "<redacted>")
    .slice(0, TEXT_MAX);
}

/** The history with one more failure on the end, capped. Pure. */
export const addFailure = (history, { at, kind, error }) =>
  [...(Array.isArray(history) ? history : []), { at, kind, text: redactError(error instanceof Error ? error.message : error) }].slice(-HISTORY_MAX);
