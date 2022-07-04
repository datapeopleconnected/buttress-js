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

	addAccessControlPolicyQueryProjection(req, projectionKeys, schema) {
		const requestMethod = req.method;
		const flattenedSchema = Helpers.getFlattenedSchema(schema);
		const projection = {};
		let requestBody = req.body;
		let allowedUpdates = false;

		if (projectionKeys && projectionKeys.length > 0) {
			projectionKeys.forEach((key) => {
				projection[key] = 1;
			});
		}

		if (requestMethod === 'POST') {
			const updatePaths = Object.keys(requestBody).map((key) => key);

			if (projectionKeys.length > 0) {
				const removedPaths = updatePaths
					.filter((key) => projectionKeys.every((updateKey) => updateKey !== key))
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
			const allowedPathUpdates = projectionKeys.filter((key) => updatePaths.some((updateKey) => updateKey === key));
			if (allowedPathUpdates.length === updatePaths.length || projectionKeys.length < 1) {
				allowedUpdates = true;
			}
		} else {
			allowedUpdates = (projectionKeys.length > 0)? this.__checkPorjectionPath(requestBody, projectionKeys) : true;
		}

		req.body.project = (req.body.project)? {...req.body.project, ...projection} : projection;
		return allowedUpdates;
	}

	__checkPorjectionPath(requestBody, projectionKeys) {
		const query = (requestBody.query) ? requestBody.query : requestBody;
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

		return queryKeys.every((key) => projectionKeys.includes(key));
	}
}
module.exports = new Projection();
