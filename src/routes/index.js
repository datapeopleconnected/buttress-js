/* eslint-disable max-lines */
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

const fs = require('fs');
const path = require('path');
const express = require('express');
const onFinished = require('on-finished');
const {v4: uuidv4} = require('uuid');
const ObjectId = require('mongodb').ObjectId;

const Config = require('node-env-obj')();

// const Route = require('./route');
const Logging = require('../helpers/logging');
const Schema = require('../schema');
const Helpers = require('../helpers');
const AccessControl = require('../access-control');
const Model = require('../model');

const AdminRoutes = require('./admin-routes');
const SchemaRoutes = require('./schema-routes');

const Datastore = require('../datastore');

class Routes {
	/**
	 * @param {Object} app - express app object
	 */
	constructor(app) {
		this.app = app;
		this.id = uuidv4();

		this._tokens = [];
		this._routerMap = {};

		this._services = null;

		this._nrp = null;

		this._preRouteMiddleware = [
			(...args) => this._timeRequest(...args),
			(...args) => this._authenticateToken(...args),
			(...args) => AccessControl.accessControlPolicyMiddleware(...args),
			(...args) => this._configCrossDomain(...args),
		];
	}

	async init(services) {
		this._services = services;

		this._nrp = services.get('nrp');
	}

	/**
	 * Init core routes & app schema
	 * @return {promise}
	 */
	async initRoutes() {
		this.app.get('/favicon.ico', (req, res, next) => res.sendStatus(404));
		this.app.get(['/', '/index.html'], (req, res, next) => res.sendFile(path.join(__dirname, '../static/index.html')));

		this.app.use((req, res, next) => {
			req.on('close', function() {
				Logging.logSilly(`close`, req.id);
			});
			req.on('end', function() {
				Logging.logSilly(`end`, req.id);
			});
			req.on('error', function(err) {
				Logging.logError(`req onError`, req.id);
				Logging.logError(err, req.id);
			});
			req.on('pause', function() {
				Logging.logSilly(`pause`, req.id);
			});
			req.on('resume', function() {
				Logging.logSilly(`resume`, req.id);
			});

			req.on('timeout', function() {
				Logging.logError(`timeout`, req.id);
			});

			if (req.socket) {
				req.socket.on('close', (hadError) => {
					Logging.logSilly(`socket onClose had_error:${hadError}`, req.id);
				});
				req.socket.on('connect', () => {
					Logging.logSilly(`socket onConnect`, req.id);
				});
				req.socket.on('end', () => {
					Logging.logSilly(`socket onEnd`, req.id);
				});
				req.socket.on('lookup', (err, address, family, host) => {
					if (err) {
						Logging.logError(`socket onLookup`, req.id);
						Logging.logError(err, req.id);
						return;
					}

					Logging.logDebug(`socket onLookup address:${address} family:${family} host:${host}}`, req.id);
				});
				req.socket.on('timeout', () => {
					Logging.logError(`socket onTimeout`, req.id);
				});
				req.socket.on('error', (err) => {
					Logging.logError(`socket onError`, req.id);
					Logging.logError(err, req.id);
				});
			}

			next();
		});
		this.app.use((err, req, res, next) => {
			if (err) Logging.logError(err, req.id);
			next();
		});

		const coreRouter = this._createRouter();
		const providers = this._getCoreRoutes();
		for (let x = 0; x < providers.length; x++) {
			const routes = providers[x];
			for (let y = 0; y < routes.length; y++) {
				const route = routes[y];
				this._initRoute(coreRouter, route, true);
			}
		}

		this._registerRouter('core', coreRouter);

		await this.loadTokens();

		await this._setupLambdaEndpoints();

		await AdminRoutes.initAdminRoutes(this.app);
		Logging.logSilly(`init:registered-routes`);
	}

	async initAppRoutes() {
		const rxsApps = await Model.App.findAll();
		for await (const app of rxsApps) {
			await this._generateAppRoutes(app);
		}
	}

	/**
	 * @return {object} - express router object
	 */
	_createRouter() {
		const apiRouter = express.Router(); // eslint-disable-line new-cap

		// We used to assign middleware to the router here. When a request comes in
		// each defined router is called to see if it has matching routes, this resulted
		// in the middleware being called mutliple times for each router defined.
		// I've now moved the middleware to be called before each route.
		// See: this._preRouteMiddleware

		return apiRouter;
	}

	/**
	 * Make sure the error handler catch is at the bottom of the stack.
	 */
	_repositionErrorHandler() {
		const logErrors = (err, req, res, next) => this.logErrors(err, req, res, next);

		let stackIndex = this.app._router.stack.findIndex((s) => s.name === 'logErrors');

		// Remove middleware from stack if it's within
		if (stackIndex !== -1 && stackIndex !== this.app._router.stack - 1) {
			this.app._router.stack.splice(stackIndex, 1);
			stackIndex = -1;
		}

		if (stackIndex === -1) {
			Logging.logSilly(`Repositioned error handler on express stack`);
			this.app.use(logErrors);
		}
	}

	/**
	 * Register a router in _routerMap
	 * @param {string} key
	 * @param {object} router - express router object
	 */
	_registerRouter(key, router) {
		if (this._routerMap[key]) {
			Logging.logSilly(`Routes:_registerRouter Reregister ${key}`);
			this._routerMap[key] = router;
			return;
		}

		Logging.logSilly(`Routes:_registerRouter Register ${key}`);
		this._routerMap[key] = router;
		this.app.use('', (...args) => this._getRouter(key)(...args));

		this._repositionErrorHandler();
	}

	/**
	 * Get router with key
	 * @param {string} key
	 * @return {object} - express router object
	 */
	_getRouter(key) {
		return this._routerMap[key];
	}

	/**
	 * Regenerate app routes for given app id
	 * @param {string} appId - Buttress app id
	 * @return {promise}
	 */
	regenerateAppRoutes(appId) {
		Logging.logSilly(`Routes:regenerateAppRoutes regenerating routes for ${appId}`);
		return Model.App.findById(appId)
			.then((app) => this._generateAppRoutes(app));
	}

	/**
	 * Genereate app routes & register for given app
	 * @param {object} app - Buttress app object
	 */
	async _generateAppRoutes(app) {
		if (!app) throw new Error(`Expected app object to be passed through to _generateAppRoutes, got ${app}`);
		if (!app.__schema) return;

		// Get DS agreements
		const appDSAs = await Helpers.streamAll(await Model.AppDataSharing.find({
			'_appId': app.id,
		}));

		const appRouter = this._createRouter();

		Schema.decode(app.__schema)
			.filter((schema) => schema.type.indexOf('collection') === 0)
			.filter((schema) => {
				if (!schema.remotes) return true;
				const remotes = (Array.isArray(schema.remotes)) ? schema.remotes : [schema.remotes];

				const nonActiveDSA = remotes.reduce((arr, remoteRef) => {
					// if the data sharing agreement is not active, we'll make note of the name for debugging.
					if (appDSAs.find((dsa) => dsa.active && dsa.name === remoteRef.name) === undefined) {
						arr.push(remoteRef.name);
					}
					return arr;
				}, []);

				if (nonActiveDSA.length > 0) {
					Logging.logWarn(`Routes:_generateAppRoutes ${app.id} skipping route /${app.apiPath} for ${schema.name}, DSA not active`);
					return false;
				}

				return true;
			})
			.forEach((schema) => {
				Logging.logSilly(`Routes:_generateAppRoutes ${app.id} init routes /${app.apiPath} for ${schema.name}`);
				return this._initSchemaRoutes(appRouter, app, schema);
			});

		this._registerRouter(app.apiPath, appRouter);
	}

	createPluginRoutes(pluginName, routes) {
		if (routes.length === 0) return;

		Logging.logDebug(`Routes:createPluginRoutes ${pluginName} has ${routes.length} routes`);

		const pluginRouter = this._createRouter();

		for (let y = 0; y < routes.length; y++) {
			const route = routes[y];
			this._initRoute(pluginRouter, route, false, pluginName);
		}

		this._registerRouter(`plugin-${pluginName}`, pluginRouter);
	}

	/**
	 * @param {Object} app - express app object
	 * @param {Function} Route - route object
	 * @param {Boolean} core - core
	 * @private
	 */
	_initRoute(app, Route, core, ...additional) {
		const route = (core) ? new Route(this._services) : new Route(null, null, this._services);
		route.paths.forEach((pathSpec) => {
			const routePath = path.join(...[
				Config.app.apiPrefix,
				...additional,
				pathSpec,
			]);
			Logging.logSilly(`_initRoute:register [${route.verb.toUpperCase()}] ${routePath}`);
			app[route.verb](routePath, this._preRouteMiddleware, (req, res, next) => {
				req.pathSpec = pathSpec;
				return route.exec(req, res).catch(next);
			});
		});
	}

	/**
	 * @param  {Object} express - express applcation container
	 * @param  {Object} app - app data object
	 * @param  {Object} schemaData - schema data object
	 */
	_initSchemaRoutes(express, app, schemaData) {
		SchemaRoutes.forEach((Route) => {
			let route = null;

			const appShortId = Helpers.shortId(app.id);

			try {
				route = new Route(schemaData, appShortId, this._services);
			} catch (err) {
				if (err instanceof Helpers.Errors.RouteMissingModel) return Logging.logWarn(`${err.message} for ${app.name}`);

				throw err;
			}

			route.paths.forEach((pathSpec) => {
				let routePath = path.join(...[
					(app.apiPath) ? app.apiPath : appShortId,
					Config.app.apiPrefix,
					pathSpec,
				]);
				if (routePath.indexOf('/') !== 0) routePath = `/${routePath}`;
				Logging.logSilly(`_initSchemaRoutes:register [${route.verb.toUpperCase()}] ${routePath}`);
				express[route.verb](routePath, this._preRouteMiddleware, (req, res, next) => {
					req.pathSpec = pathSpec;
					return route.exec(req, res).catch(next);
				});
			});
		});
	}

	_timeRequest(req, res, next) {
		// Just assign a arbitrary id to the request to help identify it in the logs
		req.id = Datastore.getInstance('core').ID.new();
		res.set('x-bjs-request-id', req.id);

		req.timer = new Helpers.Timer();
		req.timer.start();

		req.timings = {
			authenticateToken: null,
			configCrossDomain: null,
			authenticate: null,
			validate: null,
			exec: null,
			respond: null,
			logActivity: null,
			boardcastData: null,
			close: null,
			stream: [],
		};

		// Define some helper functions which allow us to send request metadata
		// to the realtime process to feedback to subscrtibers.
		req.bjsReqStatus = (data, nrp) => nrp.emit(`sock:worker:request-status`, {id: req.id, ...data});
		req.bjsReqClose = (nrp) => nrp.emit(`sock:worker:request-end`, {id: req.id, status: 'done'});

		const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

		Logging.logDebug(`[${req.method.toUpperCase()}] ${req.path} - ${ip}`, req.id);
		Logging.logTimer(`_timeRequest:start`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);

		// onFinished
		onFinished(res, () => {
			Logging.logInfo(`[${req.method.toUpperCase()}] ${req.path} ${res.statusCode} - ${ip}`, req.id);
			Logging.logTimer(`res finished`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		});

		next();
	}

	/**
	 * @param {Object} req - Request object
	 * @param {Object} res - Response object
	 * @param {Function} next - next handler function
	 * @private
	 */
	async _authenticateToken(req, res, next) {
		req.timings.authenticateToken = req.timer.interval;

		req.isPluginPath = Object.keys(this._routerMap)
			.filter((key) => key.indexOf('plugin-') === 0)
			.map((key) => key.replace('plugin-', ''))
			.some((key) => req.path.indexOf(`${Config.app.apiPrefix}/${key}`) === 0);

		// Admin route call
		const adminRoutecall = await AdminRoutes.checkAdminCall(req);
		if (adminRoutecall.adminToken && adminRoutecall.adminApp) {
			req.token = adminRoutecall.adminToken;
			Logging.logTimer(`_authenticateAdminToken:got-admin-token`,
				req.timer, Logging.Constants.LogLevel.SILLY, req.id);

			Model.authApp = req.authApp = adminRoutecall.adminApp;
			Logging.logTimer(`_authenticateAdminApp:got-admin-app`,
				req.timer, Logging.Constants.LogLevel.SILLY, req.id);

			Logging.logTimer('_authenticateAdminCall:end', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			return next();
		}

		// lambdaAPI call
		const isLambdaAPICall = req.url.includes('/api/v1/lambda/');
		let apiLambda = null;
		let apiLambdaApp = null;
		let apiPath = null;
		if (isLambdaAPICall) {
			[apiPath] = req.url.split('/api/v1/lambda/').join('').split('/');
			apiLambdaApp = await Model.App.findOne({
				apiPath: {
					$eq: apiPath,
				},
			});
		}

		if (apiLambdaApp) {
			const [endpoint] = req.url.split(`/api/v1/lambda/${apiPath}/`).join('').split('?');
			apiLambda = await Model.Lambda.findOne({
				'trigger.apiEndpoint.url': {
					$eq: endpoint,
				},
				'_appId': {
					$eq: apiLambdaApp.id,
				},
			});
		}

		if (apiLambda && apiLambda.type === 'PUBLIC') {
			const token = await Model.Token.findOne({
				_lambdaId: apiLambda.id,
			});
			req.token = token;
			Model.authApp = req.authApp = apiLambdaApp;
			Logging.logTimer(`_authenticateAPILambdaToken:got-app ${req.authApp.id}`,
				req.timer, Logging.Constants.LogLevel.SILLY, req.id);

			req.authLambda = apiLambda;
			Logging.logTimer(`_authenticateAPILambdaToken:got-lambda ${req.authLambda.id}`,
				req.timer, Logging.Constants.LogLevel.SILLY, req.id);

			Logging.logTimer('_authenticateAPILambdaToken:end', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			return next();
		}

		// TODO: Accept the token via the requset header instead of query string

		// Get the bearer token from the Authorization header or query string
		req.token = req.headers['authorization'] || req.query.token;

		if (req.token) req.token = req.token.replace('Bearer ', '');
		req.apiPath = req.query.apiPath;

		Logging.logTimer(`_authenticateToken:start ${req.token}`,
			req.timer, Logging.Constants.LogLevel.SILLY, req.id);

		try {
			if (!req.token) {
				Logging.logTimer(`_authenticateToken:end-missing-token`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
				throw new Helpers.Errors.RequestError(400, 'missing_token');
			}

			const token = await this._getToken(req);
			if (token === null) {
				Logging.logTimer(`_authenticateToken:end-cant-find-token`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
				throw new Helpers.Errors.RequestError(401, 'invalid_token');
			}

			req.token = token;

			Logging.logTimer(`_authenticateToken:got-token ${(req.token) ? req.token.id : token}`,
				req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			Logging.logTimer(`_authenticateToken:got-token type ${(req.token) ? req.token.type : token}`,
				req.timer, Logging.Constants.LogLevel.SILLY, req.id);

			let app = null;
			if (req.apiPath) {
				app = await Model.App.findOne({apiPath: req.apiPath});
			} else if (req.token._appId) {
				app = await Model.App.findById(req.token._appId);
			}

			Model.authApp = req.authApp = app;
			Logging.logTimer(`_authenticateToken:got-app ${(req.authApp) ? req.authApp.id : app}`,
				req.timer, Logging.Constants.LogLevel.SILLY, req.id);

			if (req.authApp) {
				Logging.logTimer(`_authenticateToken:got-app shortId: ${Helpers.shortId(app.id)}`,
					req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			}

			const appDataSharing = (req.token._appDataSharingId) ? await Model.AppDataSharing.findById(req.token._appDataSharingId) : null;
			req.authAppDataSharing = appDataSharing;
			Logging.logTimer(
				`_authenticateToken:got-app-data-sharing-agreement ${(req.authAppDataSharing) ? req.authAppDataSharing.id : appDataSharing}`,
				req.timer, Logging.Constants.LogLevel.SILLY, req.id,
			);

			const lambda = (req.token._lambdaId) ? await Model.Lambda.findById(req.token._lambdaId) : null;
			req.authLambda = lambda;
			Logging.logTimer(`_authenticateToken:got-lambda ${(req.authLambda) ? req.authLambda.id : lambda}`,
				req.timer, Logging.Constants.LogLevel.SILLY, req.id);

			const user = (req.token._userId) ? await Model.User.findById(req.token._userId) : null;
			req.authUser = user;
			Logging.logTimer(`_authenticateToken:got-user ${(req.authUser) ? req.authUser.id : user}`,
				req.timer, Logging.Constants.LogLevel.SILLY, req.id);

			Logging.logTimer('_authenticateToken:end', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			next();
		} catch (err) {
			next(err);
		}
	}

	/**
	 * @param  {String} req - request object
	 * @return {Promise} - resolves with the matching token if any
	 */
	async _getToken(req) {
		Logging.logTimer('_getToken:start', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		let token = null;

		if (this._tokens.length > 0 && !Model.appMetadataChanged) {
			token = this._lookupToken(this._tokens, req.token);
			if (token) {
				Logging.logTimer('_getToken:end-cache', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
				return token;
			}
		}

		// TODO: This needs to be smarter
		await this.loadTokens();

		Model.appMetadataChanged = false;
		token = this._lookupToken(this._tokens, req.token);
		Logging.logTimer('_getToken:end-lookup', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		return token;
	}

	/**
	 * @param {array} tokens - cached tokens
	 * @param {string} value - token string to look for
	 * @return {*} - false if not found, Token (native) if found
	 * @private
	 */
	_lookupToken(tokens, value) {
		const token = tokens.filter((t) => t.value === value);
		return token.length === 0 ? null : token[0];
	}

	/**
	 * @return {Promise} - resolves with tokens
	 * @private
	 */
	async loadTokens() {
		const tokens = [];
		const rxsToken = await Model.Token.findAll();

		for await (const token of rxsToken) {
			tokens.push(token);
		}

		this._tokens = tokens;
	}

	/**
	 *
	 * @param {Object} req - Request object
	 * @param {Object} res - Response object
	 * @param {Function} next - next handler function
	 * @private
	 */
	_configCrossDomain(req, res, next) {
		req.timings.configCrossDomain = req.timer.interval;
		Logging.logTimer('_configCrossDomain:start', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		if (!req.token) {
			res.status(401).json({message: 'Auth token is required'});
			Logging.logTimer('_configCrossDomain:end-no-auth', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			return;
		}
		if (req.token.type !== Model.Token.Constants.Type.USER) {
			res.header('Access-Control-Allow-Origin', '*');
			res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,SEARCH,OPTIONS');
			res.header('Access-Control-Allow-Headers', 'content-type');
			Logging.logTimer('_configCrossDomain:end-app-token', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			next();
			return;
		}

		if (!req.authUser) {
			res.status(401).json({message: 'Auth user is required'});
			Logging.logTimer('_configCrossDomain:end-no-auth-user', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			return;
		}

		const rex = /https?:\/\/(.+)$/;
		let origin = req.header('Origin');

		if (!origin) {
			origin = req.header('Host');
		}

		let matches = rex.exec(origin);
		if (matches) {
			origin = matches[1];
		}

		const domains = req.token.domains.map((d) => {
			matches = rex.exec(d);
			return matches ? matches[1] : d;
		});

		Logging.logSilly(`_configCrossDomain:origin ${origin}`, req.id);
		Logging.logSilly(`_configCrossDomain:domains ${domains}`, req.id);

		const domainIdx = domains.indexOf(origin);
		if (domainIdx === -1) {
			Logging.logError(new Error(`Invalid Domain: ${origin}`));
			res.sendStatus(403);
			Logging.logTimer('_configCrossDomain:end-invalid-domain', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			return;
		}

		res.header('Access-Control-Allow-Origin', req.header('Origin'));
		res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,SEARCH,OPTIONS');
		res.header('Access-Control-Allow-Headers', 'content-type');

		if (req.method === 'OPTIONS') {
			res.sendStatus(200);
			Logging.logTimer('_configCrossDomain:end-options-req', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			return;
		}

		Logging.logTimer('_configCrossDomain:end', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		next();
	}

	logErrors(err, req, res, next) {
		Logging.logSilly(`logErrors ${err}`);
		if (err instanceof Helpers.Errors.RequestError) {
			res.status(err.code).json({statusMessage: err.message, message: err.message});
		} else {
			if (err) {
				Logging.logError(err, req.id);
			}
			res.status(500);
		}

		res.end();
		next(err);
	}

	/**
	 * @return {Array} - returns an array of Route handlers
	 * @private
	 */
	_getCoreRoutes() {
		const filenames = fs.readdirSync(`${__dirname}/api`);

		const files = [];
		for (let x = 0; x < filenames.length; x++) {
			const file = filenames[x];
			if (path.extname(file) === '.js') {
				files.push(require(`./api/${path.basename(file, '.js')}`));
			}
		}
		return files;
	}

	async _setupLambdaEndpoints() {
		const appsToken = await Helpers.streamAll(await Model.Token.find({
			$or: [{
				type: Model.Token.Constants.Type.APP,
			}, {
				type: Model.Token.Constants.Type.SYSTEM,
			}],
		}));
		const tokenIds = appsToken.map((t) => t.id);
		const apps = await Helpers.streamAll(await Model.App.find({
			_tokenId: {
				$in: tokenIds,
			},
		}));
		const appApiPaths = apps.map((app) => app.apiPath);

		appApiPaths.forEach((apiPath) => {
			this.__configureAppLambdaEndpoints(apiPath);
		});

		this._nrp.on('app:configure-lambda-endpoints', (apiPath) => {
			this.__configureAppLambdaEndpoints(apiPath);
		});
	}

	async __configureAppLambdaEndpoints(apiPath) {
		this.app.get(`/api/v1/lambda/${apiPath}/*`, async (req, res) => {
			const [endpoint] = Object.values(req.params);
			const result = await this._validateLambdaAPIExecution(endpoint, 'GET', req.headers, req.query);
			if (result.errCode && result.errMessage) {
				res.status(result.errCode).send({message: result.errMessage});
				return;
			}

			// Disable cache for all lambda endpoints
			res.set('Cache-Control', 'no-store');

			if (result.triggerAPIType === 'SYNC') {
				result.lambdaOutput = await new Promise((resolve) => {
					this._nrp.on('lambda-execution-finish', (exec) => {
						if (exec.restWorkerId === this.id) {
							resolve(exec);
						}
					});
				});
			}

			if (result.lambdaOutput && result.lambdaOutput.res && result.lambdaOutput.res.redirect) {
				const url = result.lambdaOutput.res.url;
				const queryObj = result.lambdaOutput.res.query;
				let query = '';
				if (queryObj) {
					query = Object.keys(queryObj).reduce((output, key) => {
						if (!output) {
							output = `${key}=${queryObj[key]}`;
						} else {
							output = `${output}&${key}=${queryObj[key]}`;
						}
						return output;
					}, null);
				}
				const redirectURL = (query) ? `${url}?${query}` : url;
				res.redirect(redirectURL);
			} else if (result.lambdaOutput) {
				res.status(result.lambdaOutput.code).send({
					res: result.lambdaOutput.res,
					err: result.lambdaOutput.err,
					executionId: result.lambdaExecution.id,
				});
			} else {
				res.status(200).send({
					executionId: result.lambdaExecution.id,
				});
			}
		});

		this.app.post(`/api/v1/lambda/${apiPath}/*`, async (req, res) => {
			const [endpoint] = Object.values(req.params);
			if (!req.body || Object.values(req.body).length < 1) {
				res.status(400).send({message: 'missing_request_body'});
				return;
			}

			const result = await this._validateLambdaAPIExecution(endpoint, 'POST', req.headers, null, req.body);
			if (result.errCode && result.errMessage) {
				res.status(result.errCode).send({message: result.errMessage});
				return;
			}

			if (result.triggerAPIType === 'SYNC') {
				result.lambdaOutput = await new Promise((resolve) => {
					this._nrp.on('lambda-execution-finish', (exec) => {
						if (exec.restWorkerId === this.id) {
							resolve(exec);
						}
					});
				});
			}

			if (result.lambdaOutput && result.lambdaOutput.res && result.lambdaOutput.res.redirect) {
				const url = result.lambdaOutput.res.url;
				const queryObj = result.lambdaOutput.res.query;
				let query = '';
				if (queryObj) {
					query = Object.keys(queryObj).reduce((output, key) => {
						if (!output) {
							output = `${key}=${queryObj[key]}`;
						} else {
							output = `${output}&${key}=${queryObj[key]}`;
						}
						return output;
					}, null);
				}
				const redirectURL = (query) ? `${url}?${query}` : url;
				res.redirect(redirectURL);
			} else if (result.lambdaOutput) {
				res.status(result.lambdaOutput.code).send({
					res: result.lambdaOutput.res,
					err: result.lambdaOutput.err,
					executionId: result.lambdaExecution.id,
				});
			} else {
				res.status(200).send({
					executionId: result.lambdaExecution.id,
				});
			}
		});

		// retrieve the status of a lambda execution
		this.app.get(`/api/v1/lambda/status/${apiPath}/:executionId`, async (req, res) => {
			const executionId = req.params.executionId;
			const isValidId = ObjectId.isValid(executionId);
			if (!isValidId) {
				res.status(400).send({message: 'invalid_input'});
				return;
			}

			const lambdaExecution = await Model.LambdaExecution.findById(executionId);
			if (!lambdaExecution) {
				res.status(404).send({message: 'not_found'});
				return;
			}

			res.status(200).send({status: lambdaExecution.status});
		});
	}

	async _validateLambdaAPIExecution(endpoint, method, headers, query = null, body = null) {
		const res = {};
		let lambda = null;

		const isEndPointId = ObjectId.isValid(endpoint);
		if (isEndPointId) {
			lambda = await Model.Lambda.findById(endpoint);
		} else {
			lambda = await Model.Lambda.findOne({
				'trigger.apiEndpoint.url': {
					$eq: endpoint,
				},
			});
		}

		if (!lambda) {
			res.errCode = 404;
			res.errMessage = 'lambda_not_found';
			return res;
		}

		if (!lambda.executable) {
			res.errCode = 400;
			res.errMessage = 'lambda_is_not_executable';
			return res;
		}

		const triggerAPI = lambda.trigger.find((t) => t.type === 'API_ENDPOINT');
		if (!triggerAPI || triggerAPI.apiEndpoint.method !== method) {
			res.errCode = 404;
			res.errMessage = 'api_method_not_found';
			return res;
		}

		const deployment = await Model.Deployment.findOne({
			lambdaId: Model.Lambda.createId(lambda.id),
			hash: lambda.git.hash,
		});
		if (!deployment) {
			res.errCode = 404;
			res.errMessage = 'deployment_not_found';
			return res;
		}

		const lambdaExecution = await Model.LambdaExecution.add({
			triggerType: 'API_ENDPOINT',
			lambdaId: Model.Lambda.createId(lambda.id),
			deploymentId: Model.Deployment.createId(deployment.id),
		}, lambda._appId);

		res.lambdaExecution = lambdaExecution;
		res.triggerAPIType = triggerAPI.apiEndpoint.type;

		const data = {
			id: lambdaExecution.id,
			restWorkerId: this.id,
			lambdaId: lambda.id,
			triggerType: triggerAPI.type,
			lambdaExecBehavior: triggerAPI.apiEndpoint.type,
			headers,
		};
		if (body) {
			data.body = body;
		}
		if (query) {
			data.query = query;
		}

		if (!res.errCode && !res.errMessage) {
			this._nrp.emit('rest:worker:exec-lambda-api', data);
		}

		return res;
	}
}

module.exports = Routes;
