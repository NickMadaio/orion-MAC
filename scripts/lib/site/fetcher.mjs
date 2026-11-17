/*
 Guarded GET fetcher. Fully injectable: resolve (DNS), transport (the wire),
 now and sleep (the clock). Without live: true the defaults THROW, so nothing in
 a test or a fixture run can reach the network by accident.

 Rules: GET only; http/https on ports 80/443 only; no credentials in the URL;
 every address a name resolves to must be public, checked again on each redirect
 (max 3); body capped at 2 MB; time cap; robots.txt for the path is fetched
 through the same guarded transport and obeyed; a minimum delay per host.
 Everything that came from the web is returned wrapped as untrusted data.
*/
import { isIP } from 'node:net';
import { assertPublicAddresses } from './net-guard.mjs';
import { isAllowedByRobots, parseRobots } from './robots.mjs';
import { htmlToText } from './html-text.mjs';
import { tainted } from './untrusted.mjs';
import { createLiveResolver, createLiveTransport } from './live-transport.mjs';

export const USER_AGENT = 'OrionSiteScout/1.0 (low-volume research crawler; honours robots.txt)';
export const LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxRobotsBytes: 256 * 1024,
  maxRedirects: 3, timeoutMs: 10_000, minDelayMs: 2_000 });
const KEPT_HEADERS = ['content-type', 'content-language', 'last-modified', 'server', 'x-powered-by'];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_ACCEPT = ['text/html', 'application/xhtml+xml', 'text/plain'];

export class FetchError extends Error {
  constructor(message) { super(message); this.name = 'FetchError'; }
}

const offline = what => () => { throw new FetchError(`${what} is disabled: pass live: true to allow network access`); };

export function parseTarget(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new FetchError(`not a valid URL: ${String(raw).slice(0, 80)}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError(`scheme "${url.protocol}" is not allowed`);
  if (url.username || url.password) throw new FetchError('URLs with credentials are not allowed');
  if (url.port && url.port !== '80' && url.port !== '443') throw new FetchError(`port ${url.port} is not allowed`);
  url.hash = '';
  return url;
}

const lower = headers => Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));

export function createFetcher(options = {}) {
  const live = options.live === true;
  const resolve = options.resolve ?? (live ? createLiveResolver() : offline('DNS lookup'));
  const transport = options.transport ?? (live ? createLiveTransport() : offline('the network transport'));
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
  const limits = { ...LIMITS, ...options.limits };
  const accept = options.accept ?? DEFAULT_ACCEPT;
  const respectRobots = options.respectRobots !== false;
  const lastHit = new Map();
  const robotsByOrigin = new Map();

  async function checkedAddress(url) {
    const addresses = isIP(url.hostname.replace(/^\[|\]$/g, '')) ? [url.hostname.replace(/^\[|\]$/g, '')] : await resolve(url.hostname);
    assertPublicAddresses(url.hostname, addresses);
    return addresses[0];
  }

  async function once(url, maxBytes) {
    const address = await checkedAddress(url);
    const wait = (lastHit.get(url.hostname) ?? -Infinity) + limits.minDelayMs - now();
    if (wait > 0) await sleep(wait);
    lastHit.set(url.hostname, now());
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new FetchError(`timed out after ${limits.timeoutMs} ms`)); }, limits.timeoutMs);
    });
    try {
      const reply = await Promise.race([transport({ url: url.href, method: 'GET', address, maxBytes,
        timeoutMs: limits.timeoutMs, signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: accept.join(','), 'accept-encoding': 'identity' } }), timeout]);
      const body = typeof reply.body === 'string' ? reply.body : Buffer.from(reply.body ?? '').toString('utf8');
      if (Buffer.byteLength(body) > maxBytes) throw new FetchError(`response is larger than ${maxBytes} bytes`);
      return { status: Number(reply.status), headers: lower(reply.headers), body };
    } finally { clearTimeout(timer); }
  }

  async function robotsFor(url) {
    if (!respectRobots) return null;
    if (!robotsByOrigin.has(url.origin)) {
      const reply = await once(new URL('/robots.txt', url.origin), limits.maxRobotsBytes);
      const rules = reply.status >= 500 ? { rules: [{ allow: false, path: '/' }] }
        : reply.status >= 400 ? { rules: [] } : parseRobots(reply.body, USER_AGENT);
      robotsByOrigin.set(url.origin, rules);
    }
    return robotsByOrigin.get(url.origin);
  }

  async function fetchPage(rawUrl) {
    let url = parseTarget(rawUrl);
    for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
      const robots = await robotsFor(url);
      if (robots && !isAllowedByRobots(robots, url.pathname + url.search)) {
        throw new FetchError(`robots.txt on ${url.host} disallows ${url.pathname}`);
      }
      const reply = await once(url, limits.maxBytes);
      if (REDIRECTS.has(reply.status) && reply.headers.location) {
        if (hop === limits.maxRedirects) throw new FetchError(`more than ${limits.maxRedirects} redirects`);
        url = parseTarget(new URL(reply.headers.location, url).href);
        continue;
      }
      const type = (reply.headers['content-type'] ?? 'text/html').split(';')[0].trim().toLowerCase();
      if (reply.status < 300 && !accept.includes(type)) throw new FetchError(`content type "${type.slice(0, 40)}" is not accepted`);
      return Object.freeze({
        status: reply.status,
        finalUrl: tainted(url.href),
        headers: Object.freeze(Object.fromEntries(KEPT_HEADERS.filter(k => reply.headers[k] !== undefined).map(k => [k, tainted(reply.headers[k])]))),
        html: tainted(reply.body),
        text: tainted(htmlToText(reply.body)),
        redirects: hop,
        fetchedAt: new Date(now()).toISOString(),
      });
    }
    throw new FetchError('redirect loop');
  }

  return Object.freeze({ fetchPage, userAgent: USER_AGENT, limits });
}
