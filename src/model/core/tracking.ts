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

import StandardModel from '../type/standard';

/**
 * Constants
 */
const type = ['interaction', 'error', 'logging'];
const Type = {
	INTERACTION: type[0],
	ERROR: type[1],
	LOGGING: type[2],
};

class TrackingSchemaModel extends StandardModel {
	constructor(services) {
		const schema = TrackingSchemaModel.Schema;
		super(schema, null, services);
	}

	static get Constants() {
		return {
			Type: Type,
		};
	}
	get Constants() {
		return TrackingSchemaModel.Constants;
	}

	static get Schema() {
		return {
			name: 'trackings',
			type: 'collection',
			extends: [],
			core: true,
			properties: {
				timestamp: {
					__type: 'date',
					__default: 'now',
					__allowUpdate: false,
				},
				userId: {
					__type: 'id',
					__required: true,
					__allowUpdate: false,
				},
				name: {
					__type: 'string',
					__default: '',
					__allowUpdate: true,
				},
				type: {
					__type: 'string',
					__default: 'logging',
					__enum: type,
					__allowUpdate: true,
				},
				interaction: {
					type: {
						__type: 'string',
						__default: '',
						__allowUpdate: true,
					},
					location: {
						__type: 'string',
						__default: '',
						__allowUpdate: true,
					},
					context: {
						__type: 'string',
						__default: '',
						__allowUpdate: true,
					},
				},
				error: {
					message: {
						__type: 'string',
						__default: '',
						__allowUpdate: true,
					},
					url: {
						__type: 'string',
						__default: '',
						__allowUpdate: true,
					},
					line: {
						__type: 'string',
						__default: '',
						__allowUpdate: true,
					},
					col: {
						__type: 'string',
						__default: '',
						__allowUpdate: true,
					},
				},
				logging: {
					level: {
						__type: 'string',
						__default: '',
						__allowUpdate: true,
					},
				},
				environment: {
					browser: {
						__type: 'string',
						__default: '',
						__allowUpdate: true,
					},
					os: {
						__type: 'string',
						__default: '',
						__allowUpdate: true,
					},
					resolution: {
						__type: 'string',
						__default: '',
						__allowUpdate: true,
					},
					dpi: {
						__type: 'string',
						__default: '',
						__allowUpdate: true,
					},
					ram: {
						__type: 'string',
						__default: '',
						__allowUpdate: true,
					},
				},
				_appId: {
					__type: 'id',
					__required: true,
					__allowUpdate: false,
				},
			},
		};
	}

	/**
	 * @param {Object} body - body passed through from a POST request to be validated
	 * @return {Object} - returns an object with validation context
	 */
	__doValidation(body) {
		const res: {
			isValid: boolean,
			missing: string[],
			invalid: string[],
		} = {
			isValid: true,
			missing: [],
			invalid: [],
		};

		if (!body.name) {
			res.isValid = false;
			res.missing.push('name');
		}
		if (!body.type) {
			res.isValid = false;
			res.missing.push('type');
		}

		return res;
	}

	validate(body) {
		if (body instanceof Array === false) {
			body = [body];
		}
		const validation = body.map(this.__doValidation).filter((v) => v.isValid === false);

		return validation.length >= 1 ? validation[0] : {isValid: true};
	}
}

/* ********************************************************************************
*
* EXPORTS
*
**********************************************************************************/
export default TrackingSchemaModel;
