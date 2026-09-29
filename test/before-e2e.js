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
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { MongoClient } from 'mongodb';
import { ConnectionString } from 'mongodb-connection-string-url';
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

const CHECKOUT_ROOT = path.resolve(__dirname, '..');

// The database Buttress itself picks (see Datastore.create): the connection string's own path, or `<app code>-<env>`.
// It's read as the driver reads it, since a URL can't hold a seed list with each host's port.
const mongoDbName = (connectionString, appCode, env) => {
	if (!/^mongodb:/i.test(connectionString.trim())) return null;
	const { pathname } = new ConnectionString(connectionString.trim(), { looseValidation: true });
	return pathname.replace(/\//g, '') || `${appCode}-${env}`;
};

// host:port/db, so equivalent URLs for the same Redis database compare equal.
const redisTarget = (url) => {
	const uri = new URL(url);
	const host = ['', 'localhost', '127.0.0.1', '[::1]'].includes(uri.hostname) ? 'localhost' : uri.hostname;
	const db = Number(uri.pathname.replace(/\//g, '') || uri.searchParams.get('database') || 0);
	return `${host}:${uri.port || 6379}/${db}`;
};

const isSameOrInside = (a, b) => {
	const rel = path.relative(path.resolve(b), path.resolve(a));
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// The dev instance's settings, from a checkout's .development.env, resolved the way @dpc/node-env-obj would for
// NODE_ENV=development. Anything the dev process gets from its shell environment instead isn't seen here.
const loadDevConfig = (checkoutRoot) => {
	const envFile = path.join(checkoutRoot, '.development.env');
	if (!fs.existsSync(envFile)) return null;

	const { environment, global } = JSON.parse(fs.readFileSync(path.join(CHECKOUT_ROOT, 'src/config.json'), 'utf8'));
	const vars = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, String(value)]));
	for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
		const [key, ...value] = line.split('=');
		if (!key || key.includes('#') || !value.join('=')) continue;
		vars[key] = value.join('=');
	}
	const resolveVars = (value) => value.replace(/%(\w+)%/g, (match, key) => (typeof vars[key] === 'string' ? vars[key] : match));
	for (const key of Object.keys(vars)) vars[key] = resolveVars(resolveVars(vars[key]));

	const resolve = (value) => {
		if (typeof value === 'string') return resolveVars(value);
		if (typeof value.dev === 'string') return resolveVars(value.dev);
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child)]));
	};
	const settings = resolve(global);

	return {
		envFile,
		scope: settings.redis.scope,
		redisUrl: settings.redis.url,
		dbName: mongoDbName(settings.datastore.connectionString, settings.app.code, 'dev'),
		restUrl: settings.url.rest,
		listenPorts: settings.listenPorts,
		paths: settings.paths,
	};
};

// The main checkout, when this is a git worktree of it.
const mainCheckoutRoot = () => {
	try {
		const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
			cwd: CHECKOUT_ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
		return path.dirname(commonDir);
	} catch (err) {
		return null;
	}
};

// Refuses to run if the test settings would touch a dev instance's database, Redis or lambda folders, or cross-talk
// with its processes over Redis pub/sub (NRP and Socket.IO channels are scoped by app code, not by database index).
const assertIsolatedFromDev = (testDbName) => {
	const problems = [];
	if (Config.env !== 'test') problems.push(`NODE_ENV must be test, the config resolved to "${Config.env}"`);
	if (!Config.paths.root) problems.push(`BUTTRESS_APP_PATH isn't set, does ${CHECKOUT_ROOT} have a .test.env?`);
	if (!testDbName) problems.push(`the test database name is empty`);
	if (!Config.app.code) problems.push(`BUTTRESS_APP_CODE isn't set, so the Redis scope would match every key`);

	const roots = [...new Set([CHECKOUT_ROOT, mainCheckoutRoot()].filter(Boolean))];
	for (const dev of roots.map(loadDevConfig).filter(Boolean)) {
		const clash = (what) => problems.push(`${what} matches ${dev.envFile}`);
		if (testDbName === dev.dbName) clash(`the MongoDB database "${testDbName}"`);
		if (redisTarget(Config.redis.url) === redisTarget(dev.redisUrl)) clash(`the Redis database ${redisTarget(Config.redis.url)}`);
		if (Config.redis.scope === dev.scope) clash(`the app code / Redis scope "${Config.redis.scope}"`);
		if (Config.url.rest === dev.restUrl) clash(`the REST URL ${Config.url.rest}`);
		if (Config.listenPorts.rest === dev.listenPorts.rest || Config.listenPorts.sock === dev.listenPorts.sock) {
			clash(`a listen port (${Config.listenPorts.rest}/${Config.listenPorts.sock})`);
		}
		if (path.resolve(Config.paths.appData) === path.resolve(dev.paths.appData)) clash(`the app data folder ${Config.paths.appData}`);
		for (const testPath of Object.values(Config.paths.lambda)) {
			for (const devPath of Object.values(dev.paths.lambda)) {
				if (isSameOrInside(testPath, devPath) || isSameOrInside(devPath, testPath)) {
					clash(`the lambda folder ${testPath} (dev uses ${devPath})`);
				}
			}
		}
	}

	if (problems.length > 0) {
		throw new Error(`Refusing to clear the e2e environment:\n  - ${problems.join('\n  - ')}`);
	}
};

// Deletes only this app code's keys. FLUSHDB would take every other instance's keys in the same database with it.
const deleteScopedKeys = async (redisClient, scope) => {
	const pattern = `${scope.replace(/[*?[\]\\]/g, '\\$&')}*`;
	let deleted = 0;
	for await (const keys of redisClient.scanIterator({ MATCH: pattern, COUNT: 1000 })) {
		if (keys.length < 1) continue;
		deleted += await redisClient.unlink(keys);
	}
	return deleted;
};

(async () => {
	console.log('---------');
	console.log(`🏁 Clearing out test env for e2e tests.`);

	const dbName = mongoDbName(Config.datastore.connectionString, Config.app.code, Config.env);
	assertIsolatedFromDev(dbName);

	// Make a connection to the datastore.
	let _client = await MongoClient.connect(Config.datastore.connectionString, { appName: Config.app.code, maxPoolSize: 100 });
	let _connection = _client.db(dbName);

	console.log(`🤝 Connected to the datastore: ${Config.datastore.connectionString}`);

	// Make a connection to the redis cache.
	const redisClient = redis.createClient({ url: Config.redis.url });
	await redisClient.connect();
	console.log(`🤝 Connected to the redis cache: ${Config.redis.url}`);

	// Drop all collections
	await _connection.dropDatabase();
	console.log(`💥 Dropping all collections in ${dbName}`);

	// Clear this app code's keys from the redis cache.
	const deleted = await deleteScopedKeys(redisClient, Config.redis.scope);
	console.log(`💥 Deleted ${deleted} "${Config.redis.scope}*" keys from the redis cache`);


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
})().catch((err) => {
	console.error(`🚨 ${err.message}`);
	process.exit(1);
});
