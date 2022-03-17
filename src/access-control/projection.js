const Helpers = require('../helpers');

/**
 * @class Projection
 */
class Projection {
	constructor() {}

	addAccessControlPolicyQueryProjection(req, props, schema) {
		const requestMethod = (req.originalMethod === 'SEARCH')? 'GET' : req.originalMethod;
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
			const removedPaths = updatePaths
				.filter((key) => projectionUpdateKeys.every((updateKey) => updateKey !== key))
				.filter((path) => flattenedSchema[path]);

			removedPaths.forEach((i) => {
				// TODO think about required fields that users do not have write access to
				const config = flattenedSchema[i];
				requestBody[i] = Helpers.Schema.getPropDefault(config);
			});

			allowedUpdates = true;
		} else if (requestMethod === 'PUT') {
			if (!Array.isArray(requestBody) && typeof requestBody === 'object') {
				requestBody = [requestBody];
			}

			const updatePaths = requestBody.map((elem) => elem.path);
			const allowedPathUpdates = projectionUpdateKeys.filter((key) => updatePaths.some((updateKey) => updateKey === key));
			if (allowedPathUpdates.length === updatePaths.length) {
				allowedUpdates = true;
			}
		} else {
			allowedUpdates = true;
		}

		req.body.project = projection;
		return allowedUpdates;
	}
}
module.exports = new Projection();
