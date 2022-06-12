/* jslint node: true */
'use strict';

//  ENiGMA½
const userDb = require('./database.js').dbs.user;
const Config = require('./config.js').get;
const userGroup = require('./user_group.js');
const { Errors, ErrorReasons } = require('./enig_error.js');
const Events = require('./events.js');
const UserProps = require('./user_property.js');
const Log = require('./logger.js').log;
const StatLog = require('./stat_log.js');

//  deps
const crypto = require('crypto');
const assert = require('assert');
const async = require('async');
const _ = require('lodash');
const moment = require('moment');
const sanatizeFilename = require('sanitize-filename');
const ssh2 = require('ssh2');

module.exports = class User {
    constructor() {
        this.userId = 0;
        this.username = '';
        this.properties = {}; //  name:value
        this.groups = []; //  group membership(s)
        this.authFactor = User.AuthFactors.None;
        this.statusFlags = User.StatusFlags.None;
    }

    //  static property accessors
    static get RootUserID() {
        return 1;
    }

    static get AuthFactors() {
        return {
            None: 0, //  Not yet authenticated in any way
            Factor1: 1, //  username + password/pubkey/etc. checked out
            Factor2: 2, //  validated with 2FA of some sort such as OTP
        };
    }

    static get PBKDF2() {
        return {
            iterations: 1000,
            keyLen: 128,
            saltLen: 32,
        };
    }

    static get StandardPropertyGroups() {
        return {
            auth: [
                UserProps.PassPbkdf2Salt,
                UserProps.PassPbkdf2Dk,
                UserProps.AuthPubKey,
            ],
        };
    }

    static get AccountStatus() {
        return {
            disabled: 0, //  +op disabled
            inactive: 1, //  inactive, aka requires +op approval/activation
            active: 2, //  standard, active
            locked: 3, //  locked out (too many bad login attempts, etc.)
        };
    }

    static get StatusFlags() {
        return {
            None: 0x00000000,
            NotAvailable: 0x00000001, //  Not currently available for chat, message, page, etc.
            NotVisible: 0x00000002, //  Invisible -- does not show online, last callers, etc.
        };
    }

    isAuthenticated() {
        return true === this.authenticated;
    }

    isValid() {
        if (this.userId <= 0 || this.username.length < Config().users.usernameMin) {
            return false;
        }

        return this.hasValidPasswordProperties();
    }

    hasValidPasswordProperties() {
        const salt = this.getProperty(UserProps.PassPbkdf2Salt);
        const dk = this.getProperty(UserProps.PassPbkdf2Dk);

        if (
            !salt ||
            !dk ||
            salt.length !== User.PBKDF2.saltLen * 2 ||
            dk.length !== User.PBKDF2.keyLen * 2
        ) {
            return false;
        }

        return true;
    }

    isRoot() {
        return User.isRootUserId(this.userId);
    }

    isSysOp() {
        //  alias to isRoot()
        return this.isRoot();
    }

    isGroupMember(groupNames) {
        if (_.isString(groupNames)) {
            groupNames = [groupNames];
        }

        const isMember = groupNames.some(gn => -1 !== this.groups.indexOf(gn));
        return isMember;
    }

    getSanitizedName(type = 'username') {
        const name =
            'real' === type ? this.getProperty(UserProps.RealName) : this.username;
        return sanatizeFilename(name) || `user${this.userId.toString()}`;
    }

    isAvailable() {
        return (this.statusFlags & User.StatusFlags.NotAvailable) == 0;
    }

    isVisible() {
        return (this.statusFlags & User.StatusFlags.NotVisible) == 0;
    }

    setAvailability(available) {
        if (available) {
            this.statusFlags &= ~User.StatusFlags.NotAvailable;
        } else {
            this.statusFlags |= User.StatusFlags.NotAvailable;
        }
    }

    setVisibility(visible) {
        if (visible) {
            this.statusFlags &= ~User.StatusFlags.NotVisible;
        } else {
            this.statusFlags |= User.StatusFlags.NotVisible;
        }
    }

    getLegacySecurityLevel() {
        if (this.isRoot() || this.isGroupMember('sysops')) {
            return 100;
        }

        if (this.isGroupMember('users')) {
            return 30;
        }

        return 10; //  :TODO: Is this what we want?
    }

    processFailedLogin(userId, cb) {
        async.waterfall(
            [
                callback => {
                    return User.getUser(userId, callback);
                },
                (tempUser, callback) => {
                    return StatLog.incrementUserStat(
                        tempUser,
                        UserProps.FailedLoginAttempts,
                        1,
                        (err, failedAttempts) => {
                            return callback(null, tempUser, failedAttempts);
                        }
                    );
                },
                (tempUser, failedAttempts, callback) => {
                    const lockAccount = _.get(Config(), 'users.failedLogin.lockAccount');
                    if (lockAccount > 0 && failedAttempts >= lockAccount) {
                        const props = {
                            [UserProps.AccountStatus]: User.AccountStatus.locked,
                            [UserProps.AccountLockedTs]: StatLog.now,
                        };
                        if (
                            !_.has(tempUser.properties, UserProps.AccountLockedPrevStatus)
                        ) {
                            props[UserProps.AccountLockedPrevStatus] =
                                tempUser.getProperty(UserProps.AccountStatus);
                        }
                        Log.info(
                            { userId, failedAttempts },
                            '(Re)setting account to locked due to failed logins'
                        );
                        return tempUser.persistProperties(props, callback);
                    }

                    return cb(null);
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    unlockAccount(cb) {
        const prevStatus = this.getProperty(UserProps.AccountLockedPrevStatus);
        if (!prevStatus) {
            return cb(null); //  nothing to do
        }

        this.persistProperty(UserProps.AccountStatus, prevStatus, err => {
            if (err) {
                return cb(err);
            }

            return this.removeProperties(
                [UserProps.AccountLockedPrevStatus, UserProps.AccountLockedTs],
                cb
            );
        });
    }

    static get AuthFactor1Types() {
        return {
            SSHPubKey: 'sshPubKey',
            Password: 'password',
            TLSClient: 'tlsClientAuth',
        };
    }

    authenticateFactor1(authInfo, cb) {
        const username = authInfo.username;
        const self = this;
        const tempAuthInfo = {};

        const validatePassword = (props, callback) => {
            User.generatePasswordDerivedKey(
                authInfo.password,
                props[UserProps.PassPbkdf2Salt],
                (err, dk) => {
                    if (err) {
                        return callback(err);
                    }

                    //
                    //  Use constant time comparison here for security feel-goods
                    //
                    const passDkBuf = Buffer.from(dk, 'hex');
                    const propsDkBuf = Buffer.from(props[UserProps.PassPbkdf2Dk], 'hex');

                    return callback(
                        crypto.timingSafeEqual(passDkBuf, propsDkBuf)
                            ? null
                            : Errors.AccessDenied('Invalid password')
                    );
                }
            );
        };

        const validatePubKey = (props, callback) => {
            const pubKeyActual = ssh2.utils.parseKey(props[UserProps.AuthPubKey]);
            if (!pubKeyActual) {
                return callback(Errors.AccessDenied('Invalid public key'));
            }

            if (
                authInfo.pubKey.key.algo != pubKeyActual.type ||
                !crypto.timingSafeEqual(
                    authInfo.pubKey.key.data,
                    pubKeyActual.getPublicSSH()
                )
            ) {
                return callback(Errors.AccessDenied('Invalid public key'));
            }

            return callback(null);
        };

        async.waterfall(
            [
                function fetchUserId(callback) {
                    //  get user ID
                    User.getUserIdAndName(username, (err, uid, un) => {
                        tempAuthInfo.userId = uid;
                        tempAuthInfo.username = un;

                        return callback(err);
                    });
                },
                function getRequiredAuthProperties(callback) {
                    //  fetch properties required for authentication
                    User.loadProperties(
                        tempAuthInfo.userId,
                        { names: User.StandardPropertyGroups.auth },
                        (err, props) => {
                            return callback(err, props);
                        }
                    );
                },
                function validatePassOrPubKey(props, callback) {
                    if (User.AuthFactor1Types.SSHPubKey === authInfo.type) {
                        return validatePubKey(props, callback);
                    }
                    return validatePassword(props, callback);
                },
                function initProps(callback) {
                    User.loadProperties(tempAuthInfo.userId, (err, allProps) => {
                        if (!err) {
                            tempAuthInfo.properties = allProps;
                        }

                        return callback(err);
                    });
                },
                function checkAccountStatus(callback) {
                    const accountStatus = parseInt(
                        tempAuthInfo.properties[UserProps.AccountStatus],
                        10
                    );
                    if (User.AccountStatus.disabled === accountStatus) {
                        return callback(
                            Errors.AccessDenied('Account disabled', ErrorReasons.Disabled)
                        );
                    }
                    if (User.AccountStatus.inactive === accountStatus) {
                        return callback(
                            Errors.AccessDenied('Account inactive', ErrorReasons.Inactive)
                        );
                    }

                    if (User.AccountStatus.locked === accountStatus) {
                        const autoUnlockMinutes = _.get(
                            Config(),
                            'users.failedLogin.autoUnlockMinutes'
                        );
                        const lockedTs = moment(
                            tempAuthInfo.properties[UserProps.AccountLockedTs]
                        );
                        if (autoUnlockMinutes && lockedTs.isValid()) {
                            const minutesSinceLocked = moment().diff(lockedTs, 'minutes');
                            if (minutesSinceLocked >= autoUnlockMinutes) {
                                //  allow the login - we will clear any lock there
                                Log.info(
                                    {
                                        username,
                                        userId: tempAuthInfo.userId,
                                        lockedAt: lockedTs.format(),
                                    },
                                    'Locked account will now be unlocked due to auto-unlock minutes policy'
                                );
                                return callback(null);
                            }
                        }
                        return callback(
                            Errors.AccessDenied('Account is locked', ErrorReasons.Locked)
                        );
                    }

                    //  anything else besides active is still not allowed
                    if (User.AccountStatus.active !== accountStatus) {
                        return callback(Errors.AccessDenied('Account is not active'));
                    }

                    return callback(null);
                },
                function initGroups(callback) {
                    userGroup.getGroupsForUser(tempAuthInfo.userId, (err, groups) => {
                        if (!err) {
                            tempAuthInfo.groups = groups;
                        }

                        return callback(err);
                    });
                },
            ],
            err => {
                if (err) {
                    //
                    //  If we failed login due to something besides an inactive or disabled account,
                    //  we need to update failure status and possibly lock the account.
                    //
                    //  If locked already, update the lock timestamp -- ie, extend the lockout period.
                    //
                    if (
                        ![ErrorReasons.Disabled, ErrorReasons.Inactive].includes(
                            err.reasonCode
                        ) &&
                        tempAuthInfo.userId
                    ) {
                        self.processFailedLogin(tempAuthInfo.userId, persistErr => {
                            if (persistErr) {
                                Log.warn(
                                    { error: persistErr.message },
                                    'Failed to persist failed login information'
                                );
                            }
                            return cb(err); //  pass along original error
                        });
                    } else {
                        return cb(err);
                    }
                } else {
                    //  everything checks out - load up info
                    self.userId = tempAuthInfo.userId;
                    self.username = tempAuthInfo.username;
                    self.properties = tempAuthInfo.properties;
                    self.groups = tempAuthInfo.groups;
                    self.authFactor = User.AuthFactors.Factor1;

                    //
                    //  If 2FA/OTP is required, this user is not quite authenticated yet.
                    //
                    self.authenticated = !(self.getProperty(UserProps.AuthFactor2OTP)
                        ? true
                        : false);

                    self.removeProperty(UserProps.FailedLoginAttempts);

                    //
                    //  We need to *revert* any locked status back to
                    //  the user's previous status & clean up props.
                    //
                    self.unlockAccount(unlockErr => {
                        if (unlockErr) {
                            Log.warn(
                                { error: unlockErr.message },
                                'Failed to unlock account'
                            );
                        }
                        return cb(null);
                    });
                }
            }
        );
    }

    create(createUserInfo, cb) {
        assert(0 === this.userId);
        const config = Config();

        if (
            this.username.length < config.users.usernameMin ||
            this.username.length > config.users.usernameMax
        ) {
            return cb(Errors.Invalid('Invalid username length'));
        }

        const self = this;

        //  :TODO: set various defaults, e.g. default activation status, etc.
        self.properties[UserProps.AccountStatus] = config.users.requireActivation
            ? User.AccountStatus.inactive
            : User.AccountStatus.active;

        async.waterfall(
            [
                function beginTransaction(callback) {
                    return userDb.beginTransaction(callback);
                },
                function createUserRec(trans, callback) {
                    trans.run(
                        `INSERT INTO user (user_name)
                        VALUES (?);`,
                        [self.username],
                        function inserted(err) {
                            //  use classic function for |this|
                            if (err) {
                                return callback(err);
                            }

                            self.userId = this.lastID;

                            //  Do not require activation for userId 1 (root/admin)
                            if (User.RootUserID === self.userId) {
                                self.properties[UserProps.AccountStatus] =
                                    User.AccountStatus.active;
                            }

                            return callback(null, trans);
                        }
                    );
                },
                function genAuthCredentials(trans, callback) {
                    User.generatePasswordDerivedKeyAndSalt(
                        createUserInfo.password,
                        (err, info) => {
                            if (err) {
                                return callback(err);
                            }

                            self.properties[UserProps.PassPbkdf2Salt] = info.salt;
                            self.properties[UserProps.PassPbkdf2Dk] = info.dk;
                            return callback(null, trans);
                        }
                    );
                },
                function setInitialGroupMembership(trans, callback) {
                    //  Assign initial groups. Must perform a clone: #235 - All users are sysops (and I can't un-sysop them)
                    self.groups = [...config.users.defaultGroups];

                    if (User.RootUserID === self.userId) {
                        //  root/SysOp?
                        self.groups.push('sysops');
                    }

                    return callback(null, trans);
                },
                function saveAll(trans, callback) {
                    self.persistWithTransaction(trans, err => {
                        return callback(err, trans);
                    });
                },
                function sendEvent(trans, callback) {
                    Events.emit(Events.getSystemEvents().NewUser, {
                        user: Object.assign({}, self, {
                            sessionId: createUserInfo.sessionId,
                        }),
                    });
                    return callback(null, trans);
                },
            ],
            (err, trans) => {
                if (trans) {
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
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    static persistPropertyByUserId(userId, propName, propValue, cb) {
        userDb.run(
            `REPLACE INTO user_property (user_id, prop_name, prop_value)
            VALUES (?, ?, ?);`,
            [userId, propName, propValue],
            err => {
                if (cb) {
                    return cb(err, propValue);
                }
            }
        );
    }

    setProperty(propName, propValue) {
        this.properties[propName] = propValue;
    }

    incrementProperty(propName, incrementBy) {
        incrementBy = incrementBy || 1;
        let newValue = parseInt(this.getProperty(propName));
        if (newValue) {
            newValue += incrementBy;
        } else {
            newValue = incrementBy;
        }
        this.setProperty(propName, newValue);
        return newValue;
    }

    getProperty(propName) {
        return this.properties[propName];
    }

    getPropertyAsNumber(propName) {
        return parseInt(this.getProperty(propName), 10);
    }

    persistProperty(propName, propValue, cb) {
        //  update live props
        this.properties[propName] = propValue;

        return User.persistPropertyByUserId(this.userId, propName, propValue, cb);
    }

    removeProperty(propName, cb) {
        //  update live
        delete this.properties[propName];

        userDb.run(
            `DELETE FROM user_property
            WHERE user_id = ? AND prop_name = ?;`,
            [this.userId, propName],
            err => {
                if (cb) {
                    return cb(err);
                }
            }
        );
    }

    removeProperties(propNames, cb) {
        async.each(
            propNames,
            (name, next) => {
                return this.removeProperty(name, next);
            },
            err => {
                if (cb) {
                    return cb(err);
                }
            }
        );
    }

    persistProperties(properties, transOrDb, cb) {
        if (!_.isFunction(cb) && _.isFunction(transOrDb)) {
            cb = transOrDb;
            transOrDb = userDb;
        }

        const self = this;

        //  update live props
        _.merge(this.properties, properties);

        const stmt = transOrDb.prepare(
            `REPLACE INTO user_property (user_id, prop_name, prop_value)
            VALUES (?, ?, ?);`
        );

        async.each(
            Object.keys(properties),
            (propName, nextProp) => {
                stmt.run(self.userId, propName, properties[propName], err => {
                    return nextProp(err);
                });
            },
            err => {
                if (err) {
                    return cb(err);
                }

                stmt.finalize(() => {
                    return cb(null);
                });
            }
        );
    }

    setNewAuthCredentials(password, cb) {
        User.generatePasswordDerivedKeyAndSalt(password, (err, info) => {
            if (err) {
                return cb(err);
            }

            const newProperties = {
                [UserProps.PassPbkdf2Salt]: info.salt,
                [UserProps.PassPbkdf2Dk]: info.dk,
            };

            this.persistProperties(newProperties, err => {
                return cb(err);
            });
        });
    }

    getAge() {
        const birthdate = this.getProperty(UserProps.Birthdate);
        if (birthdate) {
            return moment().diff(birthdate, 'years');
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
                },
            ],
            (err, userName, properties, groups) => {
                const user = new User();
                user.userId = userId;
                user.username = userName;
                user.properties = properties;
                user.groups = groups;

                //  explicitly NOT an authenticated user!
                user.authenticated = false;
                user.authFactor = User.AuthFactors.None;

                return cb(err, user);
            }
        );
    }

    static getUserInfo(userId, propsList, cb) {
        if (!cb && _.isFunction(propsList)) {
            cb = propsList;
            propsList = [
                UserProps.RealName,
                UserProps.Sex,
                UserProps.EmailAddress,
                UserProps.Location,
                UserProps.Affiliations,
            ];
        }

        async.waterfall(
            [
                callback => {
                    return User.getUserName(userId, callback);
                },
                (userName, callback) => {
                    User.loadProperties(userId, { names: propsList }, (err, props) => {
                        return callback(
                            err,
                            Object.assign({}, props, { user_name: userName })
                        );
                    });
                },
            ],
            (err, userProps) => {
                if (err) {
                    return cb(err);
                }

                const userInfo = {};
                Object.keys(userProps).forEach(key => {
                    userInfo[_.camelCase(key)] = userProps[key] || 'N/A';
                });

                return cb(null, userInfo);
            }
        );
    }

    static isRootUserId(userId) {
        return User.RootUserID === userId;
    }

    static getUserIdAndName(username, cb) {
        userDb.get(
            `SELECT id, user_name
            FROM user
            WHERE user_name LIKE ?;`,
            [username],
            (err, row) => {
                if (err) {
                    return cb(err);
                }

                if (row) {
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
                WHERE prop_name='${UserProps.RealName}' AND prop_value LIKE ?
            );`,
            [realName],
            (err, row) => {
                if (err) {
                    return cb(err);
                }

                if (row) {
                    return cb(null, row.id, row.user_name);
                }

                return cb(Errors.DoesNotExist('No matching real name'));
            }
        );
    }

    static getUserIdAndNameByLookup(lookup, cb) {
        User.getUserIdAndName(lookup, (err, userId, userName) => {
            if (err) {
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
            [userId],
            (err, row) => {
                if (err) {
                    return cb(err);
                }

                if (row) {
                    return cb(null, row.user_name);
                }

                return cb(Errors.DoesNotExist('No matching user ID'));
            }
        );
    }

    static loadProperties(userId, options, cb) {
        if (!cb && _.isFunction(options)) {
            cb = options;
            options = {};
        }

        let sql = `SELECT prop_name, prop_value
            FROM user_property
            WHERE user_id = ?`;

        if (options.names) {
            sql += ` AND prop_name IN("${options.names.join('","')}");`;
        } else {
            sql += ';';
        }

        let properties = {};
        userDb.each(
            sql,
            [userId],
            (err, row) => {
                if (err) {
                    return cb(err);
                }
                properties[row.prop_name] = row.prop_value;
            },
            err => {
                return cb(err, err ? null : properties);
            }
        );
    }

    //  :TODO: make this much more flexible - propValue should allow for case-insensitive compare, etc.
    static getUserIdsWithProperty(propName, propValue, cb) {
        let userIds = [];

        userDb.each(
            `SELECT user_id
            FROM user_property
            WHERE prop_name = ? AND prop_value = ?;`,
            [propName, propValue],
            (err, row) => {
                if (row) {
                    userIds.push(row.user_id);
                }
            },
            () => {
                return cb(null, userIds);
            }
        );
    }

    static getUserCount(cb) {
        userDb.get(
            `SELECT count() AS user_count
            FROM user;`,
            (err, row) => {
                if (err) {
                    return cb(err);
                }
                return cb(null, row.user_count);
            }
        );
    }

    static getUserList(options, cb) {
        const userList = [];

        options.properties = options.properties || [UserProps.RealName];

        const asList = [];
        const joinList = [];
        for (let i = 0; i < options.properties.length; ++i) {
            const dbProp = options.properties[i];
            const propName = options.propsCamelCase ? _.camelCase(dbProp) : dbProp;
            asList.push(`p${i}.prop_value AS ${propName}`);
            joinList.push(
                `LEFT OUTER JOIN user_property p${i} ON p${i}.user_id = u.id AND p${i}.prop_name = '${dbProp}'`
            );
        }

        userDb.each(
            `SELECT u.id as userId, u.user_name as userName, ${asList.join(', ')}
            FROM user u ${joinList.join(' ')}
            ORDER BY u.user_name;`,
            (err, row) => {
                if (err) {
                    return cb(err);
                }
                userList.push(row);
            },
            err => {
                return cb(err, userList);
            }
        );
    }

    static generatePasswordDerivedKeyAndSalt(password, cb) {
        async.waterfall(
            [
                function getSalt(callback) {
                    User.generatePasswordDerivedKeySalt((err, salt) => {
                        return callback(err, salt);
                    });
                },
                function getDk(salt, callback) {
                    User.generatePasswordDerivedKey(password, salt, (err, dk) => {
                        return callback(err, salt, dk);
                    });
                },
            ],
            (err, salt, dk) => {
                return cb(err, { salt: salt, dk: dk });
            }
        );
    }

    static generatePasswordDerivedKeySalt(cb) {
        crypto.randomBytes(User.PBKDF2.saltLen, (err, salt) => {
            if (err) {
                return cb(err);
            }
            return cb(null, salt.toString('hex'));
        });
    }

    static generatePasswordDerivedKey(password, salt, cb) {
        password = Buffer.from(password).toString('hex');

        crypto.pbkdf2(
            password,
            salt,
            User.PBKDF2.iterations,
            User.PBKDF2.keyLen,
            'sha1',
            (err, dk) => {
                if (err) {
                    return cb(err);
                }

                return cb(null, dk.toString('hex'));
            }
        );
    }
};
