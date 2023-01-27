const pug = require('pug');

/**
 * Mail
 * @class
 */
class Mail {
	/**
	 * Constructor for Mail
	 */
	constructor() {
		this._templates = {};
	}

	/**
	 * Returns the render function for a given template
	 * @param {String} path - template path
	 * @param {String} key - template key
	 * @return {Object} template - pug render function for the given template
	 */
	getEmailTemplate(path, key) {
		if (this._templates[key]) return this._templates[key];

		this._templates[key] = pug.compileFile(path, {
			test: 'I am here',
		});

		return this._templates[key];
	}
}

module.exports = new Mail();
