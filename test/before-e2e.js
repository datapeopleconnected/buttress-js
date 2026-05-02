/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2026 Data People Connected LTD.
 * <https://www.dpc-ltd.com/>
 *
 * This file is part of Buttress.
 * Buttress is free software: you can redistribute it and/or modify it under the
 * terms of the GNU Affero General Public Licence as published by the Free Software
 * Foundation, either version 3 of the Licence, or (at your option) any later version.
 * Buttress is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public Licence for more details.
 * You should have received a copy of the GNU Affero General Public Licence along with
 * this program. If not, see <http://www.gnu.org/licenses/>.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MongoClient } from 'mongodb';
import createConfig from '@dpc/node-env-obj';

import * as redis from '@redis/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const Config = createConfig({
	basePath: __dirname,
	envFile: `.test.env`,
	envPath: '../',
	configPath: '../src',
});

(async () => {
	console.log('---------');
	console.log(`🏁 Clearing out test env for e2e tests.`);

	// Make a connection to the datastore.
	let _client = await MongoClient.connect(Config.datastore.connectionString, { appName: Config.app.code, maxPoolSize: 100 });
	let _connection = _client.db(`${Config.app.code}-${Config.env}`);

	console.log(`🤝 Connected to the datastore: ${Config.datastore.connectionString}`);

	// Make a connection to the redis cache.
	const redisClient = redis.createClient({ url: Config.redis.url });
	await redisClient.connect();
	console.log(`🤝 Connected to the redis cache: ${Config.redis.url}`);

	// Drop all collections
	await _connection.dropDatabase();
	console.log(`💥 Dropping all collections`);

	// FLUSHDB the redis cache.
	await redisClient.flushDb();
	console.log(`💥 Flushing the redis cache`);


	// Fetch all of the collections.
	// this.collections = await _connection.collections();
	// console.log(`📖 Found ${this.collections.length} collections.`);

	// // We only want to keep data for the super app it's token.
	// const coreCollections = ['apps', 'tokens'];

	// // Drop all collections that are not in coreCollections.
	// await Promise.all(
	// 	this.collections.map(async (collection) => {
	// 		if (coreCollections.indexOf(collection.collectionName) === -1) {
	// 			await collection.drop();
	// 		}
	// 	}),
	// );
	// console.log(`✔️ Dropping all non-core collections`);

	// // Delete all documents from apps that don't have the apiPath 'bjs'.
	// await _connection.collection('apps').deleteMany({
	// 	apiPath: {
	// 		$ne: 'bjs',
	// 	},
	// });
	// console.log(`✔️ Cleaning up apps collection`);

	// // Delete any documents from tokens that don't have the type 'system'.
	// await _connection.collection('tokens').deleteMany({
	// 	type: {
	// 		$ne: 'system',
	// 	},
	// });
	// console.log(`✔️ Cleaning up tokens collection`);

	// Close out and clean up.
	await redisClient.quit();
	await _client.close();
	_client = null;
	_connection = null;
	// this.collections = null;
	

	console.log('Datastore clean up complete! 🥳🥳');
	console.log('---------');
})();
