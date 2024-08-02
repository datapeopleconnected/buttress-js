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
import { ObjectId } from 'bson';

import AbstractAdapter from '../abstract-adapter';

class AdapterId {
	static new(id: string) {
		return new ObjectId(id);
	}

	static isValid(id: string) {
		return ObjectId.isValid(id);
	}

	static instanceOf(id: string | ObjectId) {
		return id instanceof ObjectId;
	}
}

export default class EmptyAdapter extends AbstractAdapter {
	get ID() {
		return AdapterId;
	}
};
