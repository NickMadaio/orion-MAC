/* Raw signal extraction from one page. Pure functions of the HTML string; regex scanning on purpose (no parser dependency). */
import { stripNonContent } from './html-text.mjs';

const count = (text, pattern) => (text.match(pattern) ?? []).length;
const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(2).find(v => v !== undefined);

function metaContent(html, name) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (attr(tag, 'name')?.toLowerCase() === name) return attr(tag, 'content') ?? '';
  }
  return null;
}

function copyrightYear(text) {
  const years = [...text.matchAll(/(?:©|&copy;|&#169;|\bcopyright\b)[^\n<]{0,60}?((?:19|20)\d\d)(?:\s*[-–]\s*((?:19|20)\d\d))?/gi)]
    .flatMap(m => [Number(m[1]), m[2] ? Number(m[2]) : 0]);
  return years.length ? Math.max(...years) : null;
}

function jqueryMajor(html) {
  const hits = [...html.matchAll(/jquery[-.\/]?(?:min[-.])?v?(\d+)\.(\d+)(?:\.(\d+))?/gi)];
  const majors = hits.map(m => Number(m[1]));
  return majors.length ? Math.min(...majors) : null;
}

function nestedTables(html) {
  let depth = 0; let max = 0;
  for (const m of html.matchAll(/<(\/?)table\b/gi)) { depth += m[1] ? -1 : 1; max = Math.max(max, depth); }
  return max;
}

function fixedWidthPx(html, thresholds) {
  const widths = [...html.matchAll(/(?:\bwidth\s*[=:]\s*["']?\s*|<table[^>]*\bwidth\s*=\s*["']?)(\d{3,4})(?:px)?\b/gi)].map(m => Number(m[1]));
  return widths.filter(w => w >= thresholds.fixedWidthPx && w <= thresholds.fixedWidthMaxPx && !/%/.test(String(w))).length > 0;
}

function brokenAnchors(html) {
  const ids = new Set([...html.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]));
  return [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']#([^"']+)["']/gi)].map(m => m[1]).filter(target => !ids.has(target));
}

export function extractSignals(rawHtml, { url = '', thresholds }) {
  const html = String(rawHtml);
  const visible = stripNonContent(html);
  const tags = visible.match(/<[a-z][^>\s]*/gi) ?? [];
  const styled = count(visible, /<[a-z][^>]*\sstyle\s*=/gi);
  const images = visible.match(/<img\b[^>]*>/gi) ?? [];
  const withAlt = images.filter(tag => (attr(tag, 'alt') ?? '').trim() !== '').length;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(visible)?.[1].trim() ?? '';
  const description = metaContent(visible, 'description');
  const generator = metaContent(visible, 'generator');
  return {
    https: /^https:/i.test(url), urlKnown: Boolean(url),
    viewport: metaContent(visible, 'viewport') !== null,
    copyrightYear: copyrightYear(visible),
    generator: generator ?? null,
    jqueryMajor: jqueryMajor(html),
    flashOrEmbed: /<embed\b|<object\b[^>]*(?:shockwave|\.swf|flash)|\.swf\b/i.test(visible),
    tableDepth: nestedTables(visible), tableCount: count(visible, /<table\b/gi),
    obsoleteTags: count(visible, /<(?:font|center|marquee|blink|frameset|frame|basefont)\b|\sbgcolor\s*=/gi),
    fixedWidth: fixedWidthPx(visible, thresholds),
    hasTitle: title.length > 0,
    hasDescription: Boolean(description && description.trim()),
    elementCount: tags.length, styledCount: styled,
    inlineStyleRatio: tags.length ? styled / tags.length : 0,
    imageCount: images.length, altCoverage: images.length ? withAlt / images.length : 1,
    brokenAnchors: brokenAnchors(visible),
  };
}
