'use strict'; // eslint-disable-line max-lines

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

import EventEmitter from 'node:events';

import plugins from'./index';

class ButtressPlugin extends EventEmitter {
	appType?: string;
	processRole?: string;
	infrastructureRole?: string;

	constructor() {
		super();
	}

	async initialise() {
		if (this.appType === plugins.APP_TYPE.REST) {
			this.initialiseRest();
		} else if (this.appType === plugins.APP_TYPE.SOCKET) {
			this.initialiseSocket();
		} else if (this.appType === plugins.APP_TYPE.LAMBDA) {
			this.initialiseLambda();
		}
	}

	initialiseRest() {
		throw new Error('Not implemented');
	}

	initialiseSocket() {
		throw new Error('Not implemented');
	}

	initialiseLambda() {
		throw new Error('Not implemented');
	}

	addAction(name, callback, priority = 10) {
		this.emit('add-action', {name, callback, priority});
	}

	addFilter(name, callback, priority = 10) {
		this.emit('add-filter', {name, callback, priority});
	}
}

export default ButtressPlugin;
