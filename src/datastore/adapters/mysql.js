const ObjectId = require('mongodb').ObjectId;
// const mysql = require('mysql2/promise');
const mysql = require('mysql2');
// const stream = require('stream');

const Helpers = require('../../helpers');
const Logging = require('../../logging');

const AbstractAdapter = require('../abstract-adapter');

class AdapterId {
	static new(id) {
		return new ObjectId(id);
	}

	static isValid(id) {
		return ObjectId.isValid(id);
	}
}

module.exports = class MongodbAdapter extends AbstractAdapter {
	constructor(uri, options, connection = null) {
		super(uri, options, connection);

		this.requiresFormalSchema = true;

		this._databaseName = this.uri.pathname.replace(/\//g, '');

		this._tables = [];
		this._flatSchema = null;

		this._connections = [];
	}

	async connect() {
		if (this.connection) return this.connection;

		this.connection = {
			pool: [],
			queue: [],
		};

		for (let x = 0; x < 5; x++) {
			const con = mysql.createConnection({
				host: this.uri.host,
				user: this.uri.username,
				password: this.uri.password,
				database: this._databaseName,
			}, this.options);

			con.lock = false;

			this.connection.pool.push(con);
		}
	}

	cloneAdapterConnection() {
		return new MongodbAdapter(this.uri, this.options, this.connection);
	}

	async setCollection(collectionName) {
		// Check if the table exists
		Logging.logSilly(`MongodbAdapter set collection ${collectionName}`);

		// const [showTablesRows] = await this.connection.query(`SHOW TABLES LIKE "${collectionName}"`);
		const showTablesRows = await this._fetchRow(`SHOW TABLES LIKE "${collectionName}"`);

		if (!showTablesRows || showTablesRows.length < 1) {
			Logging.logSilly(`Table with name ${collectionName} doesn't, attempting to create one`);
			// Create the table, need schema data though?
			await this._query(`CREATE TABLE \`${collectionName}\` (_id BINARY(12) NOT NULL);`);
		}

		Logging.logSilly(`Found table with the name ${collectionName}`);

		this.collection = collectionName;

		this._tableKeys = [];

		return true;
	}

	async updateSchema(schemaData) {
		if (!this.requiresFormalSchema) return;

		Logging.logSilly('updateSchema', schemaData.name);

		// Parse out MySQL tables and columns from the schema
		// This will also modify the schema properties, adding in
		// fields for ids and foreign keys
		const tables = await this.parseTablesFromSchema(this.collection, schemaData.properties);
		this._tableKeys = Object.keys(tables);

		this._flatSchema = Helpers.getFlattenedSchema(schemaData);
		// this._flatSchema['_id'] = {
		// 	'__type': 'id',
		// 	'__default': 'new',
		// 	'__required': true,
		// 	'__allowUpdate': false,
		// };

		Logging.logSilly(`Parsed ${this._tableKeys.length} tables from schema`);

		// Create / Update table from parsed data
		await Helpers.awaitForEach(this._tableKeys, async (key) => await this.createOrUpdateTable(key, tables[key]));
	}

	async parseTablesFromSchema(name, properties, parentReference = null) {
		let tables = {};

		properties['_id'] = {
			'__type': 'id',
			'__default': 'new',
			'__required': false,
			'__allowUpdate': false,
		};
		tables[name] = {
			'_id': this.getColumnType(properties['_id']),
		};

		if (parentReference) {
			properties[parentReference] = {
				'__type': 'id',
				'__default': 'new',
				'__required': false,
				'__allowUpdate': true,
			};
			tables[name][parentReference] = this.getColumnType(properties[parentReference]);
		}

		const parseProp = async (key, prop) => {
			if (!prop.__type) {
				const subObjectkeys = Object.keys(prop);
				if (subObjectkeys.length > 0) {
					await Helpers.awaitForEach(subObjectkeys, (subKey) => parseProp(`${key}.${subKey}`, prop[subKey]));
				} else {
					tables[name][key] = this.getColumnType({__type: `string`});
				}
			} else if (prop.__type === 'array' && prop.__schema) {
				const subTables = await this.parseTablesFromSchema(`${name}.${key}`, prop.__schema, `_${name}Id`);
				tables = {...tables, ...subTables};
			} else {
				tables[name][key] = this.getColumnType(prop);
			}
		};

		await Helpers.awaitForEach(Object.keys(properties), async (key) => await parseProp(key, properties[key]));

		return tables;
	}

	async createOrUpdateTable(name, columns) {
		let createTable = false;
		let currentSchemaArr = null;

		try {
			currentSchemaArr = await this._query(`DESCRIBE \`${name}\``);
		} catch (err) {
			if (err && err.code === 'ER_NO_SUCH_TABLE') createTable = true;
			else throw err;
		}

		if (createTable) {
			// Create the table
			Logging.logSilly(`MySQL Adapter ${name}, creating table`);
			// const columns = [];
			const commands = [];

			for (const [columnName, columnType] of Object.entries(columns)) {
				commands.push(this.formatColumnDataType(columnName, columnType));
			}

			await this._query(`CREATE TABLE \`${name}\` (${commands.join(',')});`);
		} else {
			const commands = [];
			const currentSchema = {};
			if (currentSchemaArr) {
				for (const chunk of currentSchemaArr) {
					chunk.Type = chunk.Type.toUpperCase();
					currentSchema[chunk.Field] = chunk;
				}
			}

			const newKeys = Object.keys(columns);
			const currentKeys = Object.keys(currentSchema);

			const additions = newKeys.filter((v) => !currentKeys.includes(v));
			const drops = currentKeys.filter((v) => !newKeys.includes(v));

			const updates = newKeys.filter((v) => !additions.includes(v) && !drops.includes(v));

			Logging.logSilly(`MySQL Adapter ${name}, we've got ${additions.length} additions, ${drops.length} drops and ${updates.length} updates`);

			additions.forEach((k) => this.createOrUpdateColumn(k, columns[k], false, null, commands));
			drops.forEach((k) => commands.push(`DROP COLUMN \`${k}\``));
			updates.forEach((k) => this.createOrUpdateColumn(k, columns[k], currentSchema[k], null, commands));

			if (commands.length < 1) return;

			return this._query(`ALTER TABLE \`${name}\` ${commands.join(', ')}`);
		}
	}

	createOrUpdateColumn(key, column, current = false, prefix = null, commands = []) {
		const columnName = (prefix) ? `${prefix}.${key}` : key;
		const commandType = (current) ? `MODIFY COLUMN` : `ADD`;

		if (!current) {
			current = {
				type: null,
				nullable: 'YES',
				key: '',
			};
		}

		if (key === '_id') {
			column.nullable = 'NO';
			column.key = 'PRI';
		}

		if (column.type !== current.Type || current.Null !== column.nullable) {
			commands.push(`${commandType} ${this.formatColumnDataType(columnName, column)}`);
		}

		if (column.key === 'PRI' && !current.Key.includes('PRI')) {
			commands.push(`ADD PRIMARY KEY (\`${columnName}\`)`);
			commands.push(`ADD UNIQUE INDEX \`${columnName}_UNIQUE\` (\`${columnName}\` ASC) VISIBLE`);
		}
	}

	formatColumnDataType(columnName, column) {
		return `\`${columnName}\` ${column.type} ${(column.nullable === 'YES') ? 'NULL' : 'NOT NULL'}`;
	}

	getColumnType(propertyData, columnName = null) {
		const rtn = {
			type: null,
			nullable: 'YES',
			key: '',
		};

		if (columnName === '_id') {
			rtn.nullable = 'NO';
			rtn.key = 'PRI';
		}

		switch (propertyData.__type) {
		case 'id':
			rtn.type ='VARCHAR(24)';
			break;
		case 'date':
			rtn.type = 'DATETIME';
			break;
		case 'string':
			rtn.type = 'VARCHAR(255)';
			break;
		case 'text':
			rtn.type = 'TEXT';
			break;
		default:
			rtn.type = 'VARCHAR(255)';
			break;
		}

		return rtn;
	}

	get ID() {
		return AdapterId;
	}

	getConnection() {
		const con = this.connection.pool.find((con) => con.lock === false);

		if (con) {
			con.lock = true;
			return Promise.resolve(con);
		}

		return new Promise((resolve) => this.connection.queue.push(resolve));
	}
	releaseConnection(con) {
		const queued = this.connection.queue.shift();

		if (queued) {
			queued(con);
		} else {
			const conIdx = this.connection.pool.findIndex((_con) => _con === con);
			if (conIdx === -1) throw new Error('Unable to find connection in pool');
			this.connection.pool[conIdx].lock = false;
		}
	}

	async _query(query, params = []) {
		const con = await this.getConnection();
		const res = await new Promise((res, rej) => con.execute(query, params, (err, result) => {
			if (err) {
				return rej(err);
			}
			return res(result);
		}));
		this.releaseConnection(con);
		return res;
		// .then((res) => {
		// 	this.connection.releaseConnection(con);
		// 	return res;
		// });
	}

	async _queryStream(query, params = []) {
		const con = await this.getConnection();
		const rx = con.execute(query, params).stream();

		// Handle closing stream
		rx.on('close', () => this.releaseConnection(con));

		return rx;
	}

	async _fetchRow(query, params = []) {
		const stream = await this._queryStream(query, params);
		return await Helpers.streamFirst(stream);
	}

	_buildQuery(command, table, selectParts, joinParts, whereParts) {
		const queryParts = [];

		// TODO: Refactor to parse in AST
		// TODO: Handle enforcing data type conversions

		if (command === 'UPDATE') {
			queryParts.push(`${command} ${table}`);

			queryParts.push(`SET ${selectParts.join(', ')}`);
		} else if (command === 'DELETE') {
			queryParts.push(command);

			queryParts.push(`FROM \`${table}\``);
		} else {
			queryParts.push(command);

			// Selectors
			// TODO: PROJECT
			if (selectParts.length > 0) queryParts.push(selectParts.join(', '));
			else queryParts.push('*');

			// Table
			queryParts.push(`FROM \`${table}\``);

			// Joins
			if (joinParts.length > 0) queryParts.push(joinParts.join(', '));
		}

		// Where
		if (whereParts.length > 0) queryParts.push(`WHERE ${whereParts.join(', ')}`);

		// TODO: SKIP
		// TODO: LIMIT
		// TODO: SORT

		// console.log(queryParts.join(' '));

		return queryParts.join(' ');
	}

	_unpackArrays(documents, parentPath, parentId) {
		let arrayMap = {};
		documents.forEach((properties) => Object.keys(properties).forEach((path) => {
			if (Array.isArray(properties[path])) {
				const fullPath = (parentPath) ? parentPath+'.'+path : path;
				const ref = (parentPath) ?
					`_${parentPath.split('.').map((p, idx) => (idx === 0) ? p : p.charAt(0).toUpperCase() + p.substring(1)).join('')}Id` :
					null;

				arrayMap[fullPath] = properties[path];
				arrayMap[fullPath].map((item) => {
					if (!item._id) item['_id'] = this.ID.new();
					if (ref) item[ref] = (parentId) ? parentId : properties._id;
				});
				arrayMap = {...arrayMap, ...this._unpackArrays(properties[path], fullPath)};
				delete properties[path];
			}
		}));
		return arrayMap;
	}

	/*
	* @return {Promise} - returns a promise that is fulfilled when the database request is completed
	*/
	isDuplicate(details) {
		return Promise.resolve(false);
	}

	/**
	 * @param {App} entity - entity object to be deleted
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	rm(entity) {
		return this.rmAll({_id: this.ID.new(entity._id)});
	}

	/**
	 * @param {Array} ids - Array of entity ids to delete
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	rmBulk(ids) {
		return this.rmAll({_id: {$in: ids}});
	}

	/*
	 * @param {Object} query - mongoDB query
	 * @return {Promise} - returns a promise that is fulfilled when the database request is completed
	 */
	rmAll(query) {
		if (!query) query = {};
		// Logging.logSilly(`rmAll: ${this.collectionName} ${query}`);

		const queryParts = this._parseBJSQueries(this.collection, query);

		const queries = Object.keys(queryParts).map((table) => {
			return this._buildQuery('DELETE', table, [], [], queryParts[table].where);
		});

		return this._query(queries.join(';'));
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @param {Object} excludes - mongoDB query excludes
	 * @param {Int} limit - should return a stream
	 * @param {Int} skip - should return a stream
	 * @param {Object} sort - mongoDB sort object
	 * @param {Boolean} project - mongoDB project ids
	 * @return {ReadableStream} - stream
	 */
	async find(query, excludes = {}, limit = 0, skip = 0, sort, project = null) {
		Logging.logSilly(`find: ${this.collection} ${query}`);

		const queryParts = this._parseBJSQueries(this.collection, query);

		// Perform joins to fetch info about secondary tables
		const selectParts = [];
		const joinParts = [];

		// !!! Warning, doth not behold at the code beyond this pointeth!
		const joinTransformQuery = Helpers.Stream.asyncIteratorToStream.obj(async function* (_self, queryStream) {
			for await (const chunk of queryStream) {
				await Helpers.awaitAll(_self._tableKeys, async (table) => {
					if (table === _self.collection) return;
					const tableNameSplit = table.split('.');
					const property = tableNameSplit.pop();
					const foreignKey = '_'+ tableNameSplit.join('.') + 'Id';
					const rows = await _self._query(`SELECT * FROM \`${table}\` WHERE \`${foreignKey}\`='${chunk._id}'`);
					chunk[property] = rows;
				});

				yield chunk;
			}
		});

		Logging.logSilly(`find: ${this.collection} ${this._tableKeys}`);

		if (this._tableKeys.length > 1) {
			return joinTransformQuery(
				this,
				await this._queryStream(
					this._buildQuery('SELECT', this.collection, selectParts, joinParts, queryParts[this.collection].where),
				),
			);
		} else {
			return await this._queryStream(
				this._buildQuery('SELECT', this.collection, selectParts, joinParts, queryParts[this.collection].where),
			);
		}
	}

	/**
	 * @param {String} id - entity id to get
	 * @return {Promise} - resolves to an array of Companies
	 */
	async findById(id) {
		// Logging.logSilly(`Schema:findById: ${this.collectionName} ${id}`);

		if (id instanceof ObjectId === false) id = this.ID.new(id);

		return await Helpers.streamFirst(await this.find({_id: id}, {}));
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @return {Promise} - resolves to an array of docs
	 */
	async findOne(query) {
		return await Helpers.streamFirst(await this.find(query, {}));
	}

	/**
	 * @return {Promise} - resolves to an array of Companies
	 */
	findAll() {
		// Logging.logSilly(`findAll: ${this.collectionName}`);

		return this.find({});
	}

	/**
	 * @param {Array} ids - Array of entities ids to get
	 * @return {Promise} - resolves to an array of Companies
	 */
	findAllById(ids) {
		// Logging.logSilly(`update: ${this.collectionName} ${ids}`);

		return this.find({_id: {$in: ids.map((id) => this.ID.new(id))}}, {});
	}

	add(body, modifier) {
		return this.__batchAddProcess(body, modifier);
	}

	async __batchAddProcess(body, modifier) {
		if (body instanceof Array === false) {
			body = [body];
		}

		const commands = [];

		const documents = await body.reduce(async (prev, item) => {
			const arr = await prev;
			return arr.concat([
				await modifier(item),
			]);
		}, Promise.resolve([]));

		const tables = this._unpackArrays(documents, this.collection);
		tables[this.collection] = documents;

		Object.keys(tables).forEach((table) => {
			tables[table].forEach((properties) => {
				if (!properties._id) properties['_id'] = this.ID.new();

				properties = Helpers.flatternObject(properties);

				const columns = Object.keys(properties);

				// TODO: ESCAPES NEEDED
				const formattedValues = Object.entries(properties).map(([field, value]) => {
					return this._castToSQLType(this._getTypeFromFieldPath(`${table}.${field}`, this.collection), value);
				});

				commands.push(`INSERT INTO \`${table}\` (\`${columns.join('`,`')}\`) VALUES (${formattedValues.join(',')});`);
			});
		});

		if (commands.length < 1) return;

		await commands.reduce(async (prev, command) => {
			await prev;
			await this._query(command);
		}, Promise.resolve());

		const insertedIds = documents.map((v) => this.ID.new(v._id));

		return this.find({_id: {$in: insertedIds}});
	}

	updateById(id, query) {
		// const filterParts = this._parseBJSQueries({_id: id});
		const updates = {...{_id: id}, ...query};
		const queryParts = this._parseBJSQueries(this.collection, updates, id);

		const queries = Object.keys(queryParts).map((table) => {
			return this._buildQuery('UPDATE', table, queryParts[table].set, [], queryParts[table].where);
		});

		return this._query(queries.join(';'));
	}

	_parseBJSQueries(collection, _query, parentId) {
		const tables = {};

		const createTable = (key) => tables[key] = {set: [], where: []};

		createTable(collection);

		if (_query && !_query['$set']) {
			// Repack Objects
			_query = Helpers.Schema.unflattenObject(_query);
		}

		for (const field in _query) {
			if (!{}.hasOwnProperty.call(_query, field)) continue;
			if (field === '$set') {
				// Unpack arrays
				const unpackedArrays = this._unpackArrays([_query[field]], this.collection, parentId);
				Object.keys(unpackedArrays).forEach((table) => {
					if (!tables[collection]) createTable(table);
					tables[collection] = {...tables[collection], ...this._parseBJSQueries(table, tables[table])};
				});

				// TODO: Unpack objects
				_query[field] = Helpers.flatternObject(_query[field]);

				for (const prop in _query[field]) {
					if (!{}.hasOwnProperty.call(_query[field], prop)) continue;

					tables[collection].set.push(this._parseOperations(prop, '$eq', _query[field][prop], collection));
				}
			} else {
				if (
					typeof _query[field] === 'object' &&
					!Array.isArray(_query[field]) &&
					_query[field] !== null &&
					!AdapterId.isValid(_query[field])
				) {
					for (const operator in _query[field]) {
						if (!{}.hasOwnProperty.call(_query[field], operator)) continue;

						const operand = _query[field][operator];
						tables[collection].where.push(this._parseOperations(field, operator, operand, collection));
					}
				} else {
					tables[collection].where.push(this._parseOperations(field, '$eq', _query[field], collection));
				}
			}
		}

		return tables;
	}
	_parseOperations(field, operator, operand, table) {
		switch (operator) {
		case '$eq': {
			const type = this._getTypeFromFieldPath(field, this.collection);

			return `\`${field}\`=${this._castToSQLType(type, operand)}`;
		}
		case '$in':
			return `\`${field}\` IN (${operand.map((v) => `'${v}'`).join(', ')})`;
		default:
			throw new Error(`Unknown operator '${operator}'`);
		}
	}

	_getTypeFromFieldPath(path, table) {
		if (path.indexOf(table) === 0) {
			path = path.substring(table.length + 1);
		}

		// Extra field from array
		const parts = path.split('.');

		// The first key will be the table, lets discard it
		// if (parts.length > 1 && parts[0] === table) parts.shift();

		const type = parts.reduce((data, part) => {
			const node = data.node;

			if (!node || data.found) return data;

			if (node && !node[part]) {
				const combined = parts.join('.');
				if (node[combined]) {
					data.found = true;
					data.node = node[combined].__type;
					return data;
				}

				// Check to see if we've got an object with
				const subKeys = Object.keys(node).filter((k) => k.indexOf(`${part}.`) === 0);
				if (subKeys.length > 0) return 'object';
				throw new Error(`Unable to find field: ${path}`);
			}

			if (node[part].__type === 'array') {
				if (node[part].__schema) {
					data.node = node[part].__schema;
					return data;
				} else if (node[part].__itemtype) {
					data.found = true;
					data.node = node[part].__itemtype;
					return data;
				} else {
					throw new Error(`Array doesn't have a schema or type ${path}`);
				}
			}

			data.found = true;
			data.node = node[part].__type;
			return data;
		}, {
			found: false,
			node: this._flatSchema,
		});

		if (!type.found) {
			throw new Error(`Unable to find field: ${path}`);
		}

		return type.node;
	}

	_castToSQLType(type, value) {
		if (value === null) {
			return 'NULL';
		}

		switch (type) {
		case 'id':
		case 'string':
		case 'text':
			return `'${value.toString()}'`;
		case 'date':
			return value;
		case 'number':
			return value;
		default:
			throw new Error(`_castToSQLType: Unknown data type '${type}'`);
		}
	}

	/**
	 * @param {Object} query - mongoDB query
	 * @return {Promise} - resolves to an array of Companies
	 */
	async count(query) {
		const result = await this._fetchRow(`SELECT COUNT(*) AS count FROM ${this.collection}`);

		return result.count;
	}

	/**
	 * @return {Promise}
	 */
	drop() {
		return this.rmAll({});
	}
};
