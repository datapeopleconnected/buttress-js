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

const Stream = require('stream');
// const JSONStream = require('JSONStream');
const Config = require('node-env-obj')();
const Logging = require('../helpers/logging');
// const Schema = require('../schema');
const Model = require('../model');
const Helpers = require('../helpers');
// const AccessControl = require('../access-control');

const SchemaModelRemote = require('../model/type/remote');

/**
 */
// var _otp = OTP.create({
//   length: 12,
//   mode: OTP.Constants.Mode.ALPHANUMERIC,
//   salt: Config.RHIZOME_OTP_SALT,
//   tolerance: 3
// });

let _app = null;
let _io = null;

/**
 * @type {{Auth: {
 *          NONE: number,
 *          USER: number,
 *          ADMIN: number,
 *          SUPER: number},
 *         Permissions: {
 *          NONE: string,
 *          ADD: string,
 *          READ: string,
 *          WRITE: string,
 *          LIST: string,
 *          DELETE: string,
 *          ALL: string
*          },
 *         Verbs: {
 *          GET: string,
 *          POST: string,
 *          PUT: string,
 *          DEL: string
*          }}}
 */
const Constants = {
	Type: {
		USER: 'user',
		DATASHARING: 'dataSharing',
		LAMBDA: 'lambda',
		APP: 'app',
		SYSTEM: 'system',
	},
	Permissions: {
		NONE: '',
		ADD: 'add',
		READ: 'read',
		WRITE: 'write',
		LIST: 'list',
		DELETE: 'delete',
		SEARCH: 'search',
		COUNT: 'count',
		ALL: '*',
	},
	Verbs: {
		GET: 'get',
		POST: 'post',
		PUT: 'put',
		DEL: 'delete',
		SEARCH: 'search',
	},
	BulkRequests: {
		BULK_PUT: '/bulk/update',
		BULK_DEL: '/bulk/delete',
	},
};

class Route {
	constructor(paths, name, services) {
		this.verb = Constants.Verbs.GET;
		this.Type = Constants.Type.SYSTEM;
		this.permissions = Constants.Permissions.READ;

		this.activity = true;
		this.activityBroadcast = false;
		this.activityVisibility = Model.Activity.Constants.Visibility.PRIVATE;
		this.activityTitle = 'Private Activity';
		this.activityDescription = '';

		this.slowLogging = Config.logging.slow === 'TRUE';
		this.slowLoggingTime = parseFloat(Config.logging.slowTime);

		this.timingChunkSample = 250;

		// Defaults for system/core routes, will be overridden by __configureSchemaRoute
		// for schema routes.
		this.core = true;
		this.redactResults = true;
		this.addSourceId = false;

		this.schema = null;
		this.model = null;

		this.paths = Array.isArray(paths) ? paths : [paths];

		this.name = name;

		this._nrp = services.get('nrp');

		this._redisClient = services.get('redisClient');
	}

	// Quickly apply some common schemaRoute configurations, will typically be called
	// straight after the constructor super call.
	__configureSchemaRoute() {
		this.core = false;
		this.redactResults = true;
		this.addSourceId = true;
	}

	/**
	 * @param {Object} req - ExpressJS request object
	 * @param {Object} res - ExpresJS response object
	 * @return {Promise} - Promise is fulfilled once execution has completed
	 */
	async exec(req, res) {
		const ip = req.ip || req._remoteAddress || (req.connection && req.connection.remoteAddress) || undefined;
		Logging.logTimer(`${req.method} ${req.originalUrl || req.url} ${ip}`, req.timer, Logging.Constants.LogLevel.DEBUG, req.id);
		Logging.logTimer('Route:exec:start', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		this._timer = req.timer;

		if (!this._exec) {
			Logging.logTimer('Route:exec:end-no-exec-defined', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			return Promise.reject(new Helpers.Errors.RequestError(500));
		}

		const token = await this._authenticate(req, res);

		req.timings.validate = req.timer.interval;
		Logging.logTimer('Route:exec:validate:start', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		const validate = await this._validate(req, res, token);
		Logging.logTimer('Route:exec:validate:end', req.timer, Logging.Constants.LogLevel.SILLY, req.id);

		req.timings.exec = req.timer.interval;
		Logging.logTimer('Route:exec:exec:start', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		const result = await this._exec(req, res, validate);
		Logging.logTimer('Route:exec:exec:end', req.timer, Logging.Constants.LogLevel.SILLY, req.id);

		// Send the result back to the client and resolve the request from
		// this point onward you should treat the request as furfilled.
		if (result instanceof Stream && result.readable) {
			result.on('bjs-stream-status', (data) => req.bjsReqStatus(data, this._nrp));

			const resStream = new Stream.PassThrough({objectMode: true});
			const broadcastStream = new Stream.PassThrough({objectMode: true});

			result.pipe(resStream);

			if (this.verb !== Constants.Verbs.GET && this.verb !== Constants.Verbs.SEARCH) {
				result.pipe(broadcastStream);
			}

			// await Plugins.do_action('route-add-many:_exec', this.schema, results);

			await this._respond(req, res, resStream);

			await this._logActivity(req, res);

			await this._boardcastData(req, res, broadcastStream);

			req.bjsReqStatus({status: 'ready'}, this._nrp);
		} else {
			// await Plugins.do_action('route-add-many:_exec', this.schema, results);

			await this._respond(req, res, result);

			await this._logActivity(req, res);

			await this._boardcastData(req, res, result);
		}

		Logging.logTimer(`Route:exec:end`, this._timer, Logging.Constants.LogLevel.SILLY, req.id);
	}

	/**
	 * Set the responce for a request
	 * @param {Object} req
	 * @param {Object} res
	 * @param {*} result
	 * @return {*} result
	 */
	async _respond(req, res, result) {
		req.timings.respond = req.timer.interval;

		const isReadStream = (result instanceof Stream && result.readable);

		Logging.logTimer(`_respond:start isReadStream:${isReadStream} redactResults:${this.redactResults}`,
			req.timer, Logging.Constants.LogLevel.SILLY, req.id);

		if (isReadStream) {
			let chunkCount = 0;
			const stringifyStream = new Helpers.JSONStringifyStream({}, (chunk) => {
				chunkCount++;

				if (chunkCount % this.timingChunkSample === 0) req.timings.stream.push(req.timer.interval);
				return (this.redactResults) ? Helpers.Schema.prepareSchemaResult(chunk, (this.addSourceId) ? req.authApp.id : null) : chunk;
			});

			res.set('Content-Type', 'application/json');

			Logging.logTimer(`_respond:start-stream`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);

			result.once('end', () => {
				// Logging.logTimerException(`PERF: STREAM DONE: ${req.pathSpec}`, req.timer, 0.05, req.id);
				Logging.logTimer(`_respond:end-stream chunks:${chunkCount}`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
				req.bjsReqClose(this._nrp);
				this._close(req);
			});

			result.pipe(stringifyStream).pipe(res);

			return result;
		}

		if (this.redactResults) {
			res.json(Helpers.Schema.prepareSchemaResult(result, (this.addSourceId) ? req.authApp.id : null));
		} else {
			res.json(result);
		}

		this._close(req);

		Logging.logTimer(`_respond:end ${req.pathSpec}`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		// Logging.logTimerException(`PERF: DONE: ${req.pathSpec}`, req.timer, 0.05, req.id);

		return result;
	}

	_logActivity(req, res) {
		req.timings.logActivity = req.timer.interval;
		Logging.logTimer('_logActivity:start', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		if (this.verb === Constants.Verbs.GET) {
			Logging.logTimer('_logActivity:end-get', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			return;
		}
		if (this.verb === Constants.Verbs.SEARCH) {
			Logging.logTimer('_logActivity:end-search', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			return;
		}

		// Fire and forget
		if (this.activity) {
			this._addLogActivity(req, req.pathSpec, this.verb);
		}

		Logging.logTimer('_logActivity:end', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
	}

	_addLogActivity(req, path, verb) {
		Logging.logTimer('_addLogActivity:start', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		// TODO: Activty should pass back a stripped version of the activty object.
		return Model.Activity.add({
			activityTitle: this.activityTitle,
			activityDescription: this.activityDescription,
			activityVisibility: this.activityVisibility,
			path: path,
			verb: verb,
			permissions: this.permissions,
			auth: this.auth,
			params: req.params,
			req: req,
			res: {},
		})
			.then(Logging.Promise.logTimer('_addLogActivity:end', req.timer, Logging.Constants.LogLevel.SILLY, req.id))
			.catch((e) => Logging.logError(e, req.id));
	}

	/**
	 * Handle broadcasting the result by app policies
	 * @param {Object} req
	 * @param {Object} res
	 * @param {*} result
	 */
	async _boardcastData(req, res, result) {
		req.timings._boardcastData = req.timer.interval;
		Logging.logTimer('_boardcastData:start', req.timer, Logging.Constants.LogLevel.SILLY, req.id);

		if (this.model && this.model instanceof SchemaModelRemote) {
			Logging.logTimer('_boardcastData:end-is-dsa', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			return;
		}

		if (this.verb === Constants.Verbs.GET || this.verb === Constants.Verbs.SEARCH) {
			Logging.logTimer('_boardcastData:end-get', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			return;
		}

		let path = req.path.split('/');
		if (path[0] === '') path.shift();
		if (req.authApp && req.authApp.apiPath && path.indexOf(req.authApp.apiPath) === 0) {
			path.shift();
		}
		// Replace API version prefix
		path = `/${path.join('/')}`.replace(Config.app.apiPrefix, '');

		this._broadcast(req, res, result, path, true);

		this._broadcast(req, res, result, path);

		Logging.logTimer('_boardcastData:end', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
	}

	/**
	 * Handle result based on the collection and broadcast
	 * @param {*} req
	 * @param {*} res
	 * @param {*} result
	 * @param {*} path
	 * @param {boolean} isSuper
	 */
	async _broadcast(req, res, result, path, isSuper = false) {
		Logging.logTimer('_broadcast:start', req.timer, Logging.Constants.LogLevel.SILLY, req.id);

		const isReadStream = (result instanceof Stream && result.readable);
		await this._checkBasedPathLambda(req);

		const emit = (_result) => {
			if (this.activityBroadcast === true) {
				this._nrp.emit('activity', {
					title: this.activityTitle,
					description: this.activityDescription,
					visibility: this.activityVisibility,
					broadcast: this.activityBroadcast,
					path: path,
					pathSpec: req.pathSpec,
					verb: this.verb,
					permissions: this.permissions,
					params: req.params,
					timestamp: new Date(),
					response: _result,
					user: req.authUser ? req.authUser.id : '',
					appAPIPath: req.authApp ? req.authApp.apiPath : '',
					appId: req.authApp ? req.authApp.id : '',
					isSuper: isSuper,
					schemaName: this.schema?.name,
				});
			} else {
				// Trigger the emit activity so we can update the stats namespace
			}
		};

		if (isReadStream) {
			result.on('data', (data) => emit(Helpers.Schema.prepareSchemaResult(data, req.authApp.id)));
			Logging.logTimer('_broadcast:end-stream', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			return;
		}

		emit(Helpers.Schema.prepareSchemaResult(result, req.authApp.id));
		Logging.logTimer('_broadcast:end', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
	}

	/**
	 * Triggers path based lambdas
	 * @param {Object} req
	 */
	_checkBasedPathLambda(req) {
		// core schema
		if (!this.schema) return;

		const isLambdaChange = req.token.type === Model.Token.Constants.Type.LAMBDA;
		if (isLambdaChange) {
			// If the current lambda is a path mutation, we don't want to trigger other path mutations
			// not great but we'll just block all lambdas that have a pathMutation trigger
			if (req.authLambda.trigger.find((t) => t.type === 'PATH_MUTATION')) {
				Logging.logSilly(`Blocked path mutation lambda ${req.authLambda.name} from triggering other path mutations`);
				return;
			}
		}

		let paths = [];
		const values = [];
		let body = JSON.parse(req.body);
		const id = req.params.id;

		if (this.verb === Constants.Verbs.POST) {
			if (req.pathSpec.includes(Constants.BulkRequests.BULK_PUT)) {
				body.forEach((item) => {
					if (Array.isArray(item.body)) {
						item.body.forEach((obj) => {
							paths.push(`${this.schema?.name}.${item.id}.${obj.path}`);
							item.body.forEach((i) => values.push(i.value));
						});
					} else {
						paths.push(`${this.schema?.name}.${item.id}.${item.body.path}`);
						values.push(item.body.value);
					}
				});
			} else if (req.pathSpec.includes(Constants.BulkRequests.BULK_DEL)) {
				body.forEach((id) => paths.push(`${this.schema?.name}.${id}`));
			} else {
				paths.push(this.schema?.name);
				values.push(body);
			}
		}

		if (this.verb === Constants.Verbs.DEL) {
			if (id) {
				paths.push(`${this.schema?.name}.${id}`);
			} else if (Array.isArray(body)) {
				body.forEach((item) => paths.push(`${this.schema?.name}.${item.path}`));
			} else {
				paths.push(this.schema?.name);
			}
		}
		if (this.verb === Constants.Verbs.PUT) {
			if (!Array.isArray(body)) body = [body];
			body.forEach((item) => {
				if (!item.path) return;
				paths.push(`${this.schema?.name}.${id}.${item.path}`);
				values.push(item.value);
			});
		}

		paths = paths.filter((v, idx, arr) => arr.indexOf(v) === idx);
		if (paths.length > 0) {
			this._nrp.emit('notifyLambdaPathChange', {
				paths,
				values,
				collection: this.schema?.name,
			});
		}
	}

	/**
	 * @param {Object} req - ExpressJS request object
	 * @param {Object} res - ExpresJS response object
	 * @return {Promise} - Promise is fulfilled once the authentication is completed
	 * @private
	 */
	_authenticate(req, res) {
		req.timings.authenticate = req.timer.interval;
		return new Promise((resolve, reject) => {
			if (!req.token) {
				this.log('EAUTH: INVALID TOKEN', Logging.Constants.LogLevel.ERR, req.id);
				Logging.logTimer('_authenticate:end-invalid-token', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
				return reject(new Helpers.Errors.RequestError(401, 'invalid_token'));
			}

			if (this.authType && req.token.type !== this.authType) {
				this.log(`EAUTH: INSUFFICIENT AUTHORITY ${req.token.type} is not equal to ${this.authType}`, Logging.Constants.LogLevel.ERR, req.id);
				Logging.logTimer('_authenticate:end-insufficient-authority', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
				return reject(new Helpers.Errors.RequestError(401, 'insufficient_authority'));
			}

			/**
			 * @description Route:
			 *  '*' - all routes (SUPER)
			 *  'route' - specific route (ALL)
			 *  'route/subroute' - specific route (ALL)
			 *  'route/*' name plus all children (ADMIN)
			 * @TODO Improve the pattern matching granularity ie like Glob
			 * @TODO Support Regex in specific ie match routes like app/:id/permission
			 */
			Logging.logTimer(`_authenticate:start-app-routes`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);

			// BYPASS schema checks for app tokens
			if (req.token.type === 'app') {
				Logging.logTimer('_authenticate:end-app-token', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
				resolve(req.token);
				return;
			}

			// NOT GOOD
			if (req.token.type === 'dataSharing') {
				Logging.logTimer('_authenticate:end-app-token', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
				resolve(req.token);
				return;
			}

			Logging.logTimer(`_authenticate:end-app-routes`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);

			resolve(req.token);
		});
	}

	/**
	 * @param {string} permissionSpec -
	 * @return {boolean} - true if authorised
	 * @private
	 */
	_matchPermission(permissionSpec) {
		if (permissionSpec === '*' || permissionSpec === this.permissions) {
			return true;
		}

		return false;
	}

	/**
	 * @param {string} log - log text
	 * @param {enum} level - NONE, ERR, WARN, INFO
	 */
	log(log, level) {
		level = level || Logging.Constants.LogLevel.INFO;
		Logging.log(log, level);
	}

	/**
	 * Called when we expect the request to be closed
	 * @param {object} req - The request object to be compared to
	 * @private
	 */
	_close(req) {
		req.timings.close = req.timer.interval;
		if (this.slowLogging && req.timings.close > this.slowLoggingTime) {
			Logging.logError(`${req.method} ${req.url} SLOW REQUEST ${JSON.stringify(req.timings)}`, req.id);
		}
	}

	static set app(app) {
		_app = app;
	}
	static get app() {
		return _app;
	}
	static set io(io) {
		_io = io;
	}
	static get io() {
		return _io;
	}
	static get Constants() {
		return Constants;
	}

	/**
	 * @return {enum} - returns the LogLevel enum (convenience)
	 */
	static get LogLevel() {
		return Logging.Constants.LogLevel;
	}
}

module.exports = Route;
