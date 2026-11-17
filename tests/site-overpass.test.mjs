import './site-nonet.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildQuery, buildRequestUrl, discover, parseResponse, CATEGORIES } from '../scripts/lib/site/overpass.mjs';
import { createFetcher } from '../scripts/lib/site/fetcher.mjs';

const response = JSON.parse(readFileSync(new URL('./fixtures/site/overpass.json', import.meta.url), 'utf8'));

test('query per category for a town', () => {
  const cafe = buildQuery('cafe', { town: 'Testford' });
  assert.match(cafe, /^\[out:json\]\[timeout:25\];/);
  assert.match(cafe, /area\["boundary"="administrative"\]\["name"="Testford"\]->\.a;/);
  assert.match(cafe, /nwr\["amenity"="cafe"\]\(area\.a\);/);
  assert.match(cafe, /out center tags/);
  const expected = { bakery: '"shop"="bakery"', restaurant: '"amenity"="restaurant"', hairdresser: '"shop"="hairdresser"',
    plumber: '"craft"="plumber"', electrician: '"craft"="electrician"', florist: '"shop"="florist"' };
  for (const [category, tag] of Object.entries(expected)) assert.ok(buildQuery(category, { town: 'Testford' }).includes(tag), category);
  assert.match(buildQuery('shop', { town: 'Testford' }), /nwr\["shop"\]\(area\.a\)/);
  assert.match(buildQuery('craft', { town: 'Testford' }), /nwr\["craft"\]\(area\.a\)/);
  assert.equal(CATEGORIES.length, 9);
});

test('bounding box query, and bad input is refused rather than interpolated', () => {
  assert.match(buildQuery('florist', { bbox: [51.1, -1.2, 51.2, -1.1] }), /nwr\["shop"="florist"\]\(51\.1,-1\.2,51\.2,-1\.1\);/);
  assert.throws(() => buildQuery('florist', { bbox: [51.2, -1.2, 51.1, -1.1] }), /inverted/);
  assert.throws(() => buildQuery('florist', { bbox: ['a', 1, 2, 3] }), /numbers/);
  assert.throws(() => buildQuery('cafe', { town: 'x"]; out;' }), /town/);
  assert.throws(() => buildQuery('cafe', {}), /town/);
  assert.throws(() => buildQuery('"]; drop', { town: 'Testford' }), /unknown category/);
  assert.match(buildRequestUrl('a b'), /\?data=a%20b$/);
});

test('parser: fields, website tag logic, social-only, dedup, skips unnamed and bad ids', () => {
  const list = parseResponse(response, { town: 'Testford' });
  const byName = Object.fromEntries(list.map(c => [c.name, c]));
  assert.equal(list.length, 6, 'node+way twins merged, unnamed and broken-id elements dropped');
  const harbour = byName['Harbour Bean Cafe'];
  assert.equal(harbour.osmId, 'node/1001');
  assert.equal(harbour.category, 'cafe');
  assert.equal(harbour.town, 'Testford');
  assert.equal(harbour.website, 'http://harbourbean.example/');
  assert.equal(harbour.hasWebsiteTag, true);
  assert.equal(harbour.socialOnly, false);
  assert.equal(harbour.phone, '+44 1000 000001');
  assert.equal(harbour.address, '4 Quay Road, ZZ1 1AA, Testford');
  assert.equal(byName['Mill Lane Tea Room'].socialOnly, true);
  assert.equal(byName['Mill Lane Tea Room'].hasWebsiteTag, false);
  assert.equal(byName['Mill Lane Tea Room'].website, undefined);
  assert.equal(byName['Corner Crumb Ltd'].website, 'http://crumbcorner.example/');
  assert.equal(byName['Instagram Only Espresso'].socialOnly, true);
  assert.equal(byName['Bad Scheme Cafe'].hasWebsiteTag, false);
  assert.equal(byName['Bad Scheme Cafe'].socialOnly, false);
  assert.equal(byName['Plain Cup'].hasWebsiteTag, false);
  assert.ok(list.every(c => typeof c.hasWebsiteTag === 'boolean' && typeof c.socialOnly === 'boolean'));
});

test('parser does not mutate its input and rejects non-Overpass JSON', () => {
  const copy = structuredClone(response);
  parseResponse(response);
  assert.deepEqual(response, copy);
  assert.throws(() => parseResponse({}), /no elements/);
  assert.throws(() => parseResponse(null), /no elements/);
});

test('discover goes through the injected fetcher (stub transport), one robots + one data request', async () => {
  const seen = [];
  const fetcher = createFetcher({ resolve: async () => ['93.184.216.34'], limits: { minDelayMs: 0 },
    accept: ['application/json', 'text/plain'],
    transport: async request => { seen.push(request.url);
      return request.url.endsWith('/robots.txt') ? { status: 404, headers: {}, body: '' }
        : { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(response) }; } });
  const list = await discover({ fetcher, category: 'cafe', area: { town: 'Testford' } });
  assert.equal(list.length, 6);
  assert.equal(seen.length, 2);
  assert.match(seen[1], /^https:\/\/overpass-api\.de\/api\/interpreter\?data=/);
});

test('discover with the default fetcher cannot reach the network', async () => {
  await assert.rejects(discover({ fetcher: createFetcher(), category: 'cafe', area: { town: 'Testford' } }), /disabled/);
});
