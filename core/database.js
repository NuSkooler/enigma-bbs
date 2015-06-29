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
	dbs.user	= new sqlite3.Database(getDatabasePath('user'));
	dbs.message	= new sqlite3.Database(getDatabasePath('message'));

	dbs.user.serialize(function serialized() {
		createUserTables();
		createInitialValues();
	});

	dbs.message.serialize(function serialized() {
		createMessageBaseTables();
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

function createMessageBaseTables() {
	dbs.message.run(
		'CREATE TABLE IF NOT EXISTS message ('		+
		'	message_id		INTEGER PRIMARY KEY,'	+ 
		'	area_id			INTEGER NOT NULL,'		+
		'	message_uuid	VARCHAR(36) NOT NULL,'	+ 
		'	reply_to_id		INTEGER,'				+
		'	to_user_name	VARCHAR NOT NULL,'		+
		'	from_user_name	VARCHAR NOT NULL,'		+
		'	subject,'								+	//	FTS @ message_fts
		'	message,'								+ 	//	FTS @ message_fts
		'	modified_timestamp	DATETIME NOT NULL,'	+
		'	UNIQUE(message_id, area_id),'			+
		'	UNIQUE(message_uuid)'					+ 
		');'
	);

	dbs.message.run(
		'CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts4 (' +
		'	content="message",' +
		'	subject,' +
		'	message' +
		');'
	);

	dbs.message.run(
		'CREATE TABLE IF NOT EXISTS message_meta (' +
		'	message_id	INTEGER NOT NULL,'	+
		'	meta_name	VARCHAR NOT NULL,'	+
		'	meta_value	VARCHAR NOT NULL,'	+
		'	UNIQUE(message_id, meta_name),' 	+
		'	FOREIGN KEY(message_id) REFERENCES message(message_id) ON DELETE CASCADE' +
		');'
	);

	dbs.message.run(
		'CREATE TABLE IF NOT EXISTS message_hash_tag (' +
		'	hash_tag	VARCHAR NOT NULL,' +
		'	message_id	INTEGER NOT NULL' +
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