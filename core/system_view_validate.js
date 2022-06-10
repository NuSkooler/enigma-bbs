/* jslint node: true */
'use strict';

//  ENiGMA½
const User = require('./user.js');
const Config = require('./config.js').get;
const Log = require('./logger.js').log;
const { getAddressedToInfo } = require('./mail_util.js');
const Message = require('./message.js');

//  deps
const fs = require('graceful-fs');

exports.validateNonEmpty = validateNonEmpty;
exports.validateMessageSubject = validateMessageSubject;
exports.validateUserNameAvail = validateUserNameAvail;
exports.validateUserNameExists = validateUserNameExists;
exports.validateUserNameOrRealNameExists = validateUserNameOrRealNameExists;
exports.validateGeneralMailAddressedTo = validateGeneralMailAddressedTo;
exports.validateEmailAvail = validateEmailAvail;
exports.validateBirthdate = validateBirthdate;
exports.validatePasswordSpec = validatePasswordSpec;

function validateNonEmpty(data, cb) {
    return cb(data && data.length > 0 ? null : new Error('Field cannot be empty'));
}

function validateMessageSubject(data, cb) {
    return cb(data && data.length > 1 ? null : new Error('Subject too short'));
}

function validateUserNameAvail(data, cb) {
    const config = Config();
    if (!data || data.length < config.users.usernameMin) {
        cb(new Error('Username too short'));
    } else if (data.length > config.users.usernameMax) {
        //  generally should be unreached due to view restraints
        return cb(new Error('Username too long'));
    } else {
        const usernameRegExp = new RegExp(config.users.usernamePattern);
        const invalidNames = config.users.newUserNames + config.users.badUserNames;

        if (!usernameRegExp.test(data)) {
            return cb(new Error('Username contains invalid characters'));
        } else if (invalidNames.indexOf(data.toLowerCase()) > -1) {
            return cb(new Error('Username is blacklisted'));
        } else if (/^[0-9]+$/.test(data)) {
            return cb(new Error('Username cannot be a number'));
        } else {
            //  a new user name cannot be an existing user name or an existing real name
            User.getUserIdAndNameByLookup(data, function userIdAndName(err) {
                if (!err) {
                    //  err is null if we succeeded -- meaning this user exists already
                    return cb(new Error('Username unavailable'));
                }

                return cb(null);
            });
        }
    }
}

const invalidUserNameError = () => new Error('Invalid username');

function validateUserNameExists(data, cb) {
    if (0 === data.length) {
        return cb(invalidUserNameError());
    }

    User.getUserIdAndName(data, err => {
        return cb(err ? invalidUserNameError() : null);
    });
}

function validateUserNameOrRealNameExists(data, cb) {
    if (0 === data.length) {
        return cb(invalidUserNameError());
    }

    User.getUserIdAndNameByLookup(data, err => {
        return cb(err ? invalidUserNameError() : null);
    });
}

function validateGeneralMailAddressedTo(data, cb) {
    //
    //  Allow any supported addressing:
    //  - Local username or real name
    //  - Supported remote flavors such as FTN, email, ...
    //
    //  :TODO: remove hard-coded FTN check here. We need a decent way to register global supported flavors with modules.
    const addressedToInfo = getAddressedToInfo(data);

    if (Message.AddressFlavor.FTN === addressedToInfo.flavor) {
        return cb(null);
    }

    return validateUserNameOrRealNameExists(data, cb);
}

function validateEmailAvail(data, cb) {
    //
    //  This particular method allows empty data - e.g. no email entered
    //
    if (!data || 0 === data.length) {
        return cb(null);
    }

    //
    //  Otherwise, it must be a valid email. We'll be pretty lose here, like
    //  the HTML5 spec.
    //
    //  See http://stackoverflow.com/questions/7786058/find-the-regex-used-by-html5-forms-for-validation
    //
    const emailRegExp = /[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9-]+(.[a-z0-9-]+)*/;
    if (!emailRegExp.test(data)) {
        return cb(new Error('Invalid email address'));
    }

    User.getUserIdsWithProperty(
        'email_address',
        data,
        function userIdsWithEmail(err, uids) {
            if (err) {
                return cb(new Error('Internal system error'));
            } else if (uids.length > 0) {
                return cb(new Error('Email address not unique'));
            }

            return cb(null);
        }
    );
}

function validateBirthdate(data, cb) {
    //  :TODO: check for dates in the future, or > reasonable values
    return cb(isNaN(Date.parse(data)) ? new Error('Invalid birthdate') : null);
}

function validatePasswordSpec(data, cb) {
    const config = Config();
    if (!data || data.length < config.users.passwordMin) {
        return cb(new Error('Password too short'));
    }

    //  check badpass, if avail
    fs.readFile(config.users.badPassFile, 'utf8', (err, passwords) => {
        if (err) {
            Log.warn({ error: err.message }, 'Cannot read bad pass file');
            return cb(null);
        }

        passwords = passwords.toString().split(/\r\n|\n/g);
        if (passwords.includes(data)) {
            return cb(new Error('Password is too common'));
        }

        return cb(null);
    });
}
