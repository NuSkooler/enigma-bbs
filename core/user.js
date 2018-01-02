/* jslint node: true */
'use strict';

const userDb		= require('./database.js').dbs.user;
const Config		= require('./config.js').config;
const userGroup		= require('./user_group.js');
const Errors		= require('./enig_error.js').Errors;

//	deps
const crypto		= require('crypto');
const assert		= require('assert');
const async			= require('async');
const _				= require('lodash');
const moment		= require('moment');

exports.isRootUserId = function(id) { return 1 === id; };

module.exports = class User {
	constructor() {
		this.userId		= 0;
		this.username	= '';
		this.properties	= {};	//	name:value
		this.groups		= [];	//	group membership(s)
	}

	//	static property accessors
	static get RootUserID() {
		return 1;
	}

	static get PBKDF2() {
		return {
			iterations	: 1000,
			keyLen		: 128,
			saltLen		: 32,
		};
	}

	static get StandardPropertyGroups() {
		return {
			password	: [ 'pw_pbkdf2_salt', 'pw_pbkdf2_dk' ],
		};
	}

	static get AccountStatus() {
		return {
			disabled	: 0,
			inactive	: 1,
			active		: 2,
		};
	}
	
	isAuthenticated() {
		return true === this.authenticated;
	}

	isValid() {
		if(this.userId <= 0 || this.username.length < Config.users.usernameMin) {
			return false;
		}

		return this.hasValidPassword();
	}

	hasValidPassword() {
		if(!this.properties || !this.properties.pw_pbkdf2_salt || !this.properties.pw_pbkdf2_dk) {
			return false;
		}

		return this.properties.pw_pbkdf2_salt.length === User.PBKDF2.saltLen * 2 && this.prop_name.pw_pbkdf2_dk.length === User.PBKDF2.keyLen * 2;
	}

	isRoot() {
		return User.isRootUserId(this.userId);
	}

	isSysOp() {	//	alias to isRoot()
		return this.isRoot();
	}

	isGroupMember(groupNames) {
		if(_.isString(groupNames)) {
			groupNames = [ groupNames ];
		}

		const isMember = groupNames.some(gn => (-1 !== this.groups.indexOf(gn))); 
		return isMember;
	}

	getLegacySecurityLevel() {
		if(this.isRoot() || this.isGroupMember('sysops')) {
			return 100;
		}
		
		if(this.isGroupMember('users')) {
			return 30;
		}
		
		return 10;	//	:TODO: Is this what we want?
	}

	authenticate(username, password, cb) {
		const self = this;
		const cachedInfo = {};

		async.waterfall(
			[
				function fetchUserId(callback) {
					//	get user ID
					User.getUserIdAndName(username, (err, uid, un) => {
						cachedInfo.userId	= uid;
						cachedInfo.username	= un;

						return callback(err);
					});
				},
				function getRequiredAuthProperties(callback) {
					//	fetch properties required for authentication
					User.loadProperties(cachedInfo.userId, { names : User.StandardPropertyGroups.password }, (err, props) => {
						return callback(err, props);
					});
				},
				function getDkWithSalt(props, callback) {
					//	get DK from stored salt and password provided
					User.generatePasswordDerivedKey(password, props.pw_pbkdf2_salt, (err, dk) => {
						return callback(err, dk, props.pw_pbkdf2_dk);
					});
				},
				function validateAuth(passDk, propsDk, callback) {
					//
					//	Use constant time comparison here for security feel-goods
					//
					const passDkBuf		= new Buffer(passDk,	'hex');
					const propsDkBuf	= new Buffer(propsDk,	'hex');

					if(passDkBuf.length !== propsDkBuf.length) {
						return callback(Errors.AccessDenied('Invalid password'));
					}

					let c = 0;
					for(let i = 0; i < passDkBuf.length; i++) {
						c |= passDkBuf[i] ^ propsDkBuf[i];
					}

					return callback(0 === c ? null : Errors.AccessDenied('Invalid password'));
				},
				function initProps(callback) {
					User.loadProperties(cachedInfo.userId, (err, allProps) => {
						if(!err) {
							cachedInfo.properties = allProps;
						}

						return callback(err);
					});
				},
				function initGroups(callback) {
					userGroup.getGroupsForUser(cachedInfo.userId, (err, groups) => {
						if(!err) {
							cachedInfo.groups = groups;
						}

						return callback(err);
					});
				}
			],
			err => {
				if(!err) {
					self.userId			= cachedInfo.userId;
					self.username		= cachedInfo.username;
					self.properties		= cachedInfo.properties;
					self.groups			= cachedInfo.groups;
					self.authenticated	= true;
				}

				return cb(err);
			}
		);
	}

	create(password, cb) {
		assert(0 === this.userId);

		if(this.username.length < Config.users.usernameMin || this.username.length > Config.users.usernameMax) {
			return cb(Errors.Invalid('Invalid username length'));
		}

		const self = this;

		//	:TODO: set various defaults, e.g. default activation status, etc.
		self.properties.account_status = Config.users.requireActivation ? User.AccountStatus.inactive : User.AccountStatus.active;

		async.waterfall(
			[
				function beginTransaction(callback) {
					return userDb.beginTransaction(callback);
				},
				function createUserRec(trans, callback) {
					trans.run(
						`INSERT INTO user (user_name)
						VALUES (?);`,
						[ self.username ],
						function inserted(err) {	//	use classic function for |this|
							if(err) {
								return callback(err);
							}
							
							self.userId = this.lastID;

							//	Do not require activation for userId 1 (root/admin)
							if(User.RootUserID === self.userId) {
								self.properties.account_status = User.AccountStatus.active;
							}
							
							return callback(null, trans);
						}
					);
				},
				function genAuthCredentials(trans, callback) {
					User.generatePasswordDerivedKeyAndSalt(password, (err, info) => {
						if(err) {
							return callback(err);
						}
						
						self.properties.pw_pbkdf2_salt	= info.salt;
						self.properties.pw_pbkdf2_dk	= info.dk;
						return callback(null, trans);
					});
				},
				function setInitialGroupMembership(trans, callback) {
					self.groups = Config.users.defaultGroups;

					if(User.RootUserID === self.userId) {	//	root/SysOp?
						self.groups.push('sysops');
					}

					return callback(null, trans);
				},
				function saveAll(trans, callback) {
					self.persistWithTransaction(trans, err => {
						return callback(err, trans);
					});
				}
			],
			(err, trans) => {
				if(trans) {
					trans[err ? 'rollback' : 'commit'](transErr => {
						return cb(err ? err : transErr);
					});
				} else {
					return cb(err);
				}
			}
		);
	}

	persistWithTransaction(trans, cb) {
		assert(this.userId > 0);

		const self = this;

		async.series(
			[
				function saveProps(callback) {
					self.persistProperties(self.properties, trans, err => {
						return callback(err);
					});
				},
				function saveGroups(callback) {
					userGroup.addUserToGroups(self.userId, self.groups, trans, err => {
						return callback(err);
					});
				}
			],
			err => {
				return cb(err);
			}
		);
	}

	persistProperty(propName, propValue, cb) {
		//	update live props
		this.properties[propName] = propValue;

		userDb.run(
			`REPLACE INTO user_property (user_id, prop_name, prop_value)
			VALUES (?, ?, ?);`, 
			[ this.userId, propName, propValue ], 
			err => {
				if(cb) {
					return cb(err);
				}
			}
		);
	}

	removeProperty(propName, cb) {
		//	update live
		delete this.properties[propName];

		userDb.run(
			`DELETE FROM user_property
			WHERE user_id = ? AND prop_name = ?;`,
			[ this.userId, propName ],
			err => {
				if(cb) {
					return cb(err);
				}
			}
		);
	}

	persistProperties(properties, transOrDb, cb) {
		if(!_.isFunction(cb) && _.isFunction(transOrDb)) {
			cb = transOrDb;
			transOrDb = userDb;
		}

		const self = this;

		//	update live props
		_.merge(this.properties, properties);

		const stmt = transOrDb.prepare(
			`REPLACE INTO user_property (user_id, prop_name, prop_value)
			VALUES (?, ?, ?);`
		);

		async.each(Object.keys(properties), (propName, nextProp) => {
			stmt.run(self.userId, propName, properties[propName], err => {
				return nextProp(err);
			});
		},
		err => {
			if(err) {
				return cb(err);
			}
			
			stmt.finalize( () => {
				return cb(null);
			});
		});
	}

	setNewAuthCredentials(password, cb) {
		User.generatePasswordDerivedKeyAndSalt(password, (err, info) => {
			if(err) {
				return cb(err);
			}
			
			const newProperties = {
				pw_pbkdf2_salt	: info.salt,
				pw_pbkdf2_dk	: info.dk,
			};

			this.persistProperties(newProperties, err => {
				return cb(err);
			});
		});
	}

	getAge() {
		if(_.has(this.properties, 'birthdate')) {
			return moment().diff(this.properties.birthdate, 'years');
		}
	}

	static getUser(userId, cb) {
		async.waterfall(
			[
				function fetchUserId(callback) {
					User.getUserName(userId, (err, userName) => {
						return callback(null, userName);
					});
				},
				function initProps(userName, callback) {
					User.loadProperties(userId, (err, properties) => {
						return callback(err, userName, properties);
					});
				},
				function initGroups(userName, properties, callback) {
					userGroup.getGroupsForUser(userId, (err, groups) => {
						return callback(null, userName, properties, groups);
					});
				}
			],
			(err, userName, properties, groups) => {
				const user = new User();
				user.userId			= userId;
				user.username		= userName;
				user.properties		= properties;
				user.groups			= groups;
				user.authenticated	= false;	//	this is NOT an authenticated user!

				return cb(err, user);
			}
		);
	}
	
	static isRootUserId(userId) {
		return (User.RootUserID === userId);
	}

	static getUserIdAndName(username, cb) {
		userDb.get(
			`SELECT id, user_name
			FROM user
			WHERE user_name LIKE ?;`,
			[ username ],
			(err, row) => {
				if(err) {
					return cb(err);
				}

				if(row) {
					return cb(null, row.id, row.user_name);
				}

				return cb(Errors.DoesNotExist('No matching username'));
			}
		);
	}

	static getUserIdAndNameByRealName(realName, cb) {
		userDb.get(
			`SELECT id, user_name
			FROM user
			WHERE id = (
				SELECT user_id
				FROM user_property
				WHERE prop_name='real_name' AND prop_value=?
			);`,
			[ realName ],
			(err, row) => {
				if(err) {
					return cb(err);
				}

				if(row) {
					return cb(null, row.id, row.user_name);
				}

				return cb(Errors.DoesNotExist('No matching real name'));
			}
		);
	}

	static getUserIdAndNameByLookup(lookup, cb) {
		User.getUserIdAndName(lookup, (err, userId, userName) => {
			if(err) {
				User.getUserIdAndNameByRealName(lookup, (err, userId, userName) => {
					return cb(err, userId, userName);
				});
			} else {
				return cb(null, userId, userName);
			}
		});
	}

	static getUserName(userId, cb) {
		userDb.get(
			`SELECT user_name
			FROM user
			WHERE id = ?;`,
			[ userId ],
			(err, row) => {
				if(err) {
					return cb(err);
				}
				
				if(row) {
					return cb(null, row.user_name);
				}
				
				return cb(Errors.DoesNotExist('No matching user ID'));
			}
		);
	}

	static loadProperties(userId, options, cb) {
		if(!cb && _.isFunction(options)) {
			cb = options;
			options = {};
		}

		let sql =
			`SELECT prop_name, prop_value
			FROM user_property
			WHERE user_id = ?`;

		if(options.names) {
			sql += ` AND prop_name IN("${options.names.join('","')}");`;
		} else {
			sql += ';';
		}

		let properties = {};
		userDb.each(sql, [ userId ], (err, row) => {
			if(err) {
				return cb(err);
			}
			properties[row.prop_name] = row.prop_value;			
		}, (err) => {
			return cb(err, err ? null : properties);
		});
	}

	//	:TODO: make this much more flexible - propValue should allow for case-insensitive compare, etc.
	static getUserIdsWithProperty(propName, propValue, cb) {
		let userIds = [];

		userDb.each(
			`SELECT user_id
			FROM user_property
			WHERE prop_name = ? AND prop_value = ?;`,
			[ propName, propValue ], 
			(err, row) => {
				if(row) {
					userIds.push(row.user_id);
				}
			}, 
			() => {
				return cb(null, userIds);
			}
		);
	}

	static getUserList(options, cb) {
		let userList = [];
		let orderClause = 'ORDER BY ' + (options.order || 'user_name');

		userDb.each(
			`SELECT id, user_name
			FROM user
			${orderClause};`,
			(err, row) => {
				if(row) {
					userList.push({
						userId		: row.id,
						userName	: row.user_name,
					});
				}
			},
			() => {
				options.properties = options.properties || [];
				async.map(userList, (user, nextUser) => {
					userDb.each(
						`SELECT prop_name, prop_value
						FROM user_property
						WHERE user_id = ? AND prop_name IN ("${options.properties.join('","')}");`,
						[ user.userId ],
						(err, row) => {
							if(row) {
								user[row.prop_name] = row.prop_value;
							}
						},
						err => {
							return nextUser(err, user);
						}
					);
				}, 
				(err, transformed) => {
					return cb(err, transformed);
				});
			}
		);
	}

	static generatePasswordDerivedKeyAndSalt(password, cb) {
		async.waterfall(
			[
				function getSalt(callback) {
					User.generatePasswordDerivedKeySalt( (err, salt) => {
						return callback(err, salt);
					});
				},
				function getDk(salt, callback) {
					User.generatePasswordDerivedKey(password, salt, (err, dk) => {
						return callback(err, salt, dk);
					});
				}
			],
			(err, salt, dk) => {
				return cb(err, { salt : salt, dk : dk } );
			}
		);
	}

	static generatePasswordDerivedKeySalt(cb) {
		crypto.randomBytes(User.PBKDF2.saltLen, (err, salt) => {
			if(err) {
				return cb(err);
			}
			return cb(null, salt.toString('hex'));
		});
	}

	static generatePasswordDerivedKey(password, salt, cb) {	
		password = new Buffer(password).toString('hex');

		crypto.pbkdf2(password, salt, User.PBKDF2.iterations, User.PBKDF2.keyLen, 'sha1', (err, dk) => {
			if(err) {
				return cb(err);
			}
			
			return cb(null, dk.toString('hex'));
		});
	}
};
