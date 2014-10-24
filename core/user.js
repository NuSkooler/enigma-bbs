/* jslint node: true */
'use strict';

var userDb			= require('./database.js').dbs.user;
var crypto			= require('crypto');
var assert			= require('assert');

exports.User						= User;
exports.getUserId					= getUserId;
exports.createNew					= createNew;
exports.generatePasswordDerivedKey	= generatePasswordDerivedKey;
exports.persistAll					= persistAll;

function User() {
	var self = this;

	this.id			= 0;
	this.userName	= '';

	this.isValid = function() {
		if(self.id <= 0 || self.userName.length < 2) {
			return false;
		}

		return this.hasValidPassword();
	};

	this.hasValidPassword = function() {
		if(!this.properties || !this.properties.pw_pbkdf2_salt || !this.properties.pw_pbkdf2_dk) {
			return false;
		}

		return this.properties.pw_pbkdf2_salt.length === User.PBKDF2.saltLen * 2 &&
			this.prop_name.pw_pbkdf2_dk.length === User.PBKDF2.keyLen * 2;
	};

	this.isRoot = function() {
		return 1 === this.id;
	};

	this.isSysOp = this.isRoot;	//	alias
}

User.PBKDF2 = {
	iterations	: 1000,
	keyLen		: 128,
	saltLen		: 32,
};

function getUserId(userName, cb) {
	userDb.get(
		'SELECT id ' +
		'FROM user ' +
		'WHERE user_name LIKE ?;',
		[ userName ],
		function onResults(err, row) {
			cb(err, row.id);
		}
	);
}

function createNew(user, cb) {
	assert(user.userName && user.userName.length > 1, 'Invalid userName');

	userDb.run(
		'INSERT INTO user (user_name) ' + 
		'VALUES (?);', 
		[ user.userName ], 
		function onUserInsert(err) {
			if(err) {
				cb(err);
			} else {
				user.id = this.lastID;

				//
				//	Allow converting user.password -> Salt/DK
				//
				if(user.password && user.password.length > 0) {
					generatePasswordDerivedKey(user.password, function onDkGenerated(err, dk) {
						user.properties = user.properties || {
							pw_pbkdf2_salt	: dk.salt,
							pw_pbkdf2_dk	: dk.dk,
						};

						persistAll(user, function onUserPersisted() {
							cb(null, user.id);
						});
					});
				} else {
					persistAll(user, function onUserPersisted() {
						cb(null, user.id);
					});
				}
			}
		}
	);
}

function generatePasswordDerivedKey(password, cb) {
	crypto.randomBytes(User.PBKDF2.saltLen, function onRandomSalt(err, salt) {
		if(err) {
			cb(err);
			return;
		}

		salt = salt.toString('hex');

		password = new Buffer(password).toString('hex');

		crypto.pbkdf2(password, salt, User.PBKDF2.iterations, User.PBKDF2.keyLen, function onDerivedKey(err, dk) {
			if(err) {
				cb(err);
			} else {
				cb(null, { dk : dk.toString('hex'), salt : salt } );
			}
		});
	});
}

function persistProperties(user, cb) {
	assert(user.id > 0);

	var stmt = userDb.prepare(
		'REPLACE INTO user_property (user_id, prop_name, prop_value) ' + 
		'VALUES (?, ?, ?);');

	Object.keys(user.properties).forEach(function onProp(name) {
		stmt.run(user.id, name, user.properties[name]);
	});

	stmt.finalize(function onFinalized() {
		if(cb) {
			cb();
		}
	});
}

function persistAll(user, cb) {
	assert(user.id > 0);

	userDb.serialize(function onSerialized() {
		userDb.run('BEGIN;');

		persistProperties(user);

		userDb.run('COMMIT;');
	});

	cb();
}