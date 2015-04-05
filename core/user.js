/* jslint node: true */
'use strict';

var userDb			= require('./database.js').dbs.user;
var crypto			= require('crypto');
var assert			= require('assert');
var async			= require('async');

exports.User						= User;
exports.getUserId					= getUserId;
exports.createNew					= createNew;
exports.persistAll					= persistAll;
exports.authenticate				= authenticate;

function User() {
	var self = this;

	this.id			= 0;
	this.userName	= '';
	this.properties	= {};

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

User.StandardPropertyGroups = {
	password	: [ 'pw_pbkdf2_salt', 'pw_pbkdf2_dk' ],
};

function getUserId(userName, cb) {
	userDb.get(
		'SELECT id ' +
		'FROM user ' +
		'WHERE user_name LIKE ?;',
		[ userName ],
		function onResults(err, row) {
			if(err) {
				cb(err);
			} else {
				if(row) {
					cb(null, row.id);
				} else {
					cb(new Error('No matching user name'));
				}
			}
		}
	);
}

function createNew(user, cb) {
	assert(user.userName && user.userName.length > 1, 'Invalid userName');

	async.series(
		[
			function beginTransaction(callback) {
				userDb.run('BEGIN;', function onBegin(err) {
					callback(err);
				});
			},
			function createUserRec(callback) {
				userDb.run(
					'INSERT INTO user (user_name) ' +
					'VALUES (?);',
					[ user.userName ],
					function onUserInsert(err) {
						if(err) {
							callback(err);
						} else {
							user.id = this.lastID;
							callback(null);
						}
					}
				);
			},
			function genPasswordDkAndSaltIfRequired(callback) {
				if(user.password && user.password.length > 0) {
					generatePasswordDerivedKeyAndSalt(user.password, function onDkAndSalt(err, info) {
						if(err) {
							callback(err);
						} else {
							user.properties = user.properties || {};
							user.properties.pw_pbkdf2_salt	= info.salt;
							user.properties.pw_pbkdf2_dk	= info.dk;
							callback(null);
						}
					});					
				} else {
					callback(null);
				}
			},
			function saveAll(callback) {
				persistAll(user, false, function onPersisted(err) {
					callback(err);
				});				
			}
		],
		function onComplete(err) {								
			if(err) {
				var originalError = err;
				userDb.run('ROLLBACK;', function onRollback(err) {
					assert(!err);
					cb(originalError);
				});
			} else {
				userDb.run('COMMIT;', function onCommit(err) {
					if(err) {
						cb(err);
					} else {
						cb(null, user.id);
					}
				});
			}
		}
	);
}

function generatePasswordDerivedKeyAndSalt(password, cb) {
	async.waterfall(
		[
			function getSalt(callback) {
				generatePasswordDerivedKeySalt(function onSalt(err, salt) {
					callback(err, salt);
				});
			},
			function getDk(salt, callback) {
				generatePasswordDerivedKey(password, salt, function onDk(err, dk) {
					callback(err, salt, dk);
				});
			}
		],
		function onComplete(err, salt, dk) {
			cb(err, { salt : salt, dk : dk });
		}
	);
}

function generatePasswordDerivedKeySalt(cb) {
	crypto.randomBytes(User.PBKDF2.saltLen, function onRandSalt(err, salt) {
		if(err) {
			cb(err);
		} else {
			cb(null, salt.toString('hex'));
		}
	});
}

function generatePasswordDerivedKey(password, salt, cb) {
	password = new Buffer(password).toString('hex');
	crypto.pbkdf2(password, salt, User.PBKDF2.iterations, User.PBKDF2.keyLen, function onDerivedKey(err, dk) {
		if(err) {
			cb(err);
		} else {
			cb(null, dk.toString('hex'));
		}
	});
}

function persistProperties(user, cb) {
	assert(user.id > 0);

	var stmt = userDb.prepare(
		'REPLACE INTO user_property (user_id, prop_name, prop_value) ' + 
		'VALUES (?, ?, ?);');

	async.each(Object.keys(user.properties), function onProp(propName, callback) {
		stmt.run(user.id, propName, user.properties[propName], function onRun(err) {
			callback(err);
		});
	}, function onComplete(err) {
		if(err) {
			cb(err);
		} else {
			stmt.finalize(function onFinalized() {
				cb(null);
			});
		}
	});
}

function getProperties(userId, propNames, cb) {
	var properties = {};

	async.each(propNames, function onPropName(propName, next) {
		userDb.get(
			'SELECT prop_value ' +
			'FROM user_property ' + 
			'WHERE user_id = ? AND prop_name = ?;',
			[ userId, propName ], 
			function onRow(err, row) {
				if(err) {
					next(err);
				} else {
					if(row) {
						properties[propName] = row.prop_value;
						next();
					} else {
						next(new Error('No property "' + propName + '" for user ' + userId));
					}
				}
			}
		);
	}, function onCompleteOrError(err) {
		if(err) {
			cb(err);
		} else {
			cb(null, properties);
		}
	});
}

function persistAll(user, useTransaction, cb) {
	assert(user.id > 0);

	async.series(
		[
			function beginTransaction(callback) {
				if(useTransaction) {
					userDb.run('BEGIN;', function onBegin(err) {
						callback(err);
					});
				} else {
					callback(null);
				}
			},
			function saveProps(callback) {
				persistProperties(user, function onPropPersist(err) {
					callback(err);
				});
			}
		],
		function onComplete(err) {
			if(err) {
				if(useTransaction) {
					userDb.run('ROLLBACK;', function onRollback(err) {
						cb(err);
					});
				} else {
					cb(err);
				}
			} else {
				if(useTransaction) {
					userDb.run('COMMIT;', function onCommit(err) {
						cb(err);
					});
				} else {
					cb(null);
				}
			}
		}
	);
}

function authenticate(userName, password, client, cb) {
	assert(client);

	async.waterfall(
		[
			function fetchUserId(callback) {
				//	get user ID
				getUserId(userName, function onUserId(err, userId) {
					callback(err, userId);
				});
			},

			function getRequiredAuthProperties(userId, callback) {
				//	fetch properties required for authentication
				getProperties(userId, User.StandardPropertyGroups.password, function onProps(err, props) {
					callback(err, props);
				});
			},
			function getDkWithSalt(props, callback) {
				//	get DK from stored salt and password provided
				generatePasswordDerivedKey(password, props.pw_pbkdf2_salt, function onDk(err, dk) {
					callback(err, dk, props.pw_pbkdf2_dk);
				});
			}		
		],
		function validateAuth(err, passDk, propsDk) {
			if(err) {
				cb(err);
			} else {
				//
				//	Use constant time comparison here for security feel-goods
				//
				var passDkBuf	= new Buffer(passDk, 'hex');
				var propsDkBuf	= new Buffer(propsDk, 'hex');

				if(passDkBuf.length !== propsDkBuf.length) {
					cb(false);
					return;
				}

				var c = 0;
				for(var i = 0; i < passDkBuf.length; i++) {
					c |= passDkBuf[i] ^ propsDkBuf[i];
				}

				cb(0 === c ? null : new Error('Invalid password'));
			}
		}
	);
}