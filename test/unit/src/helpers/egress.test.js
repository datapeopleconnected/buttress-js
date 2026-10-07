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

import { describe, it } from 'mocha';
import assert from 'assert';

import { checkDestination, isPublicAddress, parseAllowedHosts } from '../../../../dist/helpers/egress.js';

describe('helpers/egress', () => {
  it('reads an allow-list of hosts', () => {
    assert.deepStrictEqual(parseAllowedHosts(' Partner.example.com, *.trusted.org ,,'), ['partner.example.com', '*.trusted.org']);
    assert.deepStrictEqual(parseAllowedHosts(''), []);
    assert.deepStrictEqual(parseAllowedHosts(undefined), []);
  });

  it('tells public addresses from loopback, private, link-local and shared ones', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) assert.strictEqual(isPublicAddress(ip), true, ip);
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    ]) {
      assert.strictEqual(isPublicAddress(ip), false, ip);
    }
  });

  it('judges an IPv6 address that carries an IPv4 one by that IPv4 address, in any of its forms', () => {
    for (const ip of [
      // IPv4-mapped loopback and private, in hex as a URL writes them, expanded, upper case and dotted
      '::ffff:7f00:1', '::ffff:a00:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:7f00:1', '0000:0000:0000:0000:0000:FFFF:7F00:0001',
      '::FFFF:127.0.0.1', '0:0:0:0:0:ffff:192.168.1.1',
      // IPv4-compatible, IPv4-translated and NAT64
      '::7f00:1', '::127.0.0.1', '::ffff:0:7f00:1', '::ffff:0:10.0.0.1', '64:ff9b::a00:1', '64:ff9b::127.0.0.1',
    ]) {
      assert.strictEqual(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['::ffff:5db8:d822', '::ffff:93.184.216.34', '64:ff9b::808:808', '::ffff:0:8.8.8.8']) {
      assert.strictEqual(isPublicAddress(ip), true, ip);
    }
  });

  it('tells IPv6 ranges apart by their value rather than how the address is written', () => {
    for (const ip of ['FD12:3456::1', 'fe80::1%eth0', 'febf::1', 'ff02::1', '0:0:0:0:0:0:0:1', '0::0']) {
      assert.strictEqual(isPublicAddress(ip), false, ip);
    }
    // fc0::, fe0:: and ff0:: are 0fc0::, 0fe0:: and 0ff0::, which are none of those
    for (const ip of ['fc0::1', 'fe0::1', 'ff0::1', '2001:db8:fe80::1', '2a00:1450::ffff:7f00:1']) {
      assert.strictEqual(isPublicAddress(ip), true, ip);
    }
  });

  it('refuses a URL to an IPv4-mapped loopback address under a * allow-list, however it is written', async () => {
    for (const url of ['http://[::ffff:7f00:1]/', 'http://[::ffff:127.0.0.1]:9200/', 'http://[0:0:0:0:0:ffff:7f00:1]/']) {
      assert.strictEqual(await checkDestination(url, ['*']), 'address_not_allowed', url);
    }
  });

  it('allows any destination when no allow-list is set', async () => {
    assert.strictEqual(await checkDestination('http://127.0.0.1:9200/', []), null);
  });

  it('allows only listed hosts, by name or wildcard, when an allow-list is set', async () => {
    assert.strictEqual(await checkDestination('https://93.184.216.34/x', ['93.184.216.34']), null);
    assert.strictEqual(await checkDestination('https://8.8.8.8/x', ['93.184.216.34']), 'host_not_allowed');
    assert.strictEqual(await checkDestination('https://other.example/x', ['*.trusted.org']), 'host_not_allowed');
  });

  it('refuses a listed host at a private address, and a URL that is not http(s) or ws(s)', async () => {
    assert.strictEqual(await checkDestination('http://127.0.0.1/', ['127.0.0.1']), 'address_not_allowed');
    assert.strictEqual(await checkDestination('http://localhost:8000/', ['localhost']), 'address_not_allowed');
    assert.strictEqual(await checkDestination('file:///etc/passwd', ['*']), 'protocol_not_allowed');
    assert.strictEqual(await checkDestination('not a url', ['*']), 'invalid_url');
  });
});
