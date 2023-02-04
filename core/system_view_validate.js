/* jslint node: true */
'use strict';

//  ENiGMA½
const User = require('./user');
const Config = require('./config').get;
const Log = require('./logger').log;
const { getAddressedToInfo } = require('./mail_util');
const Message = require('./message');
const { Errors, ErrorReasons } = require('./enig_error'); // note: Only use ValidationFailed in this module!

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
    return cb(
        data && data.length > 0
            ? null
            : Errors.ValidationFailed('Field cannot be empty', ErrorReasons.ValueTooShort)
    );
}

function validateMessageSubject(data, cb) {
    return cb(
        data && data.length > 1
            ? null
            : Errors.ValidationFailed('Subject too short', ErrorReasons.ValueTooShort)
    );
}

function validateUserNameAvail(data, cb) {
    const config = Config();
    if (!data || data.length < config.users.usernameMin) {
        cb(Errors.ValidationFailed('Username too short', ErrorReasons.ValueTooShort));
    } else if (data.length > config.users.usernameMax) {
        //  generally should be unreached due to view restraints
        return cb(
            Errors.ValidationFailed('Username too long', ErrorReasons.ValueTooLong)
        );
    } else {
        const usernameRegExp = new RegExp(config.users.usernamePattern);
        const invalidNames = config.users.newUserNames + config.users.badUserNames;

        if (!usernameRegExp.test(data)) {
            return cb(
                Errors.ValidationFailed(
                    'Username contains invalid characters',
                    ErrorReasons.ValueInvalid
                )
            );
        } else if (invalidNames.indexOf(data.toLowerCase()) > -1) {
            return cb(
                Errors.ValidationFailed(
                    'Username is blacklisted',
                    ErrorReasons.NotAllowed
                )
            );
        } else if (/^[0-9]+$/.test(data)) {
            return cb(
                Errors.ValidationFailed(
                    'Username cannot be a number',
                    ErrorReasons.ValueInvalid
                )
            );
        } else {
            //  a new user name cannot be an existing user name or an existing real name
            User.getUserIdAndNameByLookup(data, function userIdAndName(err) {
                if (!err) {
                    //  err is null if we succeeded -- meaning this user exists already
                    return cb(
                        Errors.ValidationFailed(
                            'Username unavailable',
                            ErrorReasons.NotAvailable
                        )
                    );
                }

                return cb(null);
            });
        }
    }
}

function validateUserNameExists(data, cb) {
    if (0 === data.length) {
        return cb(
            Errors.ValidationFailed('Invalid username', ErrorReasons.ValueTooShort)
        );
    }

    User.getUserIdAndName(data, err => {
        return cb(
            err
                ? Errors.ValidationFailed(
                      'Failed to find username',
                      err.reasonCode || ErrorReasons.DoesNotExist
                  )
                : null
        );
    });
}

function validateUserNameOrRealNameExists(data, cb) {
    if (0 === data.length) {
        return cb(
            Errors.ValidationFailed('Invalid username', ErrorReasons.ValueTooShort)
        );
    }

    User.getUserIdAndNameByLookup(data, err => {
        return cb(
            err
                ? Errors.ValidationFailed(
                      'Failed to find user',
                      err.reasonCode || ErrorReasons.DoesNotExist
                  )
                : null
        );
    });
}

function validateGeneralMailAddressedTo(data, cb) {
    //
    //  Allow any supported addressing:
    //  - Local username or real name
    //  - Supported remote flavors such as FTN, email, ...
    //
    const addressedToInfo = getAddressedToInfo(data);
    if (Message.AddressFlavor.Local !== addressedToInfo.flavor) {
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
        return cb(
            Errors.ValidationFailed('Invalid email address', ErrorReasons.ValueInvalid)
        );
    }

    User.getUserIdsWithProperty(
        'email_address',
        data,
        function userIdsWithEmail(err, uids) {
            if (err) {
                return cb(
                    Errors.ValidationFailed(
                        err.message,
                        err.reasonCode || ErrorReasons.DoesNotExist
                    )
                );
            } else if (uids.length > 0) {
                return cb(
                    Errors.ValidationFailed(
                        'Email address not unique',
                        ErrorReasons.NotAvailable
                    )
                );
            }

            return cb(null);
        }
    );
}

function validateBirthdate(data, cb) {
    //  :TODO: check for dates in the future, or > reasonable values
    return cb(
        isNaN(Date.parse(data))
            ? Errors.ValidationFailed('Invalid birthdate', ErrorReasons.ValueInvalid)
            : null
    );
}

function validatePasswordSpec(data, cb) {
    const config = Config();
    if (!data || data.length < config.users.passwordMin) {
        return cb(
            Errors.ValidationFailed('Password too short', ErrorReasons.ValueTooShort)
        );
    }

    //  check badpass, if avail
    fs.readFile(config.users.badPassFile, 'utf8', (err, passwords) => {
        if (err) {
            Log.warn(
                { error: err.message, path: config.users.badPassFile },
                'Cannot read bad pass file'
            );
            return cb(null);
        }

        passwords = passwords.toString().split(/\r\n|\n/g);
        if (passwords.includes(data)) {
            return cb(
                Errors.ValidationFailed('Password is too common', ErrorReasons.NotAllowed)
            );
        }

        return cb(null);
    });
}
