/*
 Agreement between the rubric and hand labels. A labels file is JSON:
 { "nowYear": 2026, "pages": [ { "file": "pages/x.html", "url": "https://x.example/", "expected": "old",
   "pageSpeed"?: 40, "waybackYear"?: 2009 } ] }
 Files are relative to the labels file. Run on 20 real saved pages to tune score-config.mjs.
*/
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scorePage } from './score.mjs';
import { SCORE_CONFIG } from './score-config.mjs';

const BANDS = ['old', 'mid', 'new'];

export function calibrate(labelsPath, config = SCORE_CONFIG) {
  const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
  if (!Array.isArray(labels.pages) || !Number.isInteger(labels.nowYear)) throw new Error('labels file needs nowYear and a pages array');
  const rows = labels.pages.map(entry => {
    if (!BANDS.includes(entry.expected)) throw new Error(`label for ${entry.file} must be old, mid or new`);
    const html = readFileSync(join(dirname(labelsPath), entry.file), 'utf8');
    const result = scorePage({ html, url: entry.url, nowYear: labels.nowYear, pageSpeed: entry.pageSpeed, waybackYear: entry.waybackYear }, config);
    return { file: entry.file, expected: entry.expected, got: result.band, points: result.points, agree: entry.expected === result.band };
  });
  const confusion = Object.fromEntries(BANDS.map(e => [e, Object.fromEntries(BANDS.map(g => [g, rows.filter(r => r.expected === e && r.got === g).length]))]));
  const agree = rows.filter(r => r.agree).length;
  return Object.freeze({ total: rows.length, agree, accuracy: rows.length ? agree / rows.length : 0, rows, confusion,
    disagreements: rows.filter(r => !r.agree) });
}
