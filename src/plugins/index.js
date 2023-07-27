const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');

const Config = require('node-env-obj')();

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
	constructor() {
		super();
		this.plugins = [];

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
		const result = [];

		let dirs = [];
		try {
			dirs = await fs.readdir(dir);
		} catch (e) {
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

module.exports = new Plugins();
