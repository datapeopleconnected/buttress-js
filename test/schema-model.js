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

import { Readable } from 'node:stream';

import ObjectIdHelper from '../dist/datastore/adapters/object-id.js';
import StandardModel from '../dist/model/type/standard.js';

// Evaluates a query as StandardModel.parseQuery leaves it, in MongoDB's language. An operator it doesn't know throws,
// so a test never passes against a query nothing understood.
const compare = (value, operand) => (value === operand ? 0 : value > operand ? 1 : -1);
const same = (value, operand) => String(value) === String(operand);
const OPERATORS = {
  $eq: (value, operand) => (Array.isArray(value) ? value.some((v) => same(v, operand)) : same(value, operand)),
  $ne: (value, operand) => !OPERATORS.$eq(value, operand),
  $in: (value, operand) => operand.some((o) => OPERATORS.$eq(value, o)),
  $nin: (value, operand) => !OPERATORS.$in(value, operand),
  $gt: (value, operand) => value !== undefined && value !== null && compare(value, operand) > 0,
  $gte: (value, operand) => value !== undefined && value !== null && compare(value, operand) >= 0,
  $lt: (value, operand) => value !== undefined && value !== null && compare(value, operand) < 0,
  $lte: (value, operand) => value !== undefined && value !== null && compare(value, operand) <= 0,
  $exists: (value, operand) => (value !== undefined) === Boolean(operand),
  $elemMatch: (value, operand) => Array.isArray(value) && value.some((item) => matches(item, operand)),
};

const valueAt = (row, path) =>
  path.split('.').reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), row);

export const matches = (row, query = {}) =>
  Object.entries(query).every(([key, condition]) => {
    if (key === '$and') return condition.every((part) => matches(row, part));
    if (key === '$or') return condition.some((part) => matches(row, part));
    if (key === '$nor') return !condition.some((part) => matches(row, part));
    if (key.startsWith('$')) throw new Error(`The test datastore doesn't know the query operator ${key}`);

    const value = valueAt(row, key === '_id' ? 'id' : key);
    const isOperators = condition && typeof condition === 'object' && !Array.isArray(condition) &&
      Object.keys(condition).some((operator) => operator.startsWith('$'));
    if (!isOperators) return same(value, condition);

    return Object.entries(condition).every(([operator, operand]) => {
      if (operator === '$options') return true;
      if (operator === '$regex') return new RegExp(operand, condition.$options).test(String(value ?? ''));
      if (!OPERATORS[operator]) throw new Error(`The test datastore doesn't know the query operator ${operator}`);
      return OPERATORS[operator](value, operand);
    });
  });

// Orders rows as a MongoDB sort does, by each key in turn, 1 ascending and -1 descending
const bySort = (sort) => (a, b) => {
  for (const [key, direction] of Object.entries(sort)) {
    const order = compare(valueAt(a, key), valueAt(b, key));
    if (order !== 0) return order * direction;
  }
  return 0;
};

// A row with only the keys an inclusion projection names, and its id
const projectRow = (row, project) => {
  if (!project || Object.keys(project).length < 1) return row;
  return Object.fromEntries(Object.entries(row).filter(([key]) => key === 'id' || project[key]));
};

/**
 * A real StandardModel for a schema, so routes run the real parseQuery and the rest of the model, over a datastore in
 * memory. The datastore keeps `rows`, the array it's given, changing it in place as rows are added, updated and
 * removed, and records each call that reaches it in `calls`.
 * @param {object} schema - the collection's schema; an `id` property is added
 * @param {object[]} rows - rows with ObjectId-hex ids, as ids are strings outside the MongoDB adapter
 * @return {{ model: StandardModel, datastore: object }}
 */
export function createSchemaModel(schema, rows = []) {
  const services = new Map([
    ['nrp', { on: async () => () => {}, emit: () => {} }],
    ['modelManager', {}],
  ]);
  const schemaData = {
    type: 'collection',
    ...schema,
    properties: { id: { __type: 'id', __default: 'new', __allowUpdate: false }, ...schema.properties },
  };
  const model = new StandardModel(schemaData, { id: ObjectIdHelper.new() }, services);

  const datastore = {
    rows,
    calls: [],
    ID: ObjectIdHelper,
    record(call, ...args) {
      this.calls.push([call, ...args]);
    },
    select(query) {
      return this.rows.filter((row) => matches(row, query));
    },
    find(query, excludes, limit = 0, skip = 0, sort = null, project = null) {
      this.record('find', query);
      const sorted = sort && Object.keys(sort).length > 0 ? [...this.select(query)].sort(bySort(sort)) : this.select(query);
      const found = sorted.slice(skip, limit ? skip + limit : undefined);
      return Readable.from(found.map((row) => projectRow({ ...row }, project)), { objectMode: true });
    },
    async findOne(query) {
      this.record('findOne', query);
      return this.select(query)[0] ?? null;
    },
    async findById(id) {
      this.record('findById', id);
      return this.rows.find((row) => same(row.id, id)) ?? null;
    },
    findAll() {
      return this.find({});
    },
    findAllById(ids) {
      return this.find({ id: { $in: ids } });
    },
    async count(query) {
      this.record('count', query);
      return this.select(query).length;
    },
    async exists(id, extra = {}) {
      this.record('exists', id, extra);
      return this.select({ id, ...extra }).length > 0;
    },
    async findStoredIds(ids) {
      return ids.filter((id) => this.rows.some((row) => same(row.id, id)));
    },
    async isDuplicate() {
      return false;
    },
    async add(body, parse) {
      const added = (Array.isArray(body) ? body : [body]).map((item) => parse(item));
      this.record('add', added);
      this.rows.push(...added);
      return Readable.from(added, { objectMode: true });
    },
    // Applies each update that sets a value; others are only recorded
    async updateByPaths(id, updates) {
      this.record('updateByPaths', id, updates.map((update) => update.body));
      const row = this.rows.find((candidate) => same(candidate.id, id));
      for (const update of updates) {
        if (row && update.context.type === 'scalar') row[update.body.path] = update.body.value;
      }
      return updates.map((update) => ({ type: update.context.type, path: update.body.path, value: update.body.value }));
    },
    removeWhere(remove) {
      for (let idx = this.rows.length - 1; idx >= 0; idx--) {
        if (remove(this.rows[idx])) this.rows.splice(idx, 1);
      }
    },
    async rm(id) {
      this.record('rm', id);
      this.removeWhere((row) => same(row.id, id));
    },
    async rmBulk(ids) {
      this.record('rmBulk', ids);
      this.removeWhere((row) => ids.some((id) => same(row.id, id)));
    },
    async rmAll(query) {
      this.record('rmAll', query);
      this.removeWhere((row) => matches(row, query));
    },
  };
  model.adapter = datastore;

  return { model, datastore };
}

// An id for a test row
export const newId = () => ObjectIdHelper.new();
