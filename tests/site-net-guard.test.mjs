import './site-nonet.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicAddresses, BlockedAddressError, isBlockedAddress } from '../scripts/lib/site/net-guard.mjs';

test('transition prefixes that can tunnel to any IPv4 address are refused outright', () => {
  for (const ip of [
    '2002:c0a8:0101::1',        // 6to4 wrapping 192.168.1.1
    '2002:5db8:d822::1',        // 6to4 wrapping a public address: still refused, the relay is not ours to trust
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '2001::1',
    '64:ff9b::808:808',         // NAT64 well-known prefix, public 8.8.8.8 inside
    '64:ff9b::7f00:1',
    '64:ff9b:1::1',             // local-use NAT64 /48
    '64:ff9b:1:ffff::a00:1',
  ]) assert.equal(isBlockedAddress(ip), true, ip);
});

test('IPv4-compatible and IPv4-mapped forms of private ranges are refused in either notation', () => {
  for (const ip of ['::ffff:192.168.0.1', '::ffff:c0a8:1', '::ffff:7f00:1', '::127.0.0.1', '::10.0.0.1', '::a00:1',
    '::ffff:172.16.0.1', '::ffff:100.64.0.1', '0:0:0:0:0:ffff:a9fe:a9fe'])
    assert.equal(isBlockedAddress(ip), true, ip);
});

test('ordinary public IPv6 is still allowed, and 2001:db8 stays blocked', () => {
  for (const ip of ['2606:4700:4700::1111', '2a00:1450:4009:81f::200e', '2001:4860:4860::8888'])
    assert.equal(isBlockedAddress(ip), false, ip);
  assert.equal(isBlockedAddress('2001:db8::1'), true);
  assert.throws(() => assertPublicAddresses('x.test', ['93.184.216.34', '2002:a00:1::1']), BlockedAddressError);
});
