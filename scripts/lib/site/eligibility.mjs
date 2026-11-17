/*
 Email eligibility, as data only (HANDOFF 9.6). Coarse on purpose, and "ask"
 whenever unsure. Nothing here contacts anyone and no registry is called: a
 Companies House result may be passed in as `companiesHouse`.
   { kind: uk_limited | uk_sole_or_partnership | us_business | unknown,
     emailable: true | false | "ask", reason }
 companiesHouse (optional): { found: bool, type?: 'ltd'|'plc'|'llp'|'sole_trader'|'partnership', status?: 'active'|'dissolved'|... }
 The name and country come from OpenStreetMap, which is untrusted: they only select a branch here.
*/
const LIMITED_NAME = /\b(ltd|limited|plc|llp)\b\.?$/i;
const US_NAME = /\b(inc|llc|corp|co)\b\.?$/i;
const UK_PHONE = /^\s*(\+44|0044|0[127])/;
const US_PHONE = /^\s*(\+1|001)/;

function country(candidate) {
  const tag = String(candidate.country ?? '').toUpperCase();
  if (['GB', 'UK'].includes(tag)) return 'GB';
  if (tag === 'US') return 'US';
  if (UK_PHONE.test(candidate.phone ?? '') && !US_PHONE.test(candidate.phone ?? '')) return 'GB';
  if (US_PHONE.test(candidate.phone ?? '')) return 'US';
  return null;
}

const result = (kind, emailable, reason) => Object.freeze({ kind, emailable, reason });

export function classifyEmailEligibility(candidate, { companiesHouse } = {}) {
  const place = country(candidate);
  const ch = companiesHouse;
  if (ch && place !== 'US') {
    if (ch.found && ['ltd', 'plc', 'llp'].includes(ch.type) && ch.status === 'active') {
      return result('uk_limited', true, `Companies House lists an active ${ch.type}; PECR allows B2B email to companies with an opt-out`);
    }
    if (ch.found && ['sole_trader', 'partnership'].includes(ch.type)) {
      return result('uk_sole_or_partnership', false, 'Sole trader or ordinary partnership: PECR needs prior consent for marketing email');
    }
    if (ch.found) return result('uk_limited', 'ask', `Companies House entry is ${ch.type ?? 'of unknown type'} / ${ch.status ?? 'unknown status'}, not a clear active company`);
    return result('uk_sole_or_partnership', 'ask', 'No Companies House match, so probably a sole trader or partnership, but a name search can miss');
  }
  if (place === 'US') {
    return result('us_business', true, 'US business: CAN-SPAM allows it with honest headers, a postal address and a working opt-out');
  }
  if (place === 'GB') {
    return LIMITED_NAME.test(candidate.name ?? '')
      ? result('uk_limited', 'ask', 'Name ends in Ltd/Limited/LLP but nothing confirms the company is active; check Companies House')
      : result('unknown', 'ask', 'UK business with no Companies House result; sole traders cannot be emailed without consent');
  }
  if (US_NAME.test(candidate.name ?? '')) return result('unknown', 'ask', 'Name looks American but no country is known');
  return result('unknown', 'ask', 'Country and company type are not known');
}
