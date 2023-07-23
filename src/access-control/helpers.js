const Sugar = require('sugar');

const Model = require('../model');
const Logging = require('../helpers/logging');

/**
 * @class Conditoins
 */
class Helpers {
	constructor() {
		this.__coreSchema = null;
	}

	async cacheCoreSchema() {
		if (this.__coreSchema) return this.__coreSchema;

		// Accessing private..
		this.__coreSchema = Object.values(Model.CoreModels).map((model) => model.schemaData);

		Logging.logSilly(`Refreshed core cache got ${this.__coreSchema.length} schema`);
		return this.__coreSchema;
	}

	evaluateOperation(lhs, rhs, operator) {
		let passed = false;

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
				passed = lhs.every((i) => rhs.includes(i));
			} else {
				passed = rhs.some((i) => i === lhs);
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

module.exports = new Helpers();
