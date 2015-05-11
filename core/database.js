/* jslint node: true */
'use strict';

var conf			= require('./config.js');
var sqlite3			= require('sqlite3');
var paths			= require('path');

//	database handles
var dbs = {};

exports.initializeDatabases			= initializeDatabases;

exports.dbs							= dbs;

function getDatabasePath(name) {
	return paths.join(conf.config.paths.db, name + '.sqlite3');
}

function initializeDatabases() {
	//	:TODO: this will need to change if more DB's are added
	dbs.user = new sqlite3.Database(getDatabasePath('user'));

	dbs.user.serialize(function serialized() {
		createUserTables();
		createInitialValues();
	});
}

function createUserTables() {
	dbs.user.run(
		'CREATE TABLE IF NOT EXISTS user (' + 
		'	id			INTEGER PRIMARY KEY,' +
		'	user_name	VARCHAR NOT NULL,' + 
		'	UNIQUE(user_name)' +
		');'
		);

	//	:TODO: create FK on delete/etc.

	dbs.user.run(
		'CREATE TABLE IF NOT EXISTS user_property (' +
		'	user_id		INTEGER NOT NULL,' +
		'	prop_name	VARCHAR NOT NULL,' +
		'	prop_value	VARCHAR,' +
		'	UNIQUE(user_id, prop_name),' +
		'	FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE' + 
		');'
		);

	dbs.user.run(
		'CREATE TABLE IF NOT EXISTS user_group (' + 
		'	group_id	INTEGER PRIMARY KEY,' + 
		'	group_name	VARCHAR NOT NULL,' + 
		'	UNIQUE(group_name)' + 
		');'
		);

	dbs.user.run(
		'CREATE TABLE IF NOT EXISTS user_group_member (' + 
		'	group_id	INTEGER NOT NULL,' + 
		'	user_id		INTEGER NOT NULL,' +
		'	UNIQUE(group_id, user_id),' +
		'	FOREIGN KEY(group_id) REFERENCES user_group(group_id) ON DELETE CASCADE' +
		');'
		);
}

function createInitialValues() {
	dbs.user.run(
		'INSERT OR IGNORE INTO user_group ' + 
		'VALUES(1, "users");'
		);

	dbs.user.run(
		'INSERT OR IGNORE INTO user_group ' +
		'VALUES(2, "sysops");'
		);
}