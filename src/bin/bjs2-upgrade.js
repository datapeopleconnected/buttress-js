#!/usr/bin/env node
'use strict';

/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2022 Data Performance Consultancy LTD.
 * <https://dataperformanceconsultancy.com/>
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

const program = require('commander');
const MongoClient = require('mongodb').MongoClient;
// const ObjectId = require('mongodb').ObjectId;

const Config = require('node-env-obj')('../');
const Logging = require('../logging');
const Schema = require('../schema');

Logging.init('bjs2-upgrade');

program.version(Config.app.version)
	.option('--limit <n>', 'Limit number of tenders to process', parseInt)
	.option('--dry-run', 'Dry run, no live data writes')
	.option('--verbose', 'Verbose mode')
	.option('--all', 'Full Upgrade')
	.option('--app', 'Apps Upgrade')
	.option('--person', 'Maps existing bjs v1 person objects to user object')
	.option('--fix-person', 'Fixup person objects')
	.parse(process.argv);

class BJ2Upgrade {
	constructor() {
		this.options = {
			dryRun: (program.dryRun) ? program.dryRun : false,
			verbose: (program.verbose) ? program.verbose : false,

			all: (program.all) ? program.all : false,
			app: (program.app) ? program.app : false,
			person: (program.person) ? program.person : false,
			fixPerson: (program.fixPerson) ? program.fixPerson : false,
		};

		this.mongoDB = null;

		this.__initUpgrade();
	}

	__connectToMongoDB() {
		const dbName = `${Config.app.code}-${Config.env}`;
		const mongoUrl = `mongodb://${Config.mongoDb.url}/?authMechanism=DEFAULT&authSource=${dbName}`;
		return MongoClient.connect(mongoUrl, Config.mongoDb.options)
			.then((client) => client.db(dbName))
			.catch(Logging.Promise.logError());
	}

	__initUpgrade() {
		Logging.log('INIT upgrade process');

		const programs = {
			app: () => this.__upgradeApps(),
			person: () => this.__mapPeopleTouser(),
		};
		let selectedPrograms = {};

		if (this.options.person) {
			selectedPrograms.person = programs.person;
		}
		if (this.options.app) {
			selectedPrograms.app = programs.app;
		}
		if (this.options.fixPerson) {
			selectedPrograms.fixPerson = () => this.__mapFixupPerson();
		}

		if (this.options.all) {
			selectedPrograms = programs;
		}

		if (Object.keys(selectedPrograms).length < 1) {
			Logging.log(`No program selected, Please use --help for more info.`, Logging.Constants.LogLevel.ERR);
			process.exit(1);
		}

		const tasks = [];

		// Connect to mongoDB
		tasks.push(() => this.__connectToMongoDB().then((db) => this.mongoDB = db));

		// Queue up selected programs
		Logging.log(`Queuing up the following upgrades: ${Object.keys(selectedPrograms).join(', ')}`);
		for (const p in selectedPrograms) {
			if (!{}.hasOwnProperty.call(selectedPrograms, p)) continue;
			tasks.push(selectedPrograms[p]);
		}

		tasks.push(() => {
			Logging.log(`Upgrade process has finished.`);
			process.exit(1);
		});

		return tasks.reduce((prev, next) => prev.then(() => next()), Promise.resolve());
	}

	__upgradeApps() {
		const App = this.mongoDB.collection('apps');

		const dbData = {
			apps: null,
		};

		return new Promise((resolve) => App.find({}).toArray((err, doc) => {
			if (err) throw err;
			dbData.apps = doc;
			resolve(doc);
		}))
			.then(() => {
				const updates = [];

				dbData.apps.forEach((app) => {
					if (app.__schema && typeof app.__schema === 'object') {
						updates.push({
							id: app._id,
							change: {
								__schema: Schema.encode(app.__schema),
							},
						});
					}
				});

				Logging.log(`${updates.length} Updates to apps`);

				return updates.map((update) => {
					return () => {
						return new Promise((resolve) => {
							App.updateOne({_id: update.id}, {$set: update.change}, {}, (err, object) => {
								if (err) throw new Error(err);
								resolve(object);
							});
						});
					};
				});
			})
			.then((updates) => updates.reduce((prev, next) => prev.then(() => next()), Promise.resolve()));
	}

	__mapFixupPerson() {
		const People = this.mongoDB.collection('people');
		const Users = this.mongoDB.collection('users');

		const dbData = {
			people: null,
			users: null,
		};

		return new Promise((resolve) => People.find({}).toArray((err, doc) => {
			if (err) throw err;
			dbData.people = doc;
			resolve(doc);
		}))
			.then(() => new Promise((resolve) => Users.find({}).toArray((err, doc) => {
				if (err) throw err;
				dbData.users = doc;
				resolve(doc);
			})))
			.then(() => {
				// Process the data
				const updates = [];

				dbData.users.forEach((user) => {
					if (!user._person) {
						Logging.log(`User ${user._id} has no _person attached.`);
						return;
					}

					const userPerson = dbData.people.find((p) => p._id.equals(user._person));
					if (!userPerson) {
						Logging.log(`User ${user._id} unable to find person: ${user._person}.`, Logging.Constants.LogLevel.ERR);
						return;
					}

					if (!userPerson.authId || !user._id.equals(userPerson.authId)) {
						updates.push({
							id: userPerson._id,
							change: {
								authId: user._id,
							},
						});
					}

					const combinedName = [];
					if (userPerson.forename) combinedName.push(userPerson.forename);
					if (userPerson.surname) combinedName.push(userPerson.surname);
					if (!userPerson.name || userPerson.name !== combinedName.join(' ')) {
						updates.push({
							id: userPerson._id,
							change: {
								name: combinedName.join(' '),
							},
						});
					}

					if (!userPerson.avatar || userPerson.avatar !== user.auth[0].images.profile) {
						updates.push({
							id: userPerson._id,
							change: {
								avatar: user.auth[0].images.profile,
							},
						});
					}
				});

				Logging.log(`Updates ${updates.length}`);

				return updates.map((update) => {
					return () => {
						return new Promise((resolve) => {
							People.updateOne({_id: update.id}, {$set: update.change}, {}, (err, object) => {
								if (err) throw new Error(err);
								resolve(object);
							});
						});
					};
				});
			})
			.then((updates) => updates.reduce((prev, next) => prev.then(() => next()), Promise.resolve()));
	}

	__mapPeopleTouser() {
		const People = this.mongoDB.collection('people');
		const Users = this.mongoDB.collection('users');

		const dbData = {
			people: null,
			users: null,
		};

		return new Promise((resolve) => People.find({}).toArray((err, doc) => {
			if (err) throw err;
			dbData.people = doc;
			resolve(doc);
		}))
			.then(() => new Promise((resolve) => Users.find({}).toArray((err, doc) => {
				if (err) throw err;
				dbData.users = doc;
				resolve(doc);
			})))
			.then(() => {
				// Process the data
				const updates = [];

				dbData.users.forEach((user) => {
					if (!user._person) {
						Logging.log(`User ${user._id} has no _person attached.`);
						return;
					}

					const userPerson = dbData.people.find((p) => p._id.equals(user._person));
					if (!userPerson) {
						Logging.log(`User ${user._id} unable to find person: ${user._person}.`, Logging.Constants.LogLevel.ERR);
						return;
					}

					if (userPerson.metadata) {
						delete userPerson.metadata;
					}
					if (userPerson.metadata) {
						delete userPerson._id;
					}

					updates.push({
						id: user._id,
						change: {
							person: userPerson,
						},
					});
				});

				Logging.log(`Mapping person objects to ${updates.length} users`);

				return updates.map((update) => {
					return () => {
						return new Promise((resolve) => {
							Users.updateOne({_id: update.id}, {$set: update.change}, {}, (err, object) => {
								if (err) throw new Error(err);
								resolve(object);
							});
						});
					};
				});
			})
			.then((updates) => updates.reduce((prev, next) => prev.then(() => next()), Promise.resolve()));
	}
}

module.exports = new BJ2Upgrade();
