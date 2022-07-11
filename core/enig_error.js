/* jslint node: true */
'use strict';

class EnigError extends Error {
    constructor(message, code, reason, reasonCode) {
        super(message);

        this.name = this.constructor.name;
        this.message = message;
        this.code = code;
        this.reason = reason;
        this.reasonCode = reasonCode;

        if (this.reason) {
            this.message += `: ${this.reason}`;
        }

        if (typeof Error.captureStackTrace === 'function') {
            Error.captureStackTrace(this, this.constructor);
        } else {
            this.stack = new Error(message).stack;
        }
    }
}

exports.EnigError = EnigError;

exports.Errors = {
    General: (reason, reasonCode) =>
        new EnigError('An error occurred', -33000, reason, reasonCode),
    MenuStack: (reason, reasonCode) =>
        new EnigError('Menu stack error', -33001, reason, reasonCode),
    DoesNotExist: (reason, reasonCode) =>
        new EnigError('Object does not exist', -33002, reason, reasonCode),
    AccessDenied: (reason, reasonCode) =>
        new EnigError('Access denied', -32003, reason, reasonCode),
    Invalid: (reason, reasonCode) => new EnigError('Invalid', -32004, reason, reasonCode),
    ExternalProcess: (reason, reasonCode) =>
        new EnigError('External process error', -32005, reason, reasonCode),
    MissingConfig: (reason, reasonCode) =>
        new EnigError('Missing configuration', -32006, reason, reasonCode),
    UnexpectedState: (reason, reasonCode) =>
        new EnigError('Unexpected state', -32007, reason, reasonCode),
    MissingParam: (reason, reasonCode) =>
        new EnigError('Missing paramter(s)', -32008, reason, reasonCode),
    MissingMci: (reason, reasonCode) =>
        new EnigError('Missing required MCI code(s)', -32009, reason, reasonCode),
    BadLogin: (reason, reasonCode) =>
        new EnigError('Bad login attempt', -32010, reason, reasonCode),
    UserInterrupt: (reason, reasonCode) =>
        new EnigError('User interrupted', -32011, reason, reasonCode),
    NothingToDo: (reason, reasonCode) =>
        new EnigError('Nothing to do', -32012, reason, reasonCode),
};

exports.ErrorReasons = {
    AlreadyThere: 'ALREADYTHERE',
    InvalidNextMenu: 'BADNEXT',
    NoPreviousMenu: 'NOPREV',
    NoConditionMatch: 'NOCONDMATCH',
    NotEnabled: 'NOTENABLED',
    AlreadyLoggedIn: 'ALREADYLOGGEDIN',
    TooMany: 'TOOMANY',
    Disabled: 'DISABLED',
    Inactive: 'INACTIVE',
    Locked: 'LOCKED',
    NotAllowed: 'NOTALLOWED',
    Invalid2FA: 'INVALID2FA',
};
