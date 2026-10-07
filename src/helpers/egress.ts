/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2026 Data People Connected LTD.
 * <https://www.dpc-ltd.com/>
 *
 * This file is part of Buttress.
 * Buttress is free software: you can redistribute it and/or modify it under the
 * terms of the GNU Affero General Public Licence as published by the Free Software
 * Foundation, either version 3 of the Licence, or (at your option) any later version.
 * Buttress is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public Licence for more details.
 * You should have received a copy of the GNU Affero General Public Licence along with
 * this program. If not, see <http://www.gnu.org/licenses/>.
 */
import dns from 'node:dns';
import net from 'node:net';
import type { LookupFunction } from 'node:net';

import createConfig from '@dpc/node-env-obj';
const Config = createConfig() as unknown as Config;

// Where Buttress lets tenant-driven requests go, as an operator chooses with an allow-list of hosts: data sharing
// connections, and lambdas' fetch() and PDF rendering. With no list, requests go anywhere, as they always have. With
// one, a host has to be on it (`*` for any, `*.example.com` for its subdomains), and even then may not be at a
// loopback, private, link-local or shared address, which reach the instance's own network.

/**
 * The hosts of a comma-separated allow-list, in lower case.
 */
export const parseAllowedHosts = (value: unknown): string[] =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((host) => host.trim().toLowerCase())
        // An unset setting can come through as its own %NAME%
        .filter((host) => host !== '' && !host.startsWith('%'))
    : [];

const ipv4ToNumber = (ip: string) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const inIpv4Range = (ip: string, base: string, bits: number) => {
  const mask = bits === 0 ? 0 : 2 ** 32 - 2 ** (32 - bits);
  return (ipv4ToNumber(ip) & mask) >>> 0 === (ipv4ToNumber(base) & mask) >>> 0;
};
const NON_PUBLIC_IPV4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/**
 * The eight 16-bit groups of a valid IPv6 address, written in any of its forms: with `::`, in either case, with a zone,
 * or ending in a dotted IPv4 address.
 */
const ipv6Groups = (ip: string): number[] => {
  let address = ip.split('%')[0];
  const dotted = address.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const ipv4 = ipv4ToNumber(dotted[2]);
    address = `${dotted[1]}${Math.floor(ipv4 / 0x10000).toString(16)}:${(ipv4 % 0x10000).toString(16)}`;
  }

  const [head, tail] = address.split('::');
  const groupsOf = (part: string) => (part === '' ? [] : part.split(':').map((group) => parseInt(group, 16)));
  const before = groupsOf(head);
  const after = tail === undefined ? [] : groupsOf(tail);
  return [...before, ...new Array<number>(8 - before.length - after.length).fill(0), ...after];
};

/**
 * Whether an IP address is on the public internet, rather than loopback, private, link-local, shared, multicast or
 * reserved.
 */
export const isPublicAddress = (ip: string): boolean => {
  if (net.isIPv4(ip)) return !NON_PUBLIC_IPV4.some(([base, bits]) => inIpv4Range(ip, base, bits));
  if (!net.isIPv6(ip)) return false;

  const groups = ipv6Groups(ip);
  // An address that carries an IPv4 one in its last 32 bits reaches that IPv4 address, written in hex
  // (::ffff:7f00:1, as a URL gives it) or dotted: IPv4-compatible (::/96, which holds :: and ::1), IPv4-mapped
  // (::ffff:0:0/96), IPv4-translated (::ffff:0:0:0/96) and NAT64 (64:ff9b::/96)
  const prefix = groups
    .slice(0, 6)
    .map((group) => group.toString(16))
    .join(':');
  if (['0:0:0:0:0:0', '0:0:0:0:0:ffff', '0:0:0:0:ffff:0', '64:ff9b:0:0:0:0'].includes(prefix)) {
    const [high, low] = groups.slice(6);
    return isPublicAddress([high >> 8, high & 0xff, low >> 8, low & 0xff].join('.'));
  }
  // Unique local (fc00::/7), link-local (fe80::/10) and multicast (ff00::/8)
  const [first] = groups;
  return (first & 0xfe00) !== 0xfc00 && (first & 0xffc0) !== 0xfe80 && (first & 0xff00) !== 0xff00;
};

const hostAllowed = (host: string, allowedHosts: string[]) =>
  allowedHosts.some(
    (entry) => entry === '*' || entry === host || (entry.startsWith('*.') && host.endsWith(entry.slice(1))),
  );

/**
 * Why a request to `url` isn't allowed by `allowedHosts`, or null if it is. No allow-list allows every request.
 * @param {URL|string} url
 * @param {string[]} allowedHosts
 * @return {Promise<string|null>} - invalid_url, protocol_not_allowed, host_not_allowed or address_not_allowed
 */
export const checkDestination = async (url: URL | string, allowedHosts: string[]): Promise<string | null> => {
  if (allowedHosts.length < 1) return null;

  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    return 'invalid_url';
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return 'protocol_not_allowed';

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostAllowed(host, allowedHosts)) return 'host_not_allowed';

  try {
    const addresses = await dns.promises.lookup(host, { all: true });
    if (addresses.length < 1 || !addresses.every(({ address }) => isPublicAddress(address)))
      return 'address_not_allowed';
  } catch {
    return 'address_not_allowed';
  }
  return null;
};

/**
 * A lookup for http(s).request that refuses a non-public address when there's an allow-list, so the address connected
 * to is the one checked, even if the name resolves differently by then.
 * @param {string[]} allowedHosts
 * @return {LookupFunction|undefined}
 */
export const allowedAddressLookup = (allowedHosts: string[]): LookupFunction | undefined => {
  if (allowedHosts.length < 1) return undefined;

  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as dns.LookupAddress[];
      if (list.length < 1 || !list.every(({ address }) => isPublicAddress(address))) {
        return callback(new Error('address_not_allowed'), '', 0);
      }
      if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
};

/**
 * Why a data sharing agreement may not connect to one of `urls`, its remote app's endpoint and socket URL, or null.
 * @param {unknown[]} urls
 * @return {Promise<string|null>}
 */
export const dataSharingDestinationProblem = async (urls: unknown[]) => {
  const allowedHosts = parseAllowedHosts(Config.dataSharing?.allowedHosts);
  for (const url of urls) {
    if (url === undefined || url === null || url === '') continue;
    const problem = await checkDestination(String(url), allowedHosts);
    if (problem) return problem;
  }
  return null;
};

/**
 * The remote app URLs a data sharing agreement's updates set.
 * @param {unknown[]} updates - updates by path
 * @return {unknown[]}
 */
export const remoteAppUrlsOf = (updates: unknown[]) =>
  updates.flatMap((update) => {
    const { path, value } = (update ?? {}) as { path?: unknown; value?: unknown };
    if (path === 'remoteApp.endpoint' || path === 'remoteApp.ws') return [value];
    if (path === 'remoteApp' && value && typeof value === 'object') {
      const remoteApp = value as { endpoint?: unknown; ws?: unknown };
      return [remoteApp.endpoint, remoteApp.ws];
    }
    return [];
  });
