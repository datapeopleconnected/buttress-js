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

import { RoutesMiddleware } from '../../../../dist/routes/middleware.js';
import Logging from '../../../../dist/helpers/logging.js';
import * as Helpers from '../../../../dist/helpers/errors.js';

function createMiddleware() {
  return new RoutesMiddleware({}, {});
}

function createReq() {
  return { context: { id: 'req-1' } };
}

function createRes() {
  const res = {
    status: sinon.stub(),
    json: sinon.stub(),
    end: sinon.stub(),
  };
  res.status.returns(res);
  res.json.returns(res);
  return res;
}

afterEach(() => {
  sinon.restore();
});

describe('routes/RoutesMiddleware:logErrors', () => {
  it('sends the error message and code for a RequestError', () => {
    sinon.stub(Logging, 'logError');
    const middleware = createMiddleware();
    const req = createReq();
    const res = createRes();
    const next = sinon.spy();
    const err = new Helpers.RequestError(400, 'invalid_input');

    middleware.logErrors(err, req, res, next);

    assert(res.status.calledWith(400));
    assert(res.json.calledWith({ statusMessage: 'invalid_input', message: 'invalid_input' }));
    assert(res.end.calledOnce);
    assert(next.calledWith(err));
    assert(Logging.logError.notCalled);
  });

  it('logs and sends a generic JSON body for a non-RequestError, without leaking its message', () => {
    sinon.stub(Logging, 'logError');
    const middleware = createMiddleware();
    const req = createReq();
    const res = createRes();
    const next = sinon.spy();
    const err = new TypeError('connect ECONNREFUSED 127.0.0.1:27017');

    middleware.logErrors(err, req, res, next);

    assert(Logging.logError.calledWith(err, 'req-1'));
    assert(res.status.calledWith(500));
    assert(res.json.calledOnce);
    const body = res.json.firstCall.args[0];
    assert.strictEqual(body.message, 'Internal Server Error');
    assert.strictEqual(body.statusMessage, 'Internal Server Error');
    assert(!JSON.stringify(body).includes('ECONNREFUSED'));
    assert(res.end.calledOnce);
    assert(next.calledWith(err));
  });
});
