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

import { validateUpdate } from '../../../../dist/model/shared.js';

// Validation adds its own context to each update
const pathsAndValues = (body) => body.map(({ path, value }) => ({ path, value }));

const schema = (core) => ({
  name: 'thing',
  type: 'collection',
  core,
  properties: { priority: { __type: 'number', __allowUpdate: true } },
});

describe('model/shared:validateUpdate', () => {
  for (const core of [true, false]) {
    describe(core ? 'on a core schema' : 'on an app schema', () => {
      const validate = validateUpdate({}, schema(core));

      it('takes a single update', () => {
        const { validation, body } = validate({ path: 'priority', value: 1 });

        assert.strictEqual(validation.isValid, true);
        assert.deepStrictEqual(pathsAndValues(body), [{ path: 'priority', value: 1 }]);
      });

      it('takes an array of updates', () => {
        const { validation, body } = validate([{ path: 'priority', value: 1 }]);

        assert.strictEqual(validation.isValid, true);
        assert.deepStrictEqual(pathsAndValues(body), [{ path: 'priority', value: 1 }]);
      });

      for (const [label, update] of [
        ['no body', undefined],
        ['an empty object', {}],
        ['a null item', [null]],
        ['a string item', ['priority']],
      ]) {
        it(`reports ${label} as an update missing its path`, () => {
          const { validation } = validate(update);

          assert.strictEqual(validation.isValid, false);
          assert.strictEqual(validation.missingRequired, 'path');
        });
      }
    });
  }
});
