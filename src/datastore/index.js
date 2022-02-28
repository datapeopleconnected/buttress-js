// const Config = require('node-env-obj')();

const Factory = require('./adapter-factory');

let mainDatastore = null;

/**
 * This class is used to manage the lifecycle of an adapter
 */
class Datastore {
	constructor(config) {
		this.setAdapter(config);
	}

	setAdapter(config) {
		this._adapter = Factory.create(config.connectionString, config.options);
	}

	connect() {
		return this.adapter.connect();
	}

	createId(id) {
		return this.adapter.createId(id);
	}

	get adapter() {
		return this._adapter;
	}
}

module.exports = {
	Class: Datastore,
	createInstance(config) {
		if (mainDatastore) throw new Error('Datastore already exists');
		mainDatastore = new Datastore(config);
		return mainDatastore;
	},
	getInstance() {
		return mainDatastore;
	},
};
