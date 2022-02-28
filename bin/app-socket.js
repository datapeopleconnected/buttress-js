#!/usr/bin/env node
'use strict';

/**
 * ButtressJS - Realtime datastore for software
 *
 * @file socket-app.js
 * @description Entry point for socket app
 * @module Model
 * @author Chris Bates-Keegan
 *
 */

const env = (process.env.ENV_FILE) ? process.env.ENV_FILE : process.env.NODE_ENV;

const Config = require('node-env-obj')({
	envFile: `.${env}.env`,
	envPath: '../',
	configPath: '../src',
});

const Logging = require('../src/logging');
const BootstrapSocket = require('../src/bootstrap-socket');

Logging.init('SOCK');

const app = new BootstrapSocket();
app.init()
	.then((isMaster) => {
		if (isMaster) {
			Logging.log(`${Config.app.title} Socket Master v${Config.app.version} listening on port ` +
				`${Config.listenPorts.sock} in ${Config.env} mode.`);
		} else {
			Logging.log(`${Config.app.title} Socket Worker v${Config.app.version} in ${Config.env} mode.`);
		}
	})
	.catch(Logging.Promise.logError());
