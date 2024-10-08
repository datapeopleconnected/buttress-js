'use strict';

/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2024 Data People Connected LTD.
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
import createConfig from 'node-env-obj';
const Config = createConfig() as unknown as Config;

import Model from '../model';
import Logging from '../helpers/logging';
import * as Helpers from '../helpers';

import adminPolicy from '../admin-policy.json';
import adminLambda from '../admin-lambda.json';

// TODO: This file might be able to be rolled into routes.

class AdminRoutes {
	_routes: string[];

	constructor() {
		this._routes = [
			'/api/v1/check/admin',
			'/api/v1/admin/activate/:superToken',
			'/api/v1/admin/install-lambda',
		];
	}

	/**
	 * Init admin routes
	 * @param {object} app
	 * @return {promise}
	 */
	async initAdminRoutes(app) {
		app.get('/api/v1/check/admin', async (req, res) => {
			const superToken = await Model.getModel('Token').findOne({
				type: Model.getModel('Token').Constants.Type.SYSTEM,
			});
			if (!superToken) {
				Logging.logError('Buttress admin check can not find super token');
				return res.status(404).send({message: 'admin_app_not_found'});
			}

			const superApp = await Model.getModel('App').findOne({
				_tokenId: Model.getModel('Token').createId(superToken.id),
			});

			if (!superApp) {
				Logging.logError('Buttress admin check can not find super app');
				return res.status(404).send({message: 'admin_app_not_found'});
			}

			res.status(200).send({
				active: superApp?.adminActive,
				apiPath: superApp?.apiPath,
				oAuthOptions: superApp?.oAuth,
			});
		});

		app.get('/api/v1/admin/activate/:superToken', async (req, res) => {
			const tokenValue = req.params.superToken;
			const superToken = await Model.getModel('Token').findOne({
				value: tokenValue,
				type: 'system',
			});

			if (!superToken) {
				Logging.logError('The used token does not exist');
				return res.status(404).send({message: 'Please enter a valid admin token to activate your admin app'});
			}

			const superApp = await Model.getModel('App').findOne({
				_tokenId: Model.getModel('Token').createId(superToken.id),
			});

			await this._updateAppPolicySelectorList(superApp);

			res.status(200).send({appId: superApp.id});
		});

		app.post('/api/v1/admin/install-lambda', async (req, res) => {
			const tokenValue = req.query.token;
			const lambdaToInstall = req.body.installLambda;
			const refreshAdminToken = req.body.refreshAdminToken;
			const adminToken = await Model.getModel('Token').findOne({
				value: tokenValue,
			});
			if (!adminToken) {
				return res.status(401).send({message: 'invalid_token'});
			}
			if (adminToken.type !== Model.getModel('Token').Constants.Type.SYSTEM) {
				return res.status(401).send({message: 'unauthorised_token'});
			}
			if (!lambdaToInstall || !Array.isArray(lambdaToInstall)) {
				return res.status(400).send({message: 'invalid_body'});
			}

			const adminLambdaKeys = Object.keys(adminLambda);
			if (!lambdaToInstall.every((key) => adminLambdaKeys.includes(key))) {
				return res.status(404).send({message: 'lambda_not_found'});
			}

			try {
				const adminApp = await Model.getModel('App').findOne({
					_tokenId: Model.getModel('Token').createId(adminToken.id),
				});

				await this._createAdminPolicy(adminApp.id);
				for await (const lambdaKey of lambdaToInstall) {
					await this._createAdminLambda(adminLambda[lambdaKey]);
				}

				if (refreshAdminToken) {
					await this._refreshAdminAppToken(adminToken, adminApp);

					await Model.getModel('App').updateById(Model.getModel('App').createId(adminApp.id), {
						$set: {
							adminActive: true,
						},
					});
				}

				res.status(200).send({message: 'done'});
			} catch (err) {
				if (err instanceof Error){
					res.status(404).send({message: err.message});
				}

				throw err;
			}
		});
	}

	async checkAdminCall(req) {
		let adminToken: any = null;
		let adminApp = null;
		const isAdminRouteCall = this._routes.some((r) => {
			let reqURL = req.url;
			if (r.includes(':')) {
				const bareAdminRoute = r.split('/:');
				const bareCalledRoute = reqURL.split('/');
				r = bareAdminRoute?.slice(0, bareAdminRoute.length - 1).join();
				reqURL = bareCalledRoute?.slice(0, bareCalledRoute.length - 1).join('/');
			}

			return r === reqURL;
		});

		if (isAdminRouteCall) {
			adminToken = await Model.getModel('Token').findOne({
				type: Model.getModel('Token').Constants.Type.SYSTEM,
			});
		}
		if (adminToken) {
			adminApp = await Model.getModel('App').findOne({
				_tokenId: Model.getModel('Token').createId(adminToken.id),
			});
		}

		return {
			adminToken,
			adminApp,
		};
	}

	/**
	 * Update admin app policy selectors list
	 * @param {Object} app
	 */
	async _updateAppPolicySelectorList(app) {
		let adminPolicyPropsList = {
			role: [
				'ADMIN',
				'ADMIN_LAMBDA',
			],
		};
		const policyPropsList = app.policyPropertiesList;
		if (policyPropsList) {
			const currentAppListKeys = Object.keys(policyPropsList);
			Object.keys(adminPolicyPropsList).forEach((key) => {
				if (currentAppListKeys.includes(key)) {
					adminPolicyPropsList[key] = adminPolicyPropsList[key].concat(policyPropsList[key])
						.filter((v, idx, arr) => arr.indexOf(v) === idx);
				}
			});
			adminPolicyPropsList = {...policyPropsList, ...adminPolicyPropsList};
		}

		const query = {
			id: {
				$eq: app.id,
			},
		};
		await Model.getModel('App').setPolicyPropertiesList(query, adminPolicyPropsList);
	}

	/**
	 * Create Buttress pre-defined policy
	 * @param {String} appId
	 */
	async _createAdminPolicy(appId) {
		for await (const policy of (adminPolicy as any)) {
			const policyDB = await Model.getModel('Policy').findOne({
				name: {
					$eq: policy.name,
				},
			});
			if (policyDB) continue;

			const name = policy.name.replace(/[\s-]+/g, '_').toUpperCase();
			if (name.toUpperCase() === 'ADMIN_LAMBDA_ACCESS') {
				policy.config.forEach((conf, idx) => {
					const appQueryIdx = policy.config[idx].query.findIndex((q) => q.schema.includes('app'));
					const userQueryIdx = policy.config[idx].query.findIndex((q) => q.schema.includes('user'));
					if (appQueryIdx !== -1 && policy.config[idx].query[appQueryIdx].id) {
						policy.config[idx].query[appQueryIdx].id = {
							'@eq': appId,
						};
					}
					if (userQueryIdx !== -1) {
						policy.config[idx].query[userQueryIdx]._appId = {
							'@eq': appId,
						};
					}
				});
			}

			await Model.getModel('Policy').add(policy, appId);
		}
	}

	/**
	 * Create Buttress pre-defined lambda
	 * @param {Array} lambdas
	 */
	async _createAdminLambda(lambdas) {
		try {
			const adminToken = await Model.getModel('Token').findOne({
				type: Model.getModel('Token').Constants.Type.SYSTEM,
			});
			if (!adminToken) {
				throw new Error('Cannot find an admin app token');
			}

			const adminApp = await Model.getModel('App').findOne({_tokenId: Model.getModel('Token').createId(adminToken.id)});
			if (!adminApp) {
				throw new Error('Cannot find an admin app');
			}

			for await (const lambda of lambdas) {
				const lambdaDB = await Model.getModel('Lambda').findOne({
					name: lambda.name,
					_appId: Model.getModel('App').createId(adminApp.id),
				});
				if (lambdaDB) continue;

				const adminLambdaAuth = {
					type: 'lambda',
					domains: [Config.app.host],
					permissions: [
						{route: '*', permission: '*'},
					],
					policyProperties: lambda.policyProperties,
				};

				await Model.getModel('Lambda').add(lambda, adminLambdaAuth, adminApp);
			}

			// ? This normally get's attached the request and not the model manager
			// delete Model.authApp;
		} catch (err) {
			if (err instanceof Error) {
				Logging.logError(`Lambda Manager failed to clone required lambdas for installation due to ${err.message}`);
				throw err;
			} else {
				throw new Error(`Uncaught error in Lambda Manager: ${err}`);
			}
		}
	}

	/**
	 * Refresh Buttress admin app token
	 * @param {Object} token
	 * @param {Object} app
	 */
	async _refreshAdminAppToken(token, app) {
		const rxsNewToken = await Model.getModel('Token').add({
			type: Model.getModel('Token').Constants.Type.SYSTEM,
			permissions: token.permissions,
		}, {
			_appId: app.id,
		});
		const newToken: any = await Helpers.streamFirst(rxsNewToken);
		await Model.getModel('App').updateById(Model.getModel('App').createId(app.id), {
			$set: {
				_tokenId: Model.getModel('Token').createId(newToken.id),
			},
		});

		await Model.getModel('Token').rm(token.id);
	}
}

export default new AdminRoutes();
