/*
 Score one fetched page for datedness, no model. Output:
 { points, band: old|mid|new, reasons: top three, signals: all that fired, raw }.
 The page text is data: nothing in it chooses what this function does.
*/
import { SCORE_CONFIG } from './score-config.mjs';
import { extractSignals } from './score-signals.mjs';

export const bandFor = (points, config = SCORE_CONFIG) =>
  points >= config.bands.old ? 'old' : points >= config.bands.mid ? 'mid' : 'new';

function rules(raw, input, c) {
  const w = c.weights; const t = c.thresholds;
  const age = raw.copyrightYear ? input.nowYear - raw.copyrightYear : null;
  const generator = raw.generator?.toLowerCase() ?? '';
  const fired = [
    raw.urlKnown && !raw.https && ['notHttps', w.notHttps, 'Not served over HTTPS, browsers warn visitors'],
    !raw.viewport && ['noViewport', w.noViewport, 'No mobile viewport tag, so it is not built for phones'],
    age !== null && age >= t.copyrightOldYears && ['copyrightOld', w.copyrightOld, `Footer copyright year is ${raw.copyrightYear}`],
    age !== null && age >= t.copyrightDatedYears && age < t.copyrightOldYears && ['copyrightDated', w.copyrightDated, `Footer copyright year is ${raw.copyrightYear}`],
    c.oldGenerators.some(g => generator.includes(g)) && ['oldGenerator', w.oldGenerator, `Built with dated software (${raw.generator})`],
    raw.jqueryMajor === 1 && ['oldJquery', w.oldJquery, 'Loads jQuery 1.x, a library from the early 2010s'],
    raw.flashOrEmbed && ['flashOrEmbed', w.flashOrEmbed, 'Uses Flash or an embedded plug-in that no browser runs'],
    raw.tableDepth >= t.tablesForLayout && ['tableLayout', w.tableLayout, 'Page layout is built from nested tables'],
    raw.obsoleteTags >= t.obsoleteTagCount && ['obsoleteTags', w.obsoleteTags, 'Uses obsolete tags such as font, center or marquee'],
    raw.fixedWidth && ['fixedWidth', w.fixedWidth, 'Fixed-width layout that does not adapt to screen size'],
    !raw.hasTitle && ['noTitle', w.noTitle, 'Page has no title'],
    !raw.hasDescription && ['noDescription', w.noDescription, 'No meta description for search results'],
    raw.elementCount >= t.inlineStyleMinElements && raw.inlineStyleRatio >= t.inlineStyleRatio
      && ['inlineStyles', w.inlineStyles, `Styling is mostly inline (${Math.round(raw.inlineStyleRatio * 100)}% of elements)`],
    raw.imageCount >= t.altMinImages && raw.altCoverage < t.altCoverage
      && ['poorAlt', w.poorAlt, `Only ${Math.round(raw.altCoverage * 100)}% of images have alt text`],
    raw.brokenAnchors.length >= t.brokenAnchorCount && ['brokenAnchors', w.brokenAnchors, `${raw.brokenAnchors.length} in-page links point nowhere`],
    Number.isFinite(input.pageSpeed) && input.pageSpeed < t.pageSpeedSlow && ['slowPageSpeed', w.slowPageSpeed, `PageSpeed score is ${input.pageSpeed}`],
    Number.isFinite(input.pageSpeed) && input.pageSpeed >= t.pageSpeedSlow && input.pageSpeed < t.pageSpeedMiddling
      && ['middlingPageSpeed', w.middlingPageSpeed, `PageSpeed score is ${input.pageSpeed}`],
    Number.isFinite(input.waybackYear) && input.nowYear - input.waybackYear >= t.waybackYearsAgo
      && ['ancientWayback', w.ancientWayback, `First archived in ${input.waybackYear}`],
  ];
  return fired.filter(Boolean).map(([id, points, reason]) => Object.freeze({ id, points, reason }));
}

/** input: { html, url?, nowYear, pageSpeed?, waybackYear? } */
export function scorePage(input, config = SCORE_CONFIG) {
  if (typeof input?.html !== 'string') throw new TypeError('scorePage needs the page html as a string');
  if (!Number.isInteger(input.nowYear)) throw new TypeError('scorePage needs nowYear (an integer)');
  const raw = extractSignals(input.html, { url: input.url ?? '', thresholds: config.thresholds });
  const signals = rules(raw, input, config);
  const points = Math.min(config.maxPoints, signals.reduce((sum, s) => sum + s.points, 0));
  const reasons = [...signals].sort((a, b) => b.points - a.points).slice(0, 3).map(s => s.reason);
  return Object.freeze({ points, band: bandFor(points, config), reasons, signals, raw });
}
