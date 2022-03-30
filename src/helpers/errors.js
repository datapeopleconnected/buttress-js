module.exports.RequestError = class RequestError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = 'RequestError';
	}
};

module.exports.RouteMissingModel = class RouteMissingModel extends Error {
	constructor(message) {
		super(message);
		this.name = 'RouteMissingModel';
	}
};

module.exports.NotYetImplemented = class NotYetImplemented extends Error {
	constructor(message) {
		super(message);
		this.name = 'NotYetImplemented';
	}
};
