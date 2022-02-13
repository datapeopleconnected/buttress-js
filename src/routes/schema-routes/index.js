/**
 * ButtressJS - Realtime datastore for software
 *
 * @file schemaRoutes.js
 * @description A list of default routes for schema
 * @module routes
 * @author Chris Bates-Keegan
 *
 */

module.exports = [
	require('./add-many'),
	require('./add-one'),
	require('./delete-all'),
	require('./delete-many'),
	require('./delete-one'),
	require('./get-list'),
	require('./get-many'),
	require('./get-one'),
	require('./search-count'),
	require('./search-list'),
	require('./update-many'),
	require('./update-one'),
];
