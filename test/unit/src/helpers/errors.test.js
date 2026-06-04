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

import Errors from '../../../../dist/helpers/errors.js';

describe('helpers/errors:RequestError', () => {
  it('should set name and code', () => {
    const err = new Errors.RequestError(404, 'Not found');
    assert(err instanceof Error);
    assert(err instanceof Errors.RequestError);
    assert.strictEqual(err.name, 'RequestError');
    assert.strictEqual(err.code, 404);
    assert.strictEqual(err.message, 'Not found');
  });
});

describe('helpers/errors:SchemaNotFound', () => {
  it('should set name and message', () => {
    const err = new Errors.SchemaNotFound('Schema user not found');
    assert(err instanceof Error);
    assert(err instanceof Errors.SchemaNotFound);
    assert.strictEqual(err.name, 'SchemaNotFound');
    assert.strictEqual(err.message, 'Schema user not found');
  });
});

describe('helpers/errors:SchemaInvalid', () => {
  it('should set name and message', () => {
    const err = new Errors.SchemaInvalid('Schema is invalid');
    assert(err instanceof Error);
    assert(err instanceof Errors.SchemaInvalid);
    assert.strictEqual(err.name, 'SchemaInvalid');
    assert.strictEqual(err.message, 'Schema is invalid');
  });
});

describe('helpers/errors:RouteMissingModel', () => {
  it('should set name and message', () => {
    const err = new Errors.RouteMissingModel('Model not found');
    assert(err instanceof Error);
    assert(err instanceof Errors.RouteMissingModel);
    assert.strictEqual(err.name, 'RouteMissingModel');
    assert.strictEqual(err.message, 'Model not found');
  });
});

describe('helpers/errors:UnsupportedDatastore', () => {
  it('should set name and message', () => {
    const err = new Errors.UnsupportedDatastore('MongoDB not configured');
    assert(err instanceof Error);
    assert(err instanceof Errors.UnsupportedDatastore);
    assert.strictEqual(err.name, 'UnsupportedDatastore');
    assert.strictEqual(err.message, 'MongoDB not configured');
  });
});

describe('helpers/errors:NotYetImplemented', () => {
  it('should set name and message', () => {
    const err = new Errors.NotYetImplemented('Feature coming soon');
    assert(err instanceof Error);
    assert(err instanceof Errors.NotYetImplemented);
    assert.strictEqual(err.name, 'NotYetImplemented');
    assert.strictEqual(err.message, 'Feature coming soon');
  });
});

describe('helpers/errors:InvalidRequest', () => {
  it('should set name, message and code', () => {
    const err = new Errors.InvalidRequest('Bad request', 400);
    assert(err instanceof Error);
    assert(err instanceof Errors.InvalidRequest);
    assert.strictEqual(err.name, 'InvalidRequest');
    assert.strictEqual(err.message, 'Bad request');
    assert.strictEqual(err.code, 400);
  });
});

describe('helpers/errors:Unauthenticated', () => {
  it('should set name, message, status and code', () => {
    const err = new Errors.Unauthenticated('Invalid credentials', 'UNAUTHENTICATED', 401);
    assert(err instanceof Error);
    assert(err instanceof Errors.Unauthenticated);
    assert.strictEqual(err.name, 'Unauthenticated');
    assert.strictEqual(err.message, 'Invalid credentials');
    assert.strictEqual(err.status, 'UNAUTHENTICATED');
    assert.strictEqual(err.code, 401);
  });
});

describe('helpers/errors:InvalidToken', () => {
  it('should set name, message and code', () => {
    const err = new Errors.InvalidToken('Token expired', 401);
    assert(err instanceof Error);
    assert(err instanceof Errors.InvalidToken);
    assert.strictEqual(err.name, 'InvalidToken');
    assert.strictEqual(err.message, 'Token expired');
    assert.strictEqual(err.code, 401);
  });
});

describe('helpers/errors:CodedError', () => {
  it('should set name, message and code', () => {
    const err = new Errors.CodedError('Lambda error', 500);
    assert(err instanceof Error);
    assert(err instanceof Errors.CodedError);
    assert.strictEqual(err.name, 'GENERIC_LAMBDA_ERROR');
    assert.strictEqual(err.message, 'Lambda error');
    assert.strictEqual(err.code, 500);
  });
});
