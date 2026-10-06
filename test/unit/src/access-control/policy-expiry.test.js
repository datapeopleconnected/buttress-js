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
import { Readable } from 'node:stream';
import sinon from 'sinon';

import { PolicyExpiry } from '../../../../dist/access-control/policy-expiry.js';
import Model from '../../../../dist/model/index.js';
import PolicySchemaModel from '../../../../dist/model/core/policy.js';
import TokenSchemaModel from '../../../../dist/model/core/token.js';
import Logging from '../../../../dist/helpers/logging.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const PASSED = new Date('2026-10-06T11:00:00.000Z');
const TO_COME = new Date('2026-10-07T12:00:00.000Z');

// The app's policies and tokens, as the models store and find them. A look for passed limits finds every policy with a
// limit, so the sweep's own check of each one is what's tested.
function stubModels({ policies = [], tokens = [] }) {
  const policyModel = {
    find: sinon.spy((query) =>
      Readable.from(query.limit ? policies.filter((p) => p.limit) : policies.filter((p) => p._appId === query._appId)),
    ),
    rm: sinon.stub().callsFake(async (id) => {
      policies.splice(policies.findIndex((p) => p.id === id), 1);
    }),
  };
  const tokenModel = {
    find: sinon.spy((query) => Readable.from(tokens.filter((t) => t._appId === query._appId))),
    updatePolicyProperties: sinon.stub().callsFake(async (stored, properties) => {
      tokens.find((t) => t.id === stored.id).policyProperties = properties;
    }),
  };

  sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => {
    if (modelClass === PolicySchemaModel) return policyModel;
    if (modelClass === TokenSchemaModel) return tokenModel;
    throw new Error(`Unexpected model requested in test: ${modelClass?.name}`);
  });

  return { policyModel, tokenModel };
}

const policy = (id, name, selection, limit, appId = 'app1') => ({ id, name, selection, limit, _appId: appId, config: [] });
const token = (id, policyProperties, appId = 'app1') => ({ id, type: 'user', policyProperties, _appId: appId });

// The properties each token was left with, by token id
const updated = (tokenModel) =>
  Object.fromEntries(tokenModel.updatePolicyProperties.getCalls().map((call) => [call.args[0].id, call.args[1]]));

afterEach(() => {
  sinon.restore();
});

// SR-DPC-001 D1: a policy's limit took every property its selection named off the token whose request queued it, ones
// other policies selected the token by included, left every other token as it was, and was lost on a restart
describe('access-control/PolicyExpiry:sweep', () => {
  it("removes each policy whose limit has passed, and leaves one whose limit hasn't, or isn't a date", async () => {
    const { policyModel } = stubModels({
      policies: [
        policy('passed', 'passed', { role: { '@eq': 'STAFF' } }, PASSED),
        policy('to-come', 'to-come', { role: { '@eq': 'STAFF' } }, TO_COME),
        policy('not-a-date', 'not-a-date', { role: { '@eq': 'STAFF' } }, 'next tuesday'),
        policy('none', 'none', { role: { '@eq': 'STAFF' } }, null),
      ],
    });

    await new PolicyExpiry().sweep(NOW);

    assert.deepStrictEqual(policyModel.rm.args, [['passed']]);
  });

  it('takes the property named after an expired policy off every token it selects, and nothing else', async () => {
    const { policyModel, tokenModel } = stubModels({
      policies: [policy('exam', 'examAccess', { examAccess: { '@eq': true } }, PASSED)],
      tokens: [
        token('alice', { examAccess: true, role: 'STAFF' }),
        token('bob', { examAccess: true }),
        token('carol', { role: 'STAFF' }),
        // Not selected: the property's value doesn't pass the selection
        token('dan', { examAccess: false }),
        token('erin', null),
        token('other-app', { examAccess: true }, 'app2'),
      ],
    });

    await new PolicyExpiry().sweep(NOW);

    assert.deepStrictEqual(updated(tokenModel), { alice: { role: 'STAFF' }, bob: {} });
    assert.deepStrictEqual(policyModel.rm.args, [['exam']]);
  });

  it("takes off no property but the one named after the policy, so a selection by a shared property leaves it", async () => {
    const { policyModel, tokenModel } = stubModels({
      policies: [
        policy('staff', 'staff', { role: { '@eq': 'STAFF' } }, null),
        policy('promo', 'promo-editors', { role: { '@eq': 'STAFF' } }, PASSED),
      ],
      tokens: [token('alice', { role: 'STAFF' }), token('bob', { role: 'STAFF', 'promo-editors': true })],
    });

    await new PolicyExpiry().sweep(NOW);

    assert.strictEqual(tokenModel.updatePolicyProperties.callCount, 0);
    assert.deepStrictEqual(policyModel.rm.args, [['promo']]);
  });

  it('keeps the property while another policy whose limit has not passed selects by it', async () => {
    const { policyModel, tokenModel } = stubModels({
      policies: [
        policy('exam-1', 'examAccess', { examAccess: { '@eq': true } }, PASSED),
        policy('exam-2', 'examAccess', { '@or': [{ examAccess: { '@eq': true } }, { role: { '@eq': 'ADMIN' } }] }, TO_COME),
      ],
      tokens: [token('alice', { examAccess: true })],
    });

    await new PolicyExpiry().sweep(NOW);

    assert.strictEqual(tokenModel.updatePolicyProperties.callCount, 0);
    assert.deepStrictEqual(policyModel.rm.args, [['exam-1']]);
  });

  it('takes the property off once the other policies that select by it have expired too', async () => {
    const { policyModel, tokenModel } = stubModels({
      policies: [
        policy('exam-1', 'examAccess', { examAccess: { '@eq': true } }, PASSED),
        policy('exam-2', 'examAccess', { examAccess: { '@eq': true } }, PASSED),
      ],
      tokens: [token('alice', { examAccess: true, role: 'STAFF' })],
    });

    await new PolicyExpiry().sweep(NOW);

    assert.strictEqual(tokenModel.updatePolicyProperties.callCount, 1);
    assert.deepStrictEqual(updated(tokenModel), { alice: { role: 'STAFF' } });
    assert.deepStrictEqual(policyModel.rm.args, [['exam-1'], ['exam-2']]);
  });

  it("logs a policy that can't be removed, and removes the rest", async () => {
    const logError = sinon.stub(Logging, 'logError');
    const { policyModel } = stubModels({
      policies: [policy('first', 'first', null, PASSED), policy('second', 'second', null, PASSED)],
    });
    policyModel.rm.withArgs('first').rejects(new Error('datastore unavailable'));

    await new PolicyExpiry().sweep(NOW);

    assert.deepStrictEqual(policyModel.rm.args, [['first'], ['second']]);
    assert.match(logError.firstCall.args[0], /Unable to remove policy first, its limit passed: datastore unavailable/);
  });

  it("logs a sweep that can't look for policies, rather than failing", async () => {
    const logError = sinon.stub(Logging, 'logError');
    sinon.stub(Model, 'getCoreModel').throws(new Error('not ready'));

    await new PolicyExpiry().sweep(NOW);

    assert.match(logError.firstCall.args[0], /Unable to look for policies whose limit has passed: not ready/);
  });
});

describe('access-control/PolicyExpiry:start', () => {
  it('sweeps at once, again a while after each sweep, and no more once stopped', async () => {
    const clock = sinon.useFakeTimers();
    const expiry = new PolicyExpiry(1000);
    const sweep = sinon.stub(expiry, 'sweep').resolves();

    expiry.start();
    await clock.tickAsync(0);
    assert.strictEqual(sweep.callCount, 1);

    await clock.tickAsync(1000);
    assert.strictEqual(sweep.callCount, 2);

    expiry.stop();
    await clock.tickAsync(5000);
    assert.strictEqual(sweep.callCount, 2);
  });
});
