/* jslint node: true */
'use strict';

//  ENiGMA½
const UserProps = require('./user_property.js');
const stringFormat = require('./string_format.js');

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
    //
    //  A userId alone is not enough: it is set once factor 1 succeeds, so a
    //  user sitting at a 2FA prompt has one while |authenticated| is still
    //  false. Nothing should be writing budget rows for a session that may
    //  yet be refused.
    //
    if (!user || !(user.userId > 0) || !user.isAuthenticated()) {
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

    //
    //  The per-account override is read live: an operator running
    //  "oputil.js user time" while somebody is connected means it to take
    //  effect now.
    //
    const override = user.getPropertyAsNumber(UserProps.TimeMinutesPerDay);
    if (!isNaN(override)) {
        return override > 0 ? override : null;
    }

    //
    //  The band, however, is resolved once per session -- and again when the
    //  day rolls over -- rather than on every read.
    //
    //  A band is an ACS expression, and ACS reads things that move while
    //  somebody is connected: MM and WD most obviously, but also GM if the
    //  sysop changes a group, or TH/TW on a resize. Re-resolving every time
    //  lets the allowance fall underneath a session that has already spent
    //  against the old answer -- a caller who has used 100 minutes when an
    //  MM band drops the allowance to 60 goes straight to zero and is
    //  disconnected, having been warned about none of it.
    //
    //  Pinning makes a session's budget what it was when the session began,
    //  which is how every package with per-class limits behaves: they are
    //  read at logon. The visible consequence is that a configuration hot
    //  reload does not reach sessions already underway.
    //
    const today = todayDateString();
    if (client.timeBand && today === client.timeBand.date) {
        return client.timeBand.minutesPerDay;
    }

    const minutesPerDay = resolveBandMinutes(client);
    client.timeBand = { date: today, minutesPerDay };
    return minutesPerDay;
}

//  The band lookup itself, without the per-session pin. Returns null for
//  unlimited, exactly as the accessor does.
function resolveBandMinutes(client) {
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
        //
        //  Once, not once a minute. The kick is asynchronous -- it resolves
        //  art and may hand over to a menu -- so without this a session that
        //  has not finished going away gets another 'time up' on the next
        //  tick, and a timeUpLogoff menu a sysop gave a pause prompt to
        //  would have its art overwritten a minute later.
        //
        if (client.timeUpEmitted) {
            return 'time up';
        }
        client.timeUpEmitted = true;

        //  nothing more to bill on a session that is ending
        if (_.isFunction(client.stopTimeMonitor)) {
            client.stopTimeMonitor();
        }

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
        //
        //  Back above every threshold, so the latch has to go: otherwise a
        //  session that straddles midnight keeps yesterday's latch and
        //  silently skips every warning above it on the way down again. The
        //  same applies to a band a sysop raises mid-session, since the
        //  configuration is read afresh on each call.
        //
        delete client.timeWarnLatch;
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
    const text = timeWarningText(client, timeLeft);
    if (!text) {
        return threshold; //  warnings turned off; the latch still moves
    }

    const UserInterruptQueue = require('./user_interrupt_queue.js');
    UserInterruptQueue.queue({ text, pause: false }, { clients: [client] });

    return threshold;
}

//
//  May this session start at all?
//
//  Called once the user is authenticated. Without it the session starts and
//  runs until the next tick, which bills a minute the user does not have and
//  only then kicks -- so a minute per reconnect, indefinitely, which is no
//  limit at all.
//
//  Returns false having emitted 'time up', so the caller only has to not
//  proceed; the kick handler is already listening.
//
function admitSession(client) {
    const timeLeft = getTimeLeftMinutes(client);
    if (null === timeLeft || timeLeft > 0) {
        return true;
    }

    client.log.info('User has no time remaining today; Kicking');
    client.emit('time up');
    return false;
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

//
//  The warning a user sees, from their theme if it customizes one and from
//  theme.timeWarningText otherwise. The theme is not loaded for the whole
//  life of a session, so fall back to the configured string when the helper
//  is not there yet.
//
function timeWarningText(client, timeLeft) {
    const getter = _.get(client, 'currentTheme.helpers.getTimeWarningText');
    //  the same expression the helper uses, so both layers agree that an
    //  empty string means no warning
    const template = _.isFunction(getter)
        ? getter()
        : _.get(Config(), 'theme.timeWarningText', '');

    if (!template) {
        return ''; //  warnings turned off
    }

    return stringFormat(template, {
        minutes: timeLeft,
        plural: 1 === timeLeft ? '' : 's',
    });
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
    admitSession,
    hasTimeFor,
    unlimitedTimeText,
};
