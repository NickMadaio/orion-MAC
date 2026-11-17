import './site-nonet.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyEmailEligibility as classify } from '../scripts/lib/site/eligibility.mjs';
import { createStore, pickCandidate } from '../scripts/lib/site/store.mjs';
import { buildCard, isTwoSentences, SUMMARY_SLOT, renderCardText } from '../scripts/lib/site/card.mjs';
import { validate, } from '../scripts/lib/jobs/schema.mjs';
import { assertSupportedSchema } from '../scripts/lib/jobs/schema.mjs';

test('eligibility: defaults to "ask" whenever unsure', () => {
  assert.deepEqual(classify({ name: 'Cafe X' }), { kind: 'unknown', emailable: 'ask', reason: 'Country and company type are not known' });
  assert.equal(classify({ name: 'Cafe X', phone: '+44 20 0000 0000' }).emailable, 'ask');
  assert.equal(classify({ name: 'Smith Ltd', country: 'GB' }).kind, 'uk_limited');
  assert.equal(classify({ name: 'Smith Ltd', country: 'GB' }).emailable, 'ask', 'a name suffix alone is not proof');
  assert.equal(classify({ name: 'Acme Inc' }).emailable, 'ask');
});

test('eligibility: Companies House result as optional input', () => {
  const uk = { name: 'Smith & Co', country: 'GB' };
  assert.deepEqual(classify(uk, { companiesHouse: { found: true, type: 'ltd', status: 'active' } }).emailable, true);
  assert.equal(classify(uk, { companiesHouse: { found: true, type: 'llp', status: 'active' } }).kind, 'uk_limited');
  assert.equal(classify(uk, { companiesHouse: { found: true, type: 'ltd', status: 'dissolved' } }).emailable, 'ask');
  const sole = classify(uk, { companiesHouse: { found: true, type: 'sole_trader' } });
  assert.deepEqual([sole.kind, sole.emailable], ['uk_sole_or_partnership', false]);
  assert.equal(classify(uk, { companiesHouse: { found: true, type: 'partnership' } }).emailable, false);
  const none = classify(uk, { companiesHouse: { found: false } });
  assert.deepEqual([none.kind, none.emailable], ['uk_sole_or_partnership', 'ask']);
});

test('eligibility: UK without a registry result is never "true", US is a business with CAN-SPAM conditions', () => {
  assert.notEqual(classify({ name: 'Anything Limited', country: 'GB' }).emailable, true);
  const us = classify({ name: 'Joe Diner', phone: '+1 555 0100' });
  assert.deepEqual([us.kind, us.emailable], ['us_business', true]);
  assert.match(us.reason, /postal address/);
  assert.ok(classify({ name: 'x' }).reason.length > 5);
});

const tmp = async t => { const dir = await mkdtemp(join(tmpdir(), 'site-store-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const cand = (n, extra = {}) => ({ osmId: `node/${n}`, name: `Biz ${n}`, category: 'cafe', town: 'Testford', hasWebsiteTag: true, socialOnly: false, website: `http://b${n}.example/`, ...extra });

test('store: append-only log plus index, keyed by osmId, status kept across upserts', async t => {
  const root = await tmp(t);
  const store = createStore({ root });
  assert.deepEqual(await store.upsert(cand(1)), { osmId: 'node/1', status: 'new' });
  await store.upsert(cand(2));
  await store.setStatus('node/1', 'carded');
  await store.upsert(cand(1, { phone: '123' }));
  assert.equal((await store.list('carded')).length, 1);
  assert.equal((await store.list()).length, 2);
  const lines = (await readFile(join(root, 'candidates.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(l => l.type), ['upsert', 'upsert', 'status', 'upsert']);
  assert.equal((await store.history('node/1')).length, 3);
  const again = createStore({ root });
  assert.equal((await again.list('carded'))[0].osmId, 'node/1', 'a new instance reads the same state');
  assert.deepEqual((await readdir(root)).sort(), ['candidates.jsonl', 'index.json']);
});

test('store: transitions are checked and bad ids are refused', async t => {
  const store = createStore({ root: await tmp(t) });
  await store.upsert(cand(1));
  await assert.rejects(store.setStatus('node/1', 'picked'), /cannot move node\/1 from new to picked/);
  await assert.rejects(store.setStatus('node/1', 'bogus'), /status must be/);
  await assert.rejects(store.setStatus('node/99', 'carded'), /no candidate/);
  await store.setStatus('node/1', 'carded'); await store.setStatus('node/1', 'picked');
  await store.setStatus('node/1', 'rejected');
  await assert.rejects(store.setStatus('node/1', 'picked'), /cannot move/);
  assert.throws(() => pickCandidate({ osmId: '../../etc', name: 'x' }), /osmId/);
  assert.throws(() => pickCandidate({ osmId: 'node/1', name: ' ' }), /business name/);
});

test('store keeps only whitelisted fields: no review text, no personal names', async t => {
  const root = await tmp(t);
  const store = createStore({ root });
  await store.upsert(cand(1, { reviews: ['Great, ask for Dave Smith'], ownerName: 'Dave Smith', 'contact:name': 'Dave', operator: 'Dave Smith', review_text: 'x' }));
  const log = await readFile(join(root, 'candidates.jsonl'), 'utf8');
  const index = await readFile(join(root, 'index.json'), 'utf8');
  for (const needle of ['Dave', 'Great', 'reviews', 'ownerName', 'operator']) assert.equal((log + index).includes(needle), false, needle);
});

test('do-not-contact: matched by osmId, domain (www-insensitive), phone digits, email', async t => {
  const store = createStore({ root: await tmp(t) });
  assert.equal(await store.isDoNotContact({ osmId: 'node/1' }), null, 'empty list');
  await store.addDoNotContact({ osmId: 'node/7', reason: 'asked us to stop' });
  await store.addDoNotContact({ domain: 'WWW.Blocked.example'.replace('WWW.', ''), reason: 'opt-out' });
  await store.addDoNotContact({ phone: '+44 1000 000009', reason: 'refused' });
  await store.addDoNotContact({ email: 'Hello@Nope.example', reason: 'opt-out' });
  assert.ok(await store.isDoNotContact({ osmId: 'node/7' }));
  assert.ok(await store.isDoNotContact({ website: 'https://www.blocked.example/menu' }));
  assert.ok(await store.isDoNotContact({ phone: '44 1000-000009' }));
  assert.ok(await store.isDoNotContact({ email: 'hello@nope.example' }));
  assert.equal(await store.isDoNotContact({ osmId: 'node/8', website: 'http://fine.example/' }), null);
  await assert.rejects(store.addDoNotContact({ reason: 'x' }), /needs an osmId/);
});

const SCORE = { band: 'old', points: 80, reasons: ['Not served over HTTPS', 'No mobile viewport tag', 'Footer copyright year is 2008'] };

test('card: JSON and text with name, category, town, rating, band, three reasons, emailable, missing data', () => {
  const eligibility = classify({ name: 'Biz 1', phone: '+1 555 0100' });
  const card = buildCard({ candidate: cand(1), score: SCORE, eligibility, rating: { rating: 4.5, reviewCount: 30 } });
  assert.equal(card.json.name, 'Biz 1');
  assert.deepEqual(card.json.rating, { rating: 4.5, reviewCount: 30 });
  assert.equal(card.json.site.band, 'old');
  assert.equal(card.json.site.reasons.length, 3);
  assert.equal(card.json.emailable, true);
  assert.deepEqual(card.json.missing, ['phone', 'address', 'Companies House result']);
  for (const piece of ['Biz 1', 'cafe', 'Testford', '4.5 stars, 30 reviews', 'OLD (80 points)', '1. Not served over HTTPS', 'Email: yes', 'Missing: phone, address']) assert.ok(card.text.includes(piece), piece);
  assert.ok(Object.isFrozen(card));
});

test('card: no website, no rating, unknown eligibility', () => {
  const card = buildCard({ candidate: cand(2, { website: undefined, hasWebsiteTag: false, socialOnly: true }), score: null, eligibility: classify({ name: 'x' }) });
  assert.equal(card.json.rating, null);
  assert.equal(card.json.site.band, null);
  assert.match(card.text, /Site: none \(social media page only\)/);
  assert.match(card.text, /Email: ask the owner/);
  assert.ok(card.json.missing.includes('site score') && card.json.missing.includes('rating'));
});

test('card strips control characters from web-supplied names', () => {
  const card = buildCard({ candidate: cand(3, { name: 'Evil\u001b[31m‮Name' }), score: null, eligibility: classify({}) });
  // The whole escape sequence goes, not just the ESC byte: a leftover '[31m' is still noise on a card.
  assert.equal(card.json.name, 'EvilName');
  assert.doesNotMatch(renderCardText(card.json), /\u001b|‮/);
});

test('summary slot is declared, schema-valid, and checks two sentences within 240 chars', () => {
  assert.doesNotThrow(() => assertSupportedSchema(SUMMARY_SLOT.schema));
  assert.equal(SUMMARY_SLOT.kind, 'slot');
  assert.equal(SUMMARY_SLOT.schema.properties.summary.maxLength, 240);
  assert.deepEqual(validate({ summary: 'Two short sentences here. They describe the site.' }, SUMMARY_SLOT.schema), []);
  assert.notDeepEqual(validate({ summary: 'x'.repeat(241) }, SUMMARY_SLOT.schema), []);
  assert.equal(isTwoSentences('A bakery in Testford. Its site dates from 2008.'), true);
  assert.equal(isTwoSentences('Only one sentence.'), false);
  assert.equal(isTwoSentences('One. Two. Three.'), false);
  const ctx = { quote: v => `<data>${JSON.stringify(v)}</data>` };
  assert.match(SUMMARY_SLOT.prompt(ctx, { name: 'x' }), /<data>/);
});
