// What counts as one of Nick's real conversations, defined POSITIVELY: the session keys the apps actually send.
// Everything else (cron, heartbeat, eval, gate, sweep, probe, look-alikes such as `orion-chat-longc`, keys built from
// shell text) is not real. Shared by the nightly journal and the curated memory index so the two cannot drift.
//
// Where the keys come from:
// - `orion-app-v2`: the Mac app (native/Orion GatewayClient.sessionKey); the phone and Discord share it
//   (scripts/orion-remote BRAIN_SESSION, plugin provenance notes).
// - `orion-chat-<uuid>`: a Mac chat tab or a phone conversation (AppState "orion-chat-" + ChatStore UUID;
//   OrionLink CommandRunner.session lowercases it).
// - `orion-chat-phone-history`: the phone's shared thread (OrionLink CommandRunner.session with no conversation).
// The gateway stores them as `agent:<agent>:<key>`; only the `main` agent is Nick's.

export const OWNER_SESSION_KEYS = Object.freeze(["orion-app-v2", "orion-chat-phone-history"]);
const CHAT_TAB = /^orion-chat-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_PREFIX = "agent:main:";

/** True only for a key the owner's apps send. Non-strings, empty keys and anything with extra text are not real. */
export function isRealSession(key) {
  if (typeof key !== "string") return false;
  const bare = key.toLowerCase().startsWith(AGENT_PREFIX) ? key.slice(AGENT_PREFIX.length) : key;
  return OWNER_SESSION_KEYS.includes(bare.toLowerCase()) || CHAT_TAB.test(bare);
}
