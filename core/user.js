/* jslint node: true */
'use strict';

var crypto			= require('crypto');
var database		= require('./database.js');

exports.User					= User;

var PBKDF2_OPTIONS = {
	iterations	: 1000,
	keyLen		: 128,
	saltLen		: 32,
};

function User() {
	var self = this;

	this.id				= 0;
	this.userName		= '';
	this.groups			= [];
	this.permissions	= [];
	this.properties		= {};

/*
	this.load = function(userName, cb) {
		database.user.get('SELECT id FROM user WHERE user_name = $un LIMIT 1;', { un : userName }, function onUser(err, row) {
			if(err) {
				cb(err);
				return;
			}

			var user = new User();
			user.id = row.id;

			//	:TODO: load the rest.

			database.user.serialize(function loadUserSerialized() {
				database.user.each('SELECT prop_name, prop_value FROM user_property WHERE user_id = $uid;', { uid : user.id }, function onUserPropRow(err, propRow) {
					user.properties[propRow.prop_name] = propRow.prop_value;
				});
			});

			cb(null, user);
		});
	};*/
}

User.load = function(userName, cb) {
	database.user.get('SELECT id FROM user WHERE user_name = $un LIMIT 1;', { un : userName }, function onUser(err, row) {
		if(err) {
			cb(err);
			return;
		}

		var user = new User();
		user.id = row.id;

		//	:TODO: load the rest.

		database.user.serialize(function loadUserSerialized() {
			database.user.each('SELECT prop_name, prop_value FROM user_property WHERE user_id = $uid;', { uid : user.id }, function onUserPropRow(err, propRow) {
				user.properties[propRow.prop_name] = propRow.prop_value;
			});
		});

		cb(null, user);
	});
};

User.prototype.setPassword = function(password, cb) {
	//	:TODO: validate min len, etc. here?

	crypto.randomBytes(PBKDF2_OPTIONS.saltLen, function onRandomSalt(err, salt) {
		if(err) {
			cb(err);
			return;
		}

		password = Buffer.isBuffer(password) ? password : new Buffer(password, 'base64');

		crypto.pbkdf2(password, salt, PBKDF2_OPTIONS.iterations, PBKDF2_OPTIONS.keyLen, function onPbkdf2Generated(err, dk) {
			if(err) {
				cb(err);
				return;
			}

			cb(null, dk);

			this.properties['pw.pbkdf2.salt']	= salt;
			this.properties['pw.pbkdf2.dk']		= dk;
		});
	});
};