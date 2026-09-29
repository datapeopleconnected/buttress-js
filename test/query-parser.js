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

import Datastore from '../dist/datastore/index.js';
import { getFlattenedSchema } from '../dist/helpers/index.js';
import StandardModel from '../dist/model/type/standard.js';

/**
 * The real StandardModel.parseQuery for a core model's schema, with the core datastore's id codec, for
 * route tests that stub the rest of the model. A stub like `parseQuery: (q) => q` hides what parsing
 * does to the query, e.g. dropping an empty `$and`.
 * @param {typeof StandardModel} SchemaModel - a core model class with a static `Schema`
 * @return {{flatSchemaData: object, parseQuery: Function}}
 */
export function realQueryParser(SchemaModel) {
  const model = Object.create(StandardModel.prototype);
  model.adapter = { ID: Datastore.getInstance('core').ID };
  model.flatSchemaData = getFlattenedSchema(SchemaModel.Schema);
  return {
    flatSchemaData: model.flatSchemaData,
    parseQuery: (query, envFlat, schemaFlat) => model.parseQuery(query, envFlat, schemaFlat),
  };
}
