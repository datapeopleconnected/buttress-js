'use strict';

/**
 * ButtressJS - Realtime datastore for software
 *
 * @file logging.js
 * @description Logging helpers
 * @module System
 * @author Chris Bates-Keegan
 *
 * @todo Centralise this logging across the app
 * @todo Add other log targets ie to datastore
 *
 */

const cluster = require('cluster');
const winston = require('winston');
const Config = require('node-env-obj')();

/**
 *
 * @type {{ERR: string, WARN: string, INFO: string, VERBOSE: string, DEBUG: string, SILLY: string, DEFAULT: string}}
 */
const LogLevel = {
	ERR: 'error',
	WARN: 'warn',
	INFO: 'info',
	VERBOSE: 'verbose',
	DEBUG: 'debug',
	SILLY: 'silly',
	DEFAULT: 'info',
};

module.exports.Constants = {
	LogLevel: LogLevel,
};

// let _logApp = 'app';
let _logProcess = 'MASTER';
const setLogApp = (app) => {
	// _logApp = app;
	if (cluster.isWorker) {
		_logProcess = `${cluster.worker.id}`;
	}
};
module.exports.setLogApp = setLogApp;

let _captureOutput = false;
let _captureOutputBuffer = [];

/**
 * @param {String} logApp - Log applcation label (rest / socket)
 */
module.exports.init = (logApp) => {
	setLogApp(logApp);

	// winston.remove(winston.transports.Console);
	winston.add(new winston.transports.Console({
		level: Config.logging.level,
		format: winston.format.combine(
			winston.format.colorize(),
			winston.format.timestamp(),
			winston.format.errors({stack: true}),
			winston.format.printf((info) => {
				if (info.stack) {
					return `${info.timestamp} [${logApp}][${_logProcess}] ${info.level}: ${info.message}\n${info.stack}`;
				}

				return `${info.timestamp} [${logApp}][${_logProcess}] ${info.level}: ${info.message}`;
			}),
		),
	}));

	// winston.remove(winston.transports.Console);
	// winston.add(winston.transports.Console, {
	// 	name: 'console',
	// 	colorize: 'all',
	// 	timestamp: true,
	// 	level: 'info',
	// });

	// winston.add(winston.transports.Rotate, {
	// 	name: 'debug-file',
	// 	json: false,
	// 	file: `${Config.paths.logs}/log-${_logApp}-debug.log`,
	// 	level: 'debug',
	// 	size: '1m',
	// 	keep: 2,
	// 	colorize: 'all',
	// 	timestamp: true,
	// });
	// winston.add(winston.transports.Rotate, {
	// 	name: 'info-file',
	// 	json: false,
	// 	file: `${Config.paths.logs}/log-${_logApp}-info.log`,
	// 	size: '1m',
	// 	keep: 5,
	// 	colorize: 'all',
	// 	level: 'info',
	// 	timestamp: true,
	// });
	// winston.add(winston.transports.Rotate, {
	// 	name: 'error-file',
	// 	json: false,
	// 	file: `${Config.paths.logs}/log-${_logApp}-err.log`,
	// 	size: '1m',
	// 	keep: 10,
	// 	level: 'error',
	// 	colorize: 'none',
	// 	timestamp: true,
	// });
	// winston.add(winston.transports.Rotate, {
	// 	name: 'silly-file',
	// 	json: false,
	// 	file: `${Config.paths.logs}/log-${_logApp}-silly.log`,
	// 	level: 'silly',
	// 	size: '1m',
	// 	keep: 1,
	// 	colorize: 'all',
	// 	timestamp: true,
	// });
	// winston.addColors({
	// 	info: 'white',
	// 	error: 'red',
	// 	warn: 'yellow',
	// 	verbose: 'white',
	// 	debug: 'white',
	// });
};

module.exports.captureOutput = (mode = false) => {
	if (mode) {
		// Setup structure
		module.exports.clean();
	}

	_captureOutput = mode;
};
module.exports.flush = () => {
	_captureOutputBuffer.forEach((line) => {
		winston.log(line);
	});
};
module.exports.clean = () => {
	_captureOutputBuffer = [];
};

/**
 *
 * @param {string} log - log entry
 * @param {string} level - level to log at
 * @param {string} id - id
 * @private
 */
function _log(log, level, id) {
	const line = {
		level: level,
		message: (id) ? `[${id}] ${log}` : log,
	};

	if (_captureOutput) {
		_captureOutputBuffer.push(line);
		return;
	}

	winston.log(line);
}

/**
 * STANDARD LOGGING
 */

module.exports.setLogLevel = (level) => {
	winston.level = level;
	// _logLevel = level;
};

/**
 * @param {string} log - Text to log
 * @param {string} level - level to log at
 * @param {string} id - id
 */
module.exports.log = (log, level, id=null) => {
	level = level || LogLevel.DEFAULT;
	_log(log, level, id);
};

/**
 * @param {string} log - Text to log
 * @param {string} id - id
 */
module.exports.logVerbose = (log, id=null) => {
	module.exports.log(log, LogLevel.VERBOSE, id);
};

/**
 * @param {string} log - Text to log
 * @param {string} id - id
 */
module.exports.logDebug = (log, id=null) => {
	module.exports.log(log, LogLevel.DEBUG, id);
};

/**
 * @param {string} log - Text to log
 * @param {string} id - id
 */
module.exports.logSilly = (log, id=null) => {
	module.exports.log(log, LogLevel.SILLY, id);
};

/**
 * @param {string} warn - warning to log
 * @param {string} id - id
 */
module.exports.logWarn = (warn, id=null) => {
	_log(warn, LogLevel.WARN, id);
};
/**
 * @param {string} err - error object to log
 * @param {string} id - id
 */
module.exports.logError = (err, id=null) => {
	if (err && err.stack && err.message) {
		_log(err.message, LogLevel.ERR, id);
		_log(err.stack, LogLevel.ERR, id);
	} else {
		_log(err, LogLevel.ERR, id);
	}
};

/**
 * @param {string} log - Text to log
 * @param {Object} timer - Object with an 'interval' property
 * @param {string} level - level to log at
 * @param {string} id - id
 */
module.exports.logTimer = (log, timer, level, id=null) => {
	level = level || LogLevel.INFO;
	_log(`[${timer.interval.toFixed(6)}s][${timer.lapTime.toFixed(6)}s] ${log}`, level, id);
};

/**
 * @param {string} log - Text to log
 * @param {Object} timer - Object with an 'interval' property
 * @param {string} time - time above which to log the exception
 * @param {string} id - id
 */
module.exports.logTimerException = (log, timer, time, id=null) => {
	const level = LogLevel.ERR;
	if (timer.interval > time) {
		_log(`[${timer.interval.toFixed(6)}s][${timer.lapTime.toFixed(6)}s] ${log} ${timer.interval.toFixed(3)}s > ${time}s`, level, id);
	}
};

/**
 * PROMISE LOGGING
 */

module.exports.Promise = {};

/**
 * @param {string} log - Text to log
 * @param {string} level - level to log at
 * @return {function(*)} - returns a function for chaining into a promise
 * @param {string} id - id
 */
module.exports.Promise.log = (log, level, id=null) => {
	level = level || LogLevel.DEFAULT;
	return (res) => {
		_log(`${log}: ${res}`, level, id);
		return res;
	};
};

/**
 * @param {string} log - Text to log
 * @param {*} val - value to test `res` against
 * @param {string} level - level to log at
 * @return {function(*)} - returns a function for chaining into a promise
 */
module.exports.Promise.logIf = (log, val, level) => {
	level = level || LogLevel.DEFAULT;
	return (res) => {
		if (val === res) {
			_log(`${log}: ${res}`, level);
		}
		return res;
	};
};

/**
 * @param {string} log - Text to log
 * @param {*} val - value to test `res` against
 * @param {string} level - level to log at
 * @return {function(*)} - returns a function for chaining into a promise
 */
module.exports.Promise.logIfNot = (log, val, level) => {
	level = level || LogLevel.DEFAULT;
	return (res) => {
		if (val !== res) {
			_log(`${log}: ${res}`, level);
		}
		return res;
	};
};

/**
 * PROPERTY LOGGING
 */

/**
 * @param {string} log - Text to log
 * @param {string} prop - Name of the `res` property to log
 * @param {string} level - level to log at
 * @return {function(*)} - returns a function for chaining into a promise
 */
module.exports.Promise.logProp = (log, prop, level) => {
	level = level || LogLevel.DEFAULT;
	return (res) => {
		_log(`${log}: ${res[prop]}`, level);
		return res;
	};
};

/**
 * @param {string} log - Text to log
 * @param {string} prop - Name of the `res` property to log
 * @param {*} val - value to test `res` against
 * @param {string} level - level to log at
 * @return {function(*)} - returns a function for chaining into a promise
 */
module.exports.Promise.logPropIf = (log, prop, val, level) => {
	level = level || LogLevel.DEFAULT;
	return (res) => {
		if (val === res[prop]) {
			_log(`${log}: ${res[prop]}`, level);
		}
		return res;
	};
};

/**
 * @param {string} log - Text to log
 * @param {string} prop - Name of the `res` property to log
 * @param {*} val - value to test `res` against
 * @param {string} level - level to log at
 * @return {function(*)} - returns a function for chaining into a promise
 */
module.exports.Promise.logPropIfNot = (log, prop, val, level) => {
	level = level || LogLevel.DEFAULT;
	return (res) => {
		if (val !== res[prop]) {
			_log(`${log}: ${res[prop]}`, level);
		}
		return res;
	};
};

/**
 * ARRAY LOGGING
 */

/**
 * @param {string} log - Text to log
 * @param {string} level - level to log at
 * @return {function(*)} - returns a function for chaining into a promise
 */
module.exports.Promise.logArray = (log, level) => {
	level = level || LogLevel.DEFAULT;
	return (res) => {
		_log(`${log}: ${res.length}`, level);
		res.forEach((r) => {
			_log(r, level);
		});
		return res;
	};
};

/**
 * @param {string} log - Text to log
 * @param {string} prop - Name of the `res[]` property to log
 * @param {string} level - level to log at
 * @return {function(*)} - returns a function for chaining into a promise
 */
module.exports.Promise.logArrayProp = (log, prop, level) => {
	level = level || LogLevel.DEFAULT;
	return (res) => {
		_log(`${log}: ${res.length}`, level);
		res.forEach((r) => {
			_log(r[prop]);
		});
		return res;
	};
};

/**
 * @return {function(*)} - returns a function for chaining into a promise
 */
module.exports.Promise.logError = () => {
	const level = LogLevel.ERR;
	return (err) => {
		_log(err.message, level);
		_log(err.stack, level);
		return err;
	};
};

/**
 * @param {string} log - Text to log
 * @return {function(*)} - returns a function for chaining into a promise
 * @param {string} id - id
 */
module.exports.Promise.logInfo = (log, id=null) => {
	const level = LogLevel.INFO;
	return module.exports.Promise.log(log, level, id);
};

/**
 * @param {string} log - Text to log
 * @return {function(*)} - returns a function for chaining into a promise
 * @param {string} id - id
 */
module.exports.Promise.logVerbose = (log, id=null) => {
	const level = LogLevel.VERBOSE;
	return module.exports.Promise.log(log, level, id);
};

/**
 * @param {string} log - Text to log
 * @return {function(*)} - returns a function for chaining into a promise
 * @param {string} id - id
 */
module.exports.Promise.logDebug = (log, id=null) => {
	const level = LogLevel.DEBUG;
	return module.exports.Promise.log(log, level, id);
};

/**
 * @param {string} log - Text to log
 * @return {function(*)} - returns a function for chaining into a promise
 * @param {string} id - id
 */
module.exports.Promise.logSilly = (log, id=null) => {
	const level = LogLevel.SILLY;
	return module.exports.Promise.log(log, level, id);
};

/**
 * @param {string} log - Text to log
 * @param {Object} timer - Object with an 'interval' property
 * @param {string} level - level to log at
 * @return {function(*)} - returns a function for chaining into a promise
 * @param {string} id - id
 */
module.exports.Promise.logTimer = (log, timer, level, id=null) => {
	return (res) => {
		module.exports.logTimer(log, timer, level, id);
		return res;
	};
};

/**
 * @param {string} log - Text to log
 * @param {Object} timer - Object with an 'interval' property
 * @param {string} time - time above which to log the exception
 * @return {function(*)} - returns a function for chaining into a promise
 * @param {string} id - id
 */
module.exports.Promise.logTimerException = (log, timer, time, id=null) => {
	return (res) => {
		module.exports.logTimerException(log, timer, time, id);

		return res;
	};
};
