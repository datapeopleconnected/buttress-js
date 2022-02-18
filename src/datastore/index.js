// const Config = require('node-env-obj')();

const Factory = require('./adapter-factory');

/**
 * This class is used to manage the lifecycle of an adapter
 */
module.exports = class Datastore {
	constructor(config) {
		this.setAdapter(config);
	}

	setAdapter(config) {
		this._adapter = Factory.create(config.connectionString, config.options);
	}

	connect() {
		return this.adapter.connect();
	}

	get adapter() {
		return this._adapter;
	}
};
