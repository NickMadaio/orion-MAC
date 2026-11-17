/*
 Which addresses a fetch may reach. Anything private, loopback, link-local,
 carrier-grade NAT, multicast, reserved or a cloud metadata address is refused,
 as are IPv4-mapped/compatible forms of those and the transition prefixes
 (6to4, Teredo, NAT64) that tunnel to an IPv4 address.
 Every A/AAAA record of a name is checked, not just the first.
*/
import { isIP } from 'node:net';

export class BlockedAddressError extends Error {
  constructor(message) { super(message); this.name = 'BlockedAddressError'; }
}

function v4Parts(address) { return address.split('.').map(Number); }

function blockedV4(address) {
  const [a, b, c] = v4Parts(address);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)                 // link-local and 169.254.169.254 metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function v6Groups(address) {
  const [head, tail] = address.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const embedded = [...left, ...right].at(-1)?.includes('.') ? [...left, ...right].at(-1) : null;
  const expand = parts => parts.flatMap(part => {
    if (!part.includes('.')) return [parseInt(part || '0', 16)];
    const [a, b, c, d] = v4Parts(part);
    return [(a << 8) | b, (c << 8) | d];
  });
  const l = expand(left); const r = expand(right);
  const fill = tail === undefined ? [] : Array(Math.max(0, 8 - l.length - r.length)).fill(0);
  return { groups: [...l, ...fill, ...r], embedded };
}

function blockedV6(address) {
  const { groups } = v6Groups(address);
  if (groups.length !== 8 || groups.some(Number.isNaN)) return true;
  const allZeroTo = n => groups.slice(0, n).every(g => g === 0);
  if (allZeroTo(7) && groups[7] <= 1) return true;               // :: and ::1
  const mapped = allZeroTo(5) && groups[5] === 0xffff;             // ::ffff:a.b.c.d
  const compat = allZeroTo(6);                                      // ::a.b.c.d
  if (mapped || compat) {
    return blockedV4([groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.'));
  }
  const first = groups[0];
  // Transition prefixes reach an IPv4 address through a relay or translator we
  // do not control, so they are refused whatever address is embedded.
  if (first === 0x2002) return true;                                   // 6to4, 2002::/16
  if (first === 0x2001 && groups[1] === 0) return true;                // Teredo, 2001::/32
  if (first === 0x64 && groups[1] === 0xff9b && groups[2] === 0) return true; // NAT64 64:ff9b::/96
  if (first === 0x64 && groups[1] === 0xff9b && groups[2] === 1) return true; // local NAT64 64:ff9b:1::/48
  return (first & 0xfe00) === 0xfc00     // fc00::/7 unique local (includes fd00:ec2::254)
    || (first & 0xffc0) === 0xfe80       // link-local
    || (first & 0xffc0) === 0xfec0       // site-local
    || (first & 0xff00) === 0xff00       // multicast
    || (first === 0x2001 && groups[1] === 0x0db8); // documentation
}

export function isBlockedAddress(address) {
  const family = isIP(String(address));
  if (family === 4) return blockedV4(address);
  if (family === 6) return blockedV6(address);
  return true; // not an IP literal: never trust it
}

/** Throws BlockedAddressError unless every address is public. */
export function assertPublicAddresses(host, addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) throw new BlockedAddressError(`"${host}" did not resolve to any address`);
  for (const address of addresses) {
    if (isBlockedAddress(address)) throw new BlockedAddressError(`"${host}" resolves to ${address}, which is not a public address`);
  }
}
