/*
 The site-scout stages as plain functions over data, shared by the CLI and the
 job. Everything here is synchronous and offline: pages come from a lookup the
 caller supplies (fixtures today). A live caller would fill that lookup from
 fetcher.mjs in a separate, supervised step.
*/
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResponse } from './overpass.mjs';
import { scorePage } from './score.mjs';
import { classifyEmailEligibility } from './eligibility.mjs';
import { buildCard } from './card.mjs';
import { sanitizeText } from '../jobs/content.mjs';

const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw new Error(`cannot read fixture ${file}: ${error.message}`); }
};

/** Where fixtures may come from unless a caller (a test, the terminal CLI) injects another root. */
export const FIXTURE_ROOT = fileURLToPath(new URL('../../../tests/fixtures/site', import.meta.url));

const inside = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** Resolve `name` under `root` and refuse anything absolute or that lands outside it once links are followed. */
function confined(realRoot, base, name, what) {
  if (typeof name !== 'string' || name === '' || isAbsolute(name)) throw new Error(`${what} "${name}" must be a relative name, not an absolute path`);
  const target = resolve(base, name);
  if (!inside(realRoot, target)) throw new Error(`${what} "${name}" is outside the fixtures root`);
  let real;
  try { real = realpathSync(target); } catch (error) { throw new Error(`cannot read ${what} "${name}": ${error.message}`); }
  if (!inside(realRoot, real)) throw new Error(`${what} "${name}" is outside the fixtures root`);
  return real;
}

/**
 * Fixture dir (a name under `root`): overpass.json, pages.json {url: "relative/page.html"}, companies.json
 * {osmId: result}, ratings.json {osmId: {...}}. Every path, including each page named in pages.json, must stay
 * inside `root` after resolving `..` and symlinks.
 */
export function loadFixtureDir(name, { root = FIXTURE_ROOT } = {}) {
  const realRoot = realpathSync(resolve(root));
  const dir = confined(realRoot, realRoot, name, 'fixture directory');
  const pages = readJson(join(dir, 'pages.json'), {});
  return Object.freeze({
    overpass: readJson(join(dir, 'overpass.json')),
    pageHtml: Object.freeze(Object.fromEntries(Object.entries(pages).map(([url, file]) =>
      [url, readFileSync(confined(realRoot, dir, file, 'fixture page'), 'utf8')]))),
    companies: readJson(join(dir, 'companies.json'), {}),
    ratings: readJson(join(dir, 'ratings.json'), {}),
  });
}

export const discoverFromResponse = (overpass, town) => parseResponse(overpass, { town });

/** Score every candidate that has a website we hold a page for. Returns new entries; inputs are untouched. */
export function scoreCandidates(candidates, pageHtml, nowYear, extras = {}) {
  return candidates.map(candidate => {
    const html = candidate.website ? pageHtml[candidate.website] : undefined;
    if (typeof html !== 'string') return { candidate, score: null, note: candidate.website ? 'page not available' : 'no website' };
    const { raw, ...score } = scorePage({ html, url: candidate.website, nowYear, ...extras[candidate.osmId] });
    return { candidate, score };
  });
}

export const classifyCandidates = (entries, companies = {}) => entries.map(entry => ({
  ...entry, companiesHouse: companies[entry.candidate.osmId],
  eligibility: classifyEmailEligibility(entry.candidate, { companiesHouse: companies[entry.candidate.osmId] }),
}));

/** Cards, datedest site first; candidates without a score go last. */
export function cardsFor(entries, ratings = {}) {
  return entries
    .map(entry => buildCard({ candidate: entry.candidate, score: entry.score, eligibility: entry.eligibility,
      rating: ratings[entry.candidate.osmId], companiesHouse: entry.companiesHouse }))
    .sort((a, b) => (b.json.site.points ?? -1) - (a.json.site.points ?? -1));
}

const oneLine = text => sanitizeText(text).replace(/\s+/g, ' ').trim();

/** The owner sees (and approves) at most `top` cards as flat, bounded text. */
export function approvalFields(cards, { top = 5, lineMax = 250 } = {}) {
  const shown = cards.slice(0, top);
  const lines = shown.map((card, i) => {
    const j = card.json;
    const site = j.site.band ? `${j.site.band.toUpperCase()} ${j.site.points}: ${j.site.reasons.join('; ')}` : `no site score (${j.site.note})`;
    const email = j.emailable === true ? 'emailable' : j.emailable === false ? 'not emailable' : 'email: ask';
    return oneLine(`${i + 1}. ${j.name} (${j.category}, ${j.town ?? '?'}) ${site} | ${email}`).slice(0, lineMax);
  });
  return { shown: `${shown.length} of ${cards.length}`, cards: lines.join('\n') };
}

