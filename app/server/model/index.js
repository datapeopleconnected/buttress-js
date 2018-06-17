'use strict';

/**
 * ButtressJS - Realtime datastore for business software
 *
 * @file index.js
 * @description Model management
 * @module Model
 * @author Chris Bates-Keegan
 *
 */

const path = require('path');
const fs = require('fs');
const Logging = require('../logging');
const Sugar = require('sugar');
const Schema = require('../schema');
const SchemaModel = require('./schemaModel');

/**
 * @param {string} model - name of the model to load
 * @private
 */

/**
 * @class Model
 */
class Model {
  constructor() {
    this.models = {};
    this.Schema = {};
    this.Constants = {};
    this.mongoDb = null;
    this.app = false;
    this.appMetadataChanged = false;
  }

  init(db) {
    this.mongoDb = db;

    // Core Models
    let models = _getModels();
    Logging.log(models, Logging.Constants.LogLevel.SILLY);
    for (let x = 0; x < models.length; x++) {
      this._initModel(models[x]);
    }

    // Load schema models
    return this.Schema.App.statics.findAll().toArray()
    .then(apps => {
      apps.forEach(app => {
        if (app.__schema) {
          Schema.buildCollections(app.__schema).forEach(schema => {
            this._initSchemaModel(app, schema);
          });
        }
      });
    });
  }

  initModel(modelName) {
    return this[modelName];
  }

  /**
   * @param {string} model - demand loads the schema
   * @private
   */
  _initModel(model) {
    this.__defineGetter__(model, () => this._require(model).model);
    this.Schema.__defineGetter__(model, () => this._require(model).schema);
    this.Constants.__defineGetter__(model, () => this._require(model).constants);
    this._require(model);
  }

  /**
   * @param {string} model - demand loads the schema
   * @private
   */
  _initSchemaModel(app, schema) {
    const name = schema.collection;

    if (!this.models[name]) {
      this.models[name] = new SchemaModel(this.mongoDb, schema);
    }

    this.__defineGetter__(name, () => this.models[name]);
    return this.models[name];
  }

  _require(model) {
    if (!this.models[model]) {
      this.models[model] = require(`./schema/${model.toLowerCase()}`);
    }
    return this.models[model];
  }

}

/**
 * @private
 * @return {array} - list of files containing schemas
 */
function _getModels() {
  let filenames = fs.readdirSync(`${__dirname}/schema`);

  let files = [];
  for (let x = 0; x < filenames.length; x++) {
    let file = filenames[x];
    if (path.extname(file) === '.js') {
      files.push(Sugar.String.capitalize(path.basename(file, '.js')));
    }
  }
  return files;
}

module.exports = new Model();
