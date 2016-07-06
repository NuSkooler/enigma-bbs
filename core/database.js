/* jslint node: true */
'use strict';

//	ENiGMA½
const conf			= require('./config.js');

//	deps
const sqlite3		= require('sqlite3');
const paths			= require('path');
const async			= require('async');
const _				= require('lodash');
const assert		= require('assert');

//	database handles
let dbs = {};

exports.getModDatabasePath			= getModDatabasePath;
exports.initializeDatabases			= initializeDatabases;

exports.dbs							= dbs;

function getDatabasePath(name) {
	return paths.join(conf.config.paths.db, `${name}.sqlite3`);
}

function getModDatabasePath(moduleInfo, suffix) {
	//
	//	Mods that use a database are stored in Config.paths.modsDb (e.g. enigma-bbs/db/mods)
	//	We expect that moduleInfo defines packageName which will be the base of the modules
	//	filename. An optional suffix may be supplied as well.
	//	
	const HOST_RE = /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$/;

	assert(_.isObject(moduleInfo));
	assert(_.isString(moduleInfo.packageName), 'moduleInfo must define "packageName"!');
	
	let full = moduleInfo.packageName;
	if(suffix) {
		full += `.${suffix}`;
	}

	assert(
		(full.split('.').length > 1 && HOST_RE.test(full)),
		'packageName must follow Reverse Domain Name Notation - https://en.wikipedia.org/wiki/Reverse_domain_name_notation');

	return paths.join(conf.config.paths.modsDb, `${full}.sqlite3`);
}

function initializeDatabases(cb) {
	async.series(
		[
			function systemDb(callback) {
				dbs.system	= new sqlite3.Database(getDatabasePath('system'), err => {
					if(err) {
						return callback(err);
					}
					
					dbs.system.serialize( () => {
						createSystemTables();
					});

					return callback(null);
				});				
			},
			function userDb(callback) {
				dbs.user = new sqlite3.Database(getDatabasePath('user'), err => {
					if(err) {						
						return callback(err);
					}

					dbs.user.serialize( () => {
						createUserTables();
						createInitialUserValues();
					});
					
					return callback(null);
				});
			},
			function messageDb(callback) {
				dbs.message	= new sqlite3.Database(getDatabasePath('message'), err => {
					if(err) {
						return callback(err);
					}


					dbs.message.serialize(function serialized() {
						createMessageBaseTables();
						createInitialMessageValues();
					});
					
					return callback(null);
				});
			}
		],
		cb
	);
}

function createSystemTables() {
	dbs.system.run(
		'CREATE TABLE IF NOT EXISTS system_property ('		+
		'	prop_name		VARCHAR PRIMARY KEY NOT NULL,'	+
		'	prop_value		VARCHAR NOT NULL'				+
		');'
		);

	//
	//	system_log can round log_timestamp for daily, monthly, etc.
	//	statistics as well as unique entries.
	//
/*
	dbs.system.run(
		'CREATE TABLE IF NOT EXISTS system_log ('					+
			'	log_timestamp	DATETIME PRIMARY KEY NOT NULL (	'	+
			'	log_name		VARCHARNOT NULL,'					+
			'	log_value		VARCHAR NOT NULL,'					+
			'	UNIQUE(log_timestamp, log_name)'					+
			');'
		);*/
}

function createUserTables() {
	dbs.user.run(
		`CREATE TABLE IF NOT EXISTS user ( 
			id			INTEGER PRIMARY KEY,
			user_name	VARCHAR NOT NULL, 
			UNIQUE(user_name)
		);`
	);

	//	:TODO: create FK on delete/etc.

	dbs.user.run(
		`CREATE TABLE IF NOT EXISTS user_property (
			user_id		INTEGER NOT NULL,
			prop_name	VARCHAR NOT NULL,
			prop_value	VARCHAR,
			UNIQUE(user_id, prop_name),
			FOREIGN KEY(user_id) REFERENCES user(id) ON DELETE CASCADE 
		);`
	);

	dbs.user.run(
		`CREATE TABLE IF NOT EXISTS user_group_member ( 
			group_name	VARCHAR NOT NULL, 
			user_id		INTEGER NOT NULL,
			UNIQUE(group_name, user_id)
		);`
	);

	dbs.user.run(
		`CREATE TABLE IF NOT EXISTS user_login_history (	
			user_id		INTEGER NOT NULL,
			user_name	VARCHAR NOT NULL,
			timestamp	DATETIME NOT NULL
		);`
	);
}

function createMessageBaseTables() {
	dbs.message.run(
		`CREATE TABLE IF NOT EXISTS message (
			message_id				INTEGER PRIMARY KEY, 
			area_tag				VARCHAR NOT NULL,
			message_uuid			VARCHAR(36) NOT NULL, 
			reply_to_message_id		INTEGER,
			to_user_name			VARCHAR NOT NULL,
			from_user_name			VARCHAR NOT NULL,
			subject, /* FTS @ message_fts */
			message, /* FTS @ message_fts */
			modified_timestamp		DATETIME NOT NULL,
			view_count				INTEGER NOT NULL DEFAULT 0,
			UNIQUE(message_uuid) 
		);`
	);

	dbs.message.run(
		`CREATE INDEX IF NOT EXISTS message_by_area_tag_index
		ON message (area_tag);`
	);

	dbs.message.run(
		`CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts4 (
			content="message",
			subject,
			message
		);`
	);

	dbs.message.run(
		`CREATE TRIGGER IF NOT EXISTS message_before_update BEFORE UPDATE ON message BEGIN
  			DELETE FROM message_fts WHERE docid=old.rowid;
		END;
		
		CREATE TRIGGER IF NOT EXISTS message_before_delete BEFORE DELETE ON message BEGIN
  			DELETE FROM message_fts WHERE docid=old.rowid;
		END;

		CREATE TRIGGER IF NOT EXISTS message_after_update AFTER UPDATE ON message BEGIN
			INSERT INTO message_fts(docid, subject, message) VALUES(new.rowid, new.subject, new.message);
		END;

		CREATE TRIGGER IF NOT EXISTS message_after_insert AFTER INSERT ON message BEGIN
			INSERT INTO message_fts(docid, subject, message) VALUES(new.rowid, new.subject, new.message);
		END;`
	);

	dbs.message.run(
		`CREATE TABLE IF NOT EXISTS message_meta (
			message_id		INTEGER NOT NULL,
			meta_category	INTEGER NOT NULL,
			meta_name		VARCHAR NOT NULL,
			meta_value		VARCHAR NOT NULL,
			UNIQUE(message_id, meta_category, meta_name, meta_value), 
			FOREIGN KEY(message_id) REFERENCES message(message_id) ON DELETE CASCADE
		);`
	);

	//	:TODO: need SQL to ensure cleaned up if delete from message?
	/*
	dbs.message.run(
		`CREATE TABLE IF NOT EXISTS hash_tag (
			hash_tag_id		INTEGER PRIMARY KEY,
			hash_tag_name	VARCHAR NOT NULL,
			UNIQUE(hash_tag_name)
		);`
	);

	//	:TODO: need SQL to ensure cleaned up if delete from message?
	dbs.message.run(
		`CREATE TABLE IF NOT EXISTS message_hash_tag (
			hash_tag_id	INTEGER NOT NULL,
			message_id	INTEGER NOT NULL,
		);`
	);
	*/

	dbs.message.run(
		`CREATE TABLE IF NOT EXISTS user_message_area_last_read (
			user_id		INTEGER NOT NULL,
			area_tag	VARCHAR NOT NULL,
			message_id	INTEGER NOT NULL,
			UNIQUE(user_id, area_tag)
		);`
	);
	
	dbs.message.run(
		`CREATE TABLE IF NOT EXISTS message_area_last_scan (
			scan_toss		VARCHAR NOT NULL,
			area_tag		VARCHAR NOT NULL,
			message_id		INTEGER NOT NULL,
			UNIQUE(scan_toss, area_tag)
		);`	
	);
}

function createInitialMessageValues() {
}

function createInitialUserValues() {
}