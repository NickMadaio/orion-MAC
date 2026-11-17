// Importing this makes any real network or DNS use in a site test throw.
import net from 'node:net';
import dns from 'node:dns';

const refuse = what => () => { throw new Error(`site tests must stay offline, but ${what} was called`); };
net.Socket.prototype.connect = refuse('net.Socket.connect');
dns.lookup = refuse('dns.lookup');
dns.resolve = refuse('dns.resolve');
dns.promises.lookup = refuse('dns.promises.lookup');
dns.promises.resolve = refuse('dns.promises.resolve');
globalThis.fetch = refuse('fetch');
