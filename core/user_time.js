/* jslint node: true */
'use strict';

//  ENiGMA½
const UserProps = require('./user_property.js');

//
//  Read through config.js rather than capturing its |get|, which is what the
//  rest of core/ does. config.js *replaces* that export when the system
//  configuration is created, and this module is reached from several places
//  with different lifetimes -- client.js at startup, the ACS parser on every
//  evaluation, predefined_mci.js. Capturing would pin it to whichever
//  accessor happened to be installed at first require.
//
const configModule = require('./config.js');
const Config = () => configModule.get();

//  deps
const moment = require('moment');
const _ = require('lodash');

//
//  Daily time budgets.
//
//  Nothing outside this module computes elapsed or remaining time for the
//  budget. Every consumer -- ACS ML, the TR/TA/TD MCI codes, drop files,
//  warnings and the time-up kick -- comes through here, so there is exactly
//  one definition of "how much time does this user have left today".
//
//  "Unlimited" is a state, not a large number: getTimeLeftMinutes() and
//  getAllowedMinutesToday() return |null| for it. Infinity or 99999 would
//  invite arithmetic that quietly produces a plausible looking figure; null
//  cannot be compared or formatted by accident, so a consumer that forgets
//  the case fails visibly instead of writing it into a drop file.
//
//  The shipped default is unlimited for everyone and stays that way: with no
//  |users.timeLimits| in the configuration nothing here ever returns a
//  number.
//

const DateFormat = 'YYYY-MM-DD'; //  matches LoginStreakLastDate's convention

//
//  Warn at 5, 3, 2 and 1 minutes remaining: the consensus shape across
//  Synchronet, Maximus, PCBoard and Wildcat!. Descending, and matched with
//  <= rather than equality -- Mystic's "If TimeCount = 5" means a tick that
//  lands on 4 drops the warning entirely, and an equality based
//  implementation passes a naive test.
//
const WarnMinutes = [5, 3, 2, 1];

//
//  A users.timeLimits band is an ACS expression, so a band written as
//  { acs: "ML30", ... } would recurse: accessor -> evaluate bands -> ML ->
//  accessor. No sysop should write that, but ACS strings compose and the
//  failure mode is a stack overflow that takes the board down rather than a
//  config error anyone can see. While a band evaluation is in progress the
//  allowance reads as unlimited, which terminates and is consistent with the
//  fail-open rule everywhere else here.
//
let bandEvaluationDepth = 0;

function todayDateString() {
    return moment().format(DateFormat);
}

//
//  NOTE: user.isSysOp() is *not* the test we want -- it is an alias for
//  isRoot() and so covers only the single root account, leaving every
//  co-sysop metered. This is the same check getLegacySecurityLevel() uses.
//
//  The exemption is deliberately not configurable.
//
function isTimeExempt(user) {
    if (!user) {
        return false;
    }
    return user.isRoot() || user.isGroupMember('sysops');
}

//
//  Zero and re-stamp the daily counters when the stamp is not today's.
//
//  Lazily, on every read and every tick: this must never depend on the daily
//  maintenance event, since a board that was down at 04:00 would then hand
//  every user a stale balance. Daily maintenance may also clear it, but can
//  never be the only path.
//
//  Returns true if a reset actually happened.
//
function resetDailyUsageIfNeeded(user) {
    if (!user || !(user.userId > 0)) {
        return false;
    }

    const today = todayDateString();
    if (today === user.getProperty(UserProps.TimeUsedTodayDate)) {
        return false;
    }

    //
    //  persistProperty() rather than StatLog: these are budget bookkeeping,
    //  not statistics, and must not emit UserStatSet/UserStatIncrement into
    //  the achievement system.
    //
    user.persistProperty(UserProps.TimeUsedTodayMinutes, 0);
    user.persistProperty(UserProps.TimeUsedTodayDate, today);
    return true;
}

//  Minutes used today, after any pending day rollover.
function getTimeUsedTodayMinutes(user) {
    if (!user) {
        return 0;
    }
    resetDailyUsageIfNeeded(user);
    return user.getPropertyAsNumber(UserProps.TimeUsedTodayMinutes) || 0;
}

//
//  The daily allowance, in minutes, or null for unlimited.
//
//  Precedence: the per-account override, then the first matching
//  users.timeLimits band, then a band with no |acs| at all, then unlimited.
//  A configured 0 means unlimited in both tiers, matching the
//  users.idleLogoutSeconds convention in the same block.
//
function getAllowedMinutesToday(client) {
    if (bandEvaluationDepth > 0) {
        return null; //  see bandEvaluationDepth above
    }

    const user = _.get(client, 'user');
    if (!user || !user.isAuthenticated()) {
        return null;
    }

    if (isTimeExempt(user)) {
        return null;
    }

    const override = user.getPropertyAsNumber(UserProps.TimeMinutesPerDay);
    if (!isNaN(override)) {
        return override > 0 ? override : null;
    }

    const bands = _.get(Config(), 'users.timeLimits');
    if (!Array.isArray(bands) || 0 === bands.length) {
        return null;
    }

    let minutesPerDay;
    bandEvaluationDepth += 1;
    try {
        minutesPerDay = client.acs.getConditionalValue(bands, 'minutesPerDay');
    } finally {
        bandEvaluationDepth -= 1;
    }

    minutesPerDay = parseInt(minutesPerDay, 10);
    if (isNaN(minutesPerDay) || minutesPerDay <= 0) {
        return null;
    }

    return minutesPerDay;
}

//
//  Minutes remaining today, or null for unlimited.
//
function getTimeLeftMinutes(client) {
    const allowed = getAllowedMinutesToday(client);
    if (null === allowed) {
        return null;
    }

    const used = getTimeUsedTodayMinutes(client.user);

    //
    //  One term today. Written as a min() over a list anyway so that a
    //  future clamp -- a scheduled event, say -- drops in here instead of
    //  being sprinkled over every consumer, which is where other packages
    //  accumulated their special cases.
    //
    const limits = [allowed - used];
    return Math.max(0, Math.min(...limits));
}

//
//  Bill one minute against today's budget. Called from the existing 1m tick
//  in client.js rather than at logoff: client_connections.js runs on clean
//  and dirty disconnects, but nothing runs on a process crash, so per-tick
//  accrual loses at most a minute instead of a whole session.
//
//  Returns the new used-today total, or undefined if nothing was billed.
//
function accrueMinute(client) {
    const user = _.get(client, 'user');
    if (!user || !user.isAuthenticated()) {
        return;
    }

    //
    //  Roll the day over *before* incrementing, or a session straddling
    //  midnight keeps adding to yesterday's bucket.
    //
    resetDailyUsageIfNeeded(user);

    if (client.freeTimeDepth > 0) {
        return; //  this minute is on the house
    }

    const used = (user.getPropertyAsNumber(UserProps.TimeUsedTodayMinutes) || 0) + 1;
    user.persistProperty(UserProps.TimeUsedTodayMinutes, used);
    return used;
}

//
//  Warn the user as the budget runs down, and say when it is gone.
//
//  Called from the same 1m tick that bills the minute, which is the only
//  moment the balance can change, so the check is exact rather than merely
//  frequent.
//
//  Returns 'time up' when there is nothing left, the threshold warned at, or
//  undefined when there was nothing to say.
//
function checkTimeRemaining(client) {
    const timeLeft = getTimeLeftMinutes(client);
    if (null === timeLeft) {
        return; //  unlimited, exempt, or nothing configured
    }

    if (timeLeft <= 0) {
        client.emit('time up');
        return 'time up';
    }

    //
    //  The *lowest* threshold this balance has reached -- the last match in
    //  a descending list, not the first. A tick that skips from 6 straight
    //  to 2 then warns once, at 2, rather than at 5.
    //
    const threshold = WarnMinutes.filter(m => timeLeft <= m).pop();
    if (undefined === threshold) {
        return;
    }

    if (undefined !== client.timeWarnLatch && client.timeWarnLatch <= threshold) {
        return; //  already warned at this threshold or a lower one
    }
    client.timeWarnLatch = threshold;

    //
    //  Late require: client.js loads this module, and the interrupt queue
    //  reaches back into client_connections.js.
    //
    //  Queued rather than written straight to the terminal, so a warning
    //  never lands in the middle of someone's art or editor. A module that
    //  cannot be interrupted right now shows it at the next opportunity.
    //
    const UserInterruptQueue = require('./user_interrupt_queue.js');
    UserInterruptQueue.queue(
        {
            text: `|12Time warning: |15${timeLeft} minute${
                1 === timeLeft ? '' : 's'
            }|12 remaining today.|00`,
            pause: false,
        },
        { clients: [client] }
    );

    return threshold;
}

//
//  Is there enough of today's budget left to *start* something that wants
//  |minMinutes| of it?
//
//  True when nothing is asked for (no requirement configured) and true for
//  an unlimited user, so a board that has not opted in is never gated.
//
function hasTimeFor(client, minMinutes) {
    const required = parseInt(minMinutes, 10);
    if (isNaN(required) || required < 1) {
        return true;
    }

    const timeLeft = getTimeLeftMinutes(client);
    return null === timeLeft || timeLeft >= required;
}

//  What TR/TA render when no limit applies.
function unlimitedTimeText() {
    return _.get(Config(), 'users.unlimitedTimeText') || 'Unlimited';
}

module.exports = {
    WarnMinutes,
    isTimeExempt,
    resetDailyUsageIfNeeded,
    getTimeUsedTodayMinutes,
    getAllowedMinutesToday,
    getTimeLeftMinutes,
    accrueMinute,
    checkTimeRemaining,
    hasTimeFor,
    unlimitedTimeText,
};
