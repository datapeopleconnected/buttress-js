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

import { describe, it, afterEach } from 'mocha';
import assert from 'assert';
import sinon from 'sinon';

import { redactUrl, tokenFingerprint } from '../../../../dist/helpers/redact.js';
import Logging from '../../../../dist/helpers/logging.js';
import RoutesTokens from '../../../../dist/routes/tokens.js';
import Datastore from '../../../../dist/datastore/index.js';

const TOKEN = 'a-secret-token-value-that-must-not-be-logged';

// Everything logged, at any level
const logged = () => [
  ...Logging.logSilly.args, ...Logging.logDebug.args, ...Logging.logVerbose.args, ...Logging.log.args,
].map((args) => args.map(String).join(' ')).join('\n');

describe('helpers/redact', () => {
  it('fingerprints a token without showing it', () => {
    const print = tokenFingerprint(TOKEN);

    assert.ok(!print.includes(TOKEN.slice(0, 6)), print);
    assert.strictEqual(print, tokenFingerprint(TOKEN));
    assert.notStrictEqual(print, tokenFingerprint(`${TOKEN}-2`));
  });

  it('keeps only the protocol, host and path of a URL', () => {
    assert.strictEqual(redactUrl('mongodb://user:pass@db.example.com:27017/buttress?authSource=admin&token=x'),
      'mongodb://db.example.com:27017/buttress');
    assert.strictEqual(redactUrl(new URL('https://api.example.com/v1/items?api_key=secret#frag')), 'https://api.example.com/v1/items');
    assert.strictEqual(redactUrl('not a url'), '[url]');
  });
});

describe('logs never carry a token or credential', () => {
  afterEach(() => sinon.restore());

  const spyOnLogs = () => ['logSilly', 'logDebug', 'logVerbose', 'log'].forEach((level) => sinon.spy(Logging, level));

  it("REST token lookups don't log the token", async () => {
    spyOnLogs();
    const tokens = new RoutesTokens();
    tokens.tokens = [{ id: 't1', value: TOKEN }];

    await tokens._getProvidedToken({ headers: { authorization: `Bearer ${TOKEN}` }, context: { id: 'r1', timer: null } });

    assert.ok(!logged().includes(TOKEN), logged());
  });

  it("connecting to a datastore doesn't log its credentials", async () => {
    spyOnLogs();
    const datastore = Datastore.createInstance({ connectionString: 'empty://user:p4ssw0rd@db.example.com/x?token=t0k3n' });

    await datastore.connect();

    assert.ok(!/p4ssw0rd|t0k3n/.test(logged()), logged());
  });
});
