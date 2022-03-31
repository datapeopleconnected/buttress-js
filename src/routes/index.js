'use strict';

/**
 * ButtressJS - Realtime datastore for software
 *
 * @file index.js
 * @description Model management
 * @module Routes
 * @author Chris Bates-Keegan
 *
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
// const Route = require('./route');
const Logging = require('../logging');
const Schema = require('../schema');
const Helpers = require('../helpers');
const AccessControl = require('../access-control');
const Model = require('../model');
const Config = require('node-env-obj')();

const SchemaRoutes = require('./schema-routes');

const Datastore = require('../datastore');

class Routes {
	/**
	 * @param {Object} app - express app object
	 */
	constructor(app) {
		this.app = app;

		this._tokens = [];
		this._attributes = [];
		this._routerMap = {};
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
				Logging.logDebug(`close`, req.id);
			});
			req.on('end', function() {
				Logging.logDebug(`end`, req.id);
			});
			req.on('error', function(err) {
				Logging.logError(`req onError`, req.id);
				Logging.logError(err, req.id);
			});
			req.on('pause', function() {
				Logging.logDebug(`pause`, req.id);
			});
			req.on('resume', function() {
				Logging.logDebug(`resume`, req.id);
			});

			req.on('timeout', function() {
				Logging.logError(`timeout`, req.id);
			});

			if (req.socket) {
				req.socket.on('close', (hadError) => {
					Logging.logDebug(`socket onClose had_error:${hadError}`, req.id);
				});
				req.socket.on('connect', () => {
					Logging.logDebug(`socket onConnect`, req.id);
				});
				req.socket.on('end', () => {
					Logging.logDebug(`socket onEnd`, req.id);
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
					Logging.logDebug(`socket onTimeout`, req.id);
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
				this._initRoute(coreRouter, route);
			}
		}

		this._registerRouter('core', coreRouter);

		await this.loadTokens();
		await this.loadAttributes();

		Logging.logSilly(`init:registered-routes`);
	}

	async initAppRoutes() {
		const rxsApps = Model.App.findAll();
		for await (const app of rxsApps) {
			this._generateAppRoutes(app);
		}
	}

	/**
	 * @return {object} - express router object
	 */
	_createRouter() {
		const apiRouter = express.Router(); // eslint-disable-line new-cap

		apiRouter.use((...args) => this._timeRequest(...args));
		apiRouter.use((...args) => this._authenticateToken(...args));
		apiRouter.use((...args) => this._accessControlPolicy(...args));
		apiRouter.use((...args) => this._configCrossDomain(...args));

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
	_generateAppRoutes(app) {
		if (!app) throw new Error(`Expected app object to be passed through to _generateAppRoutes, got ${app}`);
		if (!app.__schema) return;

		const appRouter = this._createRouter();

		Schema.decode(app.__schema)
			.filter((s) => s.type === 'collection')
			.forEach((schema) => {
				Logging.logSilly(`Routes:_generateAppRoutes ${app._id} init routes /${app.apiPath} for ${schema.collection}`);
				return this._initSchemaRoutes(appRouter, app, schema);
			});

		this._registerRouter(app.apiPath, appRouter);
	}

	/**
	 * @param {Object} app - express app object
	 * @param {Function} Route - route object
	 * @private
	 */
	_initRoute(app, Route) {
		const route = new Route();
		const routePath = path.join(...[
			Config.app.apiPrefix,
			route.path,
		]);
		Logging.logSilly(`_initRoute:register [${route.verb.toUpperCase()}] ${routePath}`);
		app[route.verb](routePath, (req, res, next) => route.exec(req, res).catch(next));
	}

	/**
	 * @param  {Object} express - express applcation container
	 * @param  {Object} app - app data object
	 * @param  {Object} schemaData - schema data object
	 */
	_initSchemaRoutes(express, app, schemaData) {
		SchemaRoutes.forEach((Route) => {
			let route = null;

			const appShortId = Helpers.shortId(app._id);

			try {
				route = new Route(schemaData, appShortId);
			} catch (err) {
				if (err instanceof Helpers.Errors.RouteMissingModel) return Logging.logWarn(`${err.message} for ${app.name}`);

				throw err;
			}

			let routePath = path.join(...[
				(app.apiPath) ? app.apiPath : appShortId,
				Config.app.apiPrefix,
				route.path,
			]);
			if (routePath.indexOf('/') !== 0) routePath = `/${routePath}`;
			Logging.logSilly(`_initSchemaRoutes:register [${route.verb.toUpperCase()}] ${routePath}`);
			express[route.verb](routePath, (req, res, next) => route.exec(req, res).catch(next));
		});
	}

	_timeRequest(req, res, next) {
		// Just assign a arbitrary id to the request to help identify it in the logs
		req.id = Datastore.getInstance().ID.new();
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
			boardcastByAppRole: null,
			close: null,
			stream: [],
		};

		Logging.logTimer(`[${req.method.toUpperCase()}] ${req.path}`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		next();
	}

	/**
	 * @param {Object} req - Request object
	 * @param {Object} res - Response object
	 * @param {Function} next - next handler function
	 * @private
	 */
	_authenticateToken(req, res, next) {
		req.timings.authenticateToken = req.timer.interval;
		Logging.logTimer(`_authenticateToken:start ${req.query.token}`,
			req.timer, Logging.Constants.LogLevel.SILLY, req.id);

		if (!req.query.token) {
			Logging.logTimer(`_authenticateToken:end-missing-token`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(400).json({message: 'missing_token'});
			return;
		}

		this._getToken(req)
			.then((token) => {
				return new Promise((resolve, reject) => {
					if (token === null) {
						Logging.logTimer(`_authenticateToken:end-cant-find-token`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
						reject(new Helpers.Errors.RequestError(401, 'invalid_token'));
						return;
					}

					req.token = token;

					Logging.logTimer(`_authenticateToken:got-token ${(req.token) ? req.token._id : token}`,
						req.timer, Logging.Constants.LogLevel.SILLY, req.id);
					Logging.logTimer(`_authenticateToken:got-token type ${(req.token) ? req.token.type : token}`,
						req.timer, Logging.Constants.LogLevel.SILLY, req.id);

					resolve(token);
				});
			})
			.then(() => (req.token._app) ? Model.App.findById(req.token._app) : null)
			.then((app) => {
				Model.authApp = req.authApp = app;

				Logging.logTimer(`_authenticateToken:got-app ${(req.authApp) ? req.authApp._id : app}`,
					req.timer, Logging.Constants.LogLevel.SILLY, req.id);

				if (req.authApp) {
					Logging.logTimer(`_authenticateToken:got-app shortId: ${Helpers.shortId(app._id)}`,
						req.timer, Logging.Constants.LogLevel.SILLY, req.id);
				}
			})
			.then(() => (req.token._user) ? Model.User.findById(req.token._user) : null)
			.then((user) => {
				req.authUser = user;

				Logging.logTimer(`_authenticateToken:got-user ${(req.authUser) ? req.authUser._id : user}`,
					req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			})
			.then(Logging.Promise.logTimer('_authenticateToken:end', req.timer, Logging.Constants.LogLevel.SILLY, req.id))
			.then(next)
			.catch(next);
	}

	/**
	 * @param  {String} req - request object
	 * @return {Promise} - resolves with the matching token if any
	 */
	async _getToken(req) {
		Logging.logTimer('_getToken:start', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
		let token = null;

		if (this._tokens.length > 0 && !Model.appMetadataChanged) {
			token = this._lookupToken(this._tokens, req.query.token);
			if (token) {
				Logging.logTimer('_getToken:end-cache', req.timer, Logging.Constants.LogLevel.SILLY, req.id);
				return token;
			}
		}

		await this.loadTokens();

		Model.appMetadataChanged = false;
		token = this._lookupToken(this._tokens, req.query.token);
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
		const rxsToken = Model.Token.findAll();

		for await (const token of rxsToken) {

			console.log(token);

			tokens.push(token);
		}

		this._tokens = tokens;
	}

	/**
	 * @return {Promise} - resolves with attributes
	 * @private
	 */
	async loadAttributes() {
		const attributes = [];
		const rxsAttributes = Model.Attributes.findAll();

		for await (const token of rxsAttributes) {
			attributes.push(token);
		}

		this._attributes = attributes;
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
	 * Check access control policy before granting access to the data
	 * @param {Object} req - Request object
	 * @param {Object} res - Response object
	 * @param {Function} next - next handler function
	 * @return {Void}
	 * @private
	 */
	async _accessControlPolicy(req, res, next) {
		// access control policy
		const authUser = req.authUser;

		// TODO: better way to figure out the requested schema
		let requestedURL = req.originalUrl || req.url;
		requestedURL = requestedURL.split('?').shift();
		const schemaName = requestedURL.split('v1/').pop().split('/').shift();

		let userAttributes = null;

		if (authUser) {
			userAttributes = authUser._attribute;
		}

		if (!userAttributes) return next();

		userAttributes = this._getAttributesChain(userAttributes);

		const schemaBaseAttribute = userAttributes.filter((attr) => attr.targettedSchema.includes(schemaName) || attr.targettedSchema.length < 1);
		if (schemaBaseAttribute.length < 1) return next();
		const schemaAttributes = this._getSchemaRelatedAttributes(schemaBaseAttribute, userAttributes);

		const passedDisposition = await AccessControl.accessControlDisposition(req, schemaAttributes);

		if (!passedDisposition) {
			Logging.logTimer(`_accessControlPolicy:disposition-not-allowed`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).json({message: 'Access control policy disposition not allowed'});
			return;
		}

		const accessControlAuthorisation = await AccessControl.applyAccessControlPolicyConditions(req, schemaAttributes);
		if (!accessControlAuthorisation) {
			Logging.logTimer(`_accessControlPolicy:conditions-not-fulfilled`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).json({message: 'Access control policy conditions are not fulfilled'});
			return;
		}

		const schema = Schema.decode(req.authApp.__schema).filter((s) => s.type === 'collection').find((s) => s.name === schemaName);
		if (!schema) return next();

		const passedAccessControlPolicy = await AccessControl.addAccessControlPolicyQuery(req, schemaAttributes, schema);
		if (!passedAccessControlPolicy) {
			Logging.logTimer(`_accessControlPolicy:access-control-properties-permission-error`, req.timer, Logging.Constants.LogLevel.SILLY, req.id);
			res.status(401).json({message: 'Can not edit properties without privileged access'});
			return;
		}
		await AccessControl.applyAccessControlPolicyQuery(req);

		next();
	}

	/**
	 * lookup attributes and fetch user attributes chain
	 * @param {Array} attributeNames
	 * @param {Array} attributes
	 * @return {Array} attributes
	 */
	_getAttributesChain(attributeNames, attributes = []) {
		const attrs = this._attributes.filter((attr) => attributeNames.includes(attr.name));
		attributes = attributes.concat(attrs);

		const extendedAttributes = attrs.reduce((arr, attr) => {
			attr.extends.forEach((a) => {
				if (arr.includes(a)) return;

				arr.push(a);
			});

			return arr;
		}, []);

		if (extendedAttributes.length > 0) {
			return this._getAttributesChain(extendedAttributes, attributes);
		}

		return attributes;
	}

	/**
	 * Fetch schema related attributes from the user attributes
	 * @param {Array} attributes
	 * @param {Array} userAttributes
	 * @param {Array} attrs
	 * @return {Array}
	 */
	_getSchemaRelatedAttributes(attributes, userAttributes, attrs = []) {
		const attributeIds = attributes.map((attr) => attr._id);

		attributes.forEach((attr) => {
			if (attr.extends.length > 1) {
				attr.extends.forEach((extendedAttr) => {
					const extendedAttribute = userAttributes.find((attr) => attr.name === extendedAttr && !attributeIds.includes(attr._id));

					if (!extendedAttribute) return;

					attrs.push(extendedAttribute);
				});
			}

			attrs.push(attr);
		});

		return attrs;
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
}

module.exports = Routes;
