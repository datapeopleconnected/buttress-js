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

import { describe, it, before, after, afterEach } from 'mocha';
import assert from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import ivm from 'isolated-vm';
import createConfig from '@dpc/node-env-obj';

import LambdaHelpers, { CALLER_TOKEN_PLACEHOLDER } from '../../../../dist/lambda-helpers/helpers.js';

const Config = createConfig();

// A server that records the requests it gets
const listen = () =>
  new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url, authorization: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, requests, origin: `http://127.0.0.1:${server.address().port}` }),
    );
  });

// fetch() from a live isolate to a real server, for a lambda that runs as its caller
describe('lambda-helpers/Helpers:fetch as the caller', () => {
  let isolate;
  let context;
  let savedPlugins;
  let savedAllowed;
  let tmpDir;
  let buttress;
  let elsewhere;

  const fetchFromLambda = (url, headers) =>
    context.eval(
      `fetch({ url: ${JSON.stringify(url)}, options: { headers: ${JSON.stringify(headers)} } }).then(() => 'fetched', (err) => 'refused: ' + (err && err.message))`,
      { promise: true, copy: true, timeout: 5000 },
    );

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buttress-fetch-caller-'));
    savedPlugins = Config.paths.lambda.plugins;
    savedAllowed = Config.lambda.allowedHosts;
    Config.paths.lambda.plugins = tmpDir;
    Config.lambda.allowedHosts = '';
    isolate = new ivm.Isolate();
    context = await isolate.createContext();
    await LambdaHelpers._createIsolateContext(isolate, context, context.global);
    buttress = await listen();
    elsewhere = await listen();
  });

  afterEach(() => {
    LambdaHelpers.caller = null;
    buttress.requests.length = 0;
    elsewhere.requests.length = 0;
  });

  after(() => {
    isolate.dispose();
    buttress.server.close();
    elsewhere.server.close();
    Config.paths.lambda.plugins = savedPlugins;
    Config.lambda.allowedHosts = savedAllowed;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const asCaller = () => {
    LambdaHelpers.caller = { token: 'caller-token', origin: buttress.origin };
  };

  it("sends the caller's token in place of the placeholder, and drops a ?token=", async () => {
    asCaller();

    const outcome = await fetchFromLambda(`${buttress.origin}/app/api/v1/user?token=picked&x=1`, {
      Authorization: `Bearer ${CALLER_TOKEN_PLACEHOLDER}`,
    });

    assert.strictEqual(outcome, 'fetched');
    assert.deepStrictEqual(buttress.requests, [
      { url: '/app/api/v1/user?x=1', authorization: 'Bearer caller-token' },
    ]);
  });

  it('sends a token of the lambda\'s own as it is', async () => {
    asCaller();

    await fetchFromLambda(`${buttress.origin}/app/api/v1/user`, { Authorization: 'Bearer lambda-own-token' });

    assert.deepStrictEqual(buttress.requests, [
      { url: '/app/api/v1/user', authorization: 'Bearer lambda-own-token' },
    ]);
  });

  it("never sends the caller's token to another host, even with the placeholder", async () => {
    asCaller();

    await fetchFromLambda(`${elsewhere.origin}/x`, { Authorization: `Bearer ${CALLER_TOKEN_PLACEHOLDER}` });

    assert.deepStrictEqual(elsewhere.requests, [
      { url: '/x', authorization: `Bearer ${CALLER_TOKEN_PLACEHOLDER}` },
    ]);
  });

  it('sends the placeholder as it is when the lambda does not run as its caller', async () => {
    await fetchFromLambda(`${buttress.origin}/x`, { Authorization: `Bearer ${CALLER_TOKEN_PLACEHOLDER}` });

    assert.deepStrictEqual(buttress.requests, [
      { url: '/x', authorization: `Bearer ${CALLER_TOKEN_PLACEHOLDER}` },
    ]);
  });
});
