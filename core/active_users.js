'use strict';

//  Counts of distinct users who logged in within a recent window, for the
//  NodeInfo documents.
//
//  The source is each user's last login timestamp (user_property
//  'last_login_timestamp'): a user's last login is inside a window exactly when
//  they logged in at least once inside it. Unlike the login history it does
//  not depend on statLog.systemEvents.loginHistoryMax, and a user counts once
//  however often they logged in.

const UserProps = require('./user_property');

const ActiveWindowDays = Object.freeze({
    activeHalfyear: 180,
    activeMonth: 30,
    activeWeek: 7,
});

//  Partial, covering index: it holds only the last login rows (a write to any
//  other property does not touch it), and the query reads them from it without
//  the table. The WHERE of the query must repeat the literal for SQLite to use it.
const ActiveUsersIndexSql = `
    CREATE INDEX IF NOT EXISTS user_property_last_login_index0
        ON user_property (prop_value)
        WHERE prop_name = '${UserProps.LastLoginTs}';`;

const ActiveUsersSql = `
    SELECT
        COALESCE(SUM(julianday(prop_value) >= julianday(@halfyear)), 0) AS activeHalfyear,
        COALESCE(SUM(julianday(prop_value) >= julianday(@month)), 0)    AS activeMonth,
        COALESCE(SUM(julianday(prop_value) >= julianday(@week)), 0)     AS activeWeek
    FROM user_property
    WHERE prop_name = '${UserProps.LastLoginTs}';`;

//
//  Returns { activeHalfyear, activeMonth, activeWeek }: distinct users whose last
//  login is within 180 / 30 / 7 days of |nowMs| (default: now). One query;
//  throws if |db| cannot be read.
//
//  A timestamp that cannot be parsed makes julianday() NULL, so that user is
//  counted in no window.
//
function countActiveUsers(db, nowMs = Date.now()) {
    const since = days => new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
    const row = db.prepare(ActiveUsersSql).get({
        halfyear: since(ActiveWindowDays.activeHalfyear),
        month: since(ActiveWindowDays.activeMonth),
        week: since(ActiveWindowDays.activeWeek),
    });

    return {
        activeHalfyear: row.activeHalfyear,
        activeMonth: row.activeMonth,
        activeWeek: row.activeWeek,
    };
}

module.exports = {
    countActiveUsers,
    ActiveUsersIndexSql,
    ActiveUsersSql,
    ActiveWindowDays,
};
