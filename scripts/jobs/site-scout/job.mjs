/*
 site-scout: find small businesses, score how dated their website is, and stop
 for the owner before the cards go anywhere. Stages 2, 4, 6 and 7 of the
 site-pitch plan (HANDOFF 11). Nothing is built, hosted or emailed here.

 Every step is an allowlisted `echo` of JSON that pure functions computed from
 data, so the runner's rule holds: step outputs are data, never a command. The
 default is fixtures only. `--input live=on` is refused because the runner has
 no allowlisted fetch command yet (see D3-site-scout.md); nothing here can
 reach the network either way.
*/
import { approvalFields, cardsFor, classifyCandidates, discoverFromResponse, loadFixtureDir, scoreCandidates } from '../../lib/site/pipeline.mjs';

// A name under tests/fixtures/site (pipeline.mjs FIXTURE_ROOT); absolute paths and escapes are refused there.
const DEFAULT_FIXTURES = 'job';

function requireOffline(input) {
  if (input.live !== 'off') {
    throw new Error('site-scout live mode is not available: the jobs allowlist has no fetch command yet, so this job runs on fixtures only');
  }
}

const fixtures = ctx => loadFixtureDir(ctx.input.fixtures || DEFAULT_FIXTURES);
const year = ctx => Number(ctx.input.year) || new Date().getFullYear();
const read = (ctx, id) => {
  try { return JSON.parse(ctx.outputs[id].stdout); }
  catch (error) { throw new Error(`step "${id}" left output that is not JSON: ${error.message}`); }
};
const emit = value => [JSON.stringify(value)]; // one JSON argument (an object or array, so never a flag)

export default {
  name: 'site-scout',
  description: 'Find local businesses, score how dated their sites are (fixtures only), classify email eligibility, build cards, stop for approval.',
  inputs: {
    live: { maxLength: 3, default: 'off' },
    fixtures: { maxLength: 100, default: '' },
    town: { maxLength: 60, default: 'Testford' },
    year: { maxLength: 4, default: '' },
  },
  steps: [
    { id: 'discover', kind: 'script', command: 'echo', args: ctx => {
      requireOffline(ctx.input);
      return emit(discoverFromResponse(fixtures(ctx).overpass, ctx.input.town));
    } },
    { id: 'score', kind: 'script', command: 'echo', args: ctx => {
      const f = fixtures(ctx);
      return emit(scoreCandidates(read(ctx, 'discover'), f.pageHtml, year(ctx)));
    } },
    { id: 'classify', kind: 'script', command: 'echo', args: ctx =>
      emit(classifyCandidates(read(ctx, 'score'), fixtures(ctx).companies)) },
    { id: 'cards', kind: 'script', command: 'echo', args: ctx =>
      emit(cardsFor(read(ctx, 'classify'), fixtures(ctx).ratings)) },
    { id: 'approve', kind: 'approval', summary: 'Site scout: send these cards to the owner?',
      fields: ctx => approvalFields(read(ctx, 'cards')) },
  ],
};
