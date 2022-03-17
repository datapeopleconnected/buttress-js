/**
 * @class Disposition
 */
class Disposition {
	constructor() {}

	async accessControlDisposition(req, userSchemaAttributes) {
		const verb = req.originalMethod;
		const disposition = userSchemaAttributes[userSchemaAttributes.length - 1].disposition;
		return (disposition[verb] === 'allow')? true : false;
	}
}
module.exports = new Disposition();
