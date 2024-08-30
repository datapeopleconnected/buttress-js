'use strict';

/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2024 Data People Connected LTD.
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

import Sugar from 'sugar';

import Model from '../model';
import Logging from '../helpers/logging';

/**
 * @class Conditoins
 */
class Helpers {
	private __coreSchema?: any[];

	async cacheCoreSchema() {
		if (this.__coreSchema) return this.__coreSchema;

		// Accessing private..
		this.__coreSchema = Object.values(Model.CoreModels).map((model) => model.Schema);

		Logging.logSilly(`Refreshed core cache got ${this.__coreSchema.length} schema`);
		return this.__coreSchema;
	}

	evaluateOperation(lhs, rhs, operator): boolean {
		let passed = false;

		if (rhs === null || lhs === null) {
			// If either are null then we'll just fail the check, with the exeption being if we're checking for null.
			if (rhs === null && lhs === null && (operator === '$eq' || operator === '@eq')) return true;

			return false;
		}
		switch (operator) {
		case '$eq':
		case '@eq': {
			passed = lhs.toString().toUpperCase() === rhs.toString().toUpperCase();
		}
			break;
		case '$not':
		case '@not': {
			passed = lhs.toString().toUpperCase() !== rhs.toString().toUpperCase();
		}
			break;
		case '$gt':
		case '@gt': {
			passed = lhs > rhs;
		}
			break;
		case '$lt':
		case '@lt': {
			passed = lhs < rhs;
		}
			break;
		case '$gte':
		case '@gte': {
			passed = lhs >= rhs;
		}
			break;
		case '$lte':
		case '@lte': {
			passed = lhs <= rhs;
		}
			break;
		case '$gtDate':
		case '@gtDate': {
			passed = Sugar.Date.isAfter(rhs, lhs);
		}
			break;
		case '$gteDate':
		case '@gteDate': {
			passed = Sugar.Date.isAfter(rhs, lhs) || Sugar.Date.is(rhs, lhs);
		}
			break;
		case '$ltDate':
		case '@ltDate': {
			passed = Sugar.Date.isBefore(rhs, lhs);
		}
			break;
		case '$lteDate':
		case '@lteDate': {
			passed = Sugar.Date.isBefore(rhs, lhs) || Sugar.Date.is(rhs, lhs);
		}
			break;
		case '$rex':
		case '@rex': {
			const regex = new RegExp(rhs);
			passed = regex.test(lhs);
		}
			break;
		case '$rexi':
		case '@rexi': {
			const regex = new RegExp(rhs, 'i');
			passed = regex.test(lhs);
		}
			break;
		case '$in':
		case '@in': {
			if (Array.isArray(lhs)) {
				passed = lhs.every((i) => {
					return rhs.some((j) => j.toString() === i.toString());
				});
			} else {
				passed = lhs && rhs.some((i) => i.toString() === lhs.toString());
			}
		}
			break;
		case '$nin':
		case '@nin': {
			passed = lhs.every((i) => i !== lhs);
		}
			break;
		case '$exists':
		case '@exists': {
			passed = lhs.includes(rhs);
		}
			break;
		default:
		}

		return passed;
	}
}

export default new Helpers();
