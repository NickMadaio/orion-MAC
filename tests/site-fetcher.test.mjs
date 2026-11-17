import './site-nonet.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFetcher, FetchError, USER_AGENT, parseTarget } from '../scripts/lib/site/fetcher.mjs';
import { isBlockedAddress } from '../scripts/lib/site/net-guard.mjs';
import { isAllowedByRobots, parseRobots } from '../scripts/lib/site/robots.mjs';
import { htmlToText } from '../scripts/lib/site/html-text.mjs';
import { isTainted, unwrap } from '../scripts/lib/site/untrusted.mjs';

const PAGE = '<html><head><title>T</title><style>p{color:red}</style></head><body><script>alert(1)</script><p>Hello &amp; welcome</p></body></html>';

/** Stub world: routes is host+path -> reply; dns maps host -> addresses. */
function world({ routes = {}, dns = {}, robots = {} } = {}) {
  const calls = [];
  const resolveCalls = [];
  const stubDns = { 'a.test': ['93.184.216.34'], 'b.test': ['93.184.216.35'], ...dns };
  const resolve = async host => { resolveCalls.push(host); if (!stubDns[host]) throw new Error(`no such host ${host}`); return stubDns[host]; };
  const transport = async request => {
    const url = new URL(request.url);
    calls.push({ ...request, key: url.host + url.pathname });
    if (url.pathname === '/robots.txt') {
      const body = robots[url.host];
      return body === undefined ? { status: 404, headers: {}, body: '' } : { status: 200, headers: { 'content-type': 'text/plain' }, body };
    }
    const reply = routes[url.host + url.pathname];
    if (!reply) return { status: 404, headers: { 'content-type': 'text/html' }, body: 'nope' };
    return { headers: { 'content-type': 'text/html; charset=utf-8' }, ...reply };
  };
  const sleeps = [];
  let clock = 1_000_000;
  const fetcher = createFetcher({ resolve, transport, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } });
  return { fetcher, calls, resolveCalls, sleeps, advance: ms => { clock += ms; } };
}

test('default fetcher refuses all network use unless live is passed', async () => {
  const f = createFetcher();
  await assert.rejects(f.fetchPage('https://example.com/'), /DNS lookup is disabled/);
  const half = createFetcher({ resolve: async () => ['93.184.216.34'] });
  await assert.rejects(half.fetchPage('https://example.com/'), /network transport is disabled/);
});

test('returns the shape: status, finalUrl, headers subset, html, text, fetchedAt, all untrusted', async () => {
  const w = world({ routes: { 'a.test/': { status: 200, body: PAGE, headers: { 'content-type': 'text/html', server: 'x', 'set-cookie': 'secret=1' } } } });
  const r = await w.fetcher.fetchPage('https://a.test/');
  assert.equal(r.status, 200);
  assert.ok(isTainted(r.finalUrl) && isTainted(r.html) && isTainted(r.text));
  assert.equal(unwrap(r.finalUrl), 'https://a.test/');
  assert.deepEqual(Object.keys(r.headers).sort(), ['content-type', 'server']);
  assert.ok(Object.values(r.headers).every(isTainted));
  assert.equal(unwrap(r.html), PAGE);
  assert.equal(unwrap(r.text), 'T\nHello & welcome');
  assert.match(r.fetchedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(w.calls.at(-1).method, 'GET');
  assert.equal(w.calls.at(-1).headers['user-agent'], USER_AGENT);
  assert.doesNotMatch(USER_AGENT, /nick|@|\/Users/i);
});

test('only http and https, no credentials, no odd ports', () => {
  for (const bad of ['ftp://a.test/', 'file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@a.test/', 'http://a.test:8080/', 'nonsense'])
    assert.throws(() => parseTarget(bad), FetchError, bad);
});

test('address guard covers private, loopback, link-local, metadata and mapped forms', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.5.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fe80::1', 'fd00:ec2::254', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.1.1.1', '::ffff:a9fe:a9fe', 'not-an-ip'])
    assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '172.32.0.1'])
    assert.equal(isBlockedAddress(ip), false, ip);
});

test('refuses a host if ANY of its A/AAAA records is private, before any request', async () => {
  const w = world({ dns: { 'mixed.test': ['93.184.216.34', '10.0.0.5'], 'six.test': ['2606:4700:4700::1111', '::1'], 'meta.test': ['169.254.169.254'] } });
  for (const host of ['mixed.test', 'six.test', 'meta.test']) await assert.rejects(w.fetcher.fetchPage(`https://${host}/`), /not a public address/);
  await assert.rejects(w.fetcher.fetchPage('http://127.0.0.1/'), /not a public address/);
  await assert.rejects(w.fetcher.fetchPage('http://[::1]/'), /not a public address/);
  assert.equal(w.calls.length, 0);
});

test('follows up to 3 redirects, re-checking the address on each hop', async () => {
  const w = world({ routes: {
    'a.test/1': { status: 301, headers: { location: 'https://b.test/2' } },
    'b.test/2': { status: 302, headers: { location: '/3' } },
    'b.test/3': { status: 200, body: PAGE } } });
  const r = await w.fetcher.fetchPage('https://a.test/1');
  assert.equal(unwrap(r.finalUrl), 'https://b.test/3');
  assert.equal(r.redirects, 2);
  assert.ok(w.resolveCalls.filter(h => h === 'b.test').length >= 2);
});

test('a redirect into a private address is refused', async () => {
  const w = world({ dns: { 'evil.test': ['192.168.0.9'] }, routes: { 'a.test/': { status: 302, headers: { location: 'http://evil.test/x' } } } });
  await assert.rejects(w.fetcher.fetchPage('https://a.test/'), /not a public address/);
  const metadata = world({ routes: { 'a.test/': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } } } });
  await assert.rejects(metadata.fetcher.fetchPage('https://a.test/'), /not a public address/);
  const scheme = world({ routes: { 'a.test/': { status: 302, headers: { location: 'file:///etc/passwd' } } } });
  await assert.rejects(scheme.fetcher.fetchPage('https://a.test/'), /scheme/);
});

test('a fourth redirect fails', async () => {
  const hop = n => ({ status: 302, headers: { location: `/${n + 1}` } });
  const w = world({ routes: { 'a.test/0': hop(0), 'a.test/1': hop(1), 'a.test/2': hop(2), 'a.test/3': hop(3), 'a.test/4': { status: 200, body: PAGE } } });
  await assert.rejects(w.fetcher.fetchPage('https://a.test/0'), /more than 3 redirects/);
});

test('size cap: a body over 2 MB is refused; the cap is passed to the transport', async () => {
  const w = world({ routes: { 'a.test/big': { status: 200, body: 'x'.repeat(2 * 1024 * 1024 + 1) } } });
  await assert.rejects(w.fetcher.fetchPage('https://a.test/big'), /larger than 2097152/);
  assert.equal(w.calls.at(-1).maxBytes, 2 * 1024 * 1024);
});

test('time cap: a transport that hangs is cut off', async () => {
  const f = createFetcher({ resolve: async () => ['93.184.216.34'], transport: () => new Promise(() => {}),
    limits: { timeoutMs: 20, minDelayMs: 0 }, respectRobots: false });
  await assert.rejects(f.fetchPage('https://a.test/'), /timed out after 20 ms/);
});

test('robots.txt is fetched through the same transport and obeyed for the path', async () => {
  const w = world({ robots: { 'a.test': 'User-agent: *\nDisallow: /private\nAllow: /private/ok' },
    routes: { 'a.test/private/x': { status: 200, body: PAGE }, 'a.test/private/ok': { status: 200, body: PAGE }, 'a.test/open': { status: 200, body: PAGE } } });
  await assert.rejects(w.fetcher.fetchPage('https://a.test/private/x'), /robots.txt on a.test disallows/);
  assert.equal((await w.fetcher.fetchPage('https://a.test/private/ok')).status, 200);
  assert.equal((await w.fetcher.fetchPage('https://a.test/open')).status, 200);
  assert.equal(w.calls.filter(c => c.key === 'a.test/robots.txt').length, 1, 'robots cached per host');
  assert.equal(w.calls.some(c => c.key === 'a.test/private/x'), false, 'disallowed page is never requested');
});

test('robots parsing: our group beats *, longest rule wins, 5xx disallows all', async () => {
  const r = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: OrionSiteScout\nDisallow: /admin\n', USER_AGENT);
  assert.equal(isAllowedByRobots(r, '/menu'), true);
  assert.equal(isAllowedByRobots(r, '/admin/x'), false);
  assert.equal(isAllowedByRobots(parseRobots('User-agent: *\nDisallow: /*.pdf$', USER_AGENT), '/a.pdf'), false);
  const w = world({ routes: { 'a.test/': { status: 200, body: PAGE } } });
  const f = createFetcher({ resolve: async () => ['93.184.216.34'], transport: async q => (q.url.endsWith('/robots.txt') ? { status: 503, headers: {}, body: '' } : { status: 200, headers: {}, body: PAGE }), limits: { minDelayMs: 0 } });
  await assert.rejects(f.fetchPage('https://a.test/'), /disallows/);
  assert.ok(w);
});

test('minimum delay per host: second request to the same host waits, another host does not', async () => {
  const w = world({ routes: { 'a.test/1': { status: 200, body: PAGE }, 'a.test/2': { status: 200, body: PAGE }, 'b.test/1': { status: 200, body: PAGE } } });
  await w.fetcher.fetchPage('https://a.test/1');
  assert.deepEqual(w.sleeps, [2000], 'robots then page on one host: page waits for the delay');
  await w.fetcher.fetchPage('https://a.test/2');
  assert.deepEqual(w.sleeps, [2000, 2000]);
  const before = w.sleeps.length;
  await w.fetcher.fetchPage('https://b.test/1');
  assert.equal(w.sleeps.length, before + 1, 'b.test robots.txt is its first hit; only its page waits');
});

test('unaccepted content types are refused', async () => {
  const w = world({ routes: { 'a.test/f.zip': { status: 200, body: 'PK', headers: { 'content-type': 'application/zip' } } } });
  await assert.rejects(w.fetcher.fetchPage('https://a.test/f.zip'), /not accepted/);
});

test('htmlToText drops scripts, styles, comments and decodes entities', () => {
  assert.equal(htmlToText('<style>a{}</style><!-- x --><script>evil()</script><h1>Hi&nbsp;there</h1><p>&#169; 2020</p>'), 'Hi there\n\n© 2020');
});

test('the network guard in this file is live: real dns and fetch throw', async () => {
  const dns = (await import('node:dns')).default;
  assert.throws(() => dns.lookup('example.com', () => {}), /stay offline/);
  assert.throws(() => globalThis.fetch('https://example.com'), /stay offline/);
});
