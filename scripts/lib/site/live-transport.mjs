/*
 The only code here that can touch the network. It is never built unless the
 caller passed live: true (see fetcher.mjs). It connects to the exact address the
 fetcher already checked, so a name cannot resolve to something else between the
 check and the connection. It never follows redirects; the fetcher does, with a
 fresh address check on every hop.
*/
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';

export function createLiveResolver() {
  return async host => (await dns.promises.lookup(host, { all: true, verbatim: true })).map(entry => entry.address);
}

export function createLiveTransport() {
  return ({ url, headers, address, timeoutMs, maxBytes, signal }) => new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const family = address.includes(':') ? 6 : 4;
    const request = client.request(target, {
      method: 'GET', headers, signal, timeout: timeoutMs,
      lookup: (_host, _options, callback) => callback(null, address, family),
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { request.destroy(new Error(`response is larger than ${maxBytes} bytes`)); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    request.on('error', reject);
    request.end();
  });
}
