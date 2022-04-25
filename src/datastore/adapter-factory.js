const Config = require('node-env-obj')();

module.exports = class Datastore {
	static create(connectionString, optsString) {
		const uri = new URL(connectionString);

		if (!uri.pathname) {
			uri.pathname = `${Config.app.code}-${Config.env}`;
		}

		const options = new URLSearchParams(optsString);

		const Adapter = (() => {
			switch (uri.protocol) {
			case 'mongodb:':
				return require('./adapters/mongodb.js');
			case 'buttress:':
				return require('./adapters/buttress.js');
			default:
				return null;
			}
		})();

		if (Adapter === null) throw new Error(`Unknown datastore '${uri.protocol}'`);

		return new Adapter(uri, options);
	}

	static connect(connectionString, options) {
		const adatper = this.create(connectionString, options);

		return adatper.connect()
			.then(() => adatper);
	}
};
