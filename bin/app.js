#!/usr/bin/env node
'use strict';

/**
 * ButtressJS - Realtime datastore for software
 *
 * @file app.js
 * @description
 * @module System
 * @author Chris Bates-Keegan
 *
 */

const env = (process.env.ENV_FILE) ? process.env.ENV_FILE : process.env.NODE_ENV;

const Config = require('node-env-obj')({
	envFile: `.${env}.env`,
	envPath: '../',
	configPath: '../src',
});

const Bootstrap = require('../src/bootstrap');
const Logging = require('../src/logging');
const Sugar = require('sugar');
Sugar.Date.setLocale('en-GB');

/**
 *
 */
Logging.init('REST');

Bootstrap.rest()
	.then((isMaster) => {
		if (isMaster) {
			Logging.log(`${Config.app.title}:${Config.app.code} REST Server Master v${Config.app.version} listening on port ` +
				`${Config.listenPorts.rest} in ${Config.env} mode.`);
			Logging.log(`Configured Main Endpoint: ${Config.app.protocol}://${Config.app.host}`);
		} else {
			Logging.log(`${Config.app.title}:${Config.app.code} REST Server Worker v${Config.app.version} ` +
				`in ${Config.env} mode.`);
		}
	})
	.catch(Logging.Promise.logError());
