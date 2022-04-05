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

const crypto = require('crypto');

/**
 *
 * @type {{Mode: {NUMERIC: string, ALPHANUMERIC: string, ALPHA: string}}}
 */
const Constants = module.exports.Constants = {
	Mode: {
		NUMERIC: 'numeric',
		ALPHANUMERIC: 'alphanumeric',
		ALPHA: 'alpha',
	},
};

/**
 * @type {{MODE: string, EPOCH: number, WINDOW_SIZE: number, LENGTH: number, SALT: string, TOLERANCE: number}}
 */
const Defaults = {
	MODE: Constants.Mode.NUMERIC,
	EPOCH: 1.418221717366e12,
	WINDOW_SIZE: 30,
	LENGTH: 6,
	SALT: '',
	TOLERANCE: 6,
};

/**
 *
 */
class Helpers {
	static getRandomString(salt, length, numeric) {
		salt = salt || Date.now();
		length = length || Defaults.LENGTH;

		const hash = crypto.createHash('sha512');
		hash.update(`${salt}`);
		const bytes = hash.digest();

		const chars = numeric === false ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' : '0123456789012345';
		const mask = numeric === false ? 0x3d : 0x0f;
		let string = '';

		for (let byte = 0; byte < length; byte++) {
			string += chars[bytes[byte] & mask];
		}

		return string;
	}
}

/**
 * @class STOTP
 * @description Simple Time-based One Time Password
 */
class STOTP {
	constructor(options) {
		options = options || {};
		this.mode = options.mode ? options.mode : Defaults.MODE;
		this.epoch = options.epoch ? options.epoch : Defaults.EPOCH;
		this.windowSize = options.windowSize ? options.windowSize : Defaults.WINDOW_SIZE;
		this.length = options.length ? options.length : Defaults.LENGTH;
		this.salt = options.salt ? options.salt : Defaults.SALT;
		this.tolerance = options.tolerance ? options.tolerance : Defaults.TOLERANCE;
	}

	/**
	 * @param {string} salt - randomised salt
	 * @return {string} - return code
	 */
	getCode(salt) {
		salt = salt || this.salt;
		return Helpers.getRandomString(`${salt}${this._getWindow()}`,
			this.length,
			this.mode === Constants.Mode.NUMERIC);
	}

	/**
	 * @param {string} code - code to test against
	 * @param {string} salt - randomised salt if you want to override the value passed in when creating the object
	 * @param {numeric} tolerance - test the window +- this tolerance
	 * @return {boolean} - returns true if the code matches
	 */
	test(code, salt, tolerance) {
		salt = salt || this.salt;
		tolerance = tolerance || this.tolerance;
		let matches = false;
		if (!code) {
			return matches;
		}
		let window = this._getWindow() + tolerance;
		for (let x = tolerance * 2; x >= 0; x--) {
			if (Helpers.getRandomString(`${salt}${window}`,
				this.length,
				this.mode === Constants.Mode.NUMERIC) === code) {
				matches = true;
				break;
			}
			window--;
		}
		return matches;
	}

	_getWindow() {
		const interval = (Date.now() - this.epoch) / 1000;
		return Math.floor(interval / this.windowSize, 0);
	}
}

module.exports.create = (options) => {
	return new STOTP(options);
};
