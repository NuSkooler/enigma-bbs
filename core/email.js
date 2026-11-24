/* jslint node: true */
'use strict';

//  ENiGMA½
const Config = require('./config.js').get;
const Errors = require('./enig_error.js').Errors;
const Log = require('./logger.js').log;

//  deps
const _ = require('lodash');
const nodeMailer = require('nodemailer');

exports.sendMail = sendMail;
exports.getUsernameReplaceChar = getUsernameReplaceChar;
exports.emailLocalPart = emailLocalPart;
exports.findUsersByEmailLocalPart = findUsersByEmailLocalPart;
exports.resolveEmailLocalPart = resolveEmailLocalPart;

function getUsernameReplaceChar() {
    return _.get(Config(), 'email.outbound.usernameReplaceChar', '_');
}

//
//  The local part of a user's email address (local@outbound.fromDomain), from
//  their user name: what outbound mail is sent as, and inbound mail is
//  delivered by.
//
function emailLocalPart(name, replaceChar = getUsernameReplaceChar()) {
    //  RFC 5321 local-parts allow a broader set, but restrict to the
    //  conservative subset (letters, digits, dot, hyphen, underscore)
    //  that virtually every receiver handles without surprise.
    let local = String(name).replace(/[^a-zA-Z0-9._-]+/g, replaceChar);
    //  Trim leading/trailing separators and collapse repeats
    local = local.replace(/^[._-]+|[._-]+$/g, '');
    if (replaceChar) {
        const esc = replaceChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        local = local.replace(new RegExp(`${esc}{2,}`, 'g'), replaceChar);
    }
    return local;
}

//
//  cb(err, [ { userId, userName } ]): every user whose email local part (see
//  emailLocalPart()) is |localPart|, ignoring case. The database is asked
//  only for names that could be (what lies between the replacement
//  characters, in order); each is then checked exactly.
//
function findUsersByEmailLocalPart(localPart, cb) {
    if (!_.isString(localPart) || 0 === localPart.length) {
        return cb(null, []);
    }

    const replaceChar = getUsernameReplaceChar();
    const pieces = replaceChar ? localPart.split(replaceChar) : [...localPart];
    const likeEscape = piece => piece.replace(/[\\%_]/g, '\\$&');
    const pattern = `%${pieces.map(likeEscape).join('%')}%`;

    const User = require('./user.js'); //  late: user.js is loaded by much of what loads this
    User.getUserIdsAndNamesLike(pattern, (err, rows) => {
        if (err) {
            return cb(err);
        }
        const wanted = localPart.toLowerCase();
        return cb(
            null,
            rows.filter(
                row => emailLocalPart(row.userName, replaceChar).toLowerCase() === wanted
            )
        );
    });
}

//
//  cb(err, userId, userName): the user mail to |localPart|@ is for. A user
//  with exactly that name (ignoring case) first; otherwise the one user whose
//  name gives that local part ("John_Doe" for "John Doe"). Two or more such
//  users cannot be told apart, and get nothing.
//
function resolveEmailLocalPart(localPart, cb) {
    const User = require('./user.js');
    User.getUserIdAndName(localPart, (err, userId, userName) => {
        if (!err) {
            return cb(null, userId, userName);
        }

        findUsersByEmailLocalPart(localPart, (err, users) => {
            if (err) {
                return cb(err);
            }
            if (1 === users.length) {
                return cb(null, users[0].userId, users[0].userName);
            }
            if (users.length > 1) {
                Log.warn(
                    { localPart, userNames: users.map(u => u.userName) },
                    'Email local part matches more than one user; not delivering to any'
                );
                return cb(Errors.Invalid('Ambiguous email recipient'));
            }
            return cb(Errors.DoesNotExist('No user for email local part'));
        });
    });
}

function sendMail(message, cb) {
    const config = Config();
    if (!_.has(config, 'email.transport')) {
        return cb(Errors.MissingConfig('Email "email.transport" configuration missing'));
    }

    message.from = message.from || config.email.defaultFrom;

    const transportOptions = Object.assign({}, config.email.transport, {
        logger: Log,
    });

    const transport = nodeMailer.createTransport(transportOptions);

    transport.sendMail(message, (err, info) => {
        return cb(err, info);
    });
}
