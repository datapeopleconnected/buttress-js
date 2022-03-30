const ObjectId = require('mongodb').ObjectId;
// const mysql = require('mysql2/promise');
const mysql = require('mysql2');

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

		return true;
	}

	async updateSchema(schemaData) {
		if (!this.requiresFormalSchema) return;

		// Parse out MySQL tables and columns from the schema
		const tables = await this.parseTablesFromSchema(this.collection, schemaData.properties);
		const tableKeys = Object.keys(tables);

		Logging.logSilly(`Parsed ${tableKeys.length} tables from schema`);

		console.log(tables);

		// Create / Update table from parsed data
		await Helpers.awaitForEach(tableKeys, async (key) => await this.createOrUpdateTable(key, tables[key]));
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

			console.log(`ALTER TABLE \`${name}\` ${commands.join(', ')}`);

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
			console.log(current.Key);
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

		const whereParts = [];

		const parseQuery = (_query) => {
			for (const field of Object.keys(query)) {
				const command = query[field];
				for (const operator in command) {
					if (!command.hasOwnProperty(operator)) continue;
					const operand = command[operator];
					parseOperations(field, operator, operand);
				}
			}
		};
		const parseOperations = (field, operator, operand) => {
			if (operator === '$in') {
				whereParts.push(`${field} IN (${operand.map((v) => `'${v}'`).join(', ')})`);
			} else {
				throw new Error(`Unknown operator '${operator}'`);
			}
		};

		parseQuery(query);

		const queryParts = [];

		queryParts.push('SELECT');

		// Selectors
		// TODO: PROJECT
		queryParts.push('*');

		// Table
		queryParts.push(`FROM ${this.collection}`);

		// Joins

		// Where
		if (whereParts.length > 0) queryParts.push(`WHERE ${whereParts.join(', ')}`);

		// TODO: SKIP
		// TODO: LIMIT
		// TODO: SORT

		console.log(queryParts.join(' '));

		return this._queryStream(queryParts.join(' '));
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

		// TODO: Handle arrays, currently stripping them out.
		documents.forEach((properties) => {
			for (const [key, value] of Object.entries(properties)) {
				if (Array.isArray(value)) {
					delete properties[key];
				}
			}
		});

		documents.forEach((properties) => {
			const columns = Object.keys(properties);

			// TODO: ESCAPES NEEDED
			const formattedValues = Object.values(properties).map((value) => {
				if (value === null) {
					return 'NULL';
				}

				return `'${value}'`;
			});

			commands.push(`INSERT INTO ${this.collection} (\`${columns.join('`,`')}\`) VALUES (${formattedValues.join(',')});`);
		});

		if (commands.length < 1) return;

		await this._query(commands.join(';'));

		const insertedIds = documents.map((v) => this.ID.new(v._id));

		return this.find({_id: {$in: insertedIds}});
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
