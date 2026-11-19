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
const UserTime = require('./user_time.js');
const UserPreference = require('./user_preference.js');

//  deps
const _ = require('lodash');
const iconv = require('iconv-lite');

exports.login = login;
exports.enterOrKick = enterOrKick; //  exported for test; see user_time_enforcement.test.js
exports.login2FA_OTP = login2FA_OTP;
exports.setClientEncoding = setClientEncoding;
exports.logoff = logoff;
exports.prevMenu = prevMenu;
exports.nextMenu = nextMenu;
exports.prevConf = prevConf;
exports.nextConf = nextConf;
exports.prevArea = prevArea;
exports.nextArea = nextArea;
exports.sendForgotPasswordEmail = sendForgotPasswordEmail;
exports.optimizeDatabases = optimizeDatabases;
exports.setUserPreference = setUserPreference;

const handleAuthFailures = (callingMenu, err, cb) => {
    //  the caller has gone (logged by userLogin()); there is nobody to answer
    if (ErrorReasons.ClientEnded === err.reasonCode) {
        return cb(null);
    }

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

//  Menu methods are invoked through the menu dispatcher with a cb that closes
//  out the action. A few call sites have historically dropped that cb (e.g.
//  abracadabra.autoNextMenu()), and an unguarded cb(err) here used to take
//  down the whole BBS for everyone. Normalising cb at the entry of each
//  exported method makes the body safe without scattering if (cb) checks.
//
//  A user whose daily allowance is already spent never reaches the session:
//  admitSession() emits 'time up' and the kick handler takes it from there.
//
function enterOrKick(callingMenu, cb) {
    if (!UserTime.admitSession(callingMenu.client)) {
        return cb(null);
    }
    return callingMenu.nextMenu(cb);
}

function login(callingMenu, formData, extraArgs, cb) {
    cb = cb || _.noop;
    userLogin(
        callingMenu.client,
        formData.value.username,
        formData.value.password,
        err => {
            if (err) {
                return handleAuthFailures(callingMenu, err, cb);
            }

            //  success!
            return enterOrKick(callingMenu, cb);
        }
    );
}

function login2FA_OTP(callingMenu, formData, extraArgs, cb) {
    cb = cb || _.noop;
    loginFactor2_OTP(callingMenu.client, formData.value.token, err => {
        if (err) {
            return handleAuthFailures(callingMenu, err, cb);
        }

        //  success!
        return enterOrKick(callingMenu, cb);
    });
}

function logoff(callingMenu, formData, extraArgs, cb) {
    cb = cb || _.noop;
    //
    //  Simple logoff. Note that recording of @ logoff properties/stats
    //  occurs elsewhere!
    //
    const client = callingMenu.client;

    //
    //  The line noise below is random bytes read as the terminal's encoding.
    //  An emulation with an encoding of its own (PETSCII) has a name iconv
    //  does not know; its noise is read as CP437 and translated like any
    //  other output.
    //
    const noiseEncoding = iconv.encodingExists(client.term.outputEncoding)
        ? client.term.outputEncoding
        : 'cp437';

    setTimeout(() => {
        //
        //  For giggles...
        //
        client.term.write(
            ansiNormal() +
                '\n' +
                iconv.decode(
                    require('crypto').randomBytes(Math.floor(Math.random() * 65) + 20),
                    noiseEncoding
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
    cb = cb || _.noop;
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
    cb = cb || _.noop;
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
    cb = cb || _.noop;
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
    cb = cb || _.noop;
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
    cb = cb || _.noop;
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
    cb = cb || _.noop;
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

function setClientEncoding(callingMenu, formData, extraArgs, cb) {
    cb = cb || _.noop;
    // TODO: Also add other encoding types
    const client = callingMenu.client;
    let encoding = formData.value.encoding;

    client.term.outputEncoding = encoding;

    return callingMenu.nextMenu(cb);
}

function sendForgotPasswordEmail(callingMenu, formData, extraArgs, cb) {
    cb = cb || _.noop;
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
    cb = cb || _.noop;
    const dbs = require('./database').dbs;
    const client = callingMenu.client;

    client.term.write('\r\n\r\n');

    Object.keys(dbs).forEach(dbName => {
        client.log.info({ dbName }, 'Optimizing database');

        client.term.write(`Optimizing ${dbName}. Please wait...\r\n`);

        //  https://www.sqlite.org/pragma.html#pragma_optimize
        try {
            dbs[dbName].pragma('optimize');
        } catch (err) {
            client.log.error(
                { error: err, dbName },
                'Error attempting to optimize database'
            );
        }
    });

    return callingMenu.prevMenu(cb);
}

//
//  Set (or clear) a user preference: a pref__<name> user property that menus
//  route on with PV[pref__<name>,<value>]. See user_preference.js.
//
//  extraArgs (menu configuration only; formData is never read):
//    pref    the property name; must match ^pref__[A-Za-z0-9\-_+]+$
//    value   the value; must match ^[A-Za-z0-9\-_+]+$ (an integer or boolean
//            is taken as its text). null removes the property, so the board
//            default (the entry without an acs) applies again.
//    next    optional menu to go to afterwards (a step in the menu history);
//            without it, back to the previous menu
//
//  Anything else is refused, nothing is written and the caller stays on the
//  menu. This method owns the warning: it calls back without an error, so
//  the dispatcher does not log the same refusal a second time.
//
function setUserPreference(callingMenu, formData, extraArgs, cb) {
    cb = cb || _.noop;
    const client = callingMenu.client;
    const { pref, value, next } = extraArgs || {};

    UserPreference.setUserPreference(client.user, pref, value, (err, stored) => {
        if (err) {
            client.log.warn(
                { error: err.message, pref, value },
                'User preference not set'
            );
            return cb(null);
        }

        client.log.debug({ pref, value: stored }, 'User preference set');

        if (undefined === next) {
            return callingMenu.prevMenu(cb);
        }

        if (!_.isString(next) || '' === next) {
            client.log.warn(
                { next },
                'Invalid "next" for setUserPreference: going to the previous menu'
            );
            return callingMenu.prevMenu(cb);
        }

        return callingMenu.gotoMenu(next, cb);
    });
}
