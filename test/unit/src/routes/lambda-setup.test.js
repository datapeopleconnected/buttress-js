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
import sinon from 'sinon';

import { RoutesLambdaSetup } from '../../../../dist/routes/lambda-setup.js';

describe('routes/RoutesLambdaSetup:__configureAppLambdaEndpoints', () => {
  it("registers an app's lambda endpoints once, however often it's asked to", async () => {
    const app = { all: sinon.spy(), use: sinon.spy() };
    const setup = new RoutesLambdaSetup(app, undefined, [], () => {});

    await setup.__configureAppLambdaEndpoints('app-one');
    await setup.__configureAppLambdaEndpoints('app-one');
    await setup.__configureAppLambdaEndpoints('app-two');

    assert.deepStrictEqual(app.all.args.map(([path]) => path), ['/lambda/v1/app-one/*endpoint', '/lambda/v1/app-two/*endpoint']);
    assert.strictEqual(app.use.callCount, 2);
  });
});
