/* Thresholds and weights for the datedness rubric (HANDOFF 9.3). Tune here, nowhere else. */
export const SCORE_CONFIG = Object.freeze({
  bands: Object.freeze({ old: 50, mid: 20 }),            // points >= old -> old; >= mid -> mid; else new
  maxPoints: 100,
  weights: Object.freeze({
    notHttps: 15,
    noViewport: 15,
    copyrightOld: 15,        // footer year 6+ years back
    copyrightDated: 8,       // 3 to 5 years back
    oldGenerator: 10,
    oldJquery: 8,
    flashOrEmbed: 12,
    tableLayout: 8,
    obsoleteTags: 8,         // font, center, marquee, blink, frameset, bgcolor
    fixedWidth: 6,
    noTitle: 5,
    noDescription: 5,
    inlineStyles: 6,
    poorAlt: 6,
    brokenAnchors: 5,
    slowPageSpeed: 10,       // optional input
    middlingPageSpeed: 5,
    ancientWayback: 3,       // optional input
  }),
  thresholds: Object.freeze({
    copyrightOldYears: 6, copyrightDatedYears: 3,
    tablesForLayout: 2,
    obsoleteTagCount: 2,
    fixedWidthPx: 700,       // a hard width this big or bigger, up to 1100
    fixedWidthMaxPx: 1100,
    inlineStyleRatio: 0.3, inlineStyleMinElements: 10,
    altCoverage: 0.5, altMinImages: 3,
    brokenAnchorCount: 2,
    pageSpeedSlow: 50, pageSpeedMiddling: 75,
    waybackYearsAgo: 12,
  }),
  oldGenerators: Object.freeze(['frontpage', 'dreamweaver', 'iweb', 'microsoft word', 'publisher', 'web builder', 'namo', 'composer',
    'joomla! 1', 'joomla 1', 'wordpress 2', 'wordpress 3', 'wordpress 4', 'drupal 6', 'drupal 7']),
});
