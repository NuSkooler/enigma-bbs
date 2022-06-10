/* jslint node: true */
'use strict';

//  ENiGMA½
const { removeClient } = require('./client_connections.js');
const ansiNormal = require('./ansi_term.js').normal;
const { userLogin } = require('./user_login.js');
const messageArea = require('./message_area.js');
const { ErrorReasons } = require('./enig_error.js');
const UserProps = require('./user_property.js');
const { loginFactor2_OTP } = require('./user_2fa_otp.js');

//  deps
const _ = require('lodash');
const iconv = require('iconv-lite');

exports.login = login;
exports.login2FA_OTP = login2FA_OTP;
exports.logoff = logoff;
exports.prevMenu = prevMenu;
exports.nextMenu = nextMenu;
exports.prevConf = prevConf;
exports.nextConf = nextConf;
exports.prevArea = prevArea;
exports.nextArea = nextArea;
exports.sendForgotPasswordEmail = sendForgotPasswordEmail;
exports.optimizeDatabases = optimizeDatabases;

const handleAuthFailures = (callingMenu, err, cb) => {
    //  already logged in with this user?
    if (
        ErrorReasons.AlreadyLoggedIn === err.reasonCode &&
        _.has(callingMenu, 'menuConfig.config.tooNodeMenu')
    ) {
        return callingMenu.gotoMenu(callingMenu.menuConfig.config.tooNodeMenu, cb);
    }

    //  banned username results in disconnect
    if (ErrorReasons.NotAllowed === err.reasonCode) {
        return logoff(callingMenu, {}, {}, cb);
    }

    const ReasonsMenus = [
        ErrorReasons.TooMany,
        ErrorReasons.Disabled,
        ErrorReasons.Inactive,
        ErrorReasons.Locked,
    ];
    if (ReasonsMenus.includes(err.reasonCode)) {
        const menu = _.get(callingMenu, [
            'menuConfig',
            'config',
            err.reasonCode.toLowerCase(),
        ]);
        return menu ? callingMenu.gotoMenu(menu, cb) : logoff(callingMenu, {}, {}, cb);
    }

    //  Other error
    return callingMenu.prevMenu(cb);
};

function login(callingMenu, formData, extraArgs, cb) {
    userLogin(
        callingMenu.client,
        formData.value.username,
        formData.value.password,
        err => {
            if (err) {
                return handleAuthFailures(callingMenu, err, cb);
            }

            //  success!
            return callingMenu.nextMenu(cb);
        }
    );
}

function login2FA_OTP(callingMenu, formData, extraArgs, cb) {
    loginFactor2_OTP(callingMenu.client, formData.value.token, err => {
        if (err) {
            return handleAuthFailures(callingMenu, err, cb);
        }

        //  success!
        return callingMenu.nextMenu(cb);
    });
}

function logoff(callingMenu, formData, extraArgs, cb) {
    //
    //  Simple logoff. Note that recording of @ logoff properties/stats
    //  occurs elsewhere!
    //
    const client = callingMenu.client;

    setTimeout(() => {
        //
        //  For giggles...
        //
        client.term.write(
            ansiNormal() +
                '\n' +
                iconv.decode(
                    require('crypto').randomBytes(Math.floor(Math.random() * 65) + 20),
                    client.term.outputEncoding
                ) +
                'NO CARRIER',
            null,
            () => {
                //  after data is written, disconnect & remove the client
                removeClient(client);
                return cb(null);
            }
        );
    }, 500);
}

function prevMenu(callingMenu, formData, extraArgs, cb) {
    //  :TODO: this is a pretty big hack -- need the whole key map concep there like other places
    if (formData.key && 'return' === formData.key.name) {
        callingMenu.submitFormData = formData;
    }

    callingMenu.prevMenu(err => {
        if (err) {
            callingMenu.client.log.error(
                { error: err.message },
                'Error attempting to fallback!'
            );
        }
        return cb(err);
    });
}

function nextMenu(callingMenu, formData, extraArgs, cb) {
    callingMenu.nextMenu(err => {
        if (err) {
            callingMenu.client.log.error(
                { error: err.message },
                'Error attempting to go to next menu!'
            );
        }
        return cb(err);
    });
}

//  :TODO: need redrawMenu() and MenuModule.redraw()
function reloadMenu(menu, cb) {
    return menu.reload(cb);
}

function prevConf(callingMenu, formData, extraArgs, cb) {
    const confs = messageArea.getSortedAvailMessageConferences(callingMenu.client);
    const currIndex =
        confs.findIndex(
            e =>
                e.confTag === callingMenu.client.user.properties[UserProps.MessageConfTag]
        ) || confs.length;

    messageArea.changeMessageConference(
        callingMenu.client,
        confs[currIndex - 1].confTag,
        err => {
            if (err) {
                return cb(err); //  logged within changeMessageConference()
            }

            return reloadMenu(callingMenu, cb);
        }
    );
}

function nextConf(callingMenu, formData, extraArgs, cb) {
    const confs = messageArea.getSortedAvailMessageConferences(callingMenu.client);
    let currIndex = confs.findIndex(
        e => e.confTag === callingMenu.client.user.properties[UserProps.MessageConfTag]
    );

    if (currIndex === confs.length - 1) {
        currIndex = -1;
    }

    messageArea.changeMessageConference(
        callingMenu.client,
        confs[currIndex + 1].confTag,
        err => {
            if (err) {
                return cb(err); //  logged within changeMessageConference()
            }

            return reloadMenu(callingMenu, cb);
        }
    );
}

function prevArea(callingMenu, formData, extraArgs, cb) {
    const areas = messageArea.getSortedAvailMessageAreasByConfTag(
        callingMenu.client.user.properties[UserProps.MessageConfTag]
    );
    const currIndex =
        areas.findIndex(
            e =>
                e.areaTag === callingMenu.client.user.properties[UserProps.MessageAreaTag]
        ) || areas.length;

    messageArea.changeMessageArea(
        callingMenu.client,
        areas[currIndex - 1].areaTag,
        err => {
            if (err) {
                return cb(err); //  logged within changeMessageArea()
            }

            return reloadMenu(callingMenu, cb);
        }
    );
}

function nextArea(callingMenu, formData, extraArgs, cb) {
    const areas = messageArea.getSortedAvailMessageAreasByConfTag(
        callingMenu.client.user.properties[UserProps.MessageConfTag]
    );
    let currIndex = areas.findIndex(
        e => e.areaTag === callingMenu.client.user.properties[UserProps.MessageAreaTag]
    );

    if (currIndex === areas.length - 1) {
        currIndex = -1;
    }

    messageArea.changeMessageArea(
        callingMenu.client,
        areas[currIndex + 1].areaTag,
        err => {
            if (err) {
                return cb(err); //  logged within changeMessageArea()
            }

            return reloadMenu(callingMenu, cb);
        }
    );
}

function sendForgotPasswordEmail(callingMenu, formData, extraArgs, cb) {
    const username = formData.value.username || callingMenu.client.user.username;

    const WebPasswordReset = require('./web_password_reset.js').WebPasswordReset;

    WebPasswordReset.sendForgotPasswordEmail(username, err => {
        if (err) {
            callingMenu.client.log.warn(
                { err: err.message },
                'Failed sending forgot password email'
            );
        }

        if (extraArgs.next) {
            return callingMenu.gotoMenu(extraArgs.next, cb);
        }

        return logoff(callingMenu, formData, extraArgs, cb);
    });
}

function optimizeDatabases(callingMenu, formData, extraArgs, cb) {
    const dbs = require('./database').dbs;
    const client = callingMenu.client;

    client.term.write('\r\n\r\n');

    Object.keys(dbs).forEach(dbName => {
        client.log.info({ dbName }, 'Optimizing database');

        client.term.write(`Optimizing ${dbName}. Please wait...\r\n`);

        //  https://www.sqlite.org/pragma.html#pragma_optimize
        dbs[dbName].run('PRAGMA optimize;', err => {
            if (err) {
                client.log.error(
                    { error: err, dbName },
                    'Error attempting to optimize database'
                );
            }
        });
    });

    return callingMenu.prevMenu(cb);
}
