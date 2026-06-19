/**
 * Buttress - The federated real-time open data platform
 * Copyright (C) 2016-2026 Data People Connected LTD.
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

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import createConfig from '@dpc/node-env-obj';
import Routes from '../routes/index.js';
import Route from '../routes/route.js';
import type { Services } from '../bootstrap.js';
const Config = createConfig() as unknown as Config;

type PluginRouteClass = new (schema: null, app: null, services: Services) => Route;

interface Hook {
	name: string;
	callback: (...args: unknown[]) => unknown;
	priority: number;
}

type PluginEventMap = {
	'add-action': [hook: Hook];
	'add-filter': [hook: Hook];
	request: unknown[];
};

interface Plugin {
	code: string;
	routes?: PluginRouteClass[];
	initialise?: () => Promise<void>;
	on: <K extends keyof PluginEventMap>(event: K, callback: (...args: PluginEventMap[K]) => unknown) => void;
}

enum APP_TYPE {
	REST = 'rest',
	SOCKET = 'socket',
	LAMBDA = 'lambda',
}
enum PROCESS_ROLE {
	MAIN = 'main',
	WORKER = 'worker',
}
enum INFRASTRUCTURE_ROLE {
	PRIMARY = 'primary',
	SECONDARY = 'secondary',
}

class Plugins extends EventEmitter {
	plugins: Plugin[] = [];
	filters: { [key: string]: { callback: (...args: unknown[]) => unknown; priority: number }[] } = {};
	actions: { [key: string]: { callback: (...args: unknown[]) => unknown; priority: number }[] } = {};

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

	async initialise(appType: APP_TYPE, processRole: PROCESS_ROLE, infrastructureRole: INFRASTRUCTURE_ROLE) {
		this.appType = appType;
		this.processRole = processRole;
		this.infrastructureRole = infrastructureRole;

		await this._scanPlugins();
	}

	attachListeners(plugin: Plugin) {
		plugin.on('add-action', (hook) => this.add_action(hook.name, hook.callback, hook.priority));
		plugin.on('add-filter', (hook) => this.add_filter(hook.name, hook.callback, hook.priority));
		plugin.on('request', (...args) => this.emit('request', ...args));
	}

	initRoutes(router: Routes) {
		this.plugins.forEach((plugin) => {
			if (plugin.routes) {
				router.createPluginRoutes(plugin.code, plugin.routes);
			}
		});
	}

	async _scanPlugins() {
		const pluginDirs = await this._findPluginEntryFiles(Config.paths.plugins);
		for (const pluginDir of pluginDirs) {
			const plugin = new (await import(pluginDir))(this.appType, this.processRole, this.infrastructureRole);
			this.attachListeners(plugin);
			if (plugin.initialise) {
				await plugin.initialise();
				this.plugins.push(plugin);
			}
		}
	}

	async _findPluginEntryFiles(dir: string): Promise<string[]> {
		const result: string[] = [];

		let dirs: string[] = [];
		try {
			dirs = await fs.readdir(dir);
		} catch (e: unknown) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') return result;

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

	add_action(name: string, callback: (...args: unknown[]) => unknown, priority = 10) {
		if (!this.actions[name]) {
			this.actions[name] = [];
		}

		this.actions[name].push({ callback, priority });
	}

	async do_action(name: string, ...args: unknown[]) {
		if (!this.actions[name]) {
			return;
		}

		this.actions[name].sort((a, b) => a.priority - b.priority);

		for await (const action of this.actions[name]) {
			await action.callback(...args);
		}
	}

	add_filter(name: string, callback: (...args: unknown[]) => unknown, priority = 10) {
		if (!this.filters[name]) {
			this.filters[name] = [];
		}

		this.filters[name].push({ callback, priority });
	}

	async apply_filters<T>(name: string, value: T, ...args: unknown[]): Promise<T> {
		if (!this.filters[name]) {
			return value;
		}

		this.filters[name].sort((a, b) => a.priority - b.priority);

		for await (const filter of this.filters[name]) {
			value = (await filter.callback(value, ...args)) as T;
		}

		return value;
	}
}

export default new Plugins();
