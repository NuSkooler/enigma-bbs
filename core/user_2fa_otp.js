/* jslint node: true */
'use strict';

//  ENiGMA½
const UserProps = require('./user_property.js');
const { Errors, ErrorReasons } = require('./enig_error.js');
const User = require('./user.js');
const { recordLogin, transformLoginError } = require('./user_login.js');
const Config = require('./config.js').get;

//  deps
const _ = require('lodash');
const crypto = require('crypto');
const qrGen = require('qrcode-generator');

exports.prepareOTP = prepareOTP;
exports.createBackupCodes = createBackupCodes;
exports.createQRCode = createQRCode;
exports.otpFromType = otpFromType;
exports.loginFactor2_OTP = loginFactor2_OTP;

const OTPTypes = (exports.OTPTypes = {
    RFC6238_TOTP: 'rfc6238_TOTP', //  Time-Based, SHA-512
    RFC4266_HOTP: 'rfc4266_HOTP', //  HMAC-Based, SHA-512
    GoogleAuthenticator: 'googleAuth', //  Google Authenticator is basically TOTP + quirks
});

function otpFromType(otpType) {
    try {
        return {
            [OTPTypes.RFC6238_TOTP]: () => {
                const totp = require('otplib/totp');
                totp.options = { crypto, algorithm: 'sha256' };
                return totp;
            },
            [OTPTypes.RFC4266_HOTP]: () => {
                const hotp = require('otplib/hotp');
                hotp.options = { crypto, algorithm: 'sha256' };
                return hotp;
            },
            [OTPTypes.GoogleAuthenticator]: () => {
                const googleAuth = require('otplib/authenticator');
                googleAuth.options = { crypto };
                return googleAuth;
            },
        }[otpType]();
    } catch (e) {
        //  nothing
    }
}

function generateOTPBackupCode() {
    const consonants = 'bdfghjklmnprstvz'.split('');
    const vowels = 'aiou'.split('');

    const bits = [];
    const rng = crypto.randomBytes(4);

    for (let i = 0; i < rng.length / 2; ++i) {
        const n = rng.readUInt16BE(i * 2);

        const c1 = n & 0x0f;
        const v1 = (n >> 4) & 0x03;
        const c2 = (n >> 6) & 0x0f;
        const v2 = (n >> 10) & 0x03;
        const c3 = (n >> 12) & 0x0f;

        bits.push(
            [consonants[c1], vowels[v1], consonants[c2], vowels[v2], consonants[c3]].join(
                ''
            )
        );
    }

    return bits.join('-');
}

function createBackupCodes() {
    const codes = [...Array(6)].map(() => generateOTPBackupCode());
    return codes;
}

function validateAndConsumeBackupCode(user, token, cb) {
    try {
        let validCodes = JSON.parse(
            user.getProperty(UserProps.AuthFactor2OTPBackupCodes)
        );
        const matchingCode = validCodes.find(c => c === token);
        if (!matchingCode) {
            return cb(
                Errors.BadLogin('Invalid OTP value supplied', ErrorReasons.Invalid2FA)
            );
        }

        //  We're consuming a match - remove it from available backup codes
        validCodes = validCodes.filter(c => c !== matchingCode);
        validCodes = JSON.stringify(validCodes);
        user.persistProperty(UserProps.AuthFactor2OTPBackupCodes, validCodes, err => {
            return cb(err);
        });
    } catch (e) {
        return cb(e);
    }
}

function createQRCode(otp, options, secret) {
    try {
        const uri = otp.keyuri(
            options.username || 'user',
            Config().general.boardName,
            secret
        );
        const qrCode = qrGen(0, 'L');
        qrCode.addData(uri);
        qrCode.make();

        options.qrType = options.qrType || 'ascii';
        return {
            ascii: qrCode.createASCII,
            data: qrCode.createDataURL,
            img: qrCode.createImgTag,
            svg: qrCode.createSvgTag,
        }[options.qrType](options.cellSize);
    } catch (e) {
        return '';
    }
}

function prepareOTP(otpType, options, cb) {
    if (!_.isFunction(cb)) {
        cb = options;
        options = {};
    }

    const otp = otpFromType(otpType);
    if (!otp) {
        return cb(Errors.Invalid(`Unknown OTP type: ${otpType}`));
    }

    const secret =
        OTPTypes.GoogleAuthenticator === otpType
            ? otp.generateSecret()
            : crypto.randomBytes(64).toString('base64').substr(0, 32);

    const qr = createQRCode(otp, options, secret);

    return cb(null, { secret, qr });
}

function loginFactor2_OTP(client, token, cb) {
    if (client.user.authFactor < User.AuthFactors.Factor1) {
        return cb(Errors.AccessDenied('OTP requires prior authentication factor 1'));
    }

    const otpType = client.user.getProperty(UserProps.AuthFactor2OTP);
    const otp = otpFromType(otpType);

    if (!otp) {
        return cb(Errors.Invalid(`Unknown OTP type: ${otpType}`));
    }

    const secret = client.user.getProperty(UserProps.AuthFactor2OTPSecret);
    if (!secret) {
        return cb(Errors.Invalid('Missing OTP secret'));
    }

    const valid = otp.verify({ token, secret });

    const allowLogin = () => {
        client.user.authFactor = User.AuthFactors.Factor2;
        client.user.authenticated = true;
        return recordLogin(client, cb);
    };

    if (valid) {
        return allowLogin();
    }

    //  maybe they punched in a backup code?
    validateAndConsumeBackupCode(client.user, token, err => {
        if (err) {
            return cb(transformLoginError(err, client, client.user.username));
        }

        return allowLogin();
    });
}
