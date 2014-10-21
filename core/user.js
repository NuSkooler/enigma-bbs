/* jslint node: true */
'use strict';

var crypto			= require('crypto');
var assert			= require('assert');
//var database		= require('./database.js');

var userDb			= require('./database.js').dbs.user;

exports.User					= User;

var PBKDF2 = {
	iterations	: 1000,
	keyLen		: 128,
	saltLen		: 32,
};

var UserErrorCodes = Object.freeze({
	NONE				: 'No error',
	INVALID_USER		: 'Invalid user',
	INVALID_PASSWORD	: 'Invalid password',
});

function User() {
	var self = this;
	
	this.id				= 0;
	this.userName		= '';
	this.groups			= [];
	this.permissions	= [];
	this.properties		= {};


}

User.generatePasswordDerivedKey = function(password, cb) {
	crypto.randomBytes(PBKDF2.saltLen, function onRandomSalt(err, salt) {
		if(err) {
			cb(err);
			return;
		}

		salt = salt.toString('hex');

		password = new Buffer(password).toString('hex');

		crypto.pbkdf2(password, salt, PBKDF2.iterations, PBKDF2.keyLen, function onDerivedKey(err, dk) {
			if(err) {
				cb(err);
				return;
			}

			cb(null, { dk : dk.toString('hex'), salt : salt });
		});
	});
};

//
//	:TODO: createNewUser(userName, password, groups)

User.addNew = function(user, cb) {
	userDb.run('INSERT INTO user (user_name) VALUES(?);', [ user.userName ], function onUserInsert(err) {
		if(err) {
			cb(err);
			return;
		}

		user.id = this.lastID;
		user.persist(cb);
	});
};

User.prototype.persist = function(cb) {
	var self = this;

	if(0 === this.id || 0 === this.userName.length) {
		cb(new Error(UserErrorCodes.INVALID_USER));
		return;
	}

	userDb.serialize(function onSerialized() {
		userDb.run('BEGIN;');

		//	:TODO: Create persistProperties(id, {props})
		var stmt = userDb.prepare('REPLACE INTO user_property (user_id, prop_name, prop_value) VALUES(?, ?, ?);');
		Object.keys(self.properties).forEach(function onPropName(propName) {
			stmt.run(self.id, propName, self.properties[propName]);
		});

		stmt.finalize(function onFinalized() {
			userDb.run('COMMIT;');
			cb(null, self.id);
		});
	});
};

//	:TODO: make standalone function(password, dk, salt)
User.prototype.validatePassword = function(password, cb) {
	assert(this.properties.pw_pbkdf2_salt);
	assert(this.properties.pw_pbkdf2_dk);

	var self = this;

	password = new Buffer(password).toString('hex');

	crypto.pbkdf2(password, this.properties.pw_pbkdf2_salt, PBKDF2.iterations, PBKDF2.keyLen, function onDerivedKey(err, dk) {
		if(err) {
			cb(err);
			return;
		}

		//	Constant time compare
		var propDk = new Buffer(self.properties.pw_pbkdf2_dk, 'hex');

		console.log(propDk);
		console.log(dk);

		if(propDk.length !== dk.length) {
			cb(new Error('Unexpected buffer length'));
			return;
		}

		var c = 0;
		for(var i = 0; i < dk.length; i++) {
			c |= propDk[i] ^ dk[i];
		}
		cb(null, c === 0);
	});
};

//	:TODO: make this something like getUserProperties(id, [propNames], cb)
function getUserDerivedKeyAndSalt(id, cb) {
	var properties = {};
	userDb.each(
		'SELECT prop_name, prop_value ' +
		'FROM user_property ' +
		'WHERE user_id = ? AND prop_name="pw_pbkdf2_salt" OR prop_name="pw_pbkdf2_dk";', 
		[ id ], 
		function onPwPropRow(err, propRow) {
			if(err) {
				cb(err);
			} else {
				properties[propRow.prop_name] = propRow.prop_value;
			}
		}, 
		function onComplete() {
			cb(null, properties);
		}
	);
}

User.loadWithCredentials = function(userName, password, cb) {
	userDb.get('SELECT id, user_name FROM user WHERE user_name LIKE ? LIMIT 1;"', [ userName ], function onUserIds(err, userRow) {
		if(err) {
			cb(err);
			return;
		}

		if(!userRow) {
			cb(new Error(UserErrorCodes.INVALID_USER));
			return;
		}

		//	Load dk & salt properties for password validation
		getUserDerivedKeyAndSalt(userRow.id, function onDkAndSalt(err, props) {
			var user		= new User();
			user.properties = props;
			
			user.validatePassword(password, function onValidatePw(err, isCorrect) {
				if(err) {
					cb(err);
					return;
				}

				if(!isCorrect) {
					cb(new Error(UserErrorCodes.INVALID_PASSWORD));
					return;
				}

				//	userName and password OK -- load the rest.
				
				user.id			= userRow.id;
				user.userName	= userRow.user_name;

				cb(null, user);
			});
		});
	});
};

User.prototype.setPassword = function(password, cb) {
	//	:TODO: validate min len, etc. here?

	crypto.randomBytes(PBKDF2.saltLen, function onRandomSalt(err, salt) {
		if(err) {
			cb(err);
			return;
		}

		password = Buffer.isBuffer(password) ? password : new Buffer(password, 'hex');

		crypto.pbkdf2(password, salt, PBKDF2.iterations, PBKDF2.keyLen, function onPbkdf2Generated(err, dk) {
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