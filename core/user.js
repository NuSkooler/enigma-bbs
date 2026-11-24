/* jslint node: true */
'use strict';

//  ENiGMA½
const userDb = require('./database.js').dbs.user;
const { coerceToText } = require('./database.js');
const Config = require('./config.js').get;
const userGroup = require('./user_group.js');
const { Errors, ErrorReasons } = require('./enig_error.js');
const Events = require('./events.js');
const UserProps = require('./user_property.js');
const Log = require('./logger.js').log;
const StatLog = require('./stat_log.js');
const { generateActorKeyPair } = require('./activitypub/key_pair.js');

//  deps
const crypto = require('crypto');
const assert = require('assert');
const async = require('async');
const _ = require('lodash');
const moment = require('moment');
const sanatizeFilename = require('sanitize-filename');
const ssh2 = require('ssh2');
const AvatarGenerator = require('avatar-generator');
const paths = require('path');
const fse = require('fs-extra');

//  what decides whether an account is locked, and whether a lock runs out
const LockPropertyNames = [
    UserProps.AccountStatus,
    UserProps.AccountLockedTs,
    UserProps.AccountLockedPrevStatus,
    UserProps.FailedLoginAttempts,
];

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
            iterations: 210000,
            digest: 'sha512',
            keyLen: 64,
            saltLen: 32,
        };
    }

    //  Params used by hashes created before PassHashParams was stored.
    //  Absence of PassHashParams on a user record implies these values.
    static get LegacyPBKDF2() {
        return {
            iterations: 1000,
            digest: 'sha1',
            keyLen: 128,
            saltLen: 32,
        };
    }

    static get StandardPropertyGroups() {
        return {
            auth: [
                UserProps.PassPbkdf2Salt,
                UserProps.PassPbkdf2Dk,
                UserProps.SSHPubKey,
                UserProps.PassHashParams,
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
        //  Lengths are intentionally not checked against the current PBKDF2
        //  target here — legacy hashes use a different keyLen and would fail
        //  that assertion. The actual key lengths are validated at auth time
        //  using the per-user PassHashParams.
        return !!(salt && dk && salt.length > 0 && dk.length > 0);
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

    realName(withUsernameFallback = true) {
        const realName = this.getProperty(UserProps.RealName);
        if (realName) {
            return realName;
        }
        if (withUsernameFallback) {
            return this.username;
        }
    }

    getSanitizedName(type = 'username') {
        const name = 'real' === type ? this.realName(true) : this.username;
        return sanatizeFilename(name) || `user${this.userId.toString()}`;
    }

    emailAddress() {
        const email = this.getProperty(UserProps.EmailAddress);
        if (email) {
            const realName = this.realName(false);
            return realName ? `${realName} <${email}>` : email;
        }
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

    //
    //  A failed login for |userId|: count it, and lock the account once
    //  users.failedLogin.lockAccount is reached. Only an active account is
    //  locked; a disabled or inactive one keeps its status (it cannot log in
    //  anyway, and an unlock would otherwise "restore" it to active).
    //
    //  An account already locked only gets here once its lock has run out
    //  (one in force refuses before the password is checked; see
    //  authenticateFactor1()): the lock starts again from now, so guessing
    //  stays limited.
    //
    //  The UserStatIncrement event for the count is sent once it is stored
    //  (the transaction has committed), and not at all if it is not: a
    //  listener runs outside the transaction, so what it does (or throws)
    //  cannot undo the count, nor be undone with it.
    //
    processFailedLogin(userId, cb) {
        let statEventInfo;
        const afterCommit = err => {
            //  committed: the count is stored, so the event may go
            if (!err && statEventInfo) {
                try {
                    StatLog.emitUserStatIncrement(statEventInfo);
                } catch (e) {
                    Log.warn(
                        { error: e.message, userId },
                        'A failed login stat event listener threw'
                    );
                }
            }
            return cb(err);
        };

        return User.inLockTransaction(cb => {
            async.waterfall(
                [
                    callback => {
                        //  as stored now: other logins may have just counted, or
                        //  locked the account
                        return User.getUser(userId, callback);
                    },
                    (tempUser, callback) => {
                        //  a lock in force: nothing more to count, nor to move
                        if (
                            User.LockState.InForce ===
                            User.getLockState(tempUser.properties)
                        ) {
                            return callback(null, tempUser, null);
                        }
                        return StatLog.incrementUserStatWithOptions(
                            tempUser,
                            UserProps.FailedLoginAttempts,
                            1,
                            { noEvent: true },
                            (err, failedAttempts, eventInfo) => {
                                statEventInfo = eventInfo;
                                return callback(err, tempUser, failedAttempts);
                            }
                        );
                    },
                    (tempUser, failedAttempts, callback) => {
                        const lockAccount = _.get(
                            Config(),
                            'users.failedLogin.lockAccount'
                        );
                        if (!(lockAccount > 0) || null === failedAttempts) {
                            return callback(null);
                        }

                        const status = tempUser.getPropertyAsNumber(
                            UserProps.AccountStatus
                        );
                        if (User.AccountStatus.locked === status) {
                            //  only a lock that has run out gets here
                            Log.info(
                                { userId, failedAttempts },
                                'Locking account again due to a failed login after its lock ran out'
                            );
                            return tempUser.persistProperty(
                                UserProps.AccountLockedTs,
                                StatLog.now,
                                callback
                            );
                        }
                        if (
                            User.AccountStatus.active !== status ||
                            !(failedAttempts >= lockAccount)
                        ) {
                            return callback(null);
                        }

                        Log.info(
                            { userId, failedAttempts },
                            'Locking account due to failed logins'
                        );
                        return tempUser.persistProperties(
                            {
                                [UserProps.AccountStatus]: User.AccountStatus.locked,
                                [UserProps.AccountLockedTs]: StatLog.now,
                                [UserProps.AccountLockedPrevStatus]: status,
                            },
                            callback
                        );
                    },
                ],
                err => {
                    return cb(err);
                }
            );
        }, afterCommit);
    }

    //
    //  A status set by a sysop (oputil 'user activate', 'lock', ...). Activating
    //  clears any lock and the failed login count. Any other status sticks: a
    //  lock left from failed logins is dropped with it, so a sysop's lock does
    //  not run out (autoUnlockMinutes) nor go with a password reset, and a
    //  status they set over a lock is not "restored" away.
    //
    setAccountStatusBySysop(status, cb) {
        return User.inLockTransaction(
            cb => this._setAccountStatusBySysop(status, cb),
            cb
        );
    }

    _setAccountStatusBySysop(status, cb) {
        this.persistProperty(UserProps.AccountStatus, status, err => {
            if (err) {
                return cb(err);
            }

            if (User.AccountStatus.active === status) {
                return this.unlockAccount(err => {
                    if (err) {
                        return cb(err);
                    }
                    return this.removeProperty(UserProps.FailedLoginAttempts, cb);
                });
            }

            return this.removeProperties(
                [UserProps.AccountLockedTs, UserProps.AccountLockedPrevStatus],
                cb
            );
        });
    }

    //
    //  Clear a lock: a locked account gets back the status it had before (see
    //  processFailedLogin()), or active if none was kept, and the failed login
    //  count starts again. A status set since (by a sysop, say) is left
    //  alone; only the lock's leftovers go. A lock with neither (oputil's
    //  'user lock') is the sysop's to clear, with 'user activate'.
    //
    unlockAccount(cb) {
        return User.inLockTransaction(cb => {
            //  decided on the account as stored now, not as loaded earlier
            const fresh = User.refreshLockProperties(this.userId, this.properties);
            if (fresh instanceof Error) {
                return cb(fresh);
            }
            return this._unlockAccount(cb);
        }, cb);
    }

    _unlockAccount(cb) {
        const prevStatus = this.getProperty(UserProps.AccountLockedPrevStatus);
        const isLocked =
            User.AccountStatus.locked ===
            this.getPropertyAsNumber(UserProps.AccountStatus);

        if (!prevStatus && !_.has(this.properties, UserProps.AccountLockedTs)) {
            return cb(null); //  nothing to do
        }

        const restore = callback => {
            if (!isLocked) {
                return callback(null);
            }
            return this.persistProperty(
                UserProps.AccountStatus,
                prevStatus || User.AccountStatus.active,
                callback
            );
        };

        restore(err => {
            if (err) {
                return cb(err);
            }

            return this.removeProperties(
                [
                    UserProps.AccountLockedPrevStatus,
                    UserProps.AccountLockedTs,
                    UserProps.FailedLoginAttempts,
                ],
                cb
            );
        });
    }

    //
    //  Is |offeredKey| ({ algo, data } as ssh2 hands it over: the key type
    //  and the public key blob) the SSH public key in |storedKey| (OpenSSH
    //  format)? A comparison of public keys only: it proves nothing about
    //  who offered it.
    //
    static sshPubKeyMatches(storedKey, offeredKey) {
        if (!storedKey || !offeredKey || !Buffer.isBuffer(offeredKey.data)) {
            return false;
        }

        const parsedKey = ssh2.utils.parseKey(storedKey);
        if (!parsedKey || parsedKey instanceof Error) {
            return false;
        }

        const pubKeyActual = Array.isArray(parsedKey) ? parsedKey[0] : parsedKey;
        if (!pubKeyActual || !pubKeyActual.getPublicSSH) {
            return false;
        }

        const parts = storedKey.trim().split(/\s+/);
        if (parts.length < 2) {
            return false;
        }

        const storedKeyData = Buffer.from(parts[1], 'base64');

        if (offeredKey.algo !== pubKeyActual.type) {
            return false;
        }

        //  timingSafeEqual() throws on buffers of different lengths (an RSA
        //  key of another size, say)
        if (
            offeredKey.data.length !== storedKeyData.length ||
            !crypto.timingSafeEqual(offeredKey.data, storedKeyData)
        ) {
            Log.warn(
                {
                    expected: parts[1],
                    provided: offeredKey.data.toString('base64'),
                    algo: offeredKey.algo,
                },
                'SSH public key mismatch'
            );
            return false;
        }

        return true;
    }

    //
    //  An SSH client may ask whether a public key would be accepted before
    //  it signs with it (RFC 4252 section 7). This answers that: is
    //  |offeredKey| (see sshPubKeyMatches()) the key stored for |username|?
    //  It proves nothing, as anyone may know a public key, so it is not a
    //  login: nothing on this User changes, and there are none of a login's
    //  side effects.
    //
    //  Nor does a key that does not match count toward locking the account
    //  (see processFailedLogin()): an SSH client offers each key it has in
    //  turn (OpenSSH, every key in its agent), so the user's own client would
    //  lock them out. It is still a failed attempt for the connection, to
    //  users.failedLogin.disconnect (see checkSSHPubKey() in user_login.js).
    //
    checkSSHPubKey(username, offeredKey, cb) {
        let userId;
        async.waterfall(
            [
                callback => {
                    User.getUserIdAndName(username, (err, uid) => {
                        userId = uid;
                        return callback(err);
                    });
                },
                callback => {
                    User.loadProperties(
                        userId,
                        { names: User.StandardPropertyGroups.auth },
                        callback
                    );
                },
                (props, callback) => {
                    if (!User.sshPubKeyMatches(props[UserProps.SSHPubKey], offeredKey)) {
                        return callback(Errors.AccessDenied('Invalid public key'));
                    }
                    return callback(null);
                },
            ],
            err => {
                return cb(err || null);
            }
        );
    }

    //
    //  Run |work(cb)|, which reads and writes an account's status and lock
    //  properties, in one IMMEDIATE transaction: another process (oputil, say)
    //  cannot change them between the read and the write. Every step of such
    //  work is better-sqlite3, so it calls back before the transaction ends;
    //  |cb| is called after it commits (or rolls back), outside it.
    //
    static inLockTransaction(work, cb) {
        let result;
        try {
            userDb
                .transaction(() => {
                    work((...args) => (result = args));
                    if (!result) {
                        throw new Error('Account lock update did not complete in step');
                    }
                    if (result[0]) {
                        throw result[0]; //  roll back
                    }
                })
                .immediate();
        } catch (err) {
            return cb(err);
        }
        return cb(...result);
    }

    //
    //  cb-less: the account status and lock properties of |userId| as stored
    //  now, or an Error
    //
    static loadLockProperties(userId) {
        let props;
        User.loadProperties(userId, { names: LockPropertyNames }, (err, p) => {
            props = err || p;
        });
        return props;
    }

    //
    //  cb-less: update |properties| (of |userId|) with the status and lock
    //  properties as stored now. Returns |properties|, or an Error.
    //
    static refreshLockProperties(userId, properties) {
        const fresh = User.loadLockProperties(userId);
        if (fresh instanceof Error) {
            return fresh;
        }
        LockPropertyNames.forEach(name => {
            if (_.has(fresh, name)) {
                properties[name] = fresh[name];
            } else {
                delete properties[name];
            }
        });
        return properties;
    }

    static get LockState() {
        return {
            None: 'none', //  not locked
            InForce: 'inForce',
            Expired: 'expired', //  past users.failedLogin.autoUnlockMinutes
        };
    }

    //
    //  Is the account with |props| locked, and is the lock still in force? A
    //  lock with no time (oputil's 'user lock'), or with autoUnlockMinutes
    //  off, stays until a sysop clears it.
    //
    static getLockState(props) {
        if (User.AccountStatus.locked !== parseInt(props[UserProps.AccountStatus], 10)) {
            return User.LockState.None;
        }

        const autoUnlockMinutes = _.get(Config(), 'users.failedLogin.autoUnlockMinutes');
        const lockedTsProp = props[UserProps.AccountLockedTs];
        const lockedTs = moment(lockedTsProp);
        if (
            autoUnlockMinutes > 0 &&
            lockedTsProp &&
            lockedTs.isValid() &&
            moment().diff(lockedTs, 'minutes') >= autoUnlockMinutes
        ) {
            return User.LockState.Expired;
        }

        return User.LockState.InForce;
    }

    //
    //  The status a login for the account with |props| is judged on: the
    //  stored one, except for a lock that has run out, which is cleared once
    //  the login succeeds (see unlockAccount()): then the status the account
    //  had before it was locked (active, if none was kept).
    //
    static getEffectiveAccountStatus(props) {
        if (User.LockState.Expired === User.getLockState(props)) {
            const prevStatus = parseInt(props[UserProps.AccountLockedPrevStatus], 10);
            return isNaN(prevStatus) ? User.AccountStatus.active : prevStatus;
        }
        return parseInt(props[UserProps.AccountStatus], 10);
    }

    //
    //  The refusal for a login on the account with |props|, by its status
    //  (see getEffectiveAccountStatus()), or null if it is active
    //
    static accountStatusError(props) {
        if (User.LockState.InForce === User.getLockState(props)) {
            return Errors.AccessDenied('Account is locked', ErrorReasons.Locked);
        }

        const accountStatus = User.getEffectiveAccountStatus(props);
        switch (accountStatus) {
            case User.AccountStatus.active:
                return null;
            case User.AccountStatus.disabled:
                return Errors.AccessDenied('Account disabled', ErrorReasons.Disabled);
            case User.AccountStatus.inactive:
                return Errors.AccessDenied('Account inactive', ErrorReasons.Inactive);
            case User.AccountStatus.locked:
                return Errors.AccessDenied('Account is locked', ErrorReasons.Locked);
            default:
                //  anything else besides active is still not allowed
                return Errors.AccessDenied('Account is not active');
        }
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
            const hashParams = User.getHashParams(props);
            User.generatePasswordDerivedKey(
                authInfo.password,
                props[UserProps.PassPbkdf2Salt],
                hashParams,
                (err, dk) => {
                    if (err) {
                        return callback(err);
                    }

                    const passDkBuf = Buffer.from(dk, 'hex');
                    const propsDkBuf = Buffer.from(props[UserProps.PassPbkdf2Dk], 'hex');

                    //  timingSafeEqual requires equal-length buffers; length mismatch
                    //  means stored params don't match what we derived — treat as failure.
                    if (
                        passDkBuf.length !== propsDkBuf.length ||
                        !crypto.timingSafeEqual(passDkBuf, propsDkBuf)
                    ) {
                        return callback(Errors.AccessDenied('Invalid password'));
                    }

                    //  a legacy hash is upgraded once the login is accepted
                    //  (see upgradePasswordHash()), never for a refused one
                    tempAuthInfo.needsRehash = User.needsRehash(props);

                    return callback(null);
                }
            );
        };

        //
        //  Upgrade a legacy password hash to the current parameters, in the
        //  background: only for a login that was accepted, so a refused one
        //  (a lock, say) leaves nothing behind to time. setImmediate defers
        //  past the current call stack.
        //
        const upgradePasswordHash = () => {
            const oldParams = User.getHashParams(tempAuthInfo.properties);
            Log.info(
                {
                    userId: tempAuthInfo.userId,
                    username: tempAuthInfo.username,
                    fromParams: {
                        digest: oldParams.digest,
                        iterations: oldParams.iterations,
                        keyLen: oldParams.keyLen,
                    },
                    toParams: {
                        digest: User.PBKDF2.digest,
                        iterations: User.PBKDF2.iterations,
                        keyLen: User.PBKDF2.keyLen,
                    },
                },
                'Upgrading password hash to current parameters'
            );
            setImmediate(() => {
                User.rehashPassword(tempAuthInfo.userId, authInfo.password, rehashErr => {
                    if (rehashErr) {
                        Log.warn(
                            {
                                error: rehashErr.message,
                                userId: tempAuthInfo.userId,
                                username: tempAuthInfo.username,
                            },
                            'Failed to upgrade password hash; will retry on next login'
                        );
                    } else {
                        Log.info(
                            {
                                userId: tempAuthInfo.userId,
                                username: tempAuthInfo.username,
                            },
                            'Password hash upgrade complete'
                        );
                    }
                });
            });
        };

        //
        //  Only that the offered key is the one stored for this user. The
        //  caller (the SSH server) has already verified the signature made
        //  with it; a key alone proves nothing.
        //
        //  A key that is not the user's does not count toward locking the
        //  account (see checkSSHPubKey()), signed or not: a client may sign
        //  with each key it has in turn without asking first.
        //
        const validatePubKey = (props, callback) => {
            const offeredKey = _.get(authInfo, 'pubKey.key');
            if (!User.sshPubKeyMatches(props[UserProps.SSHPubKey], offeredKey)) {
                tempAuthInfo.notCounted = true;
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
                function initProps(callback) {
                    User.loadProperties(tempAuthInfo.userId, (err, allProps) => {
                        if (!err) {
                            tempAuthInfo.properties = allProps;
                        }

                        return callback(err);
                    });
                },
                function checkLock(callback) {
                    //
                    //  A lock in force refuses before the password or key is
                    //  looked at: the answer is the same either way, so it
                    //  tells nothing about them, and the attempt is not
                    //  counted.
                    //
                    if (
                        User.LockState.InForce ===
                        User.getLockState(tempAuthInfo.properties)
                    ) {
                        tempAuthInfo.notCounted = true;
                        return callback(
                            Errors.AccessDenied('Account is locked', ErrorReasons.Locked)
                        );
                    }
                    return callback(null);
                },
                function checkStatus(callback) {
                    //
                    //  Likewise an account that is not active (disabled, or
                    //  waiting for activation), judged as a login would be
                    //  (see getEffectiveAccountStatus(): a lock that has run
                    //  out, by the status from before it): it is refused
                    //  before the password or key is looked at, with the
                    //  same answer whether or not they are right, and the
                    //  attempt is not counted.
                    //
                    const statusErr = User.accountStatusError(tempAuthInfo.properties);
                    if (statusErr) {
                        tempAuthInfo.notCounted = true;
                        return callback(statusErr);
                    }
                    return callback(null);
                },
                function validatePassOrPubKey(callback) {
                    if (User.AuthFactor1Types.SSHPubKey === authInfo.type) {
                        return validatePubKey(tempAuthInfo.properties, callback);
                    }
                    return validatePassword(tempAuthInfo.properties, callback);
                },
                function initGroups(callback) {
                    userGroup.getGroupsForUser(tempAuthInfo.userId, (err, groups) => {
                        if (!err) {
                            tempAuthInfo.groups = groups;
                        }

                        return callback(err);
                    });
                },
                function checkAccountStatus(callback) {
                    //
                    //  The account as it is now, not as it was before the
                    //  password check (asynchronous; other logins may have
                    //  locked the account meanwhile, or a sysop changed its
                    //  status). From here to the end (the count reset and
                    //  any unlock) nothing is asynchronous, so nothing can
                    //  change it in between.
                    //
                    const fresh = User.refreshLockProperties(
                        tempAuthInfo.userId,
                        tempAuthInfo.properties
                    );
                    if (fresh instanceof Error) {
                        return callback(fresh);
                    }

                    const statusErr = User.accountStatusError(tempAuthInfo.properties);
                    if (statusErr) {
                        //  the right password or key: not a failed login
                        tempAuthInfo.notCounted = true;
                        return callback(statusErr);
                    }

                    if (
                        User.LockState.Expired ===
                        User.getLockState(tempAuthInfo.properties)
                    ) {
                        Log.info(
                            {
                                username,
                                userId: tempAuthInfo.userId,
                                lockedAt:
                                    tempAuthInfo.properties[UserProps.AccountLockedTs],
                                prevStatus:
                                    tempAuthInfo.properties[
                                        UserProps.AccountLockedPrevStatus
                                    ],
                            },
                            'Locked account will now be unlocked due to auto-unlock minutes policy'
                        );
                    }

                    return callback(null);
                },
            ],
            err => {
                if (err) {
                    const isAccountStatusErr = [
                        ErrorReasons.Disabled,
                        ErrorReasons.Inactive,
                        ErrorReasons.Locked,
                    ].includes(err.reasonCode);

                    //
                    //  Once the account is locked, or a sysop has disabled it
                    //  (or set it to wait for activation), every refused
                    //  login gets the same answer as the right password does:
                    //  a wrong one under way when that happened (or the one
                    //  that set the lock) must not answer otherwise, or the
                    //  right one stands out among them.
                    //
                    const answer = () => {
                        if (!isAccountStatusErr && tempAuthInfo.userId) {
                            const fresh = User.loadLockProperties(tempAuthInfo.userId);
                            if (!(fresh instanceof Error)) {
                                const statusErr = User.accountStatusError(fresh);
                                if (statusErr) {
                                    return cb(statusErr);
                                }
                            }
                        }
                        return cb(err);
                    };

                    //
                    //  A wrong password counts as a failed login (see
                    //  processFailedLogin(): it may lock the account, or
                    //  re-arm a lock that had run out). A refusal by the
                    //  account's status (a lock in force, disabled, inactive)
                    //  does not, nor does a key that is not the user's.
                    //
                    if (
                        !isAccountStatusErr &&
                        !tempAuthInfo.notCounted &&
                        tempAuthInfo.userId
                    ) {
                        self.processFailedLogin(tempAuthInfo.userId, persistErr => {
                            if (persistErr) {
                                Log.warn(
                                    { error: persistErr.message },
                                    'Failed to persist failed login information'
                                );
                            }
                            return answer();
                        });
                    } else if (!isAccountStatusErr) {
                        return answer();
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

                        if (tempAuthInfo.needsRehash) {
                            upgradePasswordHash();
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
                //  1. Async: generate password credentials
                function genAuthCredentials(callback) {
                    User.generatePasswordDerivedKeyAndSalt(
                        createUserInfo.password,
                        (err, info) => {
                            if (err) {
                                return callback(err);
                            }
                            self.properties[UserProps.PassPbkdf2Salt] = info.salt;
                            self.properties[UserProps.PassPbkdf2Dk] = info.dk;
                            self.properties[UserProps.PassHashParams] = JSON.stringify(
                                User.PBKDF2
                            );
                            return callback(null);
                        }
                    );
                },

                //  2. DB transaction: insert user record + all properties + groups
                function persistUser(callback) {
                    try {
                        userDb.transaction(() => {
                            const info = userDb
                                .prepare(`INSERT INTO user (user_name) VALUES (?);`)
                                .run(self.username);
                            self.userId = info.lastInsertRowid;

                            //  Do not require activation for userId 1 (root/admin)
                            if (User.RootUserID === self.userId) {
                                self.properties[UserProps.AccountStatus] =
                                    User.AccountStatus.active;
                            }

                            //  Assign initial groups. Clone to avoid #235 (all users becoming sysops).
                            self.groups = [...config.users.defaultGroups];
                            if (User.RootUserID === self.userId) {
                                self.groups.push('sysops');
                            }

                            const propStmt = userDb.prepare(
                                `REPLACE INTO user_property (user_id, prop_name, prop_value)
                                VALUES (?, ?, ?);`
                            );
                            _.merge(self.properties, self.properties);
                            for (const [k, v] of Object.entries(self.properties)) {
                                propStmt.run(self.userId, k, coerceToText(v));
                            }

                            const groupStmt = userDb.prepare(
                                `REPLACE INTO user_group_member (group_name, user_id)
                                VALUES (?, ?);`
                            );
                            for (const group of self.groups) {
                                groupStmt.run(group, self.userId);
                            }
                        })();
                        return callback(null);
                    } catch (err) {
                        return callback(err);
                    }
                },

                //  3. Async: NewUserPrePersist event — fires after DB commit so userId is set.
                //     Listeners (e.g. ActivityPub) may write to other databases here.
                function newUserPreEvent(callback) {
                    const eventName = Events.getSystemEvents().NewUserPrePersist;
                    const subCount = Events.listenerCount(eventName);
                    if (subCount < 1) {
                        return callback(null);
                    }

                    let returned = 0;
                    const cbWrapper = e => {
                        ++returned;
                        if (returned >= subCount) {
                            return callback(e);
                        }
                    };

                    Events.emit(eventName, {
                        user: self,
                        sessionId: createUserInfo.sessionId,
                        callback: cbWrapper,
                    });
                },

                //  4. NewUser event (fire-and-forget)
                function newUserEvent(callback) {
                    Events.emit(Events.getSystemEvents().NewUser, {
                        user: Object.assign({}, self, {
                            sessionId: createUserInfo.sessionId,
                        }),
                    });
                    return callback(null);
                },
            ],
            err => {
                return cb(err);
            }
        );
    }

    //
    //  The persist and remove methods below call |cb| outside their try, so
    //  a throw from the caller's callback is not caught and reported back
    //  through that same callback as a database error.
    //
    static persistPropertyByUserId(userId, propName, propValue, cb) {
        let error = null;
        try {
            userDb
                .prepare(
                    `REPLACE INTO user_property (user_id, prop_name, prop_value)
                    VALUES (?, ?, ?);`
                )
                .run(userId, propName, coerceToText(propValue));
        } catch (err) {
            error = err;
        }

        if (cb) {
            return error ? cb(error) : cb(null, propValue);
        }
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

        let error = null;
        try {
            userDb
                .prepare(
                    `DELETE FROM user_property
                    WHERE user_id = ? AND prop_name = ?;`
                )
                .run(this.userId, propName);
        } catch (err) {
            error = err;
        }

        if (cb) {
            return cb(error);
        }
    }

    removeProperties(propNames, cb) {
        let error = null;
        try {
            const stmt = userDb.prepare(
                `DELETE FROM user_property WHERE user_id = ? AND prop_name = ?;`
            );
            for (const name of propNames) {
                delete this.properties[name];
                stmt.run(this.userId, name);
            }
        } catch (err) {
            error = err;
        }

        if (cb) {
            return cb(error);
        }
    }

    updateActivityPubKeyPairProperties(cb) {
        generateActorKeyPair((err, keys) => {
            if (!err) {
                this.setProperty(UserProps.PrivateActivityPubSigningKey, keys.privateKey);
                this.setProperty(UserProps.PublicActivityPubSigningKey, keys.publicKey);
            }
            return cb(err);
        });
    }

    generateNewRandomAvatar(cb) {
        const spritesPath = _.get(Config(), 'users.avatars.spritesPath');
        const storagePath = _.get(Config(), 'users.avatars.storagePath');

        if (!spritesPath || !storagePath) {
            return cb(
                Errors.MissingConfig(
                    'Cannot generate new avatar: Missing path(s) in configuration'
                )
            );
        }

        async.waterfall(
            [
                callback => {
                    return fse.mkdirs(storagePath, err => {
                        return callback(err);
                    });
                },
                callback => {
                    const avatar = new AvatarGenerator({
                        parts: [
                            'background',
                            'face',
                            'clothes',
                            'head',
                            'hair',
                            'eye',
                            'mouth',
                        ],
                        partsLocation: spritesPath,
                        imageExtension: '.png',
                    });

                    const userSex = (
                        this.getProperty(UserProps.Sex) || 'M'
                    ).toUpperCase();

                    const variant = userSex[0] === 'M' ? 'male' : 'female';
                    const stableId = `user#${this.userId.toString()}`;

                    avatar
                        .generate(stableId, variant)
                        .then(image => {
                            const filename = `user-avatar-${this.userId}.png`;
                            const outPath = paths.join(storagePath, filename);
                            image.resize(640, 640);
                            image.toFile(outPath, err => {
                                if (!err) {
                                    Log.info(
                                        {
                                            userId: this.userId,
                                            username: this.username,
                                            outPath,
                                        },
                                        `New avatar generated for ${this.username}`
                                    );
                                }
                                return callback(err, outPath);
                            });
                        })
                        .catch(err => {
                            return callback(err);
                        });
                },
            ],
            (err, outPath) => {
                return cb(err, outPath);
            }
        );
    }

    persistProperties(properties, cb) {
        //  update live props
        _.merge(this.properties, properties);

        try {
            const stmt = userDb.prepare(
                `REPLACE INTO user_property (user_id, prop_name, prop_value)
                VALUES (?, ?, ?);`
            );
            for (const [propName, propValue] of Object.entries(properties)) {
                stmt.run(this.userId, propName, coerceToText(propValue));
            }
        } catch (err) {
            return cb(err);
        }

        return cb(null);
    }

    setNewAuthCredentials(password, cb) {
        User.generatePasswordDerivedKeyAndSalt(password, (err, info) => {
            if (err) {
                return cb(err);
            }

            const newProperties = {
                [UserProps.PassPbkdf2Salt]: info.salt,
                [UserProps.PassPbkdf2Dk]: info.dk,
                [UserProps.PassHashParams]: JSON.stringify(User.PBKDF2),
            };

            this.persistProperties(newProperties, err => {
                return cb(err);
            });
        });
    }

    setPublicSSHKey(pubKey, cb) {
        cb = cb || (() => {});

        if (!_.isString(pubKey)) {
            pubKey = pubKey ? String(pubKey) : '';
        }

        const trimmedKey = pubKey.trim();

        if (0 === trimmedKey.length) {
            return this.removeProperty(UserProps.SSHPubKey, cb);
        }

        const parsedKey = ssh2.utils.parseKey(trimmedKey);
        if (!parsedKey || parsedKey instanceof Error) {
            const err =
                parsedKey instanceof Error
                    ? parsedKey
                    : new Error('Invalid SSH public key');
            return cb(err);
        }

        //  When an OpenSSH public key is provided, parseKey returns an object with getPublicSSH().
        //  If an array is returned, use the first key.
        const keyObject = Array.isArray(parsedKey) ? parsedKey[0] : parsedKey;
        if (!keyObject || !keyObject.getPublicSSH) {
            const err = new Error('Invalid SSH public key');
            return cb(err);
        }

        return this.persistProperty(UserProps.SSHPubKey, trimmedKey, cb);
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

    //
    //  User name and real name lookups are exact, but case-insensitive as
    //  LIKE was (ASCII letters only, as SQLite's NOCASE): LIKE would also
    //  take '%' and '_' in what was looked up as wildcards, so "%" found the
    //  first user there is.
    //
    static getUserIdAndName(username, cb) {
        try {
            const row = userDb
                .prepare(
                    `SELECT id, user_name FROM user WHERE user_name = ? COLLATE NOCASE;`
                )
                .get(username);
            if (row) {
                return cb(null, row.id, row.user_name);
            }
            return cb(Errors.DoesNotExist('No matching username'));
        } catch (err) {
            return cb(err);
        }
    }

    //
    //  cb(err, [ { userId, userName } ]) for user names LIKE |pattern|, which
    //  may use '\\' to escape '%' and '_'. For narrowing a search down only:
    //  check each name found exactly.
    //
    static getUserIdsAndNamesLike(pattern, cb) {
        try {
            const rows = userDb
                .prepare(
                    `SELECT id, user_name FROM user WHERE user_name LIKE ? ESCAPE '\\';`
                )
                .all(pattern);
            return cb(
                null,
                rows.map(row => ({ userId: row.id, userName: row.user_name }))
            );
        } catch (err) {
            return cb(err);
        }
    }

    static getUserByUsername(username, cb) {
        User.getUserIdAndName(username, (err, userId) => {
            if (err) {
                return cb(err);
            }
            return User.getUser(userId, cb);
        });
    }

    static getUserIdAndNameByRealName(realName, cb) {
        try {
            const row = userDb
                .prepare(
                    `SELECT id, user_name
                    FROM user
                    WHERE id = (
                        SELECT user_id
                        FROM user_property
                        WHERE prop_name='${UserProps.RealName}' AND prop_value = ? COLLATE NOCASE
                    );`
                )
                .get(realName);
            if (row) {
                return cb(null, row.id, row.user_name);
            }
            return cb(Errors.DoesNotExist('No matching real name'));
        } catch (err) {
            return cb(err);
        }
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
        //  the callback runs outside the try: a throw in it is not caught
        //  here and passed to it again as a lookup error
        let row;
        try {
            row = userDb.prepare(`SELECT user_name FROM user WHERE id = ?;`).get(userId);
        } catch (err) {
            return cb(err);
        }
        if (row) {
            return cb(null, row.user_name);
        }
        return cb(Errors.DoesNotExist('No matching user ID'));
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
            sql += ` AND prop_name IN('${options.names.join("','")}');`;
        } else {
            sql += ';';
        }

        try {
            const properties = {};
            for (const row of userDb.prepare(sql).iterate(userId)) {
                properties[row.prop_name] = row.prop_value;
            }
            return cb(null, properties);
        } catch (err) {
            return cb(err, null);
        }
    }

    //  :TODO: make this much more flexible - propValue should allow for case-insensitive compare, etc.
    static getUserIdsWithProperty(propName, propValue, cb) {
        try {
            const userIds = userDb
                .prepare(
                    `SELECT user_id
                    FROM user_property
                    WHERE prop_name = ? AND prop_value = ?;`
                )
                .all(propName, propValue)
                .map(r => r.user_id);
            return cb(null, userIds);
        } catch (err) {
            return cb(err, []);
        }
    }

    static getUserCount(cb) {
        try {
            const row = userDb.prepare(`SELECT count() AS user_count FROM user;`).get();
            return cb(null, row.user_count);
        } catch (err) {
            return cb(err);
        }
    }

    static getUserList(options, cb) {
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

        try {
            const userList = userDb
                .prepare(
                    `SELECT u.id as userId, u.user_name as userName, ${asList.join(', ')}
                    FROM user u ${joinList.join(' ')}
                    ORDER BY u.user_name;`
                )
                .all();
            return cb(null, userList);
        } catch (err) {
            return cb(err);
        }
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

    //  Returns the hash params stored for a user, or LegacyPBKDF2 if absent (pre-migration user).
    static getHashParams(props) {
        const raw = props[UserProps.PassHashParams];
        if (raw) {
            try {
                return JSON.parse(raw);
            } catch (e) {
                Log.warn(
                    { error: e.message },
                    'Failed to parse PassHashParams; falling back to legacy defaults'
                );
            }
        }
        return User.LegacyPBKDF2;
    }

    //  Returns true when the stored hash was produced with parameters that differ from the current target.
    static needsRehash(props) {
        const stored = User.getHashParams(props);
        const target = User.PBKDF2;
        return (
            stored.iterations !== target.iterations ||
            stored.digest !== target.digest ||
            stored.keyLen !== target.keyLen
        );
    }

    //  Re-derives and persists a new salt + dk + PassHashParams for an existing user.
    //  Called fire-and-forget from validatePassword; errors are logged, not surfaced.
    static rehashPassword(userId, plainPassword, cb) {
        User.generatePasswordDerivedKeyAndSalt(plainPassword, (err, info) => {
            if (err) {
                return cb(err);
            }
            try {
                const stmt = userDb.prepare(
                    `REPLACE INTO user_property (user_id, prop_name, prop_value) VALUES (?, ?, ?);`
                );
                stmt.run(userId, UserProps.PassPbkdf2Salt, info.salt);
                stmt.run(userId, UserProps.PassPbkdf2Dk, info.dk);
                stmt.run(userId, UserProps.PassHashParams, JSON.stringify(User.PBKDF2));
                return cb(null);
            } catch (dbErr) {
                return cb(dbErr);
            }
        });
    }

    static generatePasswordDerivedKeySalt(cb) {
        crypto.randomBytes(User.PBKDF2.saltLen, (err, salt) => {
            if (err) {
                return cb(err);
            }
            return cb(null, salt.toString('hex'));
        });
    }

    static generatePasswordDerivedKey(password, salt, options, cb) {
        if (typeof options === 'function') {
            cb = options;
            options = User.PBKDF2;
        }

        password = Buffer.from(password).toString('hex');

        crypto.pbkdf2(
            password,
            salt,
            options.iterations,
            options.keyLen,
            options.digest,
            (err, dk) => {
                if (err) {
                    return cb(err);
                }

                return cb(null, dk.toString('hex'));
            }
        );
    }
};
