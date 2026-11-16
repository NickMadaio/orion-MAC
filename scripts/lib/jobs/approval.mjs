/*
 Approval stops, built on ORION's existing owner-only mechanism. Nothing here
 can grant: this module only MINTS tickets (mintTicket), READS grants
 (grantedHashes) and SPENDS one that exists (consumeGrant). The grant is
 written only by `scripts/orion-approve`, which ORION may not run.

 Where the code comes from: the INSTALLED plugin copy only, and only if its
 approvals.js matches the SHA-256 recorded in the gate's integrity manifest
 (written by the sanctioned installer into ~/.openclaw/orion-gate/integrity,
 which ORION cannot write). No fallback to the repo build; no environment
 override of the gate directory or of HOME. The file is read once, verified, and
 imported from those same bytes (data: URL), so there is no swap window; a module
 with relative imports cannot be verified that way and is refused. If either check fails the lane refuses.
*/
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';

export { approvalHash } from './content.mjs';

const OPENCLAW = join(userInfo().homedir, '.openclaw');
export const INSTALLED_PLUGIN_DIR = join(OPENCLAW, 'extensions/orion-control');
export const INTEGRITY_MANIFEST = join(OPENCLAW, 'orion-gate/integrity/orion-control.json');
export const GATE_APPROVALS_ROOT = join(OPENCLAW, 'orion-gate/approvals');
const CONTEXT_CAP = 1800;

export function gateRoot() { return GATE_APPROVALS_ROOT; }

/** Load approvals.js from the installed plugin after checking its recorded hash. */
export async function loadInstalledApprovals({ pluginDir = INSTALLED_PLUGIN_DIR, manifestPath = INTEGRITY_MANIFEST } = {}) {
  const rel = 'dist/approvals.js';
  let recorded;
  try { recorded = JSON.parse(await readFile(manifestPath, 'utf8')).files?.[rel]; }
  catch (error) { throw new Error(`approvals are unavailable: no readable integrity manifest (${error.code ?? error.message}); reinstall the plugin with orion-deploy`); }
  if (typeof recorded !== 'string') throw new Error('approvals are unavailable: the integrity manifest does not list approvals.js');
  const file = join(pluginDir, rel);
  const bytes = await readFile(file).catch(error => { throw new Error(`approvals are unavailable: ${file} is unreadable (${error.code ?? error.message})`); });
  if (createHash('sha256').update(bytes).digest('hex') !== recorded) {
    throw new Error('approvals are unavailable: the installed approvals.js does not match its recorded integrity hash');
  }
  if (/(?:from|import)\s*\(?\s*['"]\.{1,2}\//.test(bytes.toString('utf8'))) {
    throw new Error('approvals are unavailable: approvals.js has a relative import, which cannot be verified byte for byte');
  }
  return import(`data:text/javascript;base64,${bytes.toString('base64')}`);
}

/**
 * Lazy, so `list` and `status` never need the plugin. `loadApprovals` and
 * `root` are for tests; the CLI uses the defaults.
 */
export function createGateApprovals({ root = GATE_APPROVALS_ROOT, loadApprovals = loadInstalledApprovals } = {}) {
  let cached;
  const api = async () => {
    cached ??= await loadApprovals().then(module => ({ ...module, paths: module.approvalPaths(root) }));
    return cached;
  };
  return Object.freeze({
    /** 'granted' | 'pending' | 'none' for this exact hash. */
    async status(hash) {
      const a = await api();
      if (a.grantedHashes(a.paths).has(hash)) return 'granted';
      return a.readTickets(a.paths).some(ticket => ticket.canonicalHash === hash) ? 'pending' : 'none';
    },
    async grantedBy(hash) {
      const a = await api();
      return a.grantedHashes(a.paths).get(hash)?.grant.grantedBy ?? null;
    },
    async mint({ hash, summary, content, runId, notice = null }) {
      const a = await api();
      const context = `${notice ? `${notice}\n\n` : ''}run ${runId}:\n${content}`;
      if (context.length > CONTEXT_CAP) throw new Error('approval content does not fit in the ticket in full');
      const ticket = await a.mintTicket(a.paths, { canonicalHash: hash, action: 'job_approval', summary, context });
      return { id: ticket.id, expiresAt: ticket.expiresAt };
    },
    /** True only if a grant for exactly this hash existed and this call spent it. */
    async spend(hash) {
      const a = await api();
      return (await a.consumeGrant(a.paths, hash)) === true;
    },
  });
}
