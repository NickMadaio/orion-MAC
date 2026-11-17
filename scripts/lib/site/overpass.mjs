/*
 Discovery from OpenStreetMap through Overpass. This file only BUILDS a query
 and PARSES a response. The request itself goes through the injectable fetcher
 (buildRequestUrl gives it the GET url) and is never made here.
*/
export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

const TAGS = Object.freeze({
  cafe: ['amenity', 'cafe'], bakery: ['shop', 'bakery'], restaurant: ['amenity', 'restaurant'],
  hairdresser: ['shop', 'hairdresser'], plumber: ['craft', 'plumber'], electrician: ['craft', 'electrician'],
  florist: ['shop', 'florist'],
});
export const CATEGORIES = Object.freeze([...Object.keys(TAGS), 'shop', 'craft']);
const SOCIAL = /(^|\.)(facebook|fb|instagram|twitter|x|tiktok|linktr|linktree)\.(com|me|ee)$/i;
const TOWN = /^[\p{L}\p{N} .,'&-]{1,60}$/u;

const quoteQl = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function selectors(category) {
  if (Object.hasOwn(TAGS, category)) return [`["${TAGS[category][0]}"=${quoteQl(TAGS[category][1])}]`];
  if (category === 'shop' || category === 'craft') return [`["${category}"]`];
  throw new Error(`unknown category "${String(category).slice(0, 30)}" (use ${CATEGORIES.join(', ')})`);
}

/** area: { town } or { bbox: [south, west, north, east] }. */
export function buildQuery(category, area) {
  const picks = selectors(category);
  let scope;
  let head = '';
  if (area?.bbox) {
    if (!Array.isArray(area.bbox) || area.bbox.length !== 4 || !area.bbox.every(Number.isFinite)) throw new Error('bbox must be [south, west, north, east] numbers');
    const [s, w, n, e] = area.bbox;
    if (s >= n || w >= e || Math.abs(s) > 90 || Math.abs(n) > 90 || Math.abs(w) > 180 || Math.abs(e) > 180) throw new Error('bbox is out of range or inverted');
    scope = `(${s},${w},${n},${e})`;
  } else if (typeof area?.town === 'string' && TOWN.test(area.town.trim())) {
    head = `area["boundary"="administrative"]["name"=${quoteQl(area.town.trim())}]->.a;\n`;
    scope = '(area.a)';
  } else { throw new Error('give a town (letters, digits, spaces) or a bbox'); }
  const body = picks.map(pick => `nwr${pick}${scope};`).join('\n');
  return `[out:json][timeout:25];\n${head}(\n${body}\n);\nout center tags 200;`;
}

export const buildRequestUrl = (query, endpoint = OVERPASS_ENDPOINT) => `${endpoint}?data=${encodeURIComponent(query)}`;

function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }

function cleanWebsite(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const text = raw.trim().split(/[;\s]/)[0];
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.') ? url.href : null;
  } catch { return null; }
}

function describe(element, town) {
  const t = element.tags ?? {};
  const name = typeof t.name === 'string' ? t.name.trim() : '';
  if (!name) return null;
  const rawSite = t.website ?? t['contact:website'] ?? t.url;
  const site = cleanWebsite(rawSite);
  const socialHost = site && SOCIAL.test(hostOf(site));
  const socialTag = ['contact:facebook', 'facebook', 'contact:instagram', 'instagram', 'contact:twitter'].some(k => t[k]);
  const hasWebsiteTag = Boolean(site) && !socialHost;
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const address = [street, t['addr:postcode'], t['addr:city']].filter(Boolean).join(', ');
  const category = t.amenity ?? t.shop ?? t.craft ?? 'other';
  return Object.fromEntries(Object.entries({
    osmId: `${element.type}/${element.id}`, name, category, town: t['addr:city'] ?? town ?? null,
    website: hasWebsiteTag ? site : undefined, phone: t.phone ?? t['contact:phone'], address: address || undefined,
    postcode: t['addr:postcode'], country: t['addr:country'],
    hasWebsiteTag, socialOnly: !hasWebsiteTag && Boolean(socialHost || socialTag),
  }).filter(([, v]) => v !== undefined && v !== null));
}

const filled = candidate => Object.keys(candidate).length;
const dedupeKey = c => `${c.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')}|${(c.postcode ?? c.address ?? c.phone ?? c.town ?? '').toLowerCase().replace(/\s+/g, '')}`;

/** Elements -> candidates. Same osmId or same name at the same place collapses to one (the fuller record, with gaps filled). */
export function parseResponse(json, { town } = {}) {
  if (!json || !Array.isArray(json.elements)) throw new Error('not an Overpass response: no elements array');
  const byKey = new Map();
  for (const element of json.elements) {
    if (!element || !['node', 'way', 'relation'].includes(element.type) || !Number.isInteger(element.id)) continue;
    const candidate = describe(element, town);
    if (!candidate) continue;
    const key = dedupeKey(candidate);
    const seen = byKey.get(key);
    if (!seen) { byKey.set(key, candidate); continue; }
    const [fuller, other] = filled(candidate) > filled(seen) ? [candidate, seen] : [seen, candidate];
    byKey.set(key, { ...other, ...fuller, hasWebsiteTag: fuller.hasWebsiteTag || other.hasWebsiteTag,
      socialOnly: !(fuller.hasWebsiteTag || other.hasWebsiteTag) && (fuller.socialOnly || other.socialOnly) });
  }
  return [...byKey.values()];
}

/** Fetch through the injected fetcher (live use only) and parse. */
export async function discover({ fetcher, category, area }) {
  const reply = await fetcher.fetchPage(buildRequestUrl(buildQuery(category, area)));
  if (reply.status !== 200) throw new Error(`Overpass answered ${reply.status}`);
  return parseResponse(JSON.parse(reply.html.value), { town: area?.town });
}
