/* jslint node: true */
'use strict';

var conf			= require('./config.js');

var sqlite3			= require('sqlite3');
var paths			= require('path');
var async			= require('async');

//	database handles
var dbs = {};

exports.initializeDatabases			= initializeDatabases;

exports.dbs							= dbs;

function getDatabasePath(name) {
	return paths.join(conf.config.paths.db, name + '.sqlite3');
}

function initializeDatabases(cb) {
	//	:TODO: this will need to change if more DB's are added ... why?
	async.series(
		[
			function systemDb(callback) {
				dbs.system	= new sqlite3.Database(getDatabasePath('system'), function dbCreated(err) {
					if(err) {
						callback(err);
					} else {
						dbs.system.serialize(function serialized() {
							createSystemTables();
						});
						callback(null);
					}
				});				
			},
			function userDb(callback) {
				dbs.user = new sqlite3.Database(getDatabasePath('user'), function dbCreated(err) {
					if(err) {
						callback(err);
					} else {
						dbs.user.serialize(function serialized() {
							createUserTables();
							createInitialUserValues();
						});
						callback(null);
					}
				});
			},
			function messageDb(callback) {
				dbs.message	= new sqlite3.Database(getDatabasePath('message'), function dbCreated(err) {
					if(err) {
						callback(err);
					} else {
						dbs.message.serialize(function serialized() {
							createMessageBaseTables();
							createInitialMessageValues();
						});
						callback(null);
					}
				});
			}
		],
		cb
	);
}

function createSystemTables() {
	dbs.system.run(
		'CREATE TABLE IF NOT EXISTS system_property ('			+
		'	prop_name		VARCHAR PRIMARY KEY NOT NULL,'	+
		'	prop_value		VARCHAR NOT NULL'				+
		');'
		);
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
		'CREATE TABLE IF NOT EXISTS user_group_member (' + 
		'	group_name	VARCHAR NOT NULL,' + 
		'	user_id		INTEGER NOT NULL,' +
		'	UNIQUE(group_name, user_id)' +
		');'
		);

	dbs.user.run(
		'CREATE TABLE IF NOT EXISTS user_login_history ('	+
		'	user_id		INTEGER NOT NULL,'					+
		'	user_name	VARCHAR NOT NULL,'					+
		'	timestamp	DATETIME NOT NULL'					+
		');'
	);
}

function createMessageBaseTables() {
	dbs.message.run(
		'CREATE TABLE IF NOT EXISTS message ('						+
		'	message_id				INTEGER PRIMARY KEY,'			+ 
		'	area_name				VARCHAR NOT NULL,'				+
		'	message_uuid			VARCHAR(36) NOT NULL,'			+ 
		'	reply_to_message_id		INTEGER,'						+
		'	to_user_name			VARCHAR NOT NULL,'				+
		'	from_user_name			VARCHAR NOT NULL,'				+
		'	subject,'												+	//	FTS @ message_fts
		'	message,'												+ 	//	FTS @ message_fts
		'	modified_timestamp	DATETIME NOT NULL,'					+
		'	view_count				INTEGER NOT NULL DEFAULT 0,'	+
		'	UNIQUE(message_uuid)'									+ 
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
		'CREATE TRIGGER IF NOT EXISTS message_before_update BEFORE UPDATE ON message BEGIN'	+
  		'	DELETE FROM message_fts WHERE docid=old.rowid;'						+
		'END;'																	+
		'CREATE TRIGGER IF NOT EXISTS message_before_delete BEFORE DELETE ON message BEGIN'	+
  		'	DELETE FROM message_fts WHERE docid=old.rowid;'						+
		'END;'																	+
		''																		+
		'CREATE TRIGGER IF NOT EXISTS message_after_update AFTER UPDATE ON message BEGIN'		+
		'	INSERT INTO message_fts(docid, subject, message) VALUES(new.rowid, new.subject, new.message);'	+
		'END;'																	+
		'CREATE TRIGGER IF NOT EXISTS message_after_insert AFTER INSERT ON message BEGIN'		+
		'	INSERT INTO message_fts(docid, subject, message) VALUES(new.rowid, new.subject, new.message);'	+
		'END;'
	);

	dbs.message.run(
		'CREATE TABLE IF NOT EXISTS message_meta ('						+
		'	message_id		INTEGER NOT NULL,'							+
		'	meta_category	INTEGER NOT NULL,'							+
		'	meta_name		VARCHAR NOT NULL,'							+
		'	meta_value		VARCHAR NOT NULL,'							+
		'	UNIQUE(message_id, meta_category, meta_name, meta_value),'	+
		'	FOREIGN KEY(message_id) REFERENCES message(message_id)'		+
		');'
	);

	dbs.message.run(
		'CREATE TABLE IF NOT EXISTS hash_tag ('		+
		'	hash_tag_id		INTEGER PRIMARY KEY,'	+
		'	hash_tag_name	VARCHAR NOT NULL,'		+
		'	UNIQUE(hash_tag_name)'					+
		');'
	);

	dbs.message.run(
		'CREATE TABLE IF NOT EXISTS message_hash_tag ('	+
		'	hash_tag_id	INTEGER NOT NULL,'				+
		'	message_id	INTEGER NOT NULL'				+
		');'
	);

	dbs.message.run(
		'CREATE TABLE IF NOT EXISTS user_message_area_last_read ('	+
		'	user_id		INTEGER NOT NULL,'						+
		'	area_name	VARCHAR NOT NULL,'						+
		'	message_id	INTEGER NOT NULL,'						+
		'	UNIQUE(user_id, area_name)'				+
		');'
	);

	dbs.message.run(
		'CREATE TABLE IF NOT EXISTS user_message_status ('	+
		'	user_id		INTEGER NOT NULL,'					+
		'	message_id	INTEGER NOT NULL,'					+
		'	status		INTEGER NOT NULL,'					+
		'	UNIQUE(user_id, message_id, status),'			+
		'	FOREIGN KEY(user_id) REFERENCES user(id)'		+
		');'
	);
}

function createInitialMessageValues() {
}

function createInitialUserValues() {
}