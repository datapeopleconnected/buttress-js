const hash = require('crypto').createHash;

// const Config = require('node-env-obj')();
const Factory = require('./adapter-factory');

const Logging = require('../logging');

const datastores = {
	core: null,
};

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

	setHash(hash) {
		this._hash = hash;
	}

	connect() {
		Logging.logSilly(`Attempting to connect to datastore ${this._adapter.uri}`);
		return this.adapter.connect();
	}

	get ID() {
		return this.adapter.ID;
	}

	get adapter() {
		return this._adapter;
	}

	get hash() {
		return this._hash;
	}
}

module.exports = {
	Class: Datastore,
	hashConfig(config) {
		return hash('sha1').update(Buffer.from(config.connectionString)).digest('base64');
	},
	createInstance(config, core = false) {
		const hash = (core) ? 'core' : this.hashConfig(config);
		if (datastores[hash]) return datastores[hash];

		datastores[hash] = new Datastore(config);
		datastores[hash].setHash(hash);
		return datastores[hash];
	},
	getInstance(hash) {
		return datastores[hash];
	},
};
