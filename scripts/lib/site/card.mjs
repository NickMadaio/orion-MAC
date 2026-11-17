/*
 Candidate cards: plain text and JSON, built by code with no model. The model's
 two-sentence summary is a separate slot (SUMMARY_SLOT), declared here and not
 run by anything in this build. Fields that came from the web are only ever
 copied into text fields, never interpreted.
*/
import { sanitizeText } from '../jobs/content.mjs';

export const SUMMARY_SLOT = Object.freeze({
  id: 'summary', kind: 'slot',
  schema: Object.freeze({ type: 'object', required: ['summary'], additionalProperties: false,
    properties: Object.freeze({ summary: Object.freeze({ type: 'string', minLength: 20, maxLength: 240,
      description: 'Exactly two sentences about the business and why its website looks dated.' }) }) }),
  prompt: (ctx, card) => `Write exactly two sentences (at most 240 characters) for the owner about this business and its website. ` +
    `Use only the facts in ${ctx.quote(card)}. Reply as {"summary": "..."}.`,
});

/** Post-check the schema cannot express: exactly two sentences. */
export function isTwoSentences(text) {
  return typeof text === 'string' && (text.trim().match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? []).length === 2 && !/[^.!?\s]$/.test(text.trim());
}

const clean = value => (value === undefined || value === null ? undefined : sanitizeText(value).slice(0, 200));

export function missingData(candidate, { score, rating, companiesHouse } = {}) {
  return [
    !candidate.website && 'website', !candidate.phone && 'phone', !candidate.address && 'address',
    !rating && 'rating', !score && 'site score', !companiesHouse && 'Companies House result',
  ].filter(Boolean);
}

/** inputs: { candidate, score?, eligibility, rating?: { rating, reviewCount }, companiesHouse? } */
export function buildCard({ candidate, score, eligibility, rating, companiesHouse }) {
  const reasons = score ? score.reasons.map(clean) : [];
  const json = Object.freeze({
    osmId: candidate.osmId, name: clean(candidate.name), category: clean(candidate.category), town: clean(candidate.town) ?? null,
    rating: rating ? { rating: rating.rating ?? null, reviewCount: rating.reviewCount ?? null } : null,
    site: score ? { band: score.band, points: score.points, reasons }
      : { band: null, points: null, reasons: [], note: candidate.socialOnly ? 'social media page only' : 'no website tag' },
    emailable: eligibility.emailable, emailKind: eligibility.kind, emailReason: eligibility.reason,
    missing: missingData(candidate, { score, rating, companiesHouse }),
  });
  return Object.freeze({ json, text: renderCardText(json) });
}

export function renderCardText(card) {
  const rating = card.rating ? ` | ${card.rating.rating ?? '?'} stars, ${card.rating.reviewCount ?? '?'} reviews` : '';
  const site = card.site.band ? `Site: ${card.site.band.toUpperCase()} (${card.site.points} points)` : `Site: none (${card.site.note})`;
  return [
    `${card.name} | ${card.category} | ${card.town ?? 'town unknown'}${rating}`,
    site,
    ...card.site.reasons.map((reason, i) => `  ${i + 1}. ${reason}`),
    `Email: ${card.emailable === true ? 'yes' : card.emailable === false ? 'no' : 'ask the owner'} (${card.emailKind}) ${card.emailReason}`,
    `Missing: ${card.missing.length ? card.missing.join(', ') : 'nothing'}`,
  ].join('\n');
}
