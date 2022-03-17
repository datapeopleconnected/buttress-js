/**
 * ButtressJS - Realtime datastore for software
 *
 * @file accessControl.js
 * @description A list of access control phases
 * @module routes
 * @author Chris Bates-Keegan
 *
 */

module.exports = {
	disposition: require('./disposition'),
	conditions: require('./conditions'),
	filter: require('./filter'),
	projection: require('./projection'),
};
