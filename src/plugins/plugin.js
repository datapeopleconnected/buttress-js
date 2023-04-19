const EventEmitter = require('events');

const plugins = require('./index');

class ButtressPlugin extends EventEmitter {
	constructor() {
		super();
		this.appType = null;
		this.processRole = null;
		this.infrastructureRole = null;
	}

	async initialise() {
		if (this.appType === plugins.APP_TYPE.REST) {
			this.initialiseRest();
		} else if (this.appType === plugins.APP_TYPE.SOCKET) {
			this.initialiseSocket();
		} else if (this.appType === plugins.APP_TYPE.LAMBDA) {
			this.initialiseLambda();
		}
	}

	initialiseRest() {
		throw new Error('Not implemented');
	}

	initialiseSocket() {
		throw new Error('Not implemented');
	}

	initialiseLambda() {
		throw new Error('Not implemented');
	}

	addAction(name, callback, priority = 10) {
		this.emit('add-action', {name, callback, priority});
	}

	addFilter(name, callback, priority = 10) {
		this.emit('add-filter', {name, callback, priority});
	}
}

module.exports = ButtressPlugin;
