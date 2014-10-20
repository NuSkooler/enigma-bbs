/* jslint node: true */
'use strict';

var conf			= require('./config.js');
var sqlite3			= require('sqlite3');
var paths			= require('path');

exports.initializeDatabases			= initializeDatabases;
exports.user						= user;

//	db handles
var user;

function getDatabasePath(name) {
	return paths.join(conf.config.paths.db, name + '.sqlite3');
}

function initializeDatabases() {
	//	:TODO: this will need to change if more DB's are added
	user = new sqlite3.Database(getDatabasePath('user'));

	user.serialize(function onSerialized() {
		createUserTables();
	});
}

function createUserTables() {
	user.run(
		'CREATE TABLE IF NOT EXISTS user (' + 
		'	id			INTEGER PRIMARY KEY,' +
		'	user_name	VARCHAR NOT NULL,' + 
		'	UNIQUE(user_name)' +
		');'
		);

	user.run(
		'CREATE TABLE IF NOT EXISTS user_property (' +
		'	user_id		INTEGER NOT NULL,' +
		'	prop_name	VARCHAR NOT NULL,' +
		'	prop_value	VARCHAR,' +
		'	UNIQUE(user_id, prop_name)' +
		');'
		);
}