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

import { describe, it, before, after } from 'mocha';
import assert from 'assert';
import sinon from 'sinon';

import Model from '../../../../../dist/model/index.js';
import Route from '../../../../../dist/routes/route.js';
import { Routes } from '../../../../../dist/routes/api/index.js';
import { coreModelMembersWithoutRows } from '../../../../../eslint/core-model-access.mjs';

// Walks every core route. Core collections are shared by every app, so a route reaches their rows through
// this.scoped(req, Model), limited to the caller's app. A route that takes other than system tokens may reach every
// app only where it's listed here, with the reason it gives.
const EVERY_APP = {
  AddDataSharing: [['AppDataSharingSchemaModel', 'isDuplicate compares the body, app included']],
  AppUpdate: [['AppSchemaModel', 'an api path is checked against every app']],
  DeleteLambda: [['LambdaSchemaModel', "a hash's code is shared by every app's lambdas"]],
  FindUser: [
    ['UserSchemaModel', 'getByAuthAppId is limited to the app it is given'],
    ['TokenSchemaModel', 'findUserAuthTokens is limited to the app it is given'],
  ],
  GetUser: [['TokenSchemaModel', 'findUserAuthTokens is limited to the app it is given']],
};

// A route's own code, and that of the classes between it and Route (the core route bases), without comments, which
// may hold code that no longer runs
const codeOf = (RouteClass) => {
  const classes = [];
  for (let cls = RouteClass; cls && cls !== Route; cls = Object.getPrototypeOf(cls)) classes.push(cls);
  return classes
    .map((cls) => cls.toString())
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
};

// Each unscopedModel(Model, reason) in a route's own code, the reason as written: a string, or a constant's name
const unscopedUses = (source) =>
  [...source.matchAll(/unscopedModel\(\s*(\w+)\s*,\s*(?:(['"`])((?:(?!\2).)*)\2|(\w+))\s*\)/g)].map((match) => [
    match[1],
    match[3] ?? match[4],
  ]);

// Each Model.getCoreModel(X) in a route's own code that's used for more than what touches no rows
const coreModelRowUses = (source) =>
  [...source.matchAll(/getCoreModel\(\s*(\w+)\s*\)(\s*\.\s*(\w+))?/g)]
    .filter((match) => !coreModelMembersWithoutRows.includes(match[3]))
    .map((match) => match[0].replace(/\s+/g, ''));

describe('routes/api: every core route reaches core rows through the scoped model', () => {
  const routes = [];

  before(() => {
    // Enough of the core models for the routes' constructors, which read their schema and constants
    sinon.stub(Model, 'getCoreModel').callsFake((modelClass) => ({ schemaData: modelClass.Schema, Constants: modelClass.Constants }));
    const services = new Map([
      ['nrp', { on: () => {}, emit: () => {} }],
      ['modelManager', Model],
    ]);
    for (const RouteClass of Routes.flat()) {
      routes.push({ RouteClass, route: new RouteClass(services), source: codeOf(RouteClass) });
    }
  });
  after(() => sinon.restore());

  it('walks the core routes', () => {
    assert.ok(routes.length > 90, `only ${routes.length} routes`);
  });

  // A route with any other refuses every request (SR-DPC-001 S12), and the checks below go by it
  it('gives every route a known auth type', () => {
    const known = Object.values(Route.Constants.Type);
    const unknown = routes.filter(({ route }) => !known.includes(route.authType)).map(({ RouteClass, route }) => `${RouteClass.name}: ${route.authType}`);

    assert.deepStrictEqual(unknown, []);
  });

  it('uses Model.getCoreModel() only for what touches no rows', () => {
    const uses = routes.flatMap(({ RouteClass, source }) => coreModelRowUses(source).map((use) => `${RouteClass.name}: ${use}`));

    assert.deepStrictEqual(uses, []);
  });

  it("reaches every app's rows, other than for system tokens, only where it's listed, for the reason given", () => {
    const everyApp = Object.fromEntries(
      routes
        .filter(({ route }) => route.authType !== Route.Constants.Type.SYSTEM)
        .map(({ RouteClass, source }) => [RouteClass.name, unscopedUses(source)])
        .filter(([, uses]) => uses.length > 0),
    );

    assert.deepStrictEqual(everyApp, EVERY_APP);
  });

  it('gives a reason wherever a system-only route reaches every app', () => {
    const unexplained = routes
      .filter(({ route }) => route.authType === Route.Constants.Type.SYSTEM)
      .flatMap(({ RouteClass, source }) => unscopedUses(source).filter(([, reason]) => !reason).map(() => RouteClass.name));

    assert.deepStrictEqual(unexplained, []);
  });
});
