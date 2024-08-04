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

import addMany from './add-many';
import addOne from './add-one';
import deleteAll from './delete-all';
import deleteMany from './delete-many';
import deleteOne from './delete-one';
import getList from './get-list';
import getMany from './get-many';
import getOne from './get-one';
import searchCount from './search-count';
import searchList from './search-list';
import updateMany from './update-many';
import updateOne from './update-one';

export default [
	addMany,
	addOne,
	deleteAll,
	deleteMany,
	deleteOne,
	getList,
	getMany,
	getOne,
	searchCount,
	searchList,
	updateMany,
	updateOne
];