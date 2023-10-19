'use strict';

/**
 * @class HelloWorld
 */
class HelloWorld {
	/**
	 * Creates an instance of Auth
	 */
	constructor() {}

	/**
	 * execute
	 * @return {Promise}
	 */
	async execute() {
		lambda.setResult({
			code: 200,
			message: 'Hello World!',
		});
	}
}

module.exports = HelloWorld;
