
module.exports = class AbstractAdapter {
	constructor(uri, options, connection = null) {
		this.uri = uri;
		this.options = options;

		this.connection = connection;

		this.collection = null;
	}
};
