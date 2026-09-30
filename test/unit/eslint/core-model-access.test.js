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
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

import { coreModelAccessRestrictions } from '../../../eslint/core-model-access.mjs';

// The lint rule on src/routes/api, run by the real ESLint on route code: a route reaches core data through
// this.scoped() or this.unscopedModel(), and uses Model.getCoreModel() only for what touches no rows
const lint = async (code) => {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        rules: { 'no-restricted-syntax': ['error', ...coreModelAccessRestrictions] },
      },
    ],
  });
  const [result] = await eslint.lintText(code, { filePath: 'route.ts' });
  return result.messages.map((message) => message.message);
};

describe('eslint: core model access in routes', function () {
  // ESLint's first run loads the TypeScript parser
  this.timeout(20000);

  for (const [name, code] of [
    ['a find', 'Model.getCoreModel(PolicySchemaModel).find({});'],
    ['a write by id', 'await Model.getCoreModel(TokenSchemaModel).updatePolicyProperties(token, body);'],
    ['a call on the next line', 'Model.getCoreModel(LambdaSchemaModel)\n  .exists(id);'],
    ['the model kept in a variable', 'const lambdas = Model.getCoreModel(LambdaSchemaModel);'],
    ['the model passed on', 'ACM.find(Model.getCoreModel(TokenSchemaModel), query, ac);'],
  ]) {
    it(`refuses ${name}`, async () => {
      const messages = await lint(code);

      assert.strictEqual(messages.length, 1, JSON.stringify(messages));
      assert.match(messages[0], /this\.scoped\(req, Model\)/);
    });
  }

  it('lets through what touches no rows', async () => {
    const messages = await lint(`
      super('policy', 'GET POLICY', services, Model.getCoreModel(PolicySchemaModel).schemaData);
      const flat = Model.getCoreModel(PolicySchemaModel).flatSchemaData;
      const system = Model.getCoreModel(TokenSchemaModel).Constants.Type.SYSTEM;
      const id = Model.getCoreModel(UserSchemaModel).createId(raw);
      Model.getCoreModel(AppSchemaModel).isValidId(raw);
      Model.getCoreModel(TrackingSchemaModel).validate(body);
      Model.getCoreModel(UserSchemaModel).validateUpdate(body);
      Model.getCoreModel(SecureStoreSchemaModel).parseQuery(query, {}, flat);
      Model.getCoreModel(TokenSchemaModel).createTokenString();
    `);

    assert.deepStrictEqual(messages, []);
  });

  it('lets through the scoped and unscoped models', async () => {
    const messages = await lint(`
      await this.scoped(req, PolicySchemaModel).find({});
      await this.unscopedModel(AppSchemaModel, 'the route takes only system tokens').findAll();
    `);

    assert.deepStrictEqual(messages, []);
  });
});
