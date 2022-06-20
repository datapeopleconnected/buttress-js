const Helpers = require('../helpers');

/**
 * @class Projection
 */
class Projection {
	constructor() {
		this.logicalOperator = [
			'$and',
			'$or',
		];
	}

	addAccessControlPolicyQueryProjection(req, props, schema) {
		const requestMethod = (req.method === 'SEARCH')? 'GET' : req.method;
		const flattenedSchema = Helpers.getFlattenedSchema(schema);
		const projectionMethod = (requestMethod === 'GET')? 'READ' : 'WRITE';
		const projectionUpdateKeys = [];
		const projection = {};
		let requestBody = req.body;
		let allowedUpdates = false;

		Object.keys(props).forEach((key) => {
			if (props[key].includes(projectionMethod)) {
				projectionUpdateKeys.push(key);
				projection[key] = 1;
			}
		});

		if (requestMethod === 'POST') {
			const updatePaths = Object.keys(requestBody).map((key) => key);

			if (projectionUpdateKeys.length > 0) {
				const removedPaths = updatePaths
					.filter((key) => projectionUpdateKeys.every((updateKey) => updateKey !== key))
					.filter((path) => flattenedSchema[path]);

				removedPaths.forEach((i) => {
					// TODO think about required fields that users do not have write access to
					const config = flattenedSchema[i];
					requestBody[i] = Helpers.Schema.getPropDefault(config);
				});
			}

			allowedUpdates = true;
		} else if (requestMethod === 'PUT') {
			if (!Array.isArray(requestBody) && typeof requestBody === 'object') {
				requestBody = [requestBody];
			}

			const updatePaths = requestBody.map((elem) => elem.path);
			const allowedPathUpdates = projectionUpdateKeys.filter((key) => updatePaths.some((updateKey) => updateKey === key));
			if (allowedPathUpdates.length === updatePaths.length || projectionUpdateKeys.length < 1) {
				allowedUpdates = true;
			}
		} else {
			allowedUpdates = (projectionUpdateKeys.length > 0)? this.__checkPorjectionPath(requestBody.query, projectionUpdateKeys) : true;
		}

		req.body.project = projection;
		return allowedUpdates;
	}

	__checkPorjectionPath(query, projectionUpdateKeys) {
		const paths = Object.keys(query).filter((key) => key && key !== '__crPath');

		let queryKeys = [];
		paths.forEach((path) => {
			if (this.logicalOperator.includes(path)) {
				query[path].forEach((p) => {
					queryKeys = queryKeys.concat(Object.keys(p));
				});
				return;
			}

			queryKeys = queryKeys.concat(Object.keys(path));
		});


		return queryKeys.every((key) => projectionUpdateKeys.includes(key));
	}
}
module.exports = new Projection();
