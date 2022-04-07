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
	}

	async connect() {
		if (this.connection) return this.connection;

		const conn = mysql.createConnection({
			host: this.uri.host,
			user: this.uri.username,
			password: this.uri.password,
			database: this._databaseName,
		}, this.options);

		return this.connection = conn;
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
			await this._query(`CREATE TABLE ${collectionName} (_id BINARY(12) NOT NULL);`);
		}

		Logging.logSilly(`Found table with the name ${collectionName}`);

		this.collection = collectionName;

		this._tableKeys = [];

		return true;
	}

	async updateSchema(schemaData) {
		if (!this.requiresFormalSchema) return;

		Logging.logSilly('updateSchema', schemaData.name);

		this._flatSchema = Helpers.getFlattenedSchema(schemaData);
		this._flatSchema['_id'] = {
			'__type': 'id',
			'__default': 'new',
			'__required': true,
			'__allowUpdate': false,
		};

		// Parse out MySQL tables and columns from the schema
		const tables = await this.parseTablesFromSchema(this.collection, schemaData.properties);
		this._tableKeys = Object.keys(tables);

		Logging.logSilly(`Parsed ${this._tableKeys.length} tables from schema`);

		// Create / Update table from parsed data
		await Helpers.awaitForEach(this._tableKeys, async (key) => await this.createOrUpdateTable(key, tables[key]));
	}

	async parseTablesFromSchema(name, properties, parentReference = null) {
		let tables = {};

		tables[name] = {
			'_id': this.getColumnType({
				'__type': 'id',
				'__default': 'new',
				'__required': true,
				'__allowUpdate': false,
			}),
		};

		if (parentReference) {
			tables[name][parentReference] = this.getColumnType({
				'__type': 'id',
				'__default': null,
				'__required': true,
				'__allowUpdate': true,
			});
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
			[currentSchemaArr] = await this._query(`DESCRIBE \`${name}\``);
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

	async _query(query, params = []) {
		return this.connection.promise().execute(query, params);
	}

	_queryStream(query, params = []) {
		return this.connection.execute(query, params).stream();
	}

	async _fetchRow(query, params = []) {
		const stream = this._queryStream(query, params);
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

			queryParts.push(`FROM ${table}`);
		} else {
			queryParts.push(command);

			// Selectors
			// TODO: PROJECT
			if (selectParts.length > 0) queryParts.push(selectParts.join(', '));
			else queryParts.push('*');

			// Table
			queryParts.push(`FROM ${table}`);

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

		const queryParts = this._parseBJSQuery(query);

		return this._query(
			this._buildQuery('DELETE', this.collection, [], [], queryParts.where),
		);
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
	find(query, excludes = {}, limit = 0, skip = 0, sort, project = null) {
		Logging.logSilly(`find: ${this.collection} ${query}`);

		const queryParts = this._parseBJSQuery(query);

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
					const [rows] = await _self._query(`SELECT * FROM \`${table}\` WHERE \`${foreignKey}\`='${chunk._id}'`);
					chunk[property] = rows;
				});

				yield chunk;
			}
		});

		if (this._tableKeys.length > 1) {
			return joinTransformQuery(
				this,
				this._queryStream(
					this._buildQuery('SELECT', this.collection, selectParts, joinParts, queryParts.where),
				),
			);
		} else {
			return this._queryStream(
				this._buildQuery('SELECT', this.collection, selectParts, joinParts, queryParts.where),
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

		return await Helpers.streamFirst(this.find({_id: id}, {}));
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
				const columns = Object.keys(properties);

				// TODO: ESCAPES NEEDED
				const formattedValues = Object.entries(properties).map(([field, value]) => {
					if (value === null) {
						return 'NULL';
					}

					// return this._convertDataTypes(type? operand);

					console.log(this._getTypeFromField(field));

					return `'${value}'`;
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
		// const filterParts = this._parseBJSQuery({_id: id});
		const updates = {...{_id: id}, ...query};
		const queryParts = this._parseBJSQuery(updates, id);

		console.log('updates', updates);
		console.log('queryParts', queryParts);

		return this._query(
			this._buildQuery('UPDATE', this.collection, queryParts.set, [], queryParts.where),
		);
	}

	_parseBJSQuery(_query, parentId) {
		const parts = {
			set: [],
			where: [],
		};

		for (const field in _query) {
			if (!{}.hasOwnProperty.call(_query, field)) continue;
			if (field === '$set') {
				// _unpackArrays
				// TODO: Deconstruct array properties
				// console.log(_query[field]);
				console.log(this._unpackArrays([_query[field]], this.collection, parentId));

				for (const prop in _query[field]) {
					if (!{}.hasOwnProperty.call(_query[field], prop)) continue;

					// TODO: Deconstruct array properties

					// Set field;
					// Generate updates for tables

					parts.set.push(this._parseOperations(prop, '$eq', _query[field][prop]));
				}
			} else {
				if (typeof _query[field] === 'object' && !Array.isArray(_query[field]) && _query[field] !== null) {
					for (const operator in _query[field]) {
						if (!{}.hasOwnProperty.call(_query[field], operator)) continue;

						const operand = _query[field][operator];
						parts.where.push(this._parseOperations(field, operator, operand));
					}
				} else {
					parts.where.push(this._parseOperations(field, '$eq', _query[field]));
				}
			}
		}

		return parts;
	}
	_parseOperations(field, operator, operand) {
		switch (operator) {
		case '$eq': {
			const type = this._getTypeFromField(field);

			if (type === 'array') {
				console.log(field, operand);
			}

			return `\`${field}\`=${this._castToSQLType(this._getTypeFromField(field), operand)}`;
		}
		case '$in':
			return `\`${field}\` IN (${operand.map((v) => `'${v}'`).join(', ')})`;
		default:
			throw new Error(`Unknown operator '${operator}'`);
		}
	}

	_getTypeFromField(field) {
		if (!this._flatSchema[field]) {
			throw new Error(`Unable to find type for field: ${field}`);
		}
		if (!this._flatSchema[field].__type) {
			throw new Error(`Unable to find type for field ${field}`);
		}

		return this._flatSchema[field].__type;
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
};
