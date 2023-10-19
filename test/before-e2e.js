const MongoClient = require('mongodb').MongoClient;
const Config = require('node-env-obj')({
	basePath: __dirname,
	envFile: `.test.env`,
	envPath: '../',
	configPath: '../src',
});

(async () => {
	console.log('---------');
	console.log(`🏁 Clearing out test env for e2e tests.`);

	// Make a connection to the datastore.
	this._client = await MongoClient.connect(Config.datastore.connectionString, {appName: Config.app.code, maxPoolSize: 100});
	this.connection = this._client.db(`${Config.app.code}-${Config.env}`);

	console.log(`🤝 Connected to the datastore: ${Config.datastore.connectionString}`);

	// Fetch all of the collections.
	this.collections = await this.connection.collections();
	console.log(`📖 Found ${this.collections.length} collections.`);

	// We only want to keep data for the super app it's token.
	const coreCollections = ['apps', 'tokens'];

	// Drop all collections that are not in coreCollections.
	await Promise.all(
		this.collections.map(async (collection) => {
			if (coreCollections.indexOf(collection.collectionName) === -1) {
				await collection.drop();
			}
		}),
	);
	console.log(`✔️ Dropping all non-core collections`);

	// Delete all documents from apps that don't have the apiPath 'bjs'.
	await this.connection.collection('apps').deleteMany({
		apiPath: {
			$ne: 'bjs',
		},
	});
	console.log(`✔️ Cleaning up apps collection`);

	// Delete any documents from tokens that don't have the type 'system'.
	await this.connection.collection('tokens').deleteMany({
		type: {
			$ne: 'system',
		},
	});
	console.log(`✔️ Cleaning up tokens collection`);

	// Close out and clean up.
	await this._client.close();
	this._client = null;
	this.connection = null;
	this.collections = null;

	console.log('Datastore clean up complete! 🥳🥳');
	console.log('---------');
})();
