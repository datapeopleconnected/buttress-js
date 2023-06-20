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

const {describe, it} = require('mocha');
const assert = require('assert');

const Helpers = require('../../../../dist/helpers');

describe('helpers.compareByProps', () => {
	it('should handle one of the values being undefined', () => {
		const a = {name: 'Alex', age: 10};
		const b = {name: 'Jordan', age: undefined};
		assert.strictEqual(Helpers.compareByProps(new Map([['age', 1]]), a, b), 1);
	});

	it('should return 1 if a is greater than be when sorting by age', () => {
		const a = {name: 'Alex', age: 10};
		const b = {name: 'Jordan', age: 5};
		assert.strictEqual(Helpers.compareByProps(new Map([['age', 1]]), a, b), 1);
	});

	it('should return 0 if a is equal to be when sorting by age', () => {
		const a = {name: 'Alex', age: 10};
		const b = {name: 'Jordan', age: 10};
		assert.strictEqual(Helpers.compareByProps(new Map([['age', 1]]), a, b), 0);
	});

	it('should return 1 if a is greater than be when sorting by age desc', () => {
		const a = {name: 'Alex', age: 10};
		const b = {name: 'Jordan', age: 5};
		assert.strictEqual(Helpers.compareByProps(new Map([['age', -1]]), a, b), -1);
	});
});
