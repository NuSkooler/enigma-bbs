'use strict';

//
//  Total number of users, for |TU, the WFC and the REST stats route.
//
//  The count is read live (SELECT COUNT(*) FROM user) and cached for CacheMs,
//  so a user removed by oputil, a separate process, shows up within that time.
//  A new sign-up refreshes it at once (see watchNewUsers()). The result is also
//  kept in the non-persistent TotalUserCount system stat.
//
//  The read is a synchronous better-sqlite3 call on a tiny table, so readers
//  stay synchronous. Nothing here touches the user database until the first
//  read: it is safe to require this module early, but not to call it before
//  initializeDatabases().
//

const SysProps = require('./system_property');

const CacheMs = 30 * 1000;

let cachedCount = null;
let cachedAt = 0;

function setCount(count) {
    cachedCount = count;
    //  lazy: stat_log captures dbs.system at load
    require('./stat_log').setNonPersistentSystemStat(SysProps.TotalUserCount, count);
}

//  Reads the count now and caches it. Returns the count, or the last known
//  one (null if none) when the database cannot be read.
function refreshTotalUserCount(now = Date.now()) {
    cachedAt = now;
    try {
        const db = require('./database').dbs.user;
        setCount(db.prepare('SELECT COUNT(*) AS total FROM user;').get().total);
    } catch (e) {
        //  not ready, or broken: keep what we have and try again after CacheMs
    }
    return cachedCount;
}

//  Total users; the cached count while it is fresh. 0 if it was never read.
function getTotalUserCount(now = Date.now()) {
    if (null === cachedCount || now - cachedAt >= CacheMs) {
        refreshTotalUserCount(now);
    }
    if (null === cachedCount) {
        return require('./stat_log').getSystemStatNum(SysProps.TotalUserCount);
    }
    return cachedCount;
}

//  Count a new user at once, rather than when the cache expires.
function watchNewUsers() {
    const Events = require('./events');
    Events.addListener(Events.getSystemEvents().NewUser, () => refreshTotalUserCount());
}

function resetUserCountCache() {
    cachedCount = null;
    cachedAt = 0;
}

module.exports = {
    CacheMs,
    getTotalUserCount,
    refreshTotalUserCount,
    watchNewUsers,
    resetUserCountCache,
};
