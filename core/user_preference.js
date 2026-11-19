/* jslint node: true */
'use strict';

//
//  User preferences: user properties named pref__<name> that hold a choice
//  between alternatives an operator offers (e.g. which message reader the
//  new scan opens). Menus route on them with the PV ACS code:
//
//      action: [
//          {
//              acs: "PV[pref__msg_reader,lampboard]"
//              action: @menu:lampboardMain
//          }
//          {
//              action: @menu:mainMenuGlobalNewScan
//          }
//      ]
//
//  An unset preference matches no PV check, so the last entry is the board
//  default. Clearing a preference therefore hands the caller back to it.
//
//  Names and values are limited to what PV can test ([A-Za-z0-9\-_\+]+), and
//  names to the pref__ prefix, so nothing written here can overwrite a core
//  property (account_status, theme_id, ...). Both always come from menu
//  configuration, never from what a caller types.
//
//  Used by @systemMethod:setUserPreference and the user_pref_select module.
//

//  ENiGMA½
const { Errors } = require('./enig_error.js');

//  deps
const _ = require('lodash');

const PrefPrefix = 'pref__';
const PrefNameRegExp = /^pref__[A-Za-z0-9\-_+]+$/;
const PrefValueRegExp = /^[A-Za-z0-9\-_+]+$/;

exports.PrefPrefix = PrefPrefix;
exports.isValidPrefName = isValidPrefName;
exports.normalizePrefValue = normalizePrefValue;
exports.setUserPreference = setUserPreference;

function isValidPrefName(pref) {
    return _.isString(pref) && PrefNameRegExp.test(pref);
}

//
//  The value as it is stored, or undefined when it cannot be stored. A
//  number or boolean is taken as its text (Hjson reads `value: 1` as a
//  number, but a user property and a PV argument are both text). null means
//  "clear" and is returned as is.
//
function normalizePrefValue(value) {
    if (null === value) {
        return null;
    }
    if ((_.isNumber(value) && _.isFinite(value)) || _.isBoolean(value)) {
        value = String(value);
    }
    if (_.isString(value) && PrefValueRegExp.test(value)) {
        return value;
    }
    return undefined;
}

//
//  Set |pref| to |value| for |user| and persist it; a null |value| removes
//  the property so the board default applies again. Anything that fails
//  validation is refused with an Invalid error and nothing is written.
//
function setUserPreference(user, pref, value, cb) {
    if (!isValidPrefName(pref)) {
        return cb(
            Errors.Invalid(
                `Invalid preference name "${pref}": must match ${PrefNameRegExp.source}`
            )
        );
    }

    const normalized = normalizePrefValue(value);
    if (undefined === normalized) {
        return cb(
            Errors.Invalid(
                `Invalid value "${value}" for preference "${pref}": must match ${PrefValueRegExp.source}, or be null to clear it`
            )
        );
    }

    if (null === normalized) {
        return user.removeProperty(pref, err => cb(err || null, null));
    }

    return user.persistProperty(pref, normalized, err => cb(err || null, normalized));
}
