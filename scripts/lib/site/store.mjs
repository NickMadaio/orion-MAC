/*
 Candidate store: an append-only JSONL log, a small index rebuilt from it, and
 a do-not-contact list that later stages MUST consult (isDoNotContact).
 Keyed by osmId, status new|carded|picked|rejected. Only whitelisted fields are
 kept: never review text, never a person's name beyond the business name.
 The root is injected; the default sits under the jobs state root.
*/
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_STATE_ROOT } from '../jobs/paths.mjs';

export const DEFAULT_STORE_ROOT = join(DEFAULT_STATE_ROOT, 'site-scout');
export const STATUSES = Object.freeze(['new', 'carded', 'picked', 'rejected']);
const NEXT = Object.freeze({ new: ['carded', 'rejected'], carded: ['picked', 'rejected'], picked: ['rejected'], rejected: [] });
const KEPT = ['osmId', 'name', 'category', 'town', 'website', 'phone', 'address', 'postcode', 'country', 'hasWebsiteTag', 'socialOnly'];
const OSM_ID = /^(node|way|relation)\/\d{1,15}$/;

export function pickCandidate(raw) {
  if (!raw || !OSM_ID.test(raw.osmId ?? '')) throw new Error(`candidate needs an osmId like node/123, got "${String(raw?.osmId).slice(0, 30)}"`);
  if (typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('candidate needs a business name');
  return Object.fromEntries(KEPT.filter(key => raw[key] !== undefined && raw[key] !== null).map(key => [key, raw[key]]));
}

const parseLines = text => text.split('\n').filter(Boolean).map(line => JSON.parse(line));
const readLines = async file => readFile(file, 'utf8').then(parseLines, error => { if (error.code === 'ENOENT') return []; throw error; });

export function createStore({ root = DEFAULT_STORE_ROOT, now = () => new Date() } = {}) {
  const log = join(root, 'candidates.jsonl');
  const indexFile = join(root, 'index.json');
  const dncFile = join(root, 'do-not-contact.jsonl');

  async function readIndex() {
    try { return JSON.parse(await readFile(indexFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  async function writeIndex(index) {
    const temp = join(root, `.index-${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, indexFile);
  }
  async function append(file, event) {
    await mkdir(root, { recursive: true });
    await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  return Object.freeze({
    /** Add a candidate or refresh its fields; an existing status is kept. */
    async upsert(raw) {
      const candidate = pickCandidate(raw);
      const index = await readIndex();
      const at = now().toISOString();
      await append(log, { type: 'upsert', at, candidate });
      const status = index[candidate.osmId]?.status ?? 'new';
      await writeIndex({ ...index, [candidate.osmId]: { name: candidate.name, category: candidate.category ?? null,
        town: candidate.town ?? null, status, updatedAt: at } });
      return { osmId: candidate.osmId, status };
    },
    async setStatus(osmId, status) {
      if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
      const index = await readIndex();
      const entry = index[osmId];
      if (!entry) throw new Error(`no candidate ${String(osmId).slice(0, 30)}`);
      if (!NEXT[entry.status].includes(status)) throw new Error(`cannot move ${osmId} from ${entry.status} to ${status}`);
      const at = now().toISOString();
      await append(log, { type: 'status', at, osmId, from: entry.status, status });
      await writeIndex({ ...index, [osmId]: { ...entry, status, updatedAt: at } });
      return { osmId, status };
    },
    async list(status) {
      const index = await readIndex();
      return Object.entries(index).filter(([, v]) => !status || v.status === status).map(([osmId, v]) => ({ osmId, ...v }));
    },
    async history(osmId) { return (await readLines(log)).filter(e => e.osmId === osmId || e.candidate?.osmId === osmId); },
    /** Opt-outs and refusals. Keep only identifiers, never free text from the web. */
    async addDoNotContact({ osmId, domain, phone, email, reason }) {
      if (!osmId && !domain && !phone && !email) throw new Error('do-not-contact needs an osmId, domain, phone or email');
      const entry = Object.fromEntries(Object.entries({ osmId, domain: domain?.toLowerCase(), phone, email: email?.toLowerCase(),
        reason: String(reason ?? '').slice(0, 120), at: now().toISOString() }).filter(([, v]) => v));
      await append(dncFile, entry);
      return entry;
    },
    /** Later stages must call this before any contact. Returns the matching entry or null. */
    async isDoNotContact({ osmId, website, phone, email } = {}) {
      const host = (() => { try { return new URL(website).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } })();
      const digits = value => String(value ?? '').replace(/\D/g, '');
      const hit = (await readLines(dncFile)).find(e => (osmId && e.osmId === osmId) || (host && e.domain === host.replace(/^www\./, ''))
        || (phone && e.phone && digits(e.phone) === digits(phone)) || (email && e.email === String(email).toLowerCase()));
      return hit ?? null;
    },
  });
}
