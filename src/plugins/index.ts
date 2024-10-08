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

import { promises as fs } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

import createConfig from 'node-env-obj';
const Config = createConfig() as unknown as Config;

const APP_TYPE = {
	REST: 'rest',
	SOCKET: 'socket',
	LAMBDA: 'lambda',
};
const PROCESS_ROLE = {
	MAIN: 'main',
	WORKER: 'worker',
};
const INFRASTRUCTURE_ROLE = {
	PRIMARY: 'primary',
	SECONDARY: 'secondary',
};

class Plugins extends EventEmitter {
	plugins: any[] = [];
	filters: {[key: string] : any};
	actions: {[key: string] : any};

	appType?: string;
	processRole?: string;
	infrastructureRole?: string;

	constructor() {
		super();

		this.filters = {};
		this.actions = {};
	}

	get APP_TYPE() {
		return APP_TYPE;
	}
	get PROCESS_ROLE() {
		return PROCESS_ROLE;
	}
	get INFRASTRUCTURE_ROLE() {
		return INFRASTRUCTURE_ROLE;
	}

	async initialise(appType, processRole, infrastructureRole) {
		this.appType = appType;
		this.processRole = processRole;
		this.infrastructureRole = infrastructureRole;

		await this._scanPlugins();
	}

	attachListeners(plugin) {
		plugin.on('add-action', (hook) => this.add_action(hook.name, hook.callback, hook.priority));
		plugin.on('add-filter', (hook) => this.add_filter(hook.name, hook.callback, hook.priority));
		plugin.on('request', (...args) => this.emit('request', ...args));
	}

	initRoutes(router) {
		this.plugins.forEach((plugin) => {
			if (plugin.routes) {
				router.createPluginRoutes(plugin.code, plugin.routes);
			}
		});
	}

	async _scanPlugins() {
		const pluginDirs = await this._findPluginEntryFiles(Config.paths.plugins);
		for (const pluginDir of pluginDirs) {
			const plugin = new (require(pluginDir))(this.appType, this.processRole, this.infrastructureRole);
			this.attachListeners(plugin);
			if (plugin.initialise) {
				await plugin.initialise();
				this.plugins.push(plugin);
			}
		}
	}

	async _findPluginEntryFiles(dir) {
		const result: string[] = [];

		let dirs: string[] = [];
		try {
			dirs = await fs.readdir(dir);
		} catch (e: any) {
			if (e.code === 'ENOENT') return result;

			throw e;
		}

		for (const subdir of dirs) {
			const subDirPath = path.join(dir, subdir);
			const stats = await fs.stat(subDirPath);
			if (stats.isDirectory()) {
				const hasIndexJS = await fs.access(path.join(subDirPath, 'index.js')).then(() => true).catch(() => false);
				if (hasIndexJS) {
					result.push(subDirPath);
				}
			}
		}

		return result;
	}

	getPlugins() {
		return this.plugins;
	}

	add_action(name, callback, priority = 10) {
		if (!this.actions[name]) {
			this.actions[name] = [];
		}

		this.actions[name].push({callback, priority});
	}

	async do_action(name, ...args) {
		if (!this.actions[name]) {
			return;
		}

		this.actions[name].sort((a, b) => a.priority - b.priority);

		for await (const action of this.actions[name]) {
			await action.callback(...args);
		}
	}

	add_filter(name, callback, priority = 10) {
		if (!this.filters[name]) {
			this.filters[name] = [];
		}

		this.filters[name].push({callback, priority});
	}

	async apply_filters(name, value, ...args) {
		if (!this.filters[name]) {
			return value;
		}

		this.filters[name].sort((a, b) => a.priority - b.priority);

		for await (const filter of this.filters[name]) {
			value = await filter.callback(value, ...args);
		}

		return value;
	}
}

export default new Plugins();
