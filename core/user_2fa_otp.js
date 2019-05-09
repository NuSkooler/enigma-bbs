/* jslint node: true */
'use strict';

//  ENiGMA½
const UserProps         = require('./user_property.js');
const {
    Errors,
    ErrorReasons,
}                       = require('./enig_error.js');
const User              = require('./user.js');
const {
    recordLogin,
    transformLoginError,
}                       = require('./user_login.js');

//  deps
const _             = require('lodash');
const crypto        = require('crypto');
const async         = require('async');

exports.loginFactor2_OTP        = loginFactor2_OTP;
exports.generateNewBackupCodes  = generateNewBackupCodes;

const OTPTypes = exports.OTPTypes = {
    RFC6238_TOTP        : 'rfc6238_TOTP',   //  Time-Based, SHA-512
    RFC4266_HOTP        : 'rfc4266_HOTP',   //  HMAC-Based, SHA-512
    GoogleAuthenticator : 'googleAuth',     //  Google Authenticator is basically TOTP + quirks
};

function otpFromType(otpType) {
    return {
        [ OTPTypes.RFC6238_TOTP ] : () => {
            const totp = require('otplib/totp');
            totp.options = { crypto, algorithm : 'sha256' };
            return totp;
        },
        [ OTPTypes.RFC4266_HOTP ] : () => {
            const hotp = require('otplib/hotp');
            hotp.options = { crypto, algorithm : 'sha256' };
            return hotp;
        },
        [ OTPTypes.GoogleAuthenticator ] : () => {
            const googleAuth = require('otplib/authenticator');
            googleAuth.options = { crypto };
            return googleAuth;
        },
    }[otpType]();
}

function generateOTPBackupCode() {
    const consonants = 'bdfghjklmnprstvz'.split('');
    const vowels     = 'aiou'.split('');

    const bits = [];
    const rng = crypto.randomBytes(4);

    for(let i = 0; i < rng.length / 2; ++i) {
        const n = rng.readUInt16BE(i * 2);

        const c1 = n & 0x0f;
        const v1 = (n >> 4) & 0x03;
        const c2 = (n >> 6) & 0x0f;
        const v2 = (n >> 10) & 0x03;
        const c3 = (n >> 12) & 0x0f;

        bits.push([
            consonants[c1],
            vowels[v1],
            consonants[c2],
            vowels[v2],
            consonants[c3],
        ].join(''));
    }

    return bits.join('-');
}

function backupCodePBKDF2(secret, salt, cb) {
    return crypto.pbkdf2(secret, salt, 1000, 128, 'sha1', cb);
}

function generateNewBackupCodes(user, cb) {
    //
    //  Backup codes are not stored in plain text, but rather
    //  an array of objects: [{salt, code}, ...]
    //
    const plainCodes = [...Array(6)].map(() => generateOTPBackupCode());
    async.map(plainCodes, (code, nextCode) => {
        crypto.randomBytes(16, (err, salt) => {
            if(err) {
                return nextCode(err);
            }
            salt = salt.toString('base64');
            backupCodePBKDF2(code, salt, (err, code) => {
                if(err) {
                    return nextCode(err);
                }
                code = code.toString('base64');
                return nextCode(null, { salt, code });
            });
        });
    },
    (err, codes) => {
        if(err) {
            return cb(err);
        }

        codes = JSON.stringify(codes);
        user.persistProperty(UserProps.AuthFactor2OTPBackupCodes, codes, err => {
            return cb(err, plainCodes);
        });
    });
}

function validateAndConsumeBackupCode(user, token, cb) {
    try
    {
        let validCodes = JSON.parse(user.getProperty(UserProps.AuthFactor2OTPBackupCodes));
        async.detect(validCodes, (entry, nextEntry) => {
            backupCodePBKDF2(token, entry.salt, (err, code) => {
                if(err) {
                    return nextEntry(err);
                }
                code = code.toString('base64');
                return nextEntry(null, code === entry.code);
            });
        },
        (err, matchingEntry) => {
            if(err) {
                return cb(err);
            }

            if(!matchingEntry) {
                return cb(Errors.BadLogin('Invalid OTP value supplied', ErrorReasons.Invalid2FA));
            }

            //  We're consuming a match - remove it from available backup codes
            validCodes = validCodes.filter(entry => {
                return entry.code != matchingEntry.code && entry.salt != matchingEntry.salt;
            });

            validCodes = JSON.stringify(validCodes);
            user.persistProperty(UserProps.AuthFactor2OTPBackupCodes, validCodes, err => {
                return cb(err);
            });
        });
    } catch(e) {
        return cb(e);
    }
}

function loginFactor2_OTP(client, token, cb) {
    if(client.user.authFactor < User.AuthFactors.Factor1) {
        return cb(Errors.AccessDenied('OTP requires prior authentication factor 1'));
    }

    const otpType = client.user.getProperty(UserProps.AuthFactor2OTP);
    if(!_.values(OTPTypes).includes(otpType)) {
        return cb(Errors.Invalid(`Unknown OTP type: ${otpType}`));
    }

    const secret = client.user.getProperty(UserProps.AuthFactor2OTPSecret);
    if(!secret) {
        return cb(Errors.Invalid('Missing OTP secret'));
    }

    const otp   = otpFromType(otpType);
    const valid = otp.verify( { token, secret } );

    const allowLogin = () => {
        client.user.authFactor = User.AuthFactors.Factor2;
        client.user.authenticated = true;
        return recordLogin(client, cb);
    };

    if(valid) {
        return allowLogin();
    }

    //  maybe they punched in a backup code?
    validateAndConsumeBackupCode(client.user, token, err => {
        if(err) {
            return cb(transformLoginError(err, client, client.user.username));
        }

        return allowLogin();
    });
}
