/* jslint node: true */
'use strict';

var sysDb						= require('./database.js').dbs.system;

exports.loadSystemProperties	= loadSystemProperties;
exports.persistSystemProperty	= persistSystemProperty;
exports.getSystemProperty		= getSystemProperty;

var systemProperties = {};
exports.systemProperties 	= systemProperties;

function loadSystemProperties(cb) {
	sysDb.each(
		'SELECT prop_name, prop_value '	+
		'FROM system_property;',
		function rowResult(err, row) {
			systemProperties[row.prop_name] = row.prop_value;
		},
		cb
	);
}

function persistSystemProperty(propName, propValue, cb) {
	//	update live
	systemProperties[propName] = propValue;

	sysDb.run(
		'REPLACE INTO system_property '			+
		'VALUES (?, ?);',
		[ propName, propValue ],
		cb
	);
}

function getSystemProperty(propName) {
	return systemProperties[propName];
}
